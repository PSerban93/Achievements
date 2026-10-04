use std::error::Error;
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use half::f16;
use png::{BitDepth, ColorType, Encoder, SrgbRenderingIntent};
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
    CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, GetMonitorInfoW,
    HBITMAP, HDC, HGDIOBJ, HMONITOR, MONITORINFO, ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext,
};
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
    // Both capture modes target the primary monitor, as the original Windows path did.
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

// Restore the selected object before freeing any GDI handles, including on errors.
struct GdiCapture {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}

impl Drop for GdiCapture {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_invalid() {
                SelectObject(self.memory, self.previous);
            }
            if !self.memory.is_invalid() {
                let _ = DeleteDC(self.memory);
            }
            if !self.bitmap.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            }
            if !self.screen.is_invalid() {
                ReleaseDC(None, self.screen);
            }
        }
    }
}

fn capture_sdr(canvas: &mut Canvas) -> Result<(), AnyError> {
    let width = i32::try_from(canvas.width)?;
    let height = i32::try_from(canvas.height)?;
    let mut capture = GdiCapture {
        screen: unsafe { GetDC(None) },
        memory: HDC::default(),
        bitmap: HBITMAP::default(),
        previous: HGDIOBJ::default(),
    };
    if capture.screen.is_invalid() {
        return Err("Could not acquire the desktop device context".into());
    }
    unsafe {
        capture.memory = CreateCompatibleDC(Some(capture.screen));
        if capture.memory.is_invalid() {
            return Err("Could not create the capture device context".into());
        }
        capture.bitmap = CreateCompatibleBitmap(capture.screen, width, height);
        if capture.bitmap.is_invalid() {
            return Err("Could not create the capture bitmap".into());
        }
        capture.previous = SelectObject(capture.memory, HGDIOBJ(capture.bitmap.0));
        if capture.previous.is_invalid() {
            return Err("Could not select the capture bitmap".into());
        }
        BitBlt(
            capture.memory,
            0,
            0,
            width,
            height,
            Some(capture.screen),
            canvas.left,
            canvas.top,
            SRCCOPY | CAPTUREBLT,
        )?;
        // GetDIBits requires that the bitmap is not selected into a DC.
        if SelectObject(capture.memory, capture.previous).is_invalid() {
            return Err("Could not release the capture bitmap for reading".into());
        }
        capture.previous = HGDIOBJ::default();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // Top-down pixels, with no vertical flip.
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let rows = GetDIBits(
            capture.screen,
            capture.bitmap,
            0,
            canvas.height,
            Some(canvas.rgba.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        if rows != height {
            return Err("Desktop capture returned an incomplete bitmap".into());
        }
    }
    for pixel in canvas.rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2); // GDI BGRA -> PNG RGBA; GDI does not populate alpha.
        pixel[3] = 255;
    }
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
    let result = (|| -> Result<(), AnyError> {
        let file = File::create(&temp)?;
        let mut encoder = Encoder::new(BufWriter::new(file), canvas.width, canvas.height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_depth(BitDepth::Eight);
        encoder.set_source_srgb(SrgbRenderingIntent::Perceptual);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&canvas.rgba)?;
        writer.finish()?;
        std::fs::rename(&temp, output)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn run() -> Result<(), AnyError> {
    let mut args = std::env::args_os().skip(1);
    let first = args
        .next()
        .ok_or("Usage: achievements-hdr-screenshot.exe [--sdr] <output.png>")?;
    let sdr = first == "--sdr";
    let output = PathBuf::from(if sdr {
        args.next().ok_or("Missing output path after --sdr")?
    } else {
        first
    });
    if args.next().is_some() {
        return Err("Unexpected screenshot arguments".into());
    }
    // Avoid DPI virtualization: both modes must capture physical monitor pixels.
    if unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
        .is_invalid()
    {
        return Err("Could not enable physical-pixel desktop capture".into());
    }
    let monitors = enumerate_monitors()?;
    let primary = monitors
        .iter()
        .copied()
        .find(|entry| entry.primary)
        .unwrap_or(monitors[0]);
    if sdr {
        let mut canvas = make_canvas(&[primary])?;
        capture_sdr(&mut canvas)?;
        return write_png(&output, &canvas);
    }
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
