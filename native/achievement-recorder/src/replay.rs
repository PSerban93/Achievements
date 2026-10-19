//! Timing and retention are independent of WGC callbacks. A static desktop
//! cannot prevent audio, a trigger, a save, or shutdown from being processed.
use super::FrameRate;
use super::media_encoder::Packet;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Count each retained encoded packet once, even when several clips share it.
/// A reservation is released only after the replay ring AND every saver let go.
pub struct MemoryBudget {
    used: Arc<AtomicUsize>,
    limit: usize,
}
pub struct MemoryCharge {
    used: Arc<AtomicUsize>,
    bytes: usize,
}
impl Drop for MemoryCharge {
    fn drop(&mut self) {
        self.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
impl MemoryBudget {
    fn new(limit: usize) -> Self {
        Self {
            used: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }
    fn reserve(&self, bytes: usize) -> Option<Arc<MemoryCharge>> {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|next| *next <= self.limit)
            })
            .ok()?;
        Some(Arc::new(MemoryCharge {
            used: self.used.clone(),
            bytes,
        }))
    }
    fn used(&self) -> usize {
        self.used.load(Ordering::Acquire)
    }
}

/// Heartbeats alone do not prove that the encoder is producing video.
pub struct OutputProgress {
    last_output: i64,
    produced: u64,
}

#[derive(Default)]
pub struct PressureWindow {
    pub encoder_drops: u64,
    pub missed_deadlines: u64,
    pub copy_loss_repeats: u64,
}
impl PressureWindow {
    pub fn encoder_pressure(&self, expected_frames: f64) -> bool {
        self.encoder_drops >= (expected_frames * 0.02).ceil().max(3.0) as u64
    }
    pub fn capture_pressure(&self, expected_frames: f64) -> bool {
        let threshold = (expected_frames * 0.02).ceil().max(3.0) as u64;
        self.missed_deadlines >= threshold
            // Count only repeats preceded by an eligible source frame whose
            // copy failed. Unrelated/static repeats are not overload evidence.
            || self.copy_loss_repeats >= threshold
    }
}

/// One transient window (including encoder startup) must not lower Unlocked.
/// Fixed-rate recording never uses this governor.
#[derive(Default)]
pub struct RateGovernor {
    pressure_windows: u32,
    good_windows: u32,
}
impl RateGovernor {
    pub fn observe(&mut self, encoder: bool, capture: bool, healthy: bool) -> Option<&'static str> {
        if encoder || capture {
            self.good_windows = 0;
            self.pressure_windows += 1;
            if self.pressure_windows >= 2 {
                self.pressure_windows = 0;
                return Some(if encoder {
                    "encoder-pressure"
                } else {
                    "capture-pressure"
                });
            }
        } else {
            self.pressure_windows = 0;
            self.good_windows = if healthy { self.good_windows + 1 } else { 0 };
            if self.good_windows >= 5 {
                self.good_windows = 0;
                return Some("capacity-recovery");
            }
        }
        None
    }
}

/// Match an omitted source update to repeated output, once per failed update.
/// A successful newer image makes an older copy failure irrelevant.
#[derive(Default)]
pub struct CopyLossProgress {
    last_counted: u64,
}
impl CopyLossProgress {
    pub fn repeated_after_loss(&mut self, repeated: bool, image_time: i64, loss_time: u64) -> bool {
        if repeated && loss_time > image_time.max(0) as u64 && loss_time > self.last_counted {
            self.last_counted = loss_time;
            true
        } else {
            false
        }
    }
}
impl OutputProgress {
    pub fn new(now: i64) -> Self {
        Self {
            last_output: now,
            produced: 0,
        }
    }
    pub fn stalled(&mut self, now: i64, produced: u64, expecting_output: bool) -> bool {
        if produced != self.produced || !expecting_output {
            self.last_output = now;
            self.produced = produced;
        }
        expecting_output && now.saturating_sub(self.last_output) > 50_000_000
    }
}

