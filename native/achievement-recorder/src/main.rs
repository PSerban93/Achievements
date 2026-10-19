#![recursion_limit = "256"]
use serde::Deserialize;
use serde_json::json;
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::slice;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::Devices::Display::{
    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, DISPLAYCONFIG_DEVICE_INFO_HEADER,
    DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO, DISPLAYCONFIG_SOURCE_DEVICE_NAME,
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QDC_ONLY_ACTIVE_PATHS,
    QueryDisplayConfig,
};
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, IAudioCaptureClient, IAudioClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, WAVE_FORMAT_PCM, WAVEFORMATEX, eConsole, eRender,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows_capture::capture::{GraphicsCaptureApiError, GraphicsCaptureApiHandler};
use windows_capture::graphics_capture_api::Error as GraphicsCaptureError;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
mod media_encoder;
mod performance;
mod recording;
mod replay;
mod tone_mapper;
use recording::Capture;
type AnyError = Box<dyn Error + Send + Sync>;
#[derive(Debug)]
struct UnsupportedRecorderProfile(String);
impl std::fmt::Display for UnsupportedRecorderProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl Error for UnsupportedRecorderProfile {}
struct PipelineFailure {
    message: String,
    unsupported: bool,
}
const TICKS_PER_MILLISECOND: i64 = 10_000;
const AUDIO_SAMPLE_RATE: u32 = 48_000;
const AUDIO_CHANNELS: u16 = 2;
const AUDIO_BITS_PER_SAMPLE: u16 = 16;
const AUDIO_BLOCK_ALIGN: u16 = 4;
fn qpc_ticks() -> i64 {
    static FREQUENCY: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    let frequency = *FREQUENCY.get_or_init(|| {
        let mut n = 0;
        unsafe {
            QueryPerformanceFrequency(&mut n).expect("QPC frequency");
        }
        n
    });
    let mut counter = 0;
    unsafe {
        QueryPerformanceCounter(&mut counter).expect("QPC clock");
    }
    (i128::from(counter) * 10_000_000 / i128::from(frequency)) as i64
}
#[derive(Clone, Copy, Debug, Eq)]
struct FrameRate {
    numerator: u32,
    denominator: u32,
}

impl PartialEq for FrameRate {
    fn eq(&self, other: &Self) -> bool {
        u64::from(self.numerator) * u64::from(other.denominator)
            == u64::from(other.numerator) * u64::from(self.denominator)
    }
}

impl FrameRate {
    fn fixed(fps: u32) -> Self {
        Self {
            numerator: fps,
            denominator: 1,
        }
    }

    fn ceil_fps(self) -> u32 {
        self.numerator.div_ceil(self.denominator.max(1)).max(1)
    }
}

fn monitor_frame_rate(monitor: &Monitor) -> Result<FrameRate, AnyError> {
    display_frame_rate(&monitor.device_name()?)
}

fn display_frame_rate(device_name: &str) -> Result<FrameRate, AnyError> {
    // Display configuration can change between sizing and reading the arrays.
    for _ in 0..3 {
        let mut path_count = 0;
        let mut mode_count = 0;
        unsafe {
            GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
        }
        .ok()?;
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        let result = unsafe {
            QueryDisplayConfig(
                QDC_ONLY_ACTIVE_PATHS,
                &mut path_count,
                paths.as_mut_ptr(),
                &mut mode_count,
                modes.as_mut_ptr(),
                None,
            )
        };
        if result == windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        result.ok()?;
        for path in paths.iter().take(path_count as usize) {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: path.sourceInfo.adapterId,
                    id: path.sourceInfo.id,
                },
                ..Default::default()
            };
            if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0 {
                continue;
            }
            let end = source
                .viewGdiDeviceName
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(source.viewGdiDeviceName.len());
            if !String::from_utf16_lossy(&source.viewGdiDeviceName[..end])
                .eq_ignore_ascii_case(device_name)
            {
                continue;
            }
            let rate = path.targetInfo.refreshRate;
            if rate.Numerator > 0 && rate.Denominator > 0 && rate.Numerator >= rate.Denominator {
                return Ok(FrameRate {
                    numerator: rate.Numerator,
                    denominator: rate.Denominator,
                });
            }
        }
        break;
    }
    Err("The captured monitor's refresh rate could not be read".into())
}

