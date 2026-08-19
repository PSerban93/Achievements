use std::error::Error;
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use half::f16;
use png::{BitDepth, ColorType, Encoder, SrgbRenderingIntent};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

type AnyError = Box<dyn Error + Send + Sync>;
const MONITORINFOF_PRIMARY_FLAG: u32 = 1;

#[derive(Clone, Copy, Debug)]
struct MonitorPlacement {
    monitor: Monitor,
    rect: RECT,
    primary: bool,
}

struct Canvas {
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

#[derive(Clone)]
struct CaptureFlags {
    canvas: Arc<Mutex<Canvas>>,
    left: i32,
    top: i32,
}

struct SnapshotCapture {
    flags: CaptureFlags,
    completed: bool,
}

impl GraphicsCaptureApiHandler for SnapshotCapture {
    type Flags = CaptureFlags;
    type Error = AnyError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            flags: ctx.flags,
            completed: false,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.completed {
            capture_control.stop();
            return Ok(());
        }

        let width = frame.width();
        let height = frame.height();
        let frame_buffer = frame.buffer()?;
        let mut unpadded = Vec::new();
        let raw = frame_buffer.as_nopadding_buffer(&mut unpadded);

        if frame_buffer.color_format() != ColorFormat::Rgba16F {
            return Err("Windows Graphics Capture did not return an FP16 frame".into());
        }

        let peak = estimate_scene_peak(raw);
        let mut canvas = self
            .flags
            .canvas
            .lock()
            .map_err(|_| "HDR screenshot canvas lock was poisoned")?;
        copy_tone_mapped_frame(
            raw,
            width,
            height,
            self.flags.left,
            self.flags.top,
            peak,
            &mut canvas,
        )?;

        self.completed = true;
        capture_control.stop();
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if self.completed {
            Ok(())
        } else {
            Err("Capture source closed before the first HDR frame arrived".into())
        }
    }
}

fn monitor_info(monitor: Monitor) -> Result<MonitorPlacement, AnyError> {
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let handle = HMONITOR(monitor.as_raw_hmonitor());
    unsafe { GetMonitorInfoW(handle, &mut info).ok()? };
    Ok(MonitorPlacement {
        monitor,
        rect: info.rcMonitor,
        primary: info.dwFlags & MONITORINFOF_PRIMARY_FLAG != 0,
    })
}

fn enumerate_monitors() -> Result<Vec<MonitorPlacement>, AnyError> {
    let mut monitors = Monitor::enumerate()?
        .into_iter()
        .map(monitor_info)
        .collect::<Result<Vec<_>, _>>()?;
    if monitors.is_empty() {
        return Err("No active monitor was found".into());
    }
    // Capture the primary monitor first because Achievements notifications are
    // presented there. Additional monitors are then composed into the same
    // virtual-desktop image used by the existing screenshot path.
    monitors.sort_by_key(|entry| !entry.primary);
    Ok(monitors)
}

fn make_canvas(monitors: &[MonitorPlacement]) -> Result<Canvas, AnyError> {
    let left = monitors.iter().map(|m| m.rect.left).min().unwrap_or(0);
    let top = monitors.iter().map(|m| m.rect.top).min().unwrap_or(0);
    let right = monitors.iter().map(|m| m.rect.right).max().unwrap_or(0);
    let bottom = monitors.iter().map(|m| m.rect.bottom).max().unwrap_or(0);
    let width = u32::try_from(right - left).map_err(|_| "Invalid virtual desktop width")?;
    let height = u32::try_from(bottom - top).map_err(|_| "Invalid virtual desktop height")?;
    if width == 0 || height == 0 {
        return Err("The virtual desktop has an invalid size".into());
    }
    let byte_len = usize::try_from(width)?
        .checked_mul(usize::try_from(height)?)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or("The virtual desktop is too large to capture")?;
    Ok(Canvas {
        left,
        top,
        width,
        height,
        rgba: vec![0; byte_len],
    })
}

