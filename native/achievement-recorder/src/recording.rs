use super::media_encoder::{self, GpuConverter, Packet, Transform};
use super::performance::{ResourceMonitor, lower_export_thread_priority};
use super::replay::{
    Buffer, CopyLossProgress, Job, OutputProgress, Pacer, PressureWindow, RateGovernor,
};
use super::tone_mapper::ToneMapper;
use super::{
    AnyError, AudioLoopback, CaptureFlags, Command, emit, even_dimension, ms_to_ticks, qpc_ticks,
    ticks_to_ms,
};
use serde_json::json;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LPARAM, WPARAM};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Threading::*;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
use windows::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
use windows::core::Interface;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::d3d11::SendDirectX;
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;

#[cfg(panic = "abort")]
compile_error!("The recorder requires panic=unwind to drain queued saves after a worker panic");

struct Image {
    texture: ID3D11Texture2D,
}
// These owned D3D11 resources are only written under gpu_lock. The callback
// never writes an Image while another owner (latest frame/encoder) retains it.
unsafe impl Send for Image {}
unsafe impl Sync for Image {}

#[derive(Default)]
struct Shared {
    latest: Mutex<Option<(Arc<Image>, i64)>>,
    gpu_lock: Mutex<()>,
    stop: AtomicBool,
    captured: AtomicU64,
    skipped: AtomicU64,
    gpu_busy_drops: AtomicU64,
    texture_pool_drops: AtomicU64,
    last_copy_loss: AtomicU64,
    interval: AtomicU64,
    last_copy: AtomicU64,
}

pub(crate) struct Capture {
    shared: Arc<Shared>,
    worker: Option<thread::JoinHandle<()>>,
    shutdown_requested: Arc<AtomicBool>,
    ready_signal: Arc<AtomicBool>,
    runtime_error: Arc<Mutex<Option<super::PipelineFailure>>>,
    pool: Vec<Arc<Image>>,
    mapper: Option<ToneMapper>,
    hdr: bool,
    source_size: (u32, u32),
    target_size: (u32, u32),
    device: ID3D11Device,
    context: ID3D11DeviceContext,
}

struct Clock;
impl Clock {
    fn start() -> Result<Self, AnyError> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                RoUninitialize();
                return Err(error.into());
            }
        }
        Ok(Self)
    }
}
impl Drop for Clock {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            RoUninitialize();
        }
    }
}