fn encoding_frame_rate(monitor: &Monitor, fps: u32, unlocked: bool) -> FrameRate {
    if !unlocked {
        return FrameRate::fixed(fps);
    }
    match monitor_frame_rate(monitor) {
        Ok(rate) => rate,
        Err(error) => {
            // This is a nominal encoder rate only; capture remains unrestricted.
            let nominal_fps = monitor
                .refresh_rate()
                .ok()
                .filter(|rate| *rate > 1)
                .unwrap_or(60);
            emit(
                json!({ "type": "nominal-rate-fallback", "fps": nominal_fps, "error": error.to_string() }),
            );
            FrameRate::fixed(nominal_fps)
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Command {
    Trigger {
        id: String,
        #[serde(rename = "outputPath")]
        output_path: String,
        #[serde(default, rename = "eventAtUnixMs")]
        event_at_unix_ms: Option<u64>,
    },
    Shutdown,
}

#[derive(Clone)]
pub(crate) struct CaptureFlags {
    command_rx: Arc<Mutex<Receiver<Command>>>,
    session_dir: PathBuf,
    pre_ms: u64,
    post_ms: u64,
    segment_ms: u64,
    fps: u32,
    frame_rate: FrameRate,
    unlocked: bool,
    monitor_device_name: String,
    width: u32,
    height: u32,
    hdr_tone_map: bool,
    border_mode: &'static str,
    border_fallback: bool,
    capture_interval_mode: &'static str,
    capture_interval_ms: f64,
    ready_signal: Arc<AtomicBool>,
    runtime_error: Arc<Mutex<Option<PipelineFailure>>>,
}

struct AudioPacket {
    bytes: Vec<u8>,
    timestamp: i64,
}
struct AudioLoopback {
    receiver: Receiver<AudioPacket>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
fn emit(value: serde_json::Value) {
    println!("{value}");
    let _ = io::stdout().flush();
}

fn even_dimension(value: u32) -> u32 {
    if value.is_multiple_of(2) {
        value
    } else {
        value.saturating_add(1)
    }
}

fn ms_to_ticks(value: u64) -> i64 {
    i64::try_from(value)
        .unwrap_or(i64::MAX)
        .saturating_mul(TICKS_PER_MILLISECOND)
}

fn ticks_to_ms(value: i64) -> u64 {
    (value.max(0) / TICKS_PER_MILLISECOND) as u64
}

fn recorder_bitrate(width: u32, height: u32, fps: u32) -> u32 {
    let pixels = u64::from(width) * u64::from(height);
    let scaled = 8_000_000_u64.saturating_mul(pixels) / 2_073_600;
    let base_30_fps = scaled.clamp(5_000_000, 20_000_000);
    if fps > 60 {
        // Keep existing 30/60 settings exactly; scale higher rates with a
        // bounded bitrate rather than silently giving 240 FPS a 60 FPS budget.
        base_30_fps
            .saturating_mul(7)
            .saturating_mul(u64::from(fps))
            .saturating_div(240)
            .clamp(8_000_000, 100_000_000) as u32
    } else if fps >= 60 {
        base_30_fps
            .saturating_mul(7)
            .saturating_div(4)
            .clamp(8_000_000, 35_000_000) as u32
    } else {
        base_30_fps as u32
    }
}

fn is_border_unsupported(error: &GraphicsCaptureApiError<AnyError>) -> bool {
    if matches!(
        error,
        GraphicsCaptureApiError::GraphicsCaptureApiError(
            GraphicsCaptureError::BorderConfigUnsupported
        )
    ) {
        return true;
    }

    // Keep the exact errors observed on older Windows builds as a compatibility
    // fallback in case a future windows-capture release wraps the typed error.
    let message = error.to_string().to_ascii_lowercase();
    message.contains("borderconfigunsupported")
        || message.contains("toggling the capture border is not supported")
}

fn should_retry_sdr(error: &GraphicsCaptureApiError<AnyError>) -> bool {
    matches!(
        error,
        GraphicsCaptureApiError::DirectXError(_)
            | GraphicsCaptureApiError::NewHandlerError(_)
            | GraphicsCaptureApiError::FrameHandlerError(_)
            | GraphicsCaptureApiError::GraphicsCaptureApiError(
                GraphicsCaptureError::DirectXError(_) | GraphicsCaptureError::WindowsError(_)
            )
    )
}

fn is_minimum_interval_unsupported(error: &GraphicsCaptureApiError<AnyError>) -> bool {
    matches!(
        error,
        GraphicsCaptureApiError::GraphicsCaptureApiError(
            GraphicsCaptureError::MinimumUpdateIntervalUnsupported
        )
    )
}

fn audio_wave_format() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: AUDIO_CHANNELS,
        nSamplesPerSec: AUDIO_SAMPLE_RATE,
        nAvgBytesPerSec: AUDIO_SAMPLE_RATE * u32::from(AUDIO_BLOCK_ALIGN),
        nBlockAlign: AUDIO_BLOCK_ALIGN,
        wBitsPerSample: AUDIO_BITS_PER_SAMPLE,
        cbSize: 0,
    }
}

impl AudioLoopback {
    fn start() -> Result<Self, String> {
        // A bounded queue prevents an audio-device or graphics-capture stall from
        // turning the rolling recorder into an unbounded memory consumer.
        let (audio_tx, audio_rx) = mpsc::sync_channel(512);
        let (init_tx, init_rx) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("achievement-audio-loopback".to_string())
            .spawn(move || {
                let mut initial_status = Some(init_tx);
                supervise_audio_recovery(&worker_stop,
                    || run_audio_loopback(audio_tx.clone(), Arc::clone(&worker_stop), initial_status.take()),
                    |attempt, delay, error| {
                        emit(json!({"type":"audio-capture-failed", "error":error}));
                        emit(json!({"type":"audio-capture-retry", "attempt":attempt, "delayMs":delay.as_millis()}));
                        wait_for_audio_retry(&worker_stop, delay)
                    },
                );
            })
            .map_err(|error| error.to_string())?;

        match init_rx.recv_timeout(Duration::from_secs(5)) {
            // A missing/disconnected device is recoverable in the worker. Keep
            // the PCM/AAC timeline alive with silence while it reconnects.
            Ok(_) | Err(_) => Ok(Self {
                receiver: audio_rx,
                stop,
                worker: Some(worker),
            }),
        }
    }

    fn stop_and_join(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn wait_for_audio_retry(stop: &AtomicBool, delay: Duration) -> bool {
    let until = Instant::now() + delay;
    while !stop.load(Ordering::Acquire) && Instant::now() < until {
        thread::sleep(
            until
                .saturating_duration_since(Instant::now())
                .min(Duration::from_millis(10)),
        );
    }
    !stop.load(Ordering::Acquire)
}

fn supervise_audio_recovery(
    stop: &AtomicBool,
    mut capture: impl FnMut() -> Result<(), String>,
    mut retry: impl FnMut(usize, Duration, &str) -> bool,
) {
    let mut attempt = 0usize;
    while !stop.load(Ordering::Acquire) {
        let started = Instant::now();
        let result = capture();
        if stop.load(Ordering::Acquire) {
            break;
        }
        if started.elapsed() > Duration::from_secs(5) {
            attempt = 0;
        }
        let Err(error) = result else {
            break;
        };
        let delay = Duration::from_secs([1, 2, 5][attempt.min(2)]);
        attempt = attempt.saturating_add(1);
        if !retry(attempt, delay, &error) {
            break;
        }
    }
}

fn audio_endpoint_id(device: &IMMDevice) -> windows::core::Result<String> {
    unsafe {
        let id = device.GetId()?;
        let text = id.to_string();
        CoTaskMemFree(Some(id.0.cast()));
        Ok(text?)
    }
}

impl Drop for AudioLoopback {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}

fn run_audio_loopback(
    audio_tx: mpsc::SyncSender<AudioPacket>,
    stop: Arc<AtomicBool>,
    init_tx: Option<mpsc::SyncSender<Result<(), String>>>,
) -> Result<(), String> {
    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if initialized.is_err() {
        let error = format!("Could not initialize COM for system audio capture: {initialized:?}");
        if let Some(tx) = &init_tx {
            let _ = tx.send(Err(error.clone()));
        }
        return Err(error);
    }
    let _com = ComGuard;

    let setup = (|| -> windows::core::Result<(IAudioClient, IAudioCaptureClient, IMMDeviceEnumerator, String)> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole)? };
        let device_id = audio_endpoint_id(&device)?;
        let audio_client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None)? };
        let format = audio_wave_format();
        let flags = AUDCLNT_STREAMFLAGS_LOOPBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        unsafe {
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                flags,
                1_000_000,
                0,
                &format,
                None,
            )?;
        }
        let capture_client: IAudioCaptureClient = unsafe { audio_client.GetService()? };
        unsafe { audio_client.Start()? };
        Ok((audio_client, capture_client, enumerator, device_id))
    })();

    let (audio_client, capture_client, enumerator, device_id) = match setup {
        Ok(value) => value,
        Err(error) => {
            let message = format!("Could not start WASAPI loopback capture: {error}");
            if let Some(tx) = &init_tx {
                let _ = tx.send(Err(message.clone()));
            }
            return Err(message);
        }
    };
    emit(json!({"type":"audio-capture-started", "recovered":init_tx.is_none()}));
    if let Some(tx) = init_tx {
        let _ = tx.send(Ok(()));
    }

    let capture_result = (|| -> Result<(), String> {
        let mut overflow_reported = false;
        let mut previous_audio_timestamp = None;
        let mut next_device_check = Instant::now() + Duration::from_secs(1);
        while !stop.load(Ordering::Acquire) {
            if Instant::now() >= next_device_check {
                let current = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
                    .and_then(|device| audio_endpoint_id(&device))
                    .map_err(|error| format!("Could not check the audio output device: {error}"))?;
                if current != device_id {
                    return Err("The default audio output device changed".into());
                }
                next_device_check = Instant::now() + Duration::from_secs(1);
            }
            loop {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let packet_frames = unsafe { capture_client.GetNextPacketSize() }
                    .map_err(|error| format!("Could not query the WASAPI packet size: {error}"))?;
                if packet_frames == 0 {
                    break;
                }

                let mut data = std::ptr::null_mut();
                let mut frame_count = 0_u32;
                let mut flags = 0_u32;
                let mut device_position = 0u64;
                let mut timestamp = 0u64;
                unsafe {
                    capture_client
                        .GetBuffer(
                            &mut data,
                            &mut frame_count,
                            &mut flags,
                            Some(&mut device_position),
                            Some(&mut timestamp),
                        )
                        .map_err(|error| format!("Could not read a WASAPI packet: {error}"))?;
                }
                let byte_count = usize::try_from(frame_count)
                    .unwrap_or(usize::MAX)
                    .saturating_mul(usize::from(AUDIO_BLOCK_ALIGN));
                let packet = if byte_count == 0 {
                    Vec::new()
                } else if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
                    vec![0; byte_count]
                } else if data.is_null() && byte_count > 0 {
                    let _ = unsafe { capture_client.ReleaseBuffer(frame_count) };
                    return Err("WASAPI returned a null audio buffer".to_string());
                } else {
                    unsafe { slice::from_raw_parts(data, byte_count) }.to_vec()
                };
                unsafe {
                    capture_client
                        .ReleaseBuffer(frame_count)
                        .map_err(|error| format!("Could not release a WASAPI packet: {error}"))?;
                }
                if !packet.is_empty() {
                    if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0 {
                        // Device position remains useful when a QPC timestamp is unavailable.
                        timestamp = previous_audio_timestamp
                            .map(|(p, t): (u64, u64)| {
                                t.saturating_add(
                                    device_position.saturating_sub(p) * 10_000_000
                                        / u64::from(AUDIO_SAMPLE_RATE),
                                )
                            })
                            .unwrap_or_else(|| {
                                qpc_ticks()
                                    .saturating_sub(
                                        i64::from(frame_count) * 10_000_000
                                            / i64::from(AUDIO_SAMPLE_RATE),
                                    )
                                    .max(0) as u64
                            });
                    }
                    previous_audio_timestamp = Some((device_position, timestamp));
                    if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                        emit(
                            json!({"type":"audio-discontinuity", "devicePosition":device_position, "timestamp":timestamp}),
                        );
                    }
                    match audio_tx.try_send(AudioPacket {
                        bytes: packet,
                        timestamp: timestamp as i64,
                    }) {
                        Ok(()) => overflow_reported = false,
                        Err(mpsc::TrySendError::Full(_)) => {
                            if !overflow_reported {
                                overflow_reported = true;
                                emit(json!({
                                    "type": "audio-buffer-overflow",
                                    "error": "The bounded system-audio queue was full; an audio packet was dropped",
                                }));
                            }
                        }
                        Err(mpsc::TrySendError::Disconnected(_)) => return Ok(()),
                    }
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    })();

    let stop_result = unsafe { audio_client.Stop() };
    capture_result?;
    stop_result.map_err(|error| format!("Could not stop WASAPI loopback capture: {error}"))?;
    Ok(())
}

