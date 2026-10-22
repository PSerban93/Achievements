// Shared by the screenshot and recorder helpers. Enumeration never captures frames.
use windows::Win32::Devices::Display::*;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFOEXW};
use windows_capture::monitor::Monitor;

#[allow(dead_code)] // The recorder needs identity; the screenshot helper also lists metadata.
pub struct Display {
    pub monitor: Monitor,
    pub id: String,
    pub device_name: String,
    pub label: String,
    pub bounds: [i32; 4],
    pub primary: bool,
}

fn text(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|n| *n == 0).unwrap_or(value.len())])
}

fn hardware_id(device_name: &str) -> Option<String> {
    let (mut path_count, mut mode_count) = (0, 0);
    unsafe {
        GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
            .ok()
            .ok()?;
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
    unsafe {
        QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            None,
        )
        .ok()
        .ok()?;
    }
    for path in paths.iter().take(path_count as usize) {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
        source.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
            size: std::mem::size_of_val(&source) as u32,
            adapterId: path.sourceInfo.adapterId,
            id: path.sourceInfo.id,
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0
            || text(&source.viewGdiDeviceName) != device_name
        {
            continue;
        }
        let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
        target.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
            r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
            size: std::mem::size_of_val(&target) as u32,
            adapterId: path.sourceInfo.adapterId,
            id: path.targetInfo.id,
        };
        if unsafe { DisplayConfigGetDeviceInfo(&mut target.header) } == 0 {
            let id = text(&target.monitorDevicePath);
            if !id.is_empty() {
                return Some(id);
            }
        }
    }
    None
}

pub fn enumerate() -> Result<Vec<Display>, Box<dyn std::error::Error + Send + Sync>> {
    Monitor::enumerate()?
        .into_iter()
        .map(|monitor| {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of_val(&info) as u32;
            if !unsafe {
                GetMonitorInfoW(HMONITOR(monitor.as_raw_hmonitor()), (&raw mut info).cast())
            }
            .as_bool()
            {
                return Err("Could not read monitor placement".into());
            }
            let device_name = monitor.device_name()?;
            let r = info.monitorInfo.rcMonitor;
            Ok(Display {
                id: hardware_id(&device_name).unwrap_or_else(|| device_name.clone()),
                label: monitor.name().unwrap_or_else(|_| device_name.clone()),
                device_name,
                monitor,
                bounds: [r.left, r.top, r.right - r.left, r.bottom - r.top],
                primary: info.monitorInfo.dwFlags & 1 != 0,
            })
        })
        .collect()
}

pub fn select(id: Option<&str>) -> Result<Monitor, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(id) = id.filter(|id| !id.is_empty()) {
        if let Some(raw) = id.strip_prefix("bounds:") {
            let bounds = parse_bounds(raw).ok_or("Invalid monitor bounds")?;
            // Independent of DisplayConfig/EDID enumeration: only classic GDI
            // placement is needed, including on older Windows versions.
            for monitor in Monitor::enumerate()? {
                let mut info = MONITORINFOEXW::default();
                info.monitorInfo.cbSize = std::mem::size_of_val(&info) as u32;
                if !unsafe {
                    GetMonitorInfoW(HMONITOR(monitor.as_raw_hmonitor()), (&raw mut info).cast())
                }
                .as_bool()
                {
                    continue;
                }
                let r = info.monitorInfo.rcMonitor;
                if [r.left, r.top, r.right - r.left, r.bottom - r.top] == bounds {
                    return Ok(monitor);
                }
            }
            return Err("Selected monitor bounds are no longer available".into());
        }
        // Never silently capture a different monitor. The app resolves fallback first.
        return enumerate()?
            .into_iter()
            .find(|d| d.id.eq_ignore_ascii_case(id))
            .map(|d| d.monitor)
            .ok_or_else(|| "Selected monitor is no longer available".into());
    }
    Ok(Monitor::primary()?)
}

fn parse_bounds(raw: &str) -> Option<[i32; 4]> {
    let values: Vec<i32> = raw
        .split(',')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    let bounds: [i32; 4] = values.try_into().ok()?;
    (bounds[2] > 0 && bounds[3] > 0).then_some(bounds)
}

#[cfg(test)]
mod tests {
    use super::parse_bounds;
    #[test]
    fn physical_bounds_accept_negative_origins_but_reject_invalid_sizes() {
        assert_eq!(
            parse_bounds("-1920,-1080,1920,1080"),
            Some([-1920, -1080, 1920, 1080])
        );
        for raw in [
            "0,0,0,1080",
            "0,0,1920,-1",
            "0,0,1920",
            "0,0,1920,1080,1",
            "x,0,1920,1080",
        ] {
            assert!(parse_bounds(raw).is_none());
        }
    }
}
