use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::slice;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use windows::Foundation::TimeSpan;
use windows::Media::Editing::{MediaClip, MediaComposition};
use windows::Media::Transcoding::TranscodeFailureReason;
use windows::Storage::StorageFile;
use windows::Win32::Foundation::S_FALSE;
use windows::Win32::Media::Audio::{
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, IAudioCaptureClient,
    IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, WAVE_FORMAT_PCM, WAVEFORMATEX, eConsole,
    eRender,
};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::core::HSTRING;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

mod tone_mapper;
use tone_mapper::ToneMapper;

type AnyError = Box<dyn Error + Send + Sync>;
const TICKS_PER_MILLISECOND: i64 = 10_000;
const AUDIO_SAMPLE_RATE: u32 = 48_000;
const AUDIO_CHANNELS: u16 = 2;
const AUDIO_BITS_PER_SAMPLE: u16 = 16;
const AUDIO_BLOCK_ALIGN: u16 = AUDIO_CHANNELS * (AUDIO_BITS_PER_SAMPLE / 8);
const AUDIO_BITRATE: u32 = 192_000;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Command {
    Trigger {
        id: String,
        #[serde(rename = "outputPath")]
        output_path: String,
    },
    Shutdown,
}

#[derive(Clone)]
struct CaptureFlags {
    command_rx: Arc<Mutex<Receiver<Command>>>,
    session_dir: PathBuf,
    pre_ms: u64,
    post_ms: u64,
    segment_ms: u64,
    fps: u32,
    width: u32,
    height: u32,
    hdr_tone_map: bool,
    ready_signal: Arc<AtomicBool>,
}

struct ActiveSegment {
    encoder: VideoEncoder,
    path: PathBuf,
    start_ms: u64,
    frames: u64,
}

struct PreparedSegment {
    encoder: VideoEncoder,
    path: PathBuf,
    audio_enabled: bool,
}

struct AudioLoopback {
    receiver: Receiver<Vec<u8>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

#[derive(Clone, Debug)]
struct Segment {
    path: PathBuf,
    start_ms: u64,
    end_ms: u64,
}

struct PendingJob {
    id: String,
    output_path: PathBuf,
    event_ms: u64,
    due_ms: u64,
    boundary_requested: bool,
}

struct RenderResult {
    segment_paths: Vec<PathBuf>,
}

struct PrepareResult {
    segment: Result<PreparedSegment, String>,
    prepare_ms: u64,
}

struct FinalizeResult {
    path: PathBuf,
    start_ms: u64,
    end_ms: u64,
    frames: u64,
    finalize_ms: u64,
    result: Result<(), String>,
}

#[derive(Clone, Debug)]
struct FailedSegment {
    start_ms: u64,
    end_ms: u64,
    error: String,
}

struct Capture {
    flags: CaptureFlags,
    started_at: Instant,
    active: Option<ActiveSegment>,
    prepared: Option<PreparedSegment>,
    preparing: bool,
    compatibility_mode: bool,
    prepare_failures: u32,
    prepare_retry_after_ms: u64,
    segments: VecDeque<Segment>,
    failed_segments: VecDeque<FailedSegment>,
    pending_jobs: Vec<PendingJob>,
    in_use: HashMap<PathBuf, usize>,
    next_segment_id: u64,
    last_frame_ms: Option<u64>,
    last_capture_timestamp: Option<i64>,
    captured_frames: u64,
    encoded_frames: u64,
    estimated_dropped_frames: u64,
    rate_limited_frames: u64,
    max_frame_gap_ms: f64,
    last_stats_ms: u64,
    rotation_count: u64,
    rotation_delay_reported: bool,
    prepare_tx: Sender<PrepareResult>,
    prepare_rx: Receiver<PrepareResult>,
    finalize_tx: Sender<FinalizeResult>,
    finalize_rx: Receiver<FinalizeResult>,
    finalizing: usize,
    finalizing_ranges: Vec<(u64, u64)>,
    worker_handles: Vec<thread::JoinHandle<()>>,
    render_tx: Sender<RenderResult>,
    render_rx: Receiver<RenderResult>,
    audio: Option<AudioLoopback>,
    tone_mapper: Option<ToneMapper>,
    shutdown_requested: bool,
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

fn recorder_bitrate(width: u32, height: u32, fps: u32) -> u32 {
    let pixels = u64::from(width) * u64::from(height);
    let scaled = 8_000_000_u64.saturating_mul(pixels) / 2_073_600;
    let base_30_fps = scaled.clamp(5_000_000, 20_000_000);
    if fps >= 60 {
        base_30_fps
            .saturating_mul(7)
            .saturating_div(4)
            .clamp(8_000_000, 35_000_000) as u32
    } else {
        base_30_fps as u32
    }
}

fn estimate_missing_frames(delta_ticks: i64, fps: u32) -> u64 {
    let expected = 10_000_000_i64 / i64::from(fps.max(1));
    if expected <= 0 || delta_ticks <= expected.saturating_mul(3) / 2 {
        return 0;
    }
    (delta_ticks / expected).saturating_sub(1).max(0) as u64
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
                let result = run_audio_loopback(audio_tx, Arc::clone(&worker_stop), init_tx);
                if let Err(error) = result {
                    emit(json!({
                        "type": "audio-capture-failed",
                        "error": error,
                    }));
                }
            })
            .map_err(|error| error.to_string())?;

