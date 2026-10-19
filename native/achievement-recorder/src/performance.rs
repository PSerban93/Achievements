//! Low-frequency diagnostics for this process; no external monitoring tools.
use std::time::Instant;

use serde_json::{Value, json};
use windows::Win32::Foundation::FILETIME;
use windows::Win32::System::ProcessStatus::{
    K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Threading::{
    ALL_PROCESSOR_GROUPS, GetActiveProcessorCount, GetCurrentProcess, GetCurrentThread,
    GetProcessTimes, GetSystemTimes, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
};

fn ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

struct CpuSample {
    at: Instant,
    process: Option<u64>,
    system: Option<(u64, u64)>,
}

impl CpuSample {
    fn read() -> Self {
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let process = unsafe {
            GetProcessTimes(
                GetCurrentProcess(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        }
        .ok()
        .map(|()| ticks(kernel).saturating_add(ticks(user)));
        let mut idle = FILETIME::default();
        let system = unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }
            .ok()
            .map(|()| (ticks(kernel).saturating_add(ticks(user)), ticks(idle)));
        Self {
            at: Instant::now(),
            process,
            system,
        }
    }
}

pub struct ResourceMonitor {
    previous: CpuSample,
    logical_processors: u32,
    pub system_cpu_pct: Option<f64>,
    pub latest: Value,
}

impl ResourceMonitor {
    pub fn new() -> Self {
        Self {
            previous: CpuSample::read(),
            logical_processors: unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) }.max(1),
            system_cpu_pct: None,
            latest: Value::Null,
        }
    }

    pub fn sample(&mut self) {
        let current = CpuSample::read();
        let elapsed_ticks =
            current.at.duration_since(self.previous.at).as_secs_f64() * 10_000_000.0;
        let cpu_core_pct = current
            .process
            .zip(self.previous.process)
            .filter(|_| elapsed_ticks > 0.0)
            .map(|(now, before)| now.saturating_sub(before) as f64 * 100.0 / elapsed_ticks);
        self.system_cpu_pct = current.system.zip(self.previous.system).and_then(
            |((total, idle), (before_total, before_idle))| {
                let elapsed = total.saturating_sub(before_total);
                (elapsed > 0).then(|| {
                    let busy = elapsed.saturating_sub(idle.saturating_sub(before_idle));
                    (busy as f64 * 100.0 / elapsed as f64).clamp(0.0, 100.0)
                })
            },
        );
        let mut memory = PROCESS_MEMORY_COUNTERS_EX::default();
        memory.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let memory_available = unsafe {
            K32GetProcessMemoryInfo(
                GetCurrentProcess(),
                (&mut memory as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
                memory.cb,
            )
        }
        .as_bool();
        self.latest = json!({
            "sampleMs": elapsed_ticks / 10_000.0,
            "recorderCpuPct": cpu_core_pct.map(|pct| (pct / f64::from(self.logical_processors)).clamp(0.0, 100.0)),
            "recorderCpuCorePct": cpu_core_pct,
            "systemCpuPct": self.system_cpu_pct,
            // GetSystemTimes is scoped to the calling processor group above 64 CPUs.
            "systemCpuScope": if self.logical_processors > 64 { "processor-group" } else { "system" },
            "logicalProcessors": self.logical_processors,
            "workingSetBytes": memory_available.then_some(memory.WorkingSetSize),
            "privateBytes": memory_available.then_some(memory.PrivateUsage),
        });
        self.previous = current;
    }
}

/// Only the export coordinator is lowered. Capture/audio and the process keep
/// their existing priorities. Windows media workers have their own scheduling.
pub fn lower_export_thread_priority() -> Result<(), String> {
    unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL) }
        .map_err(|error| error.to_string())
}