// A waitable high-resolution timer affects only this worker; no global timer
// resolution or game/process priority change is needed.
struct Timer(HANDLE);
impl Timer {
    fn new() -> Self {
        Self(unsafe {
            CreateWaitableTimerExW(
                None,
                None,
                CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                TIMER_ALL_ACCESS.0,
            )
            .unwrap_or_default()
        })
    }
    fn wait(&self, ticks: i64) {
        let ticks = ticks.clamp(1_000, 20_000);
        if !self.0.is_invalid() {
            let due = -ticks;
            if unsafe { SetWaitableTimer(self.0, &due, 0, None, None, false) }.is_ok() {
                unsafe {
                    WaitForSingleObject(self.0, INFINITE);
                }
                return;
            }
        }
        thread::sleep(Duration::from_micros((ticks / 10) as u64));
    }
}
impl Drop for Timer {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = CaptureFlags;
    type Error = AnyError;
    fn new(ctx: Context<Self::Flags>) -> Result<Self, AnyError> {
        *ctx.flags.runtime_error.lock().unwrap() = None;
        // Media Foundation may also access the supplied D3D device internally.
        // The application mutex alone cannot protect those driver threads.
        unsafe {
            let _ = ctx
                .device_context
                .cast::<ID3D11Multithread>()?
                .SetMultithreadProtected(true);
        }
        let shared = Arc::new(Shared::default());
        shared.interval.store(
            (10_000_000u64 * u64::from(ctx.flags.frame_rate.denominator)
                / u64::from(ctx.flags.frame_rate.numerator))
            .max(1),
            Ordering::Release,
        );
        let worker_shared = shared.clone();
        let thread_id = unsafe { GetCurrentThreadId() };
        let device = SendDirectX(ctx.device.clone());
        let context = SendDirectX(ctx.device_context.clone());
        let flags = ctx.flags.clone();
        let worker = thread::Builder::new()
            .name("achievement-recording".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run_pipeline(&flags, worker_shared.clone(), device.0, context.0)
                }))
                .unwrap_or_else(|_| Err("Recording worker panicked".into()));
                if let Err(error) = result {
                    *flags.runtime_error.lock().unwrap() = Some(super::PipelineFailure {
                        message: error.to_string(),
                        unsupported: error.is::<super::UnsupportedRecorderProfile>(),
                    });
                    emit(json!({"type":"pipeline-failed", "error":error.to_string()}));
                }
                worker_shared.stop.store(true, Ordering::Release);
                let _ = unsafe { PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) };
            })?;
        Ok(Self {
            shared,
            worker: Some(worker),
            shutdown_requested: Arc::clone(&ctx.flags.shutdown_requested),
            ready_signal: Arc::clone(&ctx.flags.ready_signal),
            runtime_error: Arc::clone(&ctx.flags.runtime_error),
            pool: Vec::new(),
            mapper: None,
            hdr: ctx.flags.hdr_tone_map,
            source_size: (0, 0),
            target_size: (
                even_dimension(ctx.flags.width),
                even_dimension(ctx.flags.height),
            ),
            device: ctx.device,
            context: ctx.device_context,
        })
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<(), AnyError> {
        if self.shared.stop.load(Ordering::Acquire) {
            control.stop();
            return Ok(());
        }
        self.shared.captured.fetch_add(1, Ordering::Relaxed);
        let timestamp = frame.timestamp()?.Duration;
        // Copy at most once per output period. Sampling and output timestamps
        // are still controlled by the independent pacer, including static scenes.
        let interval = self.shared.interval.load(Ordering::Acquire) as i64;
        let last = self.shared.last_copy.load(Ordering::Acquire) as i64;
        if timestamp - last < interval / 2 {
            self.shared.skipped.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        let Ok(_gpu) = self.shared.gpu_lock.try_lock() else {
            self.shared.gpu_busy_drops.fetch_add(1, Ordering::Relaxed);
            self.shared
                .last_copy_loss
                .store(timestamp as u64, Ordering::Release);
            return Ok(());
        };
        let size = (frame.width(), frame.height());
        if size != self.source_size {
            self.pool.clear();
            self.mapper = if self.hdr {
                Some(ToneMapper::new(
                    self.device.clone(),
                    self.context.clone(),
                    size.0,
                    size.1,
                    self.target_size.0,
                    self.target_size.1,
                )?)
            } else {
                None
            };
            self.source_size = size;
        }
        let output_size = if self.hdr { self.target_size } else { size };
        let image = if let Some(i) = self.pool.iter().position(|s| Arc::strong_count(s) == 1) {
            self.pool[i].clone()
        } else if self.pool.len() < 4 {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            unsafe {
                frame.as_raw_texture().GetDesc(&mut desc);
            }
            desc.Width = output_size.0;
            desc.Height = output_size.1;
            desc.Format = windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
            desc.BindFlags = (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32;
            desc.CPUAccessFlags = 0;
            desc.MiscFlags = 0;
            desc.Usage = D3D11_USAGE_DEFAULT;
            let mut texture = None;
            unsafe {
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut texture))?;
            }
            let image = Arc::new(Image {
                texture: texture.ok_or("No capture copy texture")?,
            });
            self.pool.push(image.clone());
            image
        } else {
            self.shared
                .texture_pool_drops
                .fetch_add(1, Ordering::Relaxed);
            self.shared
                .last_copy_loss
                .store(timestamp as u64, Ordering::Release);
            return Ok(());
        };
        if let Some(mapper) = &mut self.mapper {
            mapper.convert_into(frame, &image.texture)?;
        } else {
            unsafe {
                self.context
                    .CopyResource(&image.texture, frame.as_raw_texture());
            }
        }
        unsafe {
            self.context.Flush();
        }
        // Keep the pooled Arc as the lease, so strong_count guards all readers.
        let mut latest = self.shared.latest.lock().unwrap();
        *latest = Some((image.clone(), timestamp));
        self.shared
            .last_copy
            .store(timestamp as u64, Ordering::Release);
        Ok(())
    }
    fn on_closed(&mut self) -> Result<(), AnyError> {
        self.shared.stop.store(true, Ordering::Release);
        Ok(())
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            // Before ready no clips have been accepted. Bound failed startup
            // cleanup without shortening the drain window of an active session.
            let timeout = if self.ready_signal.load(Ordering::Acquire) {
                65
            } else {
                8
            };
            let deadline = Instant::now() + Duration::from_secs(timeout);
            while !worker.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(5));
            }
            if worker.is_finished() {
                let _ = worker.join();
            } else {
                // Never overlap a fallback with a worker which failed to stop.
                self.shutdown_requested.store(true, Ordering::Release);
                let message = "Native recorder did not drain before its deadline";
                *self.runtime_error.lock().unwrap() = Some(super::PipelineFailure {
                    message: message.into(),
                    unsupported: false,
                });
                emit(json!({"type":"pipeline-stop-timeout", "error":message,
                        "timeoutMs":timeout * 1000}));
            }
        }
    }
}