fn read_commands(tx: Sender<Command>) {
    for line in io::stdin().lock().lines() {
        match line {
            Ok(line) => match serde_json::from_str::<Command>(&line) {
                Ok(command) => {
                    if tx.send(command).is_err() {
                        return;
                    }
                }
                Err(error) => emit(json!({"type":"protocol-error", "error":error.to_string()})),
            },
            Err(_) => break,
        }
    }
    let _ = tx.send(Command::Shutdown);
}
struct Options {
    buffer_dir: PathBuf,
    pre_ms: u64,
    post_ms: u64,
    segment_ms: u64,
    fps: u32,
    unlocked: bool,
    hdr_tone_map: bool,
}

fn parse_bool_arg(value: &std::ffi::OsStr) -> Result<bool, AnyError> {
    match value.to_string_lossy().trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        value => Err(format!("Invalid boolean value: {value}").into()),
    }
}

fn parse_options() -> Result<Options, AnyError> {
    let mut args = std::env::args_os().skip(1);
    let mut buffer_dir = None;
    let mut pre_ms = 10_000;
    let mut post_ms = 10_000;
    let mut segment_ms = 5_000;
    let mut fps = 30;
    let mut unlocked = false;
    let mut hdr_tone_map = false;
    while let Some(raw) = args.next() {
        let key = raw.to_string_lossy();
        let value = args
            .next()
            .ok_or_else(|| format!("Missing value for {key}"))?;
        match key.as_ref() {
            "--buffer-dir" => buffer_dir = Some(PathBuf::from(value)),
            "--pre-ms" => pre_ms = value.to_string_lossy().parse()?,
            "--post-ms" => post_ms = value.to_string_lossy().parse()?,
            "--segment-ms" => segment_ms = value.to_string_lossy().parse()?,
            "--fps" => {
                unlocked = value == "unlocked";
                if !unlocked {
                    fps = value.to_string_lossy().parse()?;
                }
            }
            "--hdr-tone-map" => hdr_tone_map = parse_bool_arg(&value)?,
            _ => return Err(format!("Unknown argument: {key}").into()),
        }
    }
    let buffer_dir = buffer_dir.ok_or("Missing --buffer-dir")?;
    Ok(Options {
        buffer_dir,
        pre_ms: pre_ms.clamp(1_000, 60_000),
        post_ms: post_ms.clamp(1_000, 60_000),
        segment_ms: segment_ms.clamp(1_000, 5_000),
        // Unlocked ignores this fixed-rate argument and queries the monitor.
        fps: fps.clamp(10, 60),
        unlocked,
        hdr_tone_map,
    })
}

