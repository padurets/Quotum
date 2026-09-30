//! A single latest foreground slot; GTK never waits for a browser socket writer.
use super::foreground::Head;
use std::{
    collections::VecDeque,
    io,
    os::{fd::AsRawFd, unix::net::UnixStream},
    sync::{Arc, Condvar, Mutex},
};

struct Frame {
    bytes: Vec<u8>,
    offset: usize,
    head: Option<Head>,
}
pub struct Writer {
    socket: UnixStream,
    partial: Option<Frame>,
}
#[derive(Default)]
struct Pending {
    latest: Option<Head>,
    accepted: Option<Head>,
    auxiliary: Option<serde_json::Value>,
    messages: VecDeque<Vec<u8>>,
    work: bool,
    stopped: bool,
}
pub struct Publishing {
    writer: Mutex<Writer>,
    shutdown: UnixStream,
    pending: Mutex<Pending>,
    changed: Condvar,
    published: Box<dyn Fn(Head) + Send + Sync>,
}
impl Publishing {
    pub fn new(socket: UnixStream, published: impl Fn(Head) + Send + Sync + 'static) -> io::Result<Arc<Self>> {
        let shutdown = socket.try_clone()?;
        let this = Arc::new(Self {
            writer: Mutex::new(Writer { socket, partial: None }),
            shutdown,
            pending: Mutex::default(),
            changed: Condvar::new(),
            published: Box::new(published),
        });
        let worker = this.clone();
        std::thread::spawn(move || {
            loop {
                let mut pending = worker.pending.lock().unwrap_or_else(|e| e.into_inner());
                pending =
                    worker.changed.wait_while(pending, |p| !p.work && !p.stopped).unwrap_or_else(|e| e.into_inner());
                if pending.stopped {
                    break;
                }
                pending.work = false;
                drop(pending);
                let mut writer = worker.writer.lock().unwrap_or_else(|e| e.into_inner());
                if worker.flush(&mut writer, false).is_err() {
                    worker.stop();
                    break;
                }
            }
        });
        Ok(this)
    }
    pub fn publish(&self, head: Head) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.stopped {
            return;
        }
        if pending.accepted.is_some_and(|old| {
            head.revision < old.revision
                || (head.revision == old.revision && (old == head || old.target == super::foreground::Target::None))
        }) {
            return;
        }
        pending.accepted = Some(head);
        pending.latest = Some(head);
        pending.work = true;
        drop(pending);
        // A partial frame stays with the writer: unrelated messages cannot split it.
        if let Ok(mut writer) = self.writer.try_lock()
            && self.flush(&mut writer, true).is_err()
        {
            self.stop();
        }
        self.changed.notify_one();
    }
    pub fn defer(&self, message: serde_json::Value) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.stopped {
            return;
        }
        pending.auxiliary = Some(message);
        pending.work = true;
        self.changed.notify_one();
    }
    fn flush(&self, writer: &mut Writer, nonblocking: bool) -> io::Result<()> {
        loop {
            // No byte of an unsent foreground frame belongs to the stream yet.
            // Replace it after backpressure rather than sending an obsolete head.
            if writer.partial.as_ref().is_some_and(|frame| frame.offset == 0 && frame.head.is_some()) {
                let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(head) = pending.latest.take() {
                    let mut bytes = serde_json::to_vec(&serde_json::json!({"type":"foreground", "head":head}))?;
                    bytes.push(b'\n');
                    writer.partial = Some(Frame { bytes, offset: 0, head: Some(head) });
                }
            }
            if self.pending.lock().unwrap_or_else(|e| e.into_inner()).stopped {
                return Err(io::Error::other("GUI publisher stopped"));
            }
            if writer.partial.is_none() {
                let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                let head = pending.latest.take();
                let message = if let Some(head) = head {
                    serde_json::json!({"type":"foreground", "head":head})
                } else if let Some(message) = pending.auxiliary.take() {
                    message
                } else if let Some(bytes) = pending.messages.pop_front() {
                    writer.partial = Some(Frame { bytes, offset: 0, head: None });
                    continue;
                } else {
                    return Ok(());
                };
                drop(pending);
                let mut bytes = serde_json::to_vec(&message)?;
                bytes.push(b'\n');
                writer.partial = Some(Frame { bytes, offset: 0, head });
            }
            let frame = writer.partial.as_mut().expect("pending frame");
            let bytes = &frame.bytes[frame.offset..];
            let count = unsafe {
                libc::send(
                    writer.socket.as_raw_fd(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::WouldBlock {
                    return Err(error);
                }
                if nonblocking {
                    return Ok(());
                }
                // A paused browser is not a broken connection. Wait outside GTK;
                // after wake, coalesce an entirely unsent frame before writing it.
                let mut fd = libc::pollfd { fd: writer.socket.as_raw_fd(), events: libc::POLLOUT, revents: 0 };
                let result = unsafe { libc::poll(&mut fd, 1, 2000) };
                if result < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    return Err(io::Error::last_os_error());
                }
                continue;
            }
            if count == 0 {
                return Err(io::Error::new(io::ErrorKind::WriteZero, "GUI socket closed"));
            }
            frame.offset += count as usize;
            if frame.offset < frame.bytes.len() {
                if nonblocking {
                    return Ok(());
                }
                continue;
            }
            let head = writer.partial.take().expect("written frame").head;
            if let Some(head) = head {
                (self.published)(head);
            }
        }
    }
    pub fn send(&self, value: &serde_json::Value) -> io::Result<()> {
        let mut bytes = serde_json::to_vec(value)?;
        bytes.push(b'\n');
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        // The reader must keep draining IPC while its replies wait for a paused
        // browser. A broken peer cannot retain an unbounded queue in the controller.
        if pending.stopped || bytes.len() > 65536 || pending.messages.len() >= 32 {
            drop(pending);
            self.stop();
            return Err(io::Error::other("GUI output queue unavailable"));
        }
        pending.messages.push_back(bytes);
        pending.work = true;
        self.changed.notify_one();
        Ok(())
    }
    pub fn stop(&self) {
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).stopped = true;
        let _ = self.shutdown.shutdown(std::net::Shutdown::Both);
        self.changed.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::super::foreground::Target;
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        sync::mpsc,
        time::{Duration, Instant},
    };
    fn head(revision: u64, target: Target) -> Head {
        Head { revision, target, anchor: None }
    }
    #[test]
    fn writer_contention_keeps_only_the_latest_head_and_never_waits_in_publish() {
        let (socket, peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let publisher = Publishing::new(socket, |_| {}).unwrap();
        let writer = publisher.writer.lock().unwrap();
        let start = Instant::now();
        for revision in 1..=10000 {
            publisher.publish(head(revision, Target::Compact));
        }
        publisher.publish(head(10000, Target::None));
        publisher.publish(head(10000, Target::Compact));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert_eq!(publisher.pending.lock().unwrap().latest, Some(head(10000, Target::None)));
        drop(writer);
        let mut reader = BufReader::new(peer);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let message: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(message["head"]["revision"], 10000);
        assert_eq!(message["head"]["target"], "none");
        publisher.stop();
    }
    fn saturate(socket: &UnixStream) -> usize {
        let size = 4096_i32;
        unsafe {
            libc::setsockopt(
                socket.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_SNDBUF,
                (&size as *const i32).cast(),
                std::mem::size_of_val(&size) as _,
            );
        }
        let bytes = [b' '; 1024];
        let mut total = 0;
        loop {
            let count = unsafe {
                libc::send(
                    socket.as_raw_fd(),
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
                )
            };
            if count < 0 {
                assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
                return total;
            }
            total += count as usize;
        }
    }
    #[test]
    fn a_paused_reader_can_cancel_after_the_old_write_timeout_then_drain_only_the_latest() {
        let (socket, mut peer) = UnixStream::pair().unwrap();
        let filler = saturate(&socket);
        let (sent, received) = mpsc::channel();
        let publisher = Publishing::new(socket, move |head| {
            let _ = sent.send(head);
        })
        .unwrap();
        publisher.publish(head(1, Target::Main));
        // The previous GUI write timeout was two seconds. A stopped consumer is
        // allowed to resume later without silently disabling the foreground lane.
        assert!(received.recv_timeout(Duration::from_millis(2100)).is_err());
        let start = Instant::now();
        for revision in 2..=1000 {
            publisher.publish(head(revision, Target::Compact));
        }
        publisher.publish(head(1000, Target::None));
        assert!(start.elapsed() < Duration::from_secs(1));
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        peer.read_exact(&mut vec![0; filler]).unwrap();
        let mut line = String::new();
        BufReader::new(peer).read_line(&mut line).unwrap();
        let message: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(message["head"]["revision"], 1000);
        assert_eq!(message["head"]["target"], "none");
        assert_eq!(received.recv_timeout(Duration::from_secs(2)).unwrap(), head(1000, Target::None));
        publisher.stop();
    }
    #[test]
    fn quitting_interrupts_a_stalled_writer_without_waiting_for_the_browser() {
        let (socket, mut peer) = UnixStream::pair().unwrap();
        let filler = saturate(&socket);
        let publisher = Publishing::new(socket, |_| {}).unwrap();
        publisher.publish(head(1, Target::Compact));
        let (ended, completion) = mpsc::channel();
        let writing = publisher.clone();
        std::thread::spawn(move || {
            let _ = writing.send(&serde_json::json!({"type":"response", "id":1}));
            ended.send(()).unwrap();
        });
        publisher.stop();
        completion.recv_timeout(Duration::from_secs(2)).unwrap();
        peer.read_exact(&mut vec![0; filler]).unwrap();
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
    }
    #[test]
    fn a_partial_frame_is_finished_before_an_unrelated_message() {
        let (socket, mut peer) = UnixStream::pair().unwrap();
        let publisher = Publishing::new(socket, |_| {}).unwrap();
        let head = head(1, Target::Main);
        let mut bytes = serde_json::to_vec(&serde_json::json!({"type":"foreground", "head":head})).unwrap();
        bytes.push(b'\n');
        {
            let mut writer = publisher.writer.lock().unwrap();
            writer.socket.write_all(&bytes[..9]).unwrap();
            writer.partial = Some(Frame { bytes: bytes.clone(), offset: 9, head: Some(head) });
        }
        publisher.send(&serde_json::json!({"type":"response", "id":1})).unwrap();
        let mut actual = vec![0; bytes.len()];
        peer.read_exact(&mut actual).unwrap();
        assert_eq!(actual, bytes);
        let mut line = String::new();
        BufReader::new(peer).read_line(&mut line).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&line).unwrap()["type"], "response");
        publisher.stop();
    }
    #[test]
    fn ordinary_replies_are_bounded_and_never_block_the_ipc_reader() {
        let (socket, _peer) = UnixStream::pair().unwrap();
        let publisher = Publishing::new(socket, |_| {}).unwrap();
        let _writer = publisher.writer.lock().unwrap();
        for id in 0..32 {
            publisher.send(&serde_json::json!({"type":"response", "id":id})).unwrap();
        }
        assert_eq!(publisher.pending.lock().unwrap().messages.len(), 32);
        assert!(publisher.send(&serde_json::json!({"type":"response", "id":32})).is_err());
        assert!(publisher.pending.lock().unwrap().stopped);
    }
}