struct Save {
    job: Job,
    packets: Vec<Packet>,
    origin: i64,
    video: SendDirectX<IMFMediaType>,
    audio: Option<SendDirectX<IMFMediaType>>,
}

// Drain on every exit path, including an encoder/GPU error. Dropping an ordinary
// JoinHandle would detach the saver and let process exit interrupt its MP4.
struct SaveWorker {
    sender: Option<mpsc::SyncSender<Save>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl SaveWorker {
    fn start() -> Result<Self, AnyError> {
        let (tx, rx) = mpsc::sync_channel::<Save>(8);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("achievement-mp4-save".into())
            .spawn(move || save_worker(rx, started_tx))?;
        let saver = Self {
            sender: Some(tx),
            worker: Some(worker),
        };
        started_rx
            .recv_timeout(Duration::from_secs(5))?
            .map_err(|error| format!("Could not initialize MP4 saver: {error}"))?;
        Ok(saver)
    }
    fn close_and_wait(&mut self) -> Result<(), AnyError> {
        drop(self.sender.take());
        let Some(worker) = self.worker.take() else {
            return Ok(());
        };
        emit(json!({"type":"save-draining", "timeoutMs":60000}));
        let deadline = Instant::now() + Duration::from_secs(60);
        while !worker.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        if !worker.is_finished() {
            return Err("MP4 writer did not stop before its deadline".into());
        }
        worker
            .join()
            .map_err(|_| "MP4 writer thread panicked".into())
    }
}
impl Drop for SaveWorker {
    fn drop(&mut self) {
        if let Err(error) = self.close_and_wait() {
            emit(json!({"type":"save-drain-failed", "error":error.to_string()}));
        }
    }
}

fn save_worker(rx: Receiver<Save>, started: mpsc::SyncSender<Result<(), String>>) {
    save_worker_with(rx, started, |save| {
        media_encoder::save_mp4(
            &save.job.path,
            &save.video.0,
            save.audio.as_ref().map(|a| &a.0),
            &save.packets,
            save.origin,
        )
    });
}

fn save_worker_with(
    rx: Receiver<Save>,
    started: mpsc::SyncSender<Result<(), String>>,
    mut write: impl FnMut(&Save) -> Result<(), AnyError>,
) {
    // Own a separate MFStartup reference. An encoder error must not shut the
    // platform down while a previously queued clip is still being finalized.
    let _clock = match Clock::start() {
        Ok(clock) => clock,
        Err(error) => {
            let _ = started.send(Err(error.to_string()));
            return;
        }
    };
    if started.send(Ok(())).is_err() {
        return;
    }
    let _ = lower_export_thread_priority();
    let mut generation = 0u64;
    for save in rx {
        generation += 1;
        let started = Instant::now();
        emit(
            json!({"type":"render-started", "jobCount":1, "generation":generation,
            "timeoutMs":60000, "pipeline":"compressed-remux"}),
        );
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| write(&save)))
            .unwrap_or_else(|_| Err("MP4 muxer panicked".into()));
        match result {
            Ok(()) => emit(
                json!({"type":"saved", "id":save.job.id, "outputPath":save.job.path,
                "saveMs":started.elapsed().as_millis(), "reencoded":false,
                "actualPreMs":ticks_to_ms(save.job.event - save.origin)}),
            ),
            Err(e) => emit(
                json!({"type":"failed", "id":save.job.id, "outputPath":save.job.path, "error":e.to_string()}),
            ),
        }
        emit(
            json!({"type":"render-completed", "generation":generation, "renderMs":started.elapsed().as_millis()}),
        );
    }
}