pub struct Pacer {
    pub rate: FrameRate,
    origin: i64,
    next: u64,
}
impl Pacer {
    pub fn new(rate: FrameRate, origin: i64) -> Self {
        Self {
            rate,
            origin,
            next: 0,
        }
    }
    pub fn deadline(&self) -> i64 {
        self.origin.saturating_add(
            ((i128::from(self.next) * 10_000_000 * i128::from(self.rate.denominator))
                / i128::from(self.rate.numerator)) as i64,
        )
    }
    pub fn take(&mut self, now: i64) -> Option<(i64, i64, u64)> {
        let due = self.deadline();
        if now < due {
            return None;
        }
        let current = ((i128::from(now.saturating_sub(self.origin))
            * i128::from(self.rate.numerator))
            / (10_000_000 * i128::from(self.rate.denominator))) as u64;
        // No burst of stale frames after a stall. Keep real wall-clock time.
        let missed = current.saturating_sub(self.next);
        self.next = current.max(self.next);
        let time = self.deadline();
        self.next += 1;
        Some((time, (self.deadline() - time).max(1), missed))
    }
    pub fn change_rate(&mut self, rate: FrameRate, now: i64) {
        self.rate = rate;
        self.origin = now;
        self.next = 0;
    }
}

pub struct Job {
    pub id: String,
    pub path: PathBuf,
    pub event: i64,
    pub end: i64,
}

