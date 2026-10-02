use std::{
    collections::{vec_deque::Drain, VecDeque},
    ops::RangeBounds,
    time::{Duration, Instant},
};

/// 收音 callback 與 consumer 共用同一把外層 mutex；停止閘門與入列因此具原子性。
pub(crate) struct AudioQueue {
    samples: VecDeque<f32>,
    capacity: Option<usize>,
    accepting: bool,
    stopped_samples: Option<VecDeque<f32>>,
    stopped_at: Option<Instant>,
    dropped: bool,
    last_drop_notice: Option<Instant>,
}

impl Default for AudioQueue {
    fn default() -> Self {
        Self {
            samples: VecDeque::new(),
            capacity: None,
            accepting: true,
            stopped_samples: None,
            stopped_at: None,
            dropped: false,
            last_drop_notice: None,
        }
    }
}

impl AudioQueue {
    pub fn bounded(capacity: usize) -> Self {
        Self {
            capacity: Some(capacity.max(1)),
            ..Self::default()
        }
    }

    pub fn extend(&mut self, samples: impl IntoIterator<Item = f32>) {
        if !self.accepting {
            return;
        }
        for sample in samples {
            if self
                .capacity
                .is_some_and(|capacity| self.samples.len() >= capacity)
            {
                self.samples.pop_front();
                self.dropped = true;
            }
            self.samples.push_back(sample);
        }
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn pop_front(&mut self) -> Option<f32> {
        self.samples.pop_front()
    }

    pub fn drain<R: RangeBounds<usize>>(&mut self, range: R) -> Drain<'_, f32> {
        self.samples.drain(range)
    }

    /// 在 callback 入列使用的同一 mutex 內呼叫，僅取停止邊界前的一次性快照。
    pub fn freeze(&mut self) {
        if !self.accepting {
            return;
        }
        self.accepting = false;
        self.stopped_at = Some(Instant::now());
        self.stopped_samples = Some(std::mem::take(&mut self.samples));
        self.dropped = false;
    }

    pub fn take_stopped_samples(&mut self) -> VecDeque<f32> {
        self.stopped_samples.take().unwrap_or_default()
    }

    pub fn stopped_at(&self) -> Option<Instant> {
        self.stopped_at
    }

    pub fn is_accepting(&self) -> bool {
        self.accepting
    }

    pub fn take_drop_notice(&mut self, now: Instant, throttle: Duration) -> bool {
        if !self.dropped || !self.accepting {
            return false;
        }
        if self
            .last_drop_notice
            .is_some_and(|last| now.saturating_duration_since(last) < throttle)
        {
            return false;
        }
        self.last_drop_notice = Some(now);
        self.dropped = false;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};

    #[test]
    fn producer_never_exceeds_two_seconds_and_keeps_latest_audio() {
        let mut queue = AudioQueue::bounded(32_000);
        queue.extend((0..50_000).map(|sample| sample as f32));
        assert_eq!(queue.len(), 32_000);
        assert_eq!(queue.pop_front(), Some(18_000.0));
        let now = Instant::now();
        assert!(queue.take_drop_notice(now, Duration::from_secs(5)));
        queue.extend((0..10).map(|sample| sample as f32));
        assert!(!queue.take_drop_notice(now + Duration::from_secs(4), Duration::from_secs(5)));
        assert!(queue.take_drop_notice(now + Duration::from_secs(5), Duration::from_secs(5)));
    }

    #[test]
    fn recording_default_preserves_all_samples() {
        let mut queue = AudioQueue::default();
        queue.extend((0..50_000).map(|sample| sample as f32));
        assert_eq!(queue.len(), 50_000);
        assert_eq!(queue.drain(..).count(), 50_000);
    }

    #[test]
    fn callback_that_finishes_after_stop_cannot_enqueue_or_extend_snapshot() {
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(32_000)));
        queue.lock().expect("應可入列").extend([1.0, 2.0]);
        let callback_started = Arc::new(Barrier::new(2));
        let resume_callback = Arc::new(Barrier::new(2));
        let callback_queue = queue.clone();
        let callback_started_worker = callback_started.clone();
        let resume_callback_worker = resume_callback.clone();
        let callback = std::thread::spawn(move || {
            callback_started_worker.wait();
            resume_callback_worker.wait();
            callback_queue
                .lock()
                .expect("應可取得 callback queue")
                .extend([3.0, 4.0]);
        });
        callback_started.wait();
        queue.lock().expect("應可停止入列").freeze();
        resume_callback.wait();
        callback.join().expect("callback 應結束");
        let mut queue = queue.lock().expect("應可取得尾端快照");
        assert!(!queue.is_accepting());
        assert_eq!(queue.len(), 0);
        assert_eq!(queue.take_stopped_samples(), VecDeque::from([1.0, 2.0]));
        assert!(queue.take_stopped_samples().is_empty());
        assert!(queue.stopped_at().is_some());
    }
}