fn fail(job: Job, error: &str) {
    emit(json!({"type":"failed", "id":job.id, "outputPath":job.path, "error":error}));
}

fn run_pipeline(
    flags: &CaptureFlags,
    shared: Arc<Shared>,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
) -> Result<(), AnyError> {
    if flags.shutdown_requested.load(Ordering::Acquire) || shared.stop.load(Ordering::Acquire) {
        return Ok(());
    }
    let _clock = Clock::start()?;
    let mut rate = flags.frame_rate;
    let width = even_dimension(flags.width);
    let height = even_dimension(flags.height);
    let mut allow_software = !flags.unlocked;
    let mut video = loop {
        match Transform::video(&device, width, height, rate, allow_software) {
            Ok(t) => break t,
            Err(e)
                if flags.unlocked
                    && rate.ceil_fps() > 30
                    && e.is::<super::UnsupportedRecorderProfile>() =>
            {
                let old = rate;
                rate.numerator = (rate.numerator / 2).max(30 * rate.denominator);
                emit(
                    json!({"type":"frame-rate-fallback", "requestedFps":old.ceil_fps(), "effectiveFps":rate.ceil_fps(), "error":e.to_string()}),
                );
            }
            Err(e)
                if flags.unlocked
                    && !allow_software
                    && e.is::<super::UnsupportedRecorderProfile>() =>
            {
                allow_software = true;
                emit(
                    json!({"type":"frame-rate-fallback", "requestedFps":flags.frame_rate.ceil_fps(),
                    "effectiveFps":rate.ceil_fps(), "reason":"hardware-encoder-unavailable", "error":e.to_string()}),
                );
            }
            Err(e) => return Err(e),
        }
    };
    let mut converter = {
        let _gpu = shared.gpu_lock.lock().unwrap();
        GpuConverter::new(device, context, width, height, rate)?
    };
    let (mut audio, mut audio_encoder, audio_error) =
        match (AudioLoopback::start(), Transform::audio()) {
            (Ok(a), Ok(t)) => (Some(a), Some(t), None),
            (a, t) => (
                None,
                None,
                Some(
                    a.err()
                        .or_else(|| t.err().map(|e| e.to_string()))
                        .unwrap_or_default(),
                ),
            ),
        };
    emit(
        json!({"type":"encoder-selected", "encoderBackend":"media-foundation", "encoderName":video.name,
        "hardwareAcceleration":video.hardware, "width":width, "height":height, "fps":rate.ceil_fps(),
        "inputFormat":"NV12", "monitor":flags.monitor_device_name, "pipeline":"continuous-encoded-replay"}),
    );
    let mut saver = SaveWorker::start()?;
    let mut jobs = VecDeque::new();
    let retention = ms_to_ticks(flags.pre_ms + flags.post_ms + 5000);
    // Compressed retention is bounded separately from the raw GPU texture pool.
    let mut buffer = Buffer::new(512 * 1024 * 1024);
    let timer = Timer::new();
    let mut origin = None;
    let mut pacer = None;
    let mut last_sent_image = None;
    let mut duplicate_frames = 0u64;
    let mut copy_loss_repeats = 0u64;
    let mut copy_loss_progress = CopyLossProgress::default();
    let mut missed_deadlines = 0u64;
    let mut pressure_drops = 0u64;
    let mut audio_end = 0i64;
    let mut last_prune = qpc_ticks();
    let mut last_keyframe = 0i64;
    let mut keyframe_warning_reported = false;
    let mut last_stats = qpc_ticks();
    let mut previous_output = 0u64;
    let mut previous_submitted = 0u64;
    let mut previous_drops = 0u64;
    let mut previous_missed = 0u64;
    let mut previous_copy_loss_repeats = 0u64;
    let mut governor = RateGovernor::default();
    let mut ready = false;
    let mut stopping_at = None;
    let mut audio_packets = VecDeque::new();
    let mut resources = ResourceMonitor::new();
    let mut output_progress = OutputProgress::new(qpc_ticks());
    let mut audio_output_progress = OutputProgress::new(qpc_ticks());
    loop {
        let now = qpc_ticks();
        if flags.shutdown_requested.load(Ordering::Acquire) {
            shared.stop.store(true, Ordering::Release);
        }
        // Always poll outputs before accepting more input. Encoders have a
        // finite number of GPU surfaces and async input credits.
        for p in video.poll()? {
            buffer.push(p)?;
        }
        if let Some(a) = audio_encoder.as_mut() {
            for p in a.poll()? {
                buffer.push(p)?;
            }
        }
        if !ready && video.produced > 0 {
            ready = true;
            flags.ready_signal.store(true, Ordering::Release);
            emit(
                json!({"type":"ready", "width":width, "height":height, "fps":rate.ceil_fps(),
                "frameRateMode":if flags.unlocked {"unlocked"} else {"fixed"},
                "frameRateNumerator":rate.numerator, "frameRateDenominator":rate.denominator,
                "preMs":flags.pre_ms, "postMs":flags.post_ms, "segmentMs":flags.segment_ms,
                "audioEnabled":audio.is_some(), "audioError":audio_error,
                "captureBackend":if flags.hdr_tone_map {"hdr-to-sdr-gpu"} else {"sdr"},
                "hdrToneMapping":flags.hdr_tone_map, "borderMode":flags.border_mode,
                "borderFallback":flags.border_fallback, "captureIntervalMode":flags.capture_interval_mode,
                "captureIntervalMs":flags.capture_interval_ms, "pipeline":"continuous-encoded-replay",
                "encoderBackend":"media-foundation", "encoderName":video.name,
                "hardwareAccelerationRequested":true, "hardwareAcceleration":video.hardware}),
            );
        }
        loop {
            let command = flags.command_rx.lock().unwrap().try_recv();
            match command {
                Ok(Command::Trigger {
                    id,
                    output_path,
                    event_at_unix_ms,
                }) => {
                    let unix_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let age = event_at_unix_ms
                        .filter(|t| *t <= unix_ms && unix_ms - *t <= 120_000)
                        .map(|t| unix_ms - t)
                        .unwrap_or(0);
                    let event = now.saturating_sub(ms_to_ticks(age));
                    let job = Job {
                        id: id.clone(),
                        path: PathBuf::from(output_path),
                        event,
                        end: event.saturating_add(ms_to_ticks(flags.post_ms)),
                    };
                    emit(json!({"type":"triggered", "id":id, "outputPath":job.path,
                        "eventMs":ticks_to_ms(event - origin.unwrap_or(event)),
                        "availablePreMs":ticks_to_ms(event - origin.unwrap_or(event)).min(flags.pre_ms), "triggerDelayMs":age}));
                    if jobs.len() < 32 {
                        jobs.push_back(job);
                    } else {
                        fail(job, "The bounded clip queue is full");
                    }
                }
                Ok(Command::Shutdown) | Err(mpsc::TryRecvError::Disconnected) => {
                    flags.shutdown_requested.store(true, Ordering::Release);
                    shared.stop.store(true, Ordering::Release);
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        if shared.stop.load(Ordering::Acquire) && stopping_at.is_none() {
            if let Some(a) = audio.as_mut() {
                a.stop_and_join();
            }
            let _ = video.drain();
            if let Some(a) = audio_encoder.as_ref() {
                let _ = a.drain();
            }
            stopping_at = Some(now);
        }
        if let Some(stop) = stopping_at {
            if video.oldest_pending().is_none() || now - stop > 20_000_000 {
                for job in &mut jobs {
                    job.end = job.end.min(buffer.latest_video_end().unwrap_or(now));
                }
            }
        } else {
            let image = shared.latest.lock().unwrap().clone();
            if let Some((image, image_timestamp)) = image {
                let first = *origin.get_or_insert(image_timestamp);
                let p = pacer.get_or_insert_with(|| Pacer::new(rate, first));
                if let Some((time, duration, missed)) = p.take(now) {
                    missed_deadlines += missed;
                    if video.ready()
                        && video.submitted - video.produced
                            < u64::from(rate.ceil_fps().div_ceil(8).clamp(3, 24))
                    {
                        let sample = {
                            let _gpu = shared.gpu_lock.lock().unwrap();
                            converter.sample(&image.texture, time, duration, video.hardware)?
                        };
                        if let Some(sample) = sample {
                            if time - last_keyframe >= 10_000_000 {
                                if let Err(error) = video.force_keyframe() {
                                    if !keyframe_warning_reported {
                                        emit(
                                            json!({"type":"keyframe-request-failed", "error":error.to_string(),
                                            "encoderName":video.name}),
                                        );
                                        keyframe_warning_reported = true;
                                    }
                                }
                                last_keyframe = time;
                            }
                            if video.submit(&sample)? {
                                let repeated = last_sent_image
                                    .as_ref()
                                    .is_some_and(|old| Arc::ptr_eq(old, &image));
                                if repeated {
                                    duplicate_frames += 1;
                                }
                                if copy_loss_progress.repeated_after_loss(
                                    repeated,
                                    image_timestamp,
                                    shared.last_copy_loss.load(Ordering::Acquire),
                                ) {
                                    copy_loss_repeats += 1;
                                }
                                last_sent_image = Some(image);
                            } else {
                                pressure_drops += 1;
                            }
                        } else {
                            pressure_drops += 1;
                        }
                    } else {
                        pressure_drops += 1;
                    }
                }
                // Audio packets keep the QPC timestamp supplied by WASAPI.
                // Missing packets create silence on the same timeline instead
                // of shortening audio and shifting all following sound.
                if let Some(a) = audio.as_mut() {
                    while let Ok(packet) = a.receiver.try_recv() {
                        if audio_packets.len() >= 512 {
                            audio_packets.pop_front();
                        }
                        audio_packets.push_back(packet);
                    }
                }
                if let Some(a) = audio_encoder.as_mut() {
                    if audio_end == 0 {
                        audio_end = first;
                    }
                    if audio_packets.is_empty() && now - audio_end > 500_000 {
                        let frames = (((now - 500_000 - audio_end) as i128 * 48_000 / 10_000_000)
                            as usize)
                            .min(4800);
                        if frames > 0 {
                            audio_packets.push_back(super::AudioPacket {
                                bytes: vec![0; frames * 4],
                                timestamp: audio_end,
                            });
                        }
                    }
                    for _ in 0..32 {
                        let Some(packet) = audio_packets.front() else {
                            break;
                        };
                        if !a.ready() {
                            break;
                        }
                        let mut start = packet.timestamp.max(first);
                        let skip = ((start - packet.timestamp).max(0) as i128 * 48_000 / 10_000_000)
                            as usize;
                        if skip * 4 >= packet.bytes.len() {
                            audio_packets.pop_front();
                            continue;
                        }
                        if audio_end == 0 {
                            audio_end = first;
                        }
                        if start - audio_end > 20_000 {
                            // >2ms: fill bounded chunks, never compress elapsed time
                            let frames = (((start - audio_end) as i128 * 48_000 / 10_000_000)
                                as usize)
                                .min(4800);
                            let duration = frames as i64 * 10_000_000 / 48_000;
                            let s = media_encoder::bytes_sample(
                                &vec![0; frames * 4],
                                audio_end,
                                duration,
                            )?;
                            if !a.submit(&s)? {
                                break;
                            }
                            audio_end += duration;
                            for p in a.poll()? {
                                buffer.push(p)?;
                            }
                            continue;
                        }
                        let trim = (((audio_end - start).max(0) as i128 * 48_000 / 10_000_000)
                            as usize)
                            + skip;
                        if trim * 4 >= packet.bytes.len() {
                            audio_packets.pop_front();
                            continue;
                        }
                        start = start.max(audio_end);
                        let bytes = &packet.bytes[trim * 4..];
                        let duration = (bytes.len() / 4) as i64 * 10_000_000 / 48_000;
                        let s = media_encoder::bytes_sample(bytes, start, duration)?;
                        if !a.submit(&s)? {
                            break;
                        }
                        audio_end = start + duration;
                        audio_packets.pop_front();
                        for p in a.poll()? {
                            buffer.push(p)?;
                        }
                    }
                }
            }
        }
        // Silence and audio-device reconnects still feed PCM on this timeline.
        // Only pending encoder work without output is a stall, not a quiet game.
        let audio_stalled = audio_encoder.as_ref().is_some_and(|a| {
            audio_output_progress.stalled(
                now,
                a.produced,
                stopping_at.is_none()
                    && origin.is_some()
                    && (a.oldest_pending().is_some() || !audio_packets.is_empty()),
            )
        });
        if audio_stalled {
            emit(
                json!({"type":"audio-encoder-stalled", "error":"AAC encoder stopped producing audio samples",
                "submittedFrames":audio_encoder.as_ref().map(|a| a.submitted),
                "encodedFrames":audio_encoder.as_ref().map(|a| a.produced)}),
            );
            // Use the existing bounded helper restart instead of mixing a new
            // AAC stream into retained clips. SaveWorker drains completed jobs.
            return Err("The selected AAC encoder stopped producing audio samples".into());
        }
        let video_end = buffer.latest_video_end().unwrap_or(0);
        while jobs.front().is_some_and(|j| {
            video_end >= j.end
                && !video.oldest_pending().is_some_and(|t| t < j.end)
                && (stopping_at.is_some()
                    || audio_encoder.is_none()
                    || buffer.latest_audio_end().is_some_and(|t| t >= j.end))
        }) {
            let job = jobs.pop_front().unwrap();
            let wanted_start = job.event - ms_to_ticks(flags.pre_ms);
            if let Some((origin, packets)) = buffer.select(wanted_start, job.end) {
                let save = Save {
                    job,
                    packets,
                    origin,
                    video: SendDirectX(video.output_type.clone()),
                    audio: audio_encoder
                        .as_ref()
                        .map(|a| SendDirectX(a.output_type.clone())),
                };
                if let Err(
                    mpsc::TrySendError::Full(save) | mpsc::TrySendError::Disconnected(save),
                ) = saver.sender.as_ref().unwrap().try_send(save)
                {
                    fail(save.job, "The bounded MP4 save queue is unavailable");
                }
            } else {
                fail(job, "No decodable keyframe is available for this clip");
            }
        }
        let keep_from = jobs
            .iter()
            .map(|j| j.event - ms_to_ticks(flags.pre_ms))
            .min()
            .unwrap_or(now - retention)
            .min(now - retention);
        if now - last_prune >= 1_000_000 {
            buffer.prune(keep_from);
            last_prune = now;
        }
        let no_output = output_progress.stalled(
            now,
            video.produced,
            stopping_at.is_none() && origin.is_some(),
        );
        // Preserve the existing stuck-input guard too: an old frame can remain
        // pending even while newer frames continue to produce output.
        let stalled = stopping_at.is_none()
            && (no_output || video.oldest_pending().is_some_and(|t| now - t > 50_000_000));
        if now - last_stats >= 20_000_000 {
            let elapsed = (now - last_stats) as f64 / 10_000_000.0;
            let produced = video.produced - previous_output;
            let drops = pressure_drops - previous_drops;
            if flags.unlocked {
                let effective = pacer.as_ref().map(|p| p.rate).unwrap_or(rate);
                let expected = effective.ceil_fps() as f64 * elapsed;
                let window = PressureWindow {
                    encoder_drops: drops,
                    missed_deadlines: missed_deadlines - previous_missed,
                    copy_loss_repeats: copy_loss_repeats - previous_copy_loss_repeats,
                };
                let capture_pressure = window.capture_pressure(expected);
                let encoder_pressure = window.encoder_pressure(expected)
                    || video.oldest_pending().is_some_and(|t| now - t > 2_500_000);
                let mut next = effective;
                let reason = governor.observe(
                    encoder_pressure,
                    capture_pressure,
                    produced as f64 / elapsed > f64::from(effective.ceil_fps()) * 0.95,
                );
                match reason {
                    Some("capacity-recovery") => {
                        next.numerator =
                            ((effective.numerator as f64 * 1.10) as u32).min(rate.numerator);
                    }
                    Some(_) => {
                        next.numerator = ((effective.numerator as f64 * 0.75) as u32)
                            .max(10 * effective.denominator);
                    }
                    None => (),
                }
                if next != effective {
                    if let Some(p) = pacer.as_mut() {
                        p.change_rate(next, now);
                    }
                    emit(
                        json!({"type":"frame-rate-adjusted", "requestedFps":rate.ceil_fps(), "effectiveFps":next.ceil_fps(),
                            "reason":reason, "encoderDrops":drops,
                            "copyLossRepeatedFrames":window.copy_loss_repeats,
                            "missedDeadlines":window.missed_deadlines}),
                    );
                }
            }
            let effective = pacer.as_ref().map(|p| p.rate).unwrap_or(rate);
            shared.interval.store(
                (10_000_000u64 * u64::from(effective.denominator) / u64::from(effective.numerator))
                    .max(1),
                Ordering::Release,
            );
            resources.sample();
            emit(
                json!({"type":"capture-stats", "pipeline":"continuous-encoded-replay", "uptimeMs":ticks_to_ms(now-origin.unwrap_or(now)),
                "fps":effective.ceil_fps(), "requestedFps":flags.frame_rate.ceil_fps(),
                "capturedFrames":shared.captured.load(Ordering::Relaxed), "submittedFrames":video.submitted,
                "encodedFrames":video.produced, "encodedFps":produced as f64 / elapsed,
                "submittedFps":(video.submitted-previous_submitted) as f64 / elapsed,
                "videoBackpressureDrops":pressure_drops,
                "gpuContextBusyDrops":shared.gpu_busy_drops.load(Ordering::Relaxed),
                "captureTexturePoolDrops":shared.texture_pool_drops.load(Ordering::Relaxed),
                "captureSamplingSkips":shared.skipped.load(Ordering::Relaxed),
                "copyLossRepeatedFrames":copy_loss_repeats,
                "duplicateFrames":duplicate_frames, "missedDeadlines":missed_deadlines,
                "audioSubmittedFrames":audio_encoder.as_ref().map(|a| a.submitted),
                "audioEncodedFrames":audio_encoder.as_ref().map(|a| a.produced),
                "audioPendingInputs":audio_packets.len(), "audioPipelineStalled":audio_stalled,
                "activeVideoQueue":video.submitted-video.produced, "pipelineStalled":stalled,
                "bufferBytes":buffer.bytes, "retainedEncodedBytes":buffer.retained_bytes(),
                "encodedMemoryLimitBytes":512 * 1024 * 1024, "bufferMemoryEvictions":buffer.memory_evictions,
                "pendingJobs":jobs.len(), "resources":resources.latest}),
            );
            previous_output = video.produced;
            previous_submitted = video.submitted;
            previous_drops = pressure_drops;
            previous_missed = missed_deadlines;
            previous_copy_loss_repeats = copy_loss_repeats;
            last_stats = now;
            if stalled {
                return Err("The selected encoder stopped producing video samples".into());
            }
        }
        if let Some(stop) = stopping_at {
            if jobs.is_empty() && (video.oldest_pending().is_none() || now - stop > 20_000_000) {
                break;
            }
            if now - stop > 30_000_000 {
                for j in jobs.drain(..) {
                    fail(
                        j,
                        "Recording stopped before the requested interval was available",
                    );
                }
                break;
            }
        }
        timer.wait(
            pacer
                .as_ref()
                .map(|p| p.deadline() - qpc_ticks())
                .unwrap_or(20_000),
        );
    }
    saver.close_and_wait()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn worker_panic_drains_queued_saves_and_mux_panic_does_not_kill_the_saver() {
        let _clock = Clock::start().unwrap();
        let output_type =
            media_encoder::video_type(64, 64, super::super::FrameRate::fixed(30), true).unwrap();
        let completed = Arc::new(AtomicUsize::new(0));
        let observed = completed.clone();
        let (tx, rx) = mpsc::sync_channel(8);
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            save_worker_with(rx, started_tx, |save| {
                if save.job.id == "mux-panic" {
                    panic!("injected mux panic");
                }
                thread::sleep(Duration::from_millis(25));
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
        });
        started_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let saver = SaveWorker {
                sender: Some(tx),
                worker: Some(worker),
            };
            for id in ["mux-panic", "must-finish"] {
                saver
                    .sender
                    .as_ref()
                    .unwrap()
                    .send(Save {
                        job: Job {
                            id: id.into(),
                            path: PathBuf::new(),
                            event: 0,
                            end: 0,
                        },
                        packets: Vec::new(),
                        origin: 0,
                        video: SendDirectX(output_type.clone()),
                        audio: None,
                    })
                    .unwrap_or_else(|_| panic!("save worker unexpectedly stopped"));
            }
            // SaveWorker::drop must drain the second job while this stack unwinds.
            panic!("injected recording-worker panic");
        }));
        assert!(result.is_err());
        assert_eq!(completed.load(Ordering::SeqCst), 1);
    }
}