pub struct Buffer {
    pub packets: VecDeque<Packet>,
    pub bytes: usize,
    pub memory_evictions: u64,
    byte_limit: usize,
    memory: MemoryBudget,
    video_end: Option<i64>,
    audio_end: Option<i64>,
}
impl Buffer {
    pub fn new(byte_limit: usize) -> Self {
        Self {
            packets: VecDeque::new(),
            bytes: 0,
            memory_evictions: 0,
            byte_limit,
            memory: MemoryBudget::new(byte_limit),
            video_end: None,
            audio_end: None,
        }
    }
    pub fn retained_bytes(&self) -> usize {
        self.memory.used()
    }
    fn evict_gop(&mut self) -> bool {
        let first = self
            .packets
            .iter()
            .filter(|p| p.video && p.keyframe)
            .map(|p| p.time)
            .min();
        let next = self
            .packets
            .iter()
            .filter(|p| p.video && p.keyframe && Some(p.time) > first)
            .map(|p| p.time)
            .min();
        if let Some(t) = next {
            self.remove_before(t);
            self.memory_evictions += 1;
            true
        } else {
            false
        }
    }
    pub fn push(&mut self, mut packet: Packet) -> Result<(), &'static str> {
        if packet.memory.is_none() {
            loop {
                if let Some(charge) = self.memory.reserve(packet.size) {
                    packet.memory = Some(charge);
                    break;
                }
                // Evict complete old GOPs first. Packets pinned by a slow save
                // remain charged, so eviction cannot hide their memory usage.
                if packet.size > self.byte_limit || !self.evict_gop() {
                    return Err(
                        "Compressed replay and pending saves reached the shared memory limit",
                    );
                }
            }
        }
        let end = packet.time.saturating_add(packet.duration);
        let latest = if packet.video {
            &mut self.video_end
        } else {
            &mut self.audio_end
        };
        *latest = Some(latest.unwrap_or(end).max(end));
        self.bytes += packet.size;
        self.packets.push_back(packet);
        Ok(())
    }
    fn remove_before(&mut self, time: i64) {
        self.packets.retain(|p| {
            if p.time < time {
                self.bytes = self.bytes.saturating_sub(p.size);
                false
            } else {
                true
            }
        });
    }
    pub fn prune(&mut self, keep_from: i64) {
        // Retain the preceding keyframe, including its dependent frames.
        if let Some(start) = self
            .packets
            .iter()
            .filter(|p| p.video && p.keyframe && p.time <= keep_from)
            .map(|p| p.time)
            .max()
        {
            self.remove_before(start);
        }
        while self.bytes > self.byte_limit && self.evict_gop() {}
    }
    pub fn latest_video_end(&self) -> Option<i64> {
        self.video_end
    }
    pub fn latest_audio_end(&self) -> Option<i64> {
        self.audio_end
    }
    pub fn select(&self, start: i64, end: i64) -> Option<(i64, Vec<Packet>)> {
        let keys: Vec<_> = self
            .packets
            .iter()
            .filter(|p| p.video && p.keyframe && p.time < end)
            .map(|p| p.time)
            .collect();
        let origin = keys
            .iter()
            .copied()
            .filter(|t| *t <= start)
            .max()
            .or_else(|| keys.iter().copied().min())?;
        // Preserve future-reference pictures that are decoded before the last
        // selected picture if a driver ignores the optional no-B-frame setting.
        let last_decode = self
            .packets
            .iter()
            .filter(|p| p.video && p.time >= origin && p.time < end)
            .map(|p| p.decode_time)
            .max()?;
        let actual_end = self
            .packets
            .iter()
            .filter(|p| p.video && p.time >= origin && p.decode_time <= last_decode)
            .map(|p| p.time.saturating_add(p.duration))
            .max()
            .unwrap_or(end)
            .max(end);
        let mut packets: Vec<_> = self
            .packets
            .iter()
            .filter(|p| {
                p.time >= origin
                    && if p.video {
                        p.decode_time <= last_decode
                    } else {
                        p.time < actual_end
                    }
            })
            .cloned()
            .collect();
        packets.sort_by_key(|p| (p.decode_time, !p.video));
        Some((origin, packets))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unlocked_adaptation_distinguishes_static_frames_and_capture_loss() {
        let static_scene = PressureWindow::default();
        assert!(!static_scene.capture_pressure(480.0));
        let stale_output = PressureWindow {
            copy_loss_repeats: 30,
            ..Default::default()
        };
        assert!(stale_output.capture_pressure(480.0));
        let missed = PressureWindow {
            missed_deadlines: 20,
            ..Default::default()
        };
        assert!(missed.capture_pressure(480.0));
        assert!(!missed.encoder_pressure(480.0));
        let noise = PressureWindow {
            missed_deadlines: 2,
            copy_loss_repeats: 2,
            ..Default::default()
        };
        assert!(!noise.capture_pressure(480.0));
    }
    #[test]
    fn copy_loss_is_counted_only_when_a_new_source_copy_failed_before_a_repeat() {
        let mut losses = CopyLossProgress::default();
        assert!(!losses.repeated_after_loss(true, 100, 0)); // static scene
        assert!(!losses.repeated_after_loss(true, 100, 90)); // older failure
        assert!(!losses.repeated_after_loss(false, 100, 110)); // fresh output
        assert!(losses.repeated_after_loss(true, 100, 110));
        assert!(!losses.repeated_after_loss(true, 100, 110)); // do not count twice
        assert!(losses.repeated_after_loss(true, 100, 120)); // another lost update
        assert!(!losses.repeated_after_loss(true, 140, 130)); // newer copy recovered
    }
    #[test]
    fn unlocked_requires_sustained_pressure_and_uninterrupted_recovery() {
        let mut g = RateGovernor::default();
        assert_eq!(g.observe(true, false, false), None); // startup spike
        assert_eq!(g.observe(false, false, true), None);
        assert_eq!(g.observe(false, true, false), None);
        assert_eq!(g.observe(false, true, false), Some("capture-pressure"));
        assert_eq!(g.observe(true, false, false), None);
        assert_eq!(g.observe(true, false, false), Some("encoder-pressure"));
        for _ in 0..4 {
            assert_eq!(g.observe(false, false, true), None);
        }
        assert_eq!(g.observe(false, false, false), None); // broken recovery window
        for _ in 0..4 {
            assert_eq!(g.observe(false, false, true), None);
        }
        assert_eq!(g.observe(false, false, true), Some("capacity-recovery"));
    }
    #[test]
    fn audio_encoder_watchdog_ignores_idle_input_but_detects_a_blocked_aac_encoder() {
        let mut p = OutputProgress::new(0);
        assert!(!p.stalled(300_000_000, 0, false)); // no PCM input yet
        assert!(!p.stalled(300_000_001, 0, true));
        assert!(p.stalled(350_000_001, 0, true)); // queued PCM, no AAC output
        assert!(!p.stalled(350_000_002, 1, true)); // output recovered
        // A silent/reconnected device is represented by PCM silence; progress
        // continues and must not trigger a false restart.
        for n in 1..20 {
            assert!(!p.stalled(350_000_002 + n * 10_000_000, n as u64 + 1, true));
        }
    }
    #[test]
    fn stalled_output_is_detected_even_without_pending_encoder_samples() {
        let mut p = OutputProgress::new(0);
        assert!(!p.stalled(10_000_000, 60, true));
        assert!(!p.stalled(60_000_000, 60, true));
        assert!(p.stalled(60_000_001, 60, true));
        // Output recovery resets the deadline; static scenes still produce frames.
        assert!(!p.stalled(61_000_000, 61, true));
        assert!(!p.stalled(65_000_000, 62, true));
    }
    #[test]
    fn missing_capture_input_does_not_trigger_the_output_watchdog() {
        let mut p = OutputProgress::new(0);
        assert!(!p.stalled(600_000_000, 0, false));
        assert!(!p.stalled(600_000_001, 0, true));
        assert!(p.stalled(650_000_001, 0, true));
    }
    #[test]
    fn shared_clip_packets_stay_charged_until_the_last_owner_releases_them() {
        let budget = MemoryBudget::new(10);
        let ring = budget.reserve(6).unwrap();
        let clip1 = ring.clone();
        let clip2 = ring.clone();
        assert_eq!(budget.used(), 6);
        assert!(budget.reserve(5).is_none());
        drop(ring); // Replay eviction does not release buffers pinned by saves.
        drop(clip1);
        assert_eq!(budget.used(), 6);
        let other = budget.reserve(4).unwrap();
        assert_eq!(budget.used(), 10);
        assert!(budget.reserve(1).is_none());
        drop(clip2);
        assert_eq!(budget.used(), 4);
        assert!(budget.reserve(6).is_some());
        drop(other);
        assert_eq!(budget.used(), 0);
    }
    #[test]
    fn fixed_rates_keep_exact_cadence_on_a_240_hz_clock() {
        for fps in [30, 60] {
            let mut p = Pacer::new(FrameRate::fixed(fps), 0);
            let mut times = Vec::new();
            for n in 0..2400 {
                if let Some((t, _, missed)) = p.take(n * 10_000_000 / 240) {
                    assert_eq!(missed, 0);
                    times.push(t);
                }
            }
            assert_eq!(times.len(), fps as usize * 10);
            for (i, t) in times.into_iter().enumerate() {
                assert_eq!(t, i as i64 * 10_000_000 / i64::from(fps));
            }
        }
    }
    #[test]
    fn a_stall_skips_deadlines_without_speeding_up_time() {
        let mut p = Pacer::new(FrameRate::fixed(60), 0);
        assert_eq!(p.take(0), Some((0, 166666, 0)));
        let (time, _, missed) = p.take(10_000_000).unwrap();
        assert_eq!(time, 10_000_000);
        assert_eq!(missed, 59);
        assert!(p.take(10_000_000).is_none());
    }
    #[test]
    fn fractional_rate_does_not_accumulate_rounding_drift() {
        let mut p = Pacer::new(
            FrameRate {
                numerator: 239760,
                denominator: 1000,
            },
            0,
        );
        for _ in 0..10000 {
            let due = p.deadline();
            assert_eq!(p.take(due).unwrap().0, due);
        }
        assert_eq!(p.deadline(), 10000_i64 * 10_000_000 * 1000 / 239760);
    }
}