/// Tries to start capture with border settings, with fallback to default if border is unsupported
fn try_capture_with_border_fallback<T>(
    monitor: T,
    cursor_capture_settings: CursorCaptureSettings,
    secondary_window_settings: SecondaryWindowSettings,
    minimum_update_interval_settings: MinimumUpdateIntervalSettings,
    dirty_region_settings: DirtyRegionSettings,
    color_format: ColorFormat,
    flags: CaptureFlags,
) -> Result<(), GraphicsCaptureApiError<AnyError>>
where
    T: TryInto<GraphicsCaptureItemType> + Clone,
{
    // Attempt 1: Without border (preferred)
    let mut borderless_flags = flags.clone();
    borderless_flags.border_mode = "without-border";
    borderless_flags.border_fallback = false;
    emit(json!({
        "type": "capture-border-attempt",
        "requested": "without-border",
        "captureBackend": if borderless_flags.hdr_tone_map { "hdr-to-sdr-gpu" } else { "sdr" },
    }));
    let settings = Settings::new(
        monitor.clone(),
        cursor_capture_settings,
        DrawBorderSettings::WithoutBorder,
        secondary_window_settings,
        minimum_update_interval_settings,
        dirty_region_settings,
        color_format,
        borderless_flags.clone(),
    );

    match Capture::start(settings) {
        Ok(()) => Ok(()),
        Err(err) => {
            // A runtime failure after the first encoded frame belongs to the
            // active session and must not start a second capture pipeline.
            if !borderless_flags.ready_signal.load(Ordering::Acquire) && is_border_unsupported(&err)
            {
                let err_str = err.to_string();
                emit(json!({
                    "type": "capture-border-fallback",
                    "error": &err_str,
                    "requested": "without-border",
                    "effective": "default",
                    "reason": "unsupported",
                    "captureBackend": if flags.hdr_tone_map { "hdr-to-sdr-gpu" } else { "sdr" },
                }));

                // Attempt 2: Use default border settings (fallback)
                let fallback_session_dir = flags.session_dir.join("border-default");
                if fallback_session_dir.exists() {
                    fs::remove_dir_all(&fallback_session_dir).map_err(|error| {
                        GraphicsCaptureApiError::NewHandlerError(Box::new(error) as AnyError)
                    })?;
                }
                fs::create_dir_all(&fallback_session_dir).map_err(|error| {
                    GraphicsCaptureApiError::NewHandlerError(Box::new(error) as AnyError)
                })?;
                let mut fallback_flags = flags;
                fallback_flags.session_dir = fallback_session_dir;
                fallback_flags.border_mode = "default";
                fallback_flags.border_fallback = true;
                let fallback_settings = Settings::new(
                    monitor,
                    cursor_capture_settings,
                    DrawBorderSettings::Default,
                    secondary_window_settings,
                    minimum_update_interval_settings,
                    dirty_region_settings,
                    color_format,
                    fallback_flags,
                );
                Capture::start(fallback_settings)
            } else {
                // If error is not about border, propagate it
                Err(err)
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn try_capture_with_rate_limit_fallback<T>(
    monitor: T,
    cursor_capture_settings: CursorCaptureSettings,
    secondary_window_settings: SecondaryWindowSettings,
    dirty_region_settings: DirtyRegionSettings,
    color_format: ColorFormat,
    mut flags: CaptureFlags,
) -> Result<(), GraphicsCaptureApiError<AnyError>>
where
    T: TryInto<GraphicsCaptureItemType> + Clone,
{
    let interval_nanos = if flags.unlocked {
        0
    } else {
        1_000_000_000_u64 / u64::from(flags.fps.max(1))
    };
    let interval = Duration::from_nanos(interval_nanos);
    flags.capture_interval_mode = if flags.unlocked { "unlocked" } else { "os" };
    flags.capture_interval_ms = interval.as_secs_f64() * 1_000.0;
    emit(json!({
        "type": "capture-rate-limit-attempt",
        "requested": flags.capture_interval_mode,
        "intervalMs": flags.capture_interval_ms,
        "fps": flags.fps,
    }));

    let result = try_capture_with_border_fallback(
        monitor.clone(),
        cursor_capture_settings,
        secondary_window_settings,
        MinimumUpdateIntervalSettings::Custom(interval),
        dirty_region_settings,
        color_format,
        flags.clone(),
    );
    if !flags.ready_signal.load(Ordering::Acquire)
        && result.as_ref().is_err_and(is_minimum_interval_unsupported)
    {
        emit(json!({
            "type": "capture-rate-limit-fallback",
            "requested": if flags.unlocked { "unlocked" } else { "os" },
            "effective": if flags.unlocked { "unlocked" } else { "callback" },
            "reason": "minimum-update-interval-unsupported",
            "intervalMs": flags.capture_interval_ms,
            "fps": flags.fps,
        }));
        let fallback_session_dir = flags.session_dir.join("rate-default");
        if fallback_session_dir.exists() {
            fs::remove_dir_all(&fallback_session_dir).map_err(|error| {
                GraphicsCaptureApiError::NewHandlerError(Box::new(error) as AnyError)
            })?;
        }
        fs::create_dir_all(&fallback_session_dir).map_err(|error| {
            GraphicsCaptureApiError::NewHandlerError(Box::new(error) as AnyError)
        })?;
        flags.session_dir = fallback_session_dir;
        flags.capture_interval_mode = if flags.unlocked {
            "unlocked"
        } else {
            "callback"
        };
        return try_capture_with_border_fallback(
            monitor,
            cursor_capture_settings,
            secondary_window_settings,
            MinimumUpdateIntervalSettings::Default,
            dirty_region_settings,
            color_format,
            flags,
        );
    }
    result
}

fn run() -> Result<(), AnyError> {
    let options = parse_options()?;
    fs::create_dir_all(&options.buffer_dir)?;
    let session_dir = options
        .buffer_dir
        .join(format!("session-{}", std::process::id()));
    if session_dir.exists() {
        fs::remove_dir_all(&session_dir)?;
    }
    fs::create_dir_all(&session_dir)?;

    let monitor = Monitor::primary()?;
    let width = monitor.width()?;
    let height = monitor.height()?;
    let frame_rate = encoding_frame_rate(&monitor, options.fps, options.unlocked);
    let (command_tx, command_rx) = mpsc::channel();
    thread::spawn(move || read_commands(command_tx));
    let command_rx = Arc::new(Mutex::new(command_rx));
    let ready_signal = Arc::new(AtomicBool::new(false));
    let runtime_error = Arc::new(Mutex::new(None));

    let color_format = if options.hdr_tone_map {
        ColorFormat::Rgba16F
    } else {
        ColorFormat::Bgra8
    };

    let flags = CaptureFlags {
        command_rx: Arc::clone(&command_rx),
        session_dir: session_dir.clone(),
        pre_ms: options.pre_ms,
        post_ms: options.post_ms,
        segment_ms: options.segment_ms,
        fps: frame_rate.ceil_fps(),
        frame_rate,
        unlocked: options.unlocked,
        monitor_device_name: monitor.device_name()?,
        width,
        height,
        hdr_tone_map: options.hdr_tone_map,
        border_mode: "without-border",
        border_fallback: false,
        capture_interval_mode: "callback",
        capture_interval_ms: if options.unlocked {
            0.0
        } else {
            1_000.0 / f64::from(options.fps.max(1))
        },
        ready_signal: Arc::clone(&ready_signal),
        runtime_error: runtime_error.clone(),
    };

    let mut capture_result = try_capture_with_rate_limit_fallback(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        SecondaryWindowSettings::Default,
        DirtyRegionSettings::Default,
        color_format,
        flags,
    );

    // If HDR tone-mapping failed and capture hasn't started, fallback to SDR
    if options.hdr_tone_map
        && capture_result.as_ref().is_err_and(should_retry_sdr)
        && !ready_signal.load(Ordering::Acquire)
    {
        emit(json!({
            "type": "hdr-tone-map-fallback",
            "error": capture_result.as_ref().err().map(ToString::to_string),
            "fallback": "sdr",
            "reason": "hdr-capture-failed-before-ready",
        }));
        let fallback_monitor = Monitor::primary()?;
        let fallback_width = fallback_monitor.width()?;
        let fallback_height = fallback_monitor.height()?;
        let fallback_frame_rate =
            encoding_frame_rate(&fallback_monitor, options.fps, options.unlocked);
        ready_signal.store(false, Ordering::Release);
        *runtime_error.lock().unwrap() = None;
        let fallback_session_dir = session_dir.join("sdr-fallback");
        if fallback_session_dir.exists() {
            fs::remove_dir_all(&fallback_session_dir)?;
        }
        fs::create_dir_all(&fallback_session_dir)?;

        let fallback_flags = CaptureFlags {
            command_rx,
            session_dir: fallback_session_dir,
            pre_ms: options.pre_ms,
            post_ms: options.post_ms,
            segment_ms: options.segment_ms,
            fps: fallback_frame_rate.ceil_fps(),
            frame_rate: fallback_frame_rate,
            unlocked: options.unlocked,
            monitor_device_name: fallback_monitor.device_name()?,
            width: fallback_width,
            height: fallback_height,
            hdr_tone_map: false,
            border_mode: "without-border",
            border_fallback: false,
            capture_interval_mode: "callback",
            capture_interval_ms: if options.unlocked {
                0.0
            } else {
                1_000.0 / f64::from(options.fps.max(1))
            },
            ready_signal,
            runtime_error: runtime_error.clone(),
        };

        capture_result = try_capture_with_rate_limit_fallback(
            fallback_monitor,
            CursorCaptureSettings::WithoutCursor,
            SecondaryWindowSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            fallback_flags,
        );
    }

    let _ = fs::remove_dir_all(&session_dir);
    capture_result?;
    if let Some(error) = runtime_error.lock().unwrap().take() {
        return Err(if error.unsupported {
            Box::new(UnsupportedRecorderProfile(error.message)) as AnyError
        } else {
            error.message.into()
        });
    }
    emit(json!({ "type": "stopped" }));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        let unsupported = error.is::<UnsupportedRecorderProfile>();
        emit(
            json!({"type":"fatal", "error":error.to_string(), "retryable":!unsupported,
            "errorCode":if unsupported {"recorder-unsupported-profile"} else {"recorder-fatal"}}),
        );
        std::process::exit(if unsupported { 2 } else { 1 });
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_recovery_retries_with_bounded_backoff_then_resumes() {
        let stop = AtomicBool::new(false);
        let mut calls = 0;
        let mut retries = Vec::new();
        supervise_audio_recovery(
            &stop,
            || {
                calls += 1;
                if calls < 6 {
                    Err("device unavailable".into())
                } else {
                    Ok(())
                }
            },
            |attempt, delay, _| {
                retries.push((attempt, delay.as_secs()));
                true
            },
        );
        assert_eq!(calls, 6);
        assert_eq!(retries, vec![(1, 1), (2, 2), (3, 5), (4, 5), (5, 5)]);
    }
    #[test]
    fn stopping_during_audio_retry_does_not_open_another_device() {
        let stop = AtomicBool::new(false);
        let mut calls = 0;
        supervise_audio_recovery(
            &stop,
            || {
                calls += 1;
                Err("device lost".into())
            },
            |_, _, _| {
                stop.store(true, Ordering::Release);
                true
            },
        );
        assert_eq!(calls, 1);
        assert!(!wait_for_audio_retry(&stop, Duration::from_secs(5)));
    }
    #[test]
    fn fractional_frame_rates_compare_by_value() {
        assert_eq!(
            FrameRate {
                numerator: 60000,
                denominator: 1000
            },
            FrameRate::fixed(60)
        );
    }
    #[test]
    fn encoding_dimensions_are_even() {
        assert_eq!(even_dimension(1919), 1920);
        assert_eq!(even_dimension(1080), 1080);
    }
    #[test]
    fn wasapi_format_matches_encoder() {
        let f = audio_wave_format();
        let sample_rate = f.nSamplesPerSec;
        assert_eq!(sample_rate, 48000);
        let align = f.nBlockAlign;
        assert_eq!(align, 4);
    }
    #[test]
    fn qpc_has_the_same_units_as_wasapi_and_wgc() {
        let a = qpc_ticks();
        std::thread::sleep(Duration::from_millis(10));
        let b = qpc_ticks();
        assert!(b - a >= 50_000 && b - a < 10_000_000);
    }
}