fn read_half(raw: &[u8], offset: usize) -> f32 {
    let bits = u16::from_le_bytes([raw[offset], raw[offset + 1]]);
    let value = f16::from_bits(bits).to_f32();
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

fn estimate_scene_peak(raw: &[u8]) -> f32 {
    const BINS: usize = 4096;
    const MAX_SIGNAL: f32 = 16.0;
    let mut histogram = [0_u32; BINS];
    let mut samples = 0_u64;

    for pixel in raw.chunks_exact(8).step_by(4) {
        let peak = read_half(pixel, 0)
            .max(read_half(pixel, 2))
            .max(read_half(pixel, 4))
            .min(MAX_SIGNAL);
        let bin = ((peak / MAX_SIGNAL) * (BINS - 1) as f32).round() as usize;
        histogram[bin] = histogram[bin].saturating_add(1);
        samples += 1;
    }

    if samples == 0 {
        return 1.0;
    }
    let target = ((samples as f64) * 0.999).ceil() as u64;
    let mut seen = 0_u64;
    for (index, count) in histogram.into_iter().enumerate() {
        seen += u64::from(count);
        if seen >= target {
            return (((index as f32) / (BINS - 1) as f32) * MAX_SIGNAL).max(1.0);
        }
    }
    1.0
}

fn tone_map_linear(value: f32, scene_peak: f32) -> f32 {
    let value = value.max(0.0);
    if scene_peak <= 1.05 {
        return value.min(1.0);
    }

    // Keep most SDR content unchanged and roll HDR highlights into the top
    // portion of the SDR range. A logarithmic shoulder avoids hard clipping.
    const KNEE: f32 = 0.80;
    if value <= KNEE {
        return value;
    }
    let peak = scene_peak.max(KNEE + 0.001);
    let numerator = (1.0 + 20.0 * (value.min(peak) - KNEE)).ln();
    let denominator = (1.0 + 20.0 * (peak - KNEE)).ln();
    (KNEE + (1.0 - KNEE) * numerator / denominator).clamp(0.0, 1.0)
}

fn linear_to_srgb(value: f32) -> u8 {
    let value = value.clamp(0.0, 1.0);
    let encoded = if value <= 0.003_130_8 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    };
    (encoded * 255.0).round().clamp(0.0, 255.0) as u8
}

fn copy_tone_mapped_frame(
    raw: &[u8],
    width: u32,
    height: u32,
    frame_left: i32,
    frame_top: i32,
    scene_peak: f32,
    canvas: &mut Canvas,
) -> Result<(), AnyError> {
    let expected = usize::try_from(width)?
        .checked_mul(usize::try_from(height)?)
        .and_then(|pixels| pixels.checked_mul(8))
        .ok_or("Captured HDR frame is too large")?;
    if raw.len() < expected {
        return Err("Captured HDR frame buffer is incomplete".into());
    }

    let dest_x = u32::try_from(frame_left - canvas.left)
        .map_err(|_| "Monitor lies outside the virtual desktop")?;
    let dest_y = u32::try_from(frame_top - canvas.top)
        .map_err(|_| "Monitor lies outside the virtual desktop")?;
    let copy_width = width.min(canvas.width.saturating_sub(dest_x));
    let copy_height = height.min(canvas.height.saturating_sub(dest_y));

    for y in 0..copy_height {
        for x in 0..copy_width {
            let src = ((y * width + x) * 8) as usize;
            let dst = (((dest_y + y) * canvas.width + dest_x + x) * 4) as usize;
            canvas.rgba[dst] = linear_to_srgb(tone_map_linear(read_half(raw, src), scene_peak));
            canvas.rgba[dst + 1] =
                linear_to_srgb(tone_map_linear(read_half(raw, src + 2), scene_peak));
            canvas.rgba[dst + 2] =
                linear_to_srgb(tone_map_linear(read_half(raw, src + 4), scene_peak));
            canvas.rgba[dst + 3] = 255;
        }
    }
    Ok(())
}

fn capture_monitor(
    placement: MonitorPlacement,
    canvas: Arc<Mutex<Canvas>>,
) -> Result<(), AnyError> {
    let settings = Settings::new(
        placement.monitor,
        CursorCaptureSettings::WithoutCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Rgba16F,
        CaptureFlags {
            canvas,
            left: placement.rect.left,
            top: placement.rect.top,
        },
    );
    SnapshotCapture::start(settings)?;
    Ok(())
}

fn write_png(output: &PathBuf, canvas: &Canvas) -> Result<(), AnyError> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = output.with_extension(format!(
        "{}.tmp",
        output
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("png")
    ));
    let file = File::create(&temp)?;
    let mut encoder = Encoder::new(BufWriter::new(file), canvas.width, canvas.height);
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_source_srgb(SrgbRenderingIntent::Perceptual);
    let mut writer = encoder.write_header()?;
    writer.write_image_data(&canvas.rgba)?;
    writer.finish()?;
    std::fs::rename(temp, output)?;
    Ok(())
}

fn run() -> Result<(), AnyError> {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("Usage: achievements-hdr-screenshot.exe <output.png>")?;
    let monitors = enumerate_monitors()?;
    let primary = monitors
        .iter()
        .copied()
        .find(|entry| entry.primary)
        .unwrap_or(monitors[0]);
    // The existing screenshot-desktop Windows path captures the primary
    // desktop surface. Keep the same dimensions and target when HDR is on.
    let canvas = Arc::new(Mutex::new(make_canvas(&[primary])?));
    capture_monitor(primary, Arc::clone(&canvas))?;

    let canvas = canvas
        .lock()
        .map_err(|_| "HDR screenshot canvas lock was poisoned")?;
    write_png(&output, &canvas)?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