        match init_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(Self {
                receiver: audio_rx,
                stop,
                worker: Some(worker),
            }),
            Ok(Err(error)) => {
                stop.store(true, Ordering::Release);
                let _ = worker.join();
                Err(error)
            }
            Err(error) => {
                stop.store(true, Ordering::Release);
                let _ = worker.join();
                Err(format!(
                    "Timed out while initializing system audio capture: {error}"
                ))
            }
        }
    }

    fn stop_and_join(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for AudioLoopback {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}

fn run_audio_loopback(
    audio_tx: mpsc::SyncSender<Vec<u8>>,
    stop: Arc<AtomicBool>,
    init_tx: mpsc::SyncSender<Result<(), String>>,
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
        let _ = init_tx.send(Err(error.clone()));
        return Err(error);
    }
    let _com = ComGuard;

    let setup = (|| -> windows::core::Result<(IAudioClient, IAudioCaptureClient)> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole)? };
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
        Ok((audio_client, capture_client))
    })();

    let (audio_client, capture_client) = match setup {
        Ok(value) => value,
        Err(error) => {
            let message = format!("Could not start WASAPI loopback capture: {error}");
            let _ = init_tx.send(Err(message.clone()));
            return Err(message);
        }
    };
    if init_tx.send(Ok(())).is_err() {
        let _ = unsafe { audio_client.Stop() };
        return Ok(());
    }

    let capture_result = (|| -> Result<(), String> {
        let mut overflow_reported = false;
        while !stop.load(Ordering::Acquire) {
            loop {
                let packet_frames = unsafe { capture_client.GetNextPacketSize() }
                    .map_err(|error| format!("Could not query the WASAPI packet size: {error}"))?;
                if packet_frames == 0 {
                    break;
                }

                let mut data = std::ptr::null_mut();
                let mut frame_count = 0_u32;
                let mut flags = 0_u32;
                unsafe {
                    capture_client
                        .GetBuffer(&mut data, &mut frame_count, &mut flags, None, None)
                        .map_err(|error| format!("Could not read a WASAPI packet: {error}"))?;
                }
                let byte_count = usize::try_from(frame_count)
                    .unwrap_or(usize::MAX)
                    .saturating_mul(usize::from(AUDIO_BLOCK_ALIGN));
                let packet = if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
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
                    match audio_tx.try_send(packet) {
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

fn create_segment_encoder(
    path: &Path,
    width: u32,
    height: u32,
    fps: u32,
    audio_enabled: bool,
) -> Result<VideoEncoder, AnyError> {
    Ok(VideoEncoder::new(
        VideoSettingsBuilder::new(even_dimension(width), even_dimension(height))
            .sub_type(VideoSettingsSubType::H264)
            .bitrate(recorder_bitrate(width, height, fps))
            .frame_rate(fps),
        AudioSettingsBuilder::new()
            .bitrate(AUDIO_BITRATE)
            .channel_count(u32::from(AUDIO_CHANNELS))
            .sample_rate(AUDIO_SAMPLE_RATE)
            .bit_per_sample(u32::from(AUDIO_BITS_PER_SAMPLE))
            .disabled(!audio_enabled),
        ContainerSettingsBuilder::default(),
        path,
    )?)
}

impl Capture {
    fn elapsed_ms(&self) -> u64 {
        self.started_at
            .elapsed()
            .as_millis()
            .min(u128::from(u64::MAX)) as u64
    }

    fn allocate_segment_path(&mut self) -> PathBuf {
        self.next_segment_id = self.next_segment_id.saturating_add(1);
        self.flags
            .session_dir
            .join(format!("segment-{:08}.mp4", self.next_segment_id))
    }

    fn request_prepared_segment(&mut self, now_ms: u64) {
        if self.shutdown_requested
            || self.compatibility_mode
            || self.preparing
            || self.prepared.is_some()
            || now_ms < self.prepare_retry_after_ms
        {
            return;
        }
        let path = self.allocate_segment_path();
        let width = self.flags.width;
        let height = self.flags.height;
        let fps = self.flags.fps;
        let audio_enabled = self.audio.is_some();
        let tx = self.prepare_tx.clone();
        self.preparing = true;
        self.worker_handles.push(thread::spawn(move || {
            let started = Instant::now();
            let segment = create_segment_encoder(&path, width, height, fps, audio_enabled)
                .map(|encoder| PreparedSegment {
                    encoder,
                    path,
                    audio_enabled,
                })
                .map_err(|error| error.to_string());
            let prepare_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            let _ = tx.send(PrepareResult {
                segment,
                prepare_ms,
            });
        }));
    }

    fn drain_audio(&mut self) -> Result<bool, AnyError> {
        let Some(audio) = self.audio.as_ref() else {
            return Ok(true);
        };
        loop {
            match audio.receiver.try_recv() {
                Ok(packet) => {
                    if let Some(active) = self.active.as_mut() {
                        active.encoder.send_audio_buffer(&packet, 0)?;
                    }
                }
                Err(mpsc::TryRecvError::Empty) => return Ok(true),
                Err(mpsc::TryRecvError::Disconnected) => return Ok(false),
            }
        }
    }

    fn stop_audio(&mut self) -> Result<(), AnyError> {
        if let Some(audio) = self.audio.as_mut() {
            audio.stop_and_join();
        }
        let _ = self.drain_audio()?;
        self.audio = None;
        Ok(())
    }

    fn handle_audio_failure(&mut self, now_ms: u64) -> Result<(), AnyError> {
        emit(json!({
            "type": "audio-capture-disabled",
            "reason": "WASAPI loopback stream ended; continuing with video only",
        }));
        self.stop_audio()?;
        if let Some(prepared) = self.prepared.take() {
            let path = prepared.path.clone();
            self.worker_handles.push(thread::spawn(move || {
                let _ = prepared.encoder.finish();
                let _ = fs::remove_file(path);
            }));
        }
        self.prepare_retry_after_ms = now_ms;
        self.request_prepared_segment(now_ms);
        Ok(())
    }

    fn spawn_finalize(&mut self, active: ActiveSegment, end_ms: u64) {
        let tx = self.finalize_tx.clone();
        self.finalizing = self.finalizing.saturating_add(1);
        self.finalizing_ranges.push((active.start_ms, end_ms));
        self.worker_handles.push(thread::spawn(move || {
            let ActiveSegment {
                encoder,
                path,
                start_ms,
                frames,
            } = active;
            let started = Instant::now();
            let result = encoder.finish().map_err(|error| error.to_string());
            let finalize_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
            let _ = tx.send(FinalizeResult {
                path,
                start_ms,
                end_ms,
                frames,
                finalize_ms,
                result,
            });
        }));
    }

    fn rotate_active(&mut self, now_ms: u64) -> Result<bool, AnyError> {
        let Some(prepared) = self.prepared.take() else {
            if self.compatibility_mode || (!self.preparing && self.prepare_failures >= 3) {
                if !self.compatibility_mode {
                    self.compatibility_mode = true;
                    emit(json!({
                        "type": "pipeline-compatibility-fallback",
                        "atMs": now_ms,
                        "prepareFailures": self.prepare_failures,
                        "reason": "parallel-encoder-unavailable",
                    }));
                }
                self.finish_active_blocking(now_ms)?;
                let path = self.allocate_segment_path();
                let encoder = create_segment_encoder(
                    &path,
                    self.flags.width,
                    self.flags.height,
                    self.flags.fps,
                    self.audio.is_some(),
                )?;
                self.active = Some(ActiveSegment {
                    encoder,
                    path,
                    start_ms: now_ms,
                    frames: 0,
                });
                self.rotation_count = self.rotation_count.saturating_add(1);
                self.rotation_delay_reported = false;
                return Ok(true);
            }
            if !self.rotation_delay_reported {
                self.rotation_delay_reported = true;
                emit(json!({
                    "type": "segment-rotation-delayed",
                    "atMs": now_ms,
                    "reason": if self.preparing { "encoder-preparing" } else { "encoder-unavailable" },
                }));
            }
            self.request_prepared_segment(now_ms);
            return Ok(false);
        };
        if prepared.audio_enabled != self.audio.is_some() {
            let path = prepared.path.clone();
            self.worker_handles.push(thread::spawn(move || {
                let _ = prepared.encoder.finish();
                let _ = fs::remove_file(path);
            }));
            self.request_prepared_segment(now_ms);
            return Ok(false);
        }
        let next = ActiveSegment {
            encoder: prepared.encoder,
            path: prepared.path,
            start_ms: now_ms,
            frames: 0,
        };
        if let Some(previous) = self.active.replace(next) {
            self.spawn_finalize(previous, now_ms);
        }
        self.rotation_count = self.rotation_count.saturating_add(1);
        self.rotation_delay_reported = false;
        self.request_prepared_segment(now_ms);
        Ok(true)
    }

    fn finish_active_blocking(&mut self, now_ms: u64) -> Result<(), AnyError> {
        let Some(active) = self.active.take() else {
            return Ok(());
        };
        let ActiveSegment {
            encoder,
            path,
            start_ms,
            frames,
        } = active;
        encoder.finish()?;
        if frames > 0 && now_ms > start_ms && path.exists() {
            let segment = Segment {
                path,
                start_ms,
                end_ms: now_ms,
            };
            let insert_at = self
                .segments
                .iter()
                .position(|existing| existing.start_ms > segment.start_ms)
                .unwrap_or(self.segments.len());
            self.segments.insert(insert_at, segment);
        } else {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }

    fn shutdown_pipeline(&mut self, now_ms: u64) -> Result<(), AnyError> {
        self.stop_audio()?;
        self.finish_active_blocking(now_ms)?;
        while let Some(handle) = self.worker_handles.pop() {
            let _ = handle.join();
        }
        self.process_pipeline_results(now_ms);
        if let Some(prepared) = self.prepared.take() {
            let path = prepared.path.clone();
            let _ = prepared.encoder.finish();
            let _ = fs::remove_file(path);
        }
        self.process_render_results();
        Ok(())
    }

    fn process_commands(&mut self) {
        loop {
            let command = {
                let Ok(receiver) = self.flags.command_rx.lock() else {
                    self.shutdown_requested = true;
                    return;
                };
                receiver.try_recv()
            };
            match command {
                Ok(Command::Trigger { id, output_path }) => {
                    let event_ms = self.elapsed_ms();
                    let output_path = PathBuf::from(output_path);
                    self.pending_jobs.push(PendingJob {
                        id: id.clone(),
                        output_path: output_path.clone(),
                        event_ms,
                        due_ms: event_ms.saturating_add(self.flags.post_ms),
                        boundary_requested: false,
                    });
                    emit(json!({
                        "type": "triggered",
                        "id": id,
                        "outputPath": output_path,
                        "eventMs": event_ms,
                        "availablePreMs": event_ms.min(self.flags.pre_ms),
                    }));
                }
                Ok(Command::Shutdown) => {
                    self.shutdown_requested = true;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    self.shutdown_requested = true;
                    break;
                }
            }
        }
    }

    fn reap_worker_handles(&mut self) {
        let mut index = 0;
        while index < self.worker_handles.len() {
            if self.worker_handles[index].is_finished() {
                let handle = self.worker_handles.swap_remove(index);
                let _ = handle.join();
            } else {
                index += 1;
            }
        }
    }

    fn process_pipeline_results(&mut self, now_ms: u64) {
        while let Ok(result) = self.prepare_rx.try_recv() {
            self.preparing = false;
            match result.segment {
                Ok(segment) if segment.audio_enabled == self.audio.is_some() => {
                    emit(json!({
                        "type": "segment-prepared",
                        "prepareMs": result.prepare_ms,
                        "path": segment.path,
                    }));
                    self.prepared = Some(segment);
                    self.prepare_failures = 0;
                    self.prepare_retry_after_ms = 0;
                }
                Ok(segment) => {
                    let path = segment.path.clone();
                    self.worker_handles.push(thread::spawn(move || {
                        let _ = segment.encoder.finish();
                        let _ = fs::remove_file(path);
                    }));
                    self.prepare_retry_after_ms = now_ms;
                }
                Err(error) => {
                    self.prepare_failures = self.prepare_failures.saturating_add(1);
                    emit(json!({
                        "type": "segment-prepare-failed",
                        "error": error,
                        "retryMs": 1_000,
                    }));
                    self.prepare_retry_after_ms = now_ms.saturating_add(1_000);
                }
            }
        }

        while let Ok(result) = self.finalize_rx.try_recv() {
            self.finalizing = self.finalizing.saturating_sub(1);
            if let Some(index) = self
                .finalizing_ranges
                .iter()
                .position(|range| *range == (result.start_ms, result.end_ms))
            {
                self.finalizing_ranges.swap_remove(index);
            }
            match result.result {
                Ok(())
                    if result.frames > 0
                        && result.end_ms > result.start_ms
                        && result.path.exists() =>
                {
                    let segment = Segment {
                        path: result.path.clone(),
                        start_ms: result.start_ms,
                        end_ms: result.end_ms,
                    };
                    let insert_at = self
                        .segments
                        .iter()
                        .position(|existing| existing.start_ms > segment.start_ms)
                        .unwrap_or(self.segments.len());
                    self.segments.insert(insert_at, segment);
                    emit(json!({
                        "type": "segment-finalized",
                        "path": result.path,
                        "startMs": result.start_ms,
                        "endMs": result.end_ms,
                        "frames": result.frames,
                        "finalizeMs": result.finalize_ms,
                        "pendingFinalizers": self.finalizing,
                    }));
                }
                Ok(()) => {
                    let _ = fs::remove_file(&result.path);
                }
                Err(error) => {
                    let _ = fs::remove_file(&result.path);
                    self.failed_segments.push_back(FailedSegment {
                        start_ms: result.start_ms,
                        end_ms: result.end_ms,
                        error: error.clone(),
                    });
                    emit(json!({
                        "type": "segment-finalize-failed",
                        "path": result.path,
                        "startMs": result.start_ms,
                        "endMs": result.end_ms,
                        "frames": result.frames,
                        "finalizeMs": result.finalize_ms,
                        "error": error,
                    }));
                }
            }
        }
        self.reap_worker_handles();
        self.request_prepared_segment(now_ms);
    }

    fn observe_capture_frame(&mut self, timestamp: i64) {
        self.captured_frames = self.captured_frames.saturating_add(1);
        if let Some(previous) = self.last_capture_timestamp {
            let delta = timestamp.saturating_sub(previous);
            if delta > 0 {
                let gap_ms = delta as f64 / 10_000.0;
                self.max_frame_gap_ms = self.max_frame_gap_ms.max(gap_ms);
                self.estimated_dropped_frames = self
                    .estimated_dropped_frames
                    .saturating_add(estimate_missing_frames(delta, self.flags.fps));
            }
        }
        self.last_capture_timestamp = Some(timestamp);
    }

    fn emit_capture_stats_if_due(&mut self, now_ms: u64) {
        if now_ms.saturating_sub(self.last_stats_ms) < 30_000 {
            return;
        }
        self.last_stats_ms = now_ms;
        emit(json!({
            "type": "capture-stats",
            "uptimeMs": now_ms,
            "capturedFrames": self.captured_frames,
            "encodedFrames": self.encoded_frames,
            "estimatedDroppedFrames": self.estimated_dropped_frames,
            "rateLimitedFrames": self.rate_limited_frames,
            "maxFrameGapMs": self.max_frame_gap_ms,
            "rotationCount": self.rotation_count,
            "segmentsReady": self.segments.len(),
            "finalizersActive": self.finalizing,
            "encoderPrepared": self.prepared.is_some(),
            "encoderPreparing": self.preparing,
            "pendingRecords": self.pending_jobs.len(),
        }));
    }

    fn process_render_results(&mut self) {
        while let Ok(result) = self.render_rx.try_recv() {
            for path in result.segment_paths {
                if let Some(count) = self.in_use.get_mut(&path) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        self.in_use.remove(&path);
                    }
                }
            }
        }
    }

    fn schedule_due_jobs(&mut self, now_ms: u64) {
        let mut index = 0;
        while index < self.pending_jobs.len() {
            if self.pending_jobs[index].due_ms > now_ms {
                index += 1;
                continue;
            }
            let target_start = self.pending_jobs[index]
                .event_ms
                .saturating_sub(self.flags.pre_ms);
            let target_end = self.pending_jobs[index].due_ms;
            if let Some(failed) = self
                .failed_segments
                .iter()
                .find(|failed| failed.end_ms > target_start && failed.start_ms < target_end)
            {
                let job = self.pending_jobs.remove(index);
                let _ = fs::remove_file(&job.output_path);
                emit(json!({
                    "type": "failed",
                    "id": job.id,
                    "outputPath": job.output_path,
                    "error": format!("A rolling video segment could not be finalized: {}", failed.error),
                }));
                continue;
            }
            let finalized_through = self
                .segments
                .iter()
                .map(|segment| segment.end_ms)
                .max()
                .unwrap_or(0);
            let overlapping_finalizer = self
                .finalizing_ranges
                .iter()
                .any(|(start_ms, end_ms)| *end_ms > target_start && *start_ms < target_end);
            if finalized_through < target_end || overlapping_finalizer {
                index += 1;
                continue;
            }
            let anchor = self.pending_jobs.remove(index);
            let mut jobs = vec![anchor];
            for candidate_index in (0..self.pending_jobs.len()).rev() {
                let candidate = &self.pending_jobs[candidate_index];
                if candidate.due_ms <= now_ms
                    && candidate.event_ms.abs_diff(jobs[0].event_ms) <= 500
                {
                    jobs.push(self.pending_jobs.remove(candidate_index));
                }
            }
            let target_start = jobs[0].event_ms.saturating_sub(self.flags.pre_ms);
            let target_end = jobs[0].due_ms;
            let selected = self
                .segments
                .iter()
                .filter(|segment| segment.end_ms > target_start && segment.start_ms < target_end)
                .cloned()
                .collect::<Vec<_>>();
            if selected.is_empty() {
                for job in jobs {
                    let _ = fs::remove_file(&job.output_path);
                    emit(json!({
                        "type": "failed",
                        "id": job.id,
                        "outputPath": job.output_path,
                        "error": "No captured segments were available for this achievement",
                    }));
                }
                continue;
            }
            let segment_paths = selected
                .iter()
                .map(|segment| segment.path.clone())
                .collect::<Vec<_>>();
            for path in &segment_paths {
                *self.in_use.entry(path.clone()).or_insert(0) += 1;
            }
            let tx = self.render_tx.clone();
            let handle = thread::spawn(move || {
                let primary_output = jobs[0].output_path.clone();
                let result = render_record(&selected, target_start, target_end, &primary_output)
                    .map_err(|error| error.to_string());
                match result {
                    Ok(()) => {
                        for (job_index, job) in jobs.into_iter().enumerate() {
                            let copy_result = if job_index == 0 {
                                Ok(())
                            } else {
                                fs::copy(&primary_output, &job.output_path).map(|_| ())
                            };
                            match copy_result {
                                Ok(()) => emit(json!({
                                    "type": "saved",
                                    "id": job.id,
                                    "outputPath": job.output_path,
                                })),
                                Err(error) => {
                                    let _ = fs::remove_file(&job.output_path);
                                    emit(json!({
                                        "type": "failed",
                                        "id": job.id,
                                        "outputPath": job.output_path,
                                        "error": error.to_string(),
                                    }));
                                }
                            }
                        }
                    }
                    Err(error) => {
                        for job in jobs {
                            let _ = fs::remove_file(&job.output_path);
                            emit(json!({
                                "type": "failed",
                                "id": job.id,
                                "outputPath": job.output_path,
                                "error": error,
                            }));
                        }
                    }
                }
                let _ = tx.send(RenderResult { segment_paths });
            });
            self.worker_handles.push(handle);
        }
    }

    fn cleanup_old_segments(&mut self, now_ms: u64) {
        let keep_ms = self.flags.pre_ms.saturating_add(self.flags.segment_ms * 3);
        let oldest_needed = self
            .pending_jobs
            .iter()
            .map(|job| job.event_ms.saturating_sub(self.flags.pre_ms))
            .min()
            .unwrap_or_else(|| now_ms.saturating_sub(keep_ms));
        while let Some(segment) = self.segments.front() {
            if segment.end_ms >= oldest_needed || self.in_use.contains_key(&segment.path) {
                break;
            }
            let segment = self
                .segments
                .pop_front()
                .expect("front segment disappeared");
            let _ = fs::remove_file(segment.path);
        }
        while self
            .failed_segments
            .front()
            .is_some_and(|failed| failed.end_ms < oldest_needed)
        {
            self.failed_segments.pop_front();
        }
    }
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = CaptureFlags;
    type Error = AnyError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (render_tx, render_rx) = mpsc::channel();
        let (prepare_tx, prepare_rx) = mpsc::channel();
        let (finalize_tx, finalize_rx) = mpsc::channel();
        let tone_mapper = if ctx.flags.hdr_tone_map {
            Some(ToneMapper::new(
                ctx.device.clone(),
                ctx.device_context.clone(),
                ctx.flags.width,
                ctx.flags.height,
                even_dimension(ctx.flags.width),
                even_dimension(ctx.flags.height),
            )?)
        } else {
            None
        };
        let (audio, audio_error) = match AudioLoopback::start() {
            Ok(audio) => (Some(audio), None),
            Err(error) => (None, Some(error)),
        };
        let ready_signal = Arc::clone(&ctx.flags.ready_signal);
        let first_path = ctx.flags.session_dir.join("segment-00000001.mp4");
        let first_encoder = create_segment_encoder(
            &first_path,
            ctx.flags.width,
            ctx.flags.height,
            ctx.flags.fps,
            audio.is_some(),
        )?;
        let mut capture = Self {
            flags: ctx.flags,
            started_at: Instant::now(),
            active: Some(ActiveSegment {
                encoder: first_encoder,
                path: first_path,
                start_ms: 0,
                frames: 0,
            }),
            prepared: None,
            preparing: false,
            compatibility_mode: false,
            prepare_failures: 0,
            prepare_retry_after_ms: 0,
            segments: VecDeque::new(),
            failed_segments: VecDeque::new(),
            pending_jobs: Vec::new(),
            in_use: HashMap::new(),
            next_segment_id: 1,
            last_frame_ms: None,
            last_capture_timestamp: None,
            captured_frames: 0,
            encoded_frames: 0,
            estimated_dropped_frames: 0,
            rate_limited_frames: 0,
            max_frame_gap_ms: 0.0,
            last_stats_ms: 0,
            rotation_count: 0,
            rotation_delay_reported: false,
            prepare_tx,
            prepare_rx,
            finalize_tx,
            finalize_rx,
            finalizing: 0,
            finalizing_ranges: Vec::new(),
            worker_handles: Vec::new(),
            render_tx,
            render_rx,
            audio,
            tone_mapper,
            shutdown_requested: false,
        };
        capture.request_prepared_segment(0);
        ready_signal.store(true, Ordering::Release);
        emit(json!({
            "type": "ready",
            "width": capture.flags.width,
            "height": capture.flags.height,
            "fps": capture.flags.fps,
            "preMs": capture.flags.pre_ms,
            "postMs": capture.flags.post_ms,
            "segmentMs": capture.flags.segment_ms,
            "audioEnabled": capture.audio.is_some(),
            "audioSampleRate": capture.audio.as_ref().map(|_| AUDIO_SAMPLE_RATE),
            "audioChannels": capture.audio.as_ref().map(|_| AUDIO_CHANNELS),
            "audioError": audio_error,
            "captureBackend": if capture.tone_mapper.is_some() { "hdr-to-sdr-gpu" } else { "sdr" },
            "hdrToneMapping": capture.tone_mapper.is_some(),
            "pipeline": "precreated-segments-async-finalize",
        }));
        Ok(capture)
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        let now_ms = self.elapsed_ms();
        self.process_pipeline_results(now_ms);
        self.process_render_results();
        self.process_commands();

        if self.shutdown_requested {
            self.shutdown_pipeline(now_ms)?;
            capture_control.stop();
            return Ok(());
        }

        if !self.drain_audio()? {
            self.handle_audio_failure(now_ms)?;
        }

        let frame_timestamp = frame.timestamp()?.Duration;
        self.observe_capture_frame(frame_timestamp);
        let frame_interval_ms = (1000_u64 / u64::from(self.flags.fps.max(1))).max(1);
        let should_send = self
            .last_frame_ms
            .is_none_or(|last| now_ms.saturating_sub(last) >= frame_interval_ms);
        if should_send {
            if let Some(active) = self.active.as_mut() {
                if let Some(tone_mapper) = self.tone_mapper.as_ref() {
                    let surface = tone_mapper.convert(frame)?;
                    active.encoder.send_surface(surface, frame_timestamp)?;
                } else {
                    active.encoder.send_frame(frame)?;
                }
                active.frames = active.frames.saturating_add(1);
                self.encoded_frames = self.encoded_frames.saturating_add(1);
            }
            self.last_frame_ms = Some(now_ms);
        } else {
            self.rate_limited_frames = self.rate_limited_frames.saturating_add(1);
        }

        let segment_due = self
            .active
            .as_ref()
            .is_some_and(|active| now_ms.saturating_sub(active.start_ms) >= self.flags.segment_ms);
        for job in &mut self.pending_jobs {
            if !job.boundary_requested
                && job.due_ms <= now_ms
                && self
                    .active
                    .as_ref()
                    .is_some_and(|active| active.start_ms >= job.due_ms)
            {
                job.boundary_requested = true;
            }
        }
        let record_due = self
            .pending_jobs
            .iter()
            .any(|job| job.due_ms <= now_ms && !job.boundary_requested);
        if segment_due || record_due {
            if !self.drain_audio()? {
                self.handle_audio_failure(now_ms)?;
            }
            if self.rotate_active(now_ms)? {
                for job in &mut self.pending_jobs {
                    if job.due_ms <= now_ms {
                        job.boundary_requested = true;
                    }
                }
            }
        }
        self.schedule_due_jobs(now_ms);
        self.cleanup_old_segments(now_ms);
        self.emit_capture_stats_if_due(now_ms);
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        let now_ms = self.elapsed_ms();
        self.shutdown_requested = true;
        self.shutdown_pipeline(now_ms)?;
        Ok(())
    }
}

fn render_record(
    segments: &[Segment],
    target_start_ms: u64,
    target_end_ms: u64,
    output_path: &Path,
) -> Result<(), AnyError> {
    struct WinRtGuard;
    impl Drop for WinRtGuard {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    if let Err(error) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
        && error.code() != S_FALSE
    {
        return Err(error.into());
    }
    let _winrt = WinRtGuard;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)?;
    }
    if !output_path.exists() {
        fs::File::create(output_path)?;
    }
    let composition = MediaComposition::new()?;
    let clips = composition.Clips()?;

    for segment in segments {
        let segment_path = HSTRING::from(segment.path.to_string_lossy().as_ref());
        let storage_file = StorageFile::GetFileFromPathAsync(&segment_path)?.join()?;
        let clip = MediaClip::CreateFromFileAsync(&storage_file)?.join()?;
        let duration_ticks = clip.OriginalDuration()?.Duration.max(0);
        let trim_start_ms = target_start_ms.saturating_sub(segment.start_ms);
        let trim_end_ms = segment.end_ms.saturating_sub(target_end_ms);
        let mut trim_start_ticks = i64::try_from(trim_start_ms)
            .unwrap_or(i64::MAX)
            .saturating_mul(TICKS_PER_MILLISECOND)
            .min(duration_ticks);
        let mut trim_end_ticks = i64::try_from(trim_end_ms)
            .unwrap_or(i64::MAX)
            .saturating_mul(TICKS_PER_MILLISECOND)
            .min(duration_ticks);
        if trim_start_ticks.saturating_add(trim_end_ticks) >= duration_ticks {
            if duration_ticks <= 1 {
                continue;
            }
            let overflow = trim_start_ticks
                .saturating_add(trim_end_ticks)
                .saturating_sub(duration_ticks - 1);
            if trim_end_ticks >= overflow {
                trim_end_ticks -= overflow;
            } else {
                trim_start_ticks = trim_start_ticks.saturating_sub(overflow - trim_end_ticks);
                trim_end_ticks = 0;
            }
        }
        if trim_start_ticks > 0 {
            clip.SetTrimTimeFromStart(TimeSpan {
                Duration: trim_start_ticks,
            })?;
        }
        if trim_end_ticks > 0 {
            clip.SetTrimTimeFromEnd(TimeSpan {
                Duration: trim_end_ticks,
            })?;
        }
        clips.Append(&clip)?;
    }

    if clips.Size()? == 0 {
        return Err("All captured segments were empty after trimming".into());
    }
    let destination_path = HSTRING::from(output_path.to_string_lossy().as_ref());
    let destination = StorageFile::GetFileFromPathAsync(&destination_path)?.join()?;
    let reason = composition.RenderToFileAsync(&destination)?.join()?;
    if reason != TranscodeFailureReason::None {
        return Err(format!("Windows MediaComposition failed: {reason:?}").into());
    }
    if fs::metadata(output_path)?.len() == 0 {
        return Err("Windows MediaComposition produced an empty MP4".into());
    }
    Ok(())
}

fn read_commands(tx: Sender<Command>) {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(trimmed) {
            Ok(command) => {
                let shutdown = matches!(command, Command::Shutdown);
                if tx.send(command).is_err() || shutdown {
                    break;
                }
            }
            Err(error) => emit(json!({
                "type": "protocol-error",
                "error": error.to_string(),
            })),
        }
    }
}

struct Options {
    buffer_dir: PathBuf,
    pre_ms: u64,
    post_ms: u64,
    segment_ms: u64,
    fps: u32,
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
    let mut segment_ms = 2_000;
    let mut fps = 30;
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
            "--fps" => fps = value.to_string_lossy().parse()?,
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
        fps: fps.clamp(10, 60),
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
) -> Result<(), AnyError>
where
    T: TryInto<GraphicsCaptureItemType> + Clone,
{
    // Attempt 1: Without border (preferred)
    let settings = Settings::new(
        monitor.clone(),
        cursor_capture_settings,
        DrawBorderSettings::WithoutBorder,
        secondary_window_settings,
        minimum_update_interval_settings,
        dirty_region_settings,
        color_format,
        flags.clone(),
    );

    match Capture::start(settings) {
        Ok(()) => {
            emit(json!({
                "type": "capture-border-mode",
                "mode": "without-border"
            }));
            Ok(())
        }
        Err(err) => {
            // Check if error is specifically about border settings not supported
            let err_str = err.to_string();
            if err_str.contains("border") || err_str.contains("BorderConfigUnsupported") {
                emit(json!({
                    "type": "capture-border-fallback",
                    "error": &err_str,
                    "fallback_to": "default"
                }));

                // Attempt 2: Use default border settings (fallback)
                let fallback_settings = Settings::new(
                    monitor,
                    cursor_capture_settings,
                    DrawBorderSettings::Default,
                    secondary_window_settings,
                    minimum_update_interval_settings,
                    dirty_region_settings,
                    color_format,
                    flags,
                );

                match Capture::start(fallback_settings) {
                    Ok(()) => {
                        emit(json!({
                            "type": "capture-border-mode",
                            "mode": "default"
                        }));
                        Ok(())
                    }
                    Err(fallback_err) => Err(Box::new(fallback_err)),
                }
            } else {
                // If error is not about border, propagate it
                Err(Box::new(err))
            }
        }
    }
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
    let (command_tx, command_rx) = mpsc::channel();
    thread::spawn(move || read_commands(command_tx));
    let command_rx = Arc::new(Mutex::new(command_rx));
    let ready_signal = Arc::new(AtomicBool::new(false));

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
        fps: options.fps,
        width,
        height,
        hdr_tone_map: options.hdr_tone_map,
        ready_signal: Arc::clone(&ready_signal),
    };

    let mut capture_result = try_capture_with_border_fallback(
        monitor,
        CursorCaptureSettings::WithoutCursor,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        color_format,
        flags,
    );

    // If HDR tone-mapping failed and capture hasn't started, fallback to SDR
    if options.hdr_tone_map && capture_result.is_err() && !ready_signal.load(Ordering::Acquire) {
        emit(json!({
            "type": "hdr-tone-map-fallback",
            "error": capture_result.as_ref().err().map(ToString::to_string),
            "fallback": "sdr",
        }));
        let fallback_monitor = Monitor::primary()?;
        let fallback_width = fallback_monitor.width()?;
        let fallback_height = fallback_monitor.height()?;
        ready_signal.store(false, Ordering::Release);

        let fallback_flags = CaptureFlags {
            command_rx,
            session_dir: session_dir.clone(),
            pre_ms: options.pre_ms,
            post_ms: options.post_ms,
            segment_ms: options.segment_ms,
            fps: options.fps,
            width: fallback_width,
            height: fallback_height,
            hdr_tone_map: false,
            ready_signal,
        };

        capture_result = try_capture_with_border_fallback(
            fallback_monitor,
            CursorCaptureSettings::WithoutCursor,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8,
            fallback_flags,
        );
    }

    let _ = fs::remove_dir_all(&session_dir);
    capture_result?;
    emit(json!({ "type": "stopped" }));
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        emit(json!({
            "type": "fatal",
            "error": error.to_string(),
        }));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_format_matches_encoder_input() {
        let format = audio_wave_format();
        let format_tag = format.wFormatTag;
        let channels = format.nChannels;
        let sample_rate = format.nSamplesPerSec;
        let average_bytes = format.nAvgBytesPerSec;
        let block_align = format.nBlockAlign;
        let bits_per_sample = format.wBitsPerSample;
        let extra_size = format.cbSize;
        assert_eq!(format_tag, WAVE_FORMAT_PCM as u16);
        assert_eq!(channels, AUDIO_CHANNELS);
        assert_eq!(sample_rate, AUDIO_SAMPLE_RATE);
        assert_eq!(
            average_bytes,
            AUDIO_SAMPLE_RATE * u32::from(AUDIO_BLOCK_ALIGN)
        );
        assert_eq!(block_align, AUDIO_BLOCK_ALIGN);
        assert_eq!(bits_per_sample, AUDIO_BITS_PER_SAMPLE);
        assert_eq!(extra_size, 0);
    }

    #[test]
    fn recorder_bitrate_scales_for_sixty_fps() {
        let bitrate_30 = recorder_bitrate(1920, 1080, 30);
        let bitrate_60 = recorder_bitrate(1920, 1080, 60);
        assert_eq!(bitrate_30, 8_000_000);
        assert_eq!(bitrate_60, 14_000_000);
    }

    #[test]
    fn encoder_dimensions_are_always_even() {
        assert_eq!(even_dimension(1920), 1920);
        assert_eq!(even_dimension(1919), 1920);
    }

    #[test]
    fn dropped_frame_estimate_uses_capture_timestamps() {
        assert_eq!(estimate_missing_frames(166_667, 60), 0);
        assert_eq!(estimate_missing_frames(333_334, 60), 1);
        assert_eq!(estimate_missing_frames(500_001, 60), 2);
        assert_eq!(estimate_missing_frames(666_667, 30), 1);
    }

    #[test]
    fn boolean_argument_accepts_supported_values() {
        assert!(parse_bool_arg(std::ffi::OsStr::new("true")).unwrap());
        assert!(!parse_bool_arg(std::ffi::OsStr::new("off")).unwrap());
        assert!(parse_bool_arg(std::ffi::OsStr::new("invalid")).is_err());
    }
}
