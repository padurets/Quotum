//! A bounded append journal for undelivered completed intervals, never a second history store.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::clock::Epoch;
use super::{BODY_BYTES, Batch, Frame, Loss, MAX_FRAMES, SAFE_INTEGER, State, Witness};
use crate::model::Millis;

const SEGMENT_BYTES: u64 = 1024 * 1024;
const QUEUE_BYTES: u64 = 64 * 1024 * 1024;
const MANIFEST_BYTES: usize = 64 * 1024;
const METADATA_BYTES: usize = 256 * 1024;
const MAX_SEGMENTS: usize = 128;
const MAX_METADATA: usize = 256;
const AGE_MS: Millis = 7 * 86_400_000;

fn invalid() -> io::Error {
    io::ErrorKind::InvalidData.into()
}

fn plain(path: &Path, write: bool, create: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(write).create_new(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .share_mode(if path.file_name().is_some_and(|name| name == "writer.lock" || name == "budget.lock") {
                0
            } else {
                7
            })
            .custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file.metadata()?.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
    }
    Ok(file)
}

pub(super) fn directory(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid());
        }
    }
    Ok(())
}

fn sync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) fn atomic(path: &Path, value: &impl Serialize, cap: usize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
    if bytes.len() > cap {
        return Err(invalid());
    }
    if fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(invalid());
    }
    let temp = path.with_extension("tmp");
    match plain(&temp, false, false) {
        Ok(file) => {
            drop(file);
            fs::remove_file(&temp)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut file = plain(&temp, true, true)?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        sync_dir(path.parent().ok_or_else(invalid)?)
    })();
    if temp.exists() {
        let _ = fs::remove_file(&temp);
    }
    result
}

pub(super) fn read_json<T: serde::de::DeserializeOwned>(path: &Path, cap: usize) -> io::Result<T> {
    let file = plain(path, false, false)?;
    if file.metadata()?.len() > cap as u64 {
        return Err(invalid());
    }
    serde_json::from_reader(file.take(cap as u64 + 1)).map_err(|_| invalid())
}

fn write_payload(file: &mut File, value: &impl Serialize) -> io::Result<()> {
    let mut length = PayloadLength(0);
    serde_json::to_writer(&mut length, value).map_err(|_| invalid())?;
    file.write_all(&(length.0 as u32).to_be_bytes())?;
    let hashing = PayloadWriter { file, hash: Sha256::new() };
    let mut buffered = BufWriter::with_capacity(length.0.clamp(1, 64 * 1024), hashing);
    serde_json::to_writer(&mut buffered, value).map_err(|_| invalid())?;
    buffered.flush()?;
    let mut writer = buffered.into_inner().map_err(|_| invalid())?;
    let checksum = std::mem::take(&mut writer.hash).finalize();
    writer.file.write_all(&checksum)
}

struct PayloadLength(usize);
impl Write for PayloadLength {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let size = self.0.checked_add(bytes.len()).ok_or_else(invalid)?;
        if size > BODY_BYTES {
            return Err(invalid());
        }
        self.0 = size;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct PayloadWriter<'a> {
    file: &'a mut File,
    hash: Sha256,
}
impl Write for PayloadWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let size = self.file.write(bytes)?;
        self.hash.update(&bytes[..size]);
        Ok(size)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn read_payload<T: serde::de::DeserializeOwned>(file: &mut File) -> io::Result<Option<T>> {
    let mut length = [0; 4];
    let at = file.stream_position()?;
    if file.read(&mut length[..1])? == 0 {
        return Ok(None);
    }
    file.read_exact(&mut length[1..])?;
    let length = u32::from_be_bytes(length) as usize;
    if length > BODY_BYTES {
        return Err(invalid());
    }
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)?;
    let mut checksum = [0; 32];
    file.read_exact(&mut checksum)?;
    if Sha256::digest(&bytes)[..] != checksum {
        file.seek(SeekFrom::Start(at))?;
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| invalid())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Binding {
    pub hub_id: String,
    pub device_id: String,
    pub authority_epoch: String,
    pub floor_at: Millis,
}

#[derive(Clone, Serialize, Deserialize)]
struct Segment {
    first: u64,
    last: u64,
    clock: String,
    witness: Option<String>,
    bytes: u64,
    end_tick: u64,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u8,
    namespace: String,
    queue_id: String,
    open_id: String,
    binding: Option<Binding>,
    next_seq: u64,
    ack: u64,
    segments: Vec<Segment>,
    losses: Vec<Loss>,
    #[serde(default)]
    privacy_revision: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Metadata {
    pub clocks: BTreeMap<String, Epoch>,
    pub witnesses: BTreeMap<String, Witness>,
    pub releases: Vec<String>,
    pub active_clock: Option<String>,
    pub active_witness: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Header {
    version: u8,
    namespace: String,
    queue_id: String,
    clock: String,
    witness: Option<String>,
    state: Arc<State>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Raw {
    pub seq: u64,
    pub capture_epoch: String,
    pub clock_epoch: String,
    pub from_tick: u64,
    pub to_tick: u64,
    pub from_wall: Millis,
    pub to_wall: Millis,
    pub base_state_digest: String,
    pub next_state: Option<Arc<State>>,
    pub complete: bool,
}

pub(crate) struct Outbox {
    root: PathBuf,
    manifest: Manifest,
    pub metadata: Metadata,
    current: Option<File>,
    tail_digest: Option<String>,
    _lock: File,
    _budget: Option<File>,
    limit: u64,
}

impl Drop for Outbox {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // A concurrent client fork may retain the description until exec. It owns no writer.
            for file in std::iter::once(&self._lock).chain(self._budget.iter()) {
                // SAFETY: these regular-file descriptors remain pinned during explicit release.
                unsafe {
                    libc::flock(file.as_raw_fd(), libc::LOCK_UN);
                }
            }
        }
    }
}

impl Outbox {
    pub fn open_bounded(parent: PathBuf, namespace: String) -> io::Result<Self> {
        if namespace.len() != 64 || !namespace.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err(invalid());
        }
        directory(&parent)?;
        let budget_path = parent.join("budget.lock");
        let budget = match plain(&budget_path, true, true) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => plain(&budget_path, true, false)?,
            Err(e) => return Err(e),
        };
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: the directory budget has one pinned regular-file owner.
            if unsafe { libc::flock(budget.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let mut others = Vec::new();
        let mut other_bytes = 0;
        for entry in fs::read_dir(&parent)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "budget.lock" || name == namespace {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if name.len() != 64
                || !name.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !metadata.is_dir()
                || metadata.file_type().is_symlink()
                || others.len() >= 64
            {
                return Err(invalid());
            }
            let manifest: Manifest = read_json(&entry.path().join("manifest.json"), MANIFEST_BYTES)?;
            if manifest.namespace != name || manifest.version != 1 {
                return Err(invalid());
            }
            let bytes = Self::directory_bytes(&entry.path())?;
            other_bytes += bytes;
            others.push((metadata.modified()?, entry.path(), name, bytes));
        }
        others.sort_by_key(|entry| entry.0);
        for (_, path, name, bytes) in others {
            if other_bytes + 2 * SEGMENT_BYTES + 4096 <= QUEUE_BYTES {
                break;
            }
            let mut old = Self::open(path, name)?;
            old.retire_all("overflow")?;
            old.metadata.active_clock = None;
            old.metadata.active_witness = None;
            old.metadata_gc()?;
            other_bytes = other_bytes - bytes + old.physical_bytes()?;
        }
        let mut out = Self::open(parent.join(&namespace), namespace)?;
        out.limit = QUEUE_BYTES.checked_sub(other_bytes + 4096).ok_or_else(invalid)?;
        out._budget = Some(budget);
        out.make_room(0, 0)?;
        Ok(out)
    }

    pub fn open(root: PathBuf, namespace: String) -> io::Result<Self> {
        directory(&root)?;
        let lock_path = root.join("writer.lock");
        let lock = match plain(&lock_path, true, true) {
            Ok(f) => f,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => plain(&lock_path, true, false)?,
            Err(e) => return Err(e),
        };
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: the regular file remains pinned until the writer is dropped.
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let file = root.join("manifest.json");
        let manifest = match read_json::<Manifest>(&file, MANIFEST_BYTES) {
            Ok(m)
                if m.version == 1
                    && m.namespace == namespace
                    && m.next_seq > m.ack
                    && m.next_seq <= SAFE_INTEGER
                    && m.segments.len() <= MAX_SEGMENTS =>
            {
                m
            }
            Ok(_) => return Err(invalid()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                // A lost manifest cannot silently reuse a sequence in an existing journal.
                if fs::read_dir(&root)?
                    .any(|entry| entry.is_ok_and(|e| e.file_name().to_string_lossy().ends_with(".segment")))
                {
                    return Err(invalid());
                }
                let m = Manifest {
                    version: 1,
                    namespace,
                    queue_id: crate::config::random_hex(),
                    open_id: crate::config::random_hex(),
                    binding: None,
                    next_seq: 1,
                    ack: 0,
                    segments: Vec::new(),
                    losses: Vec::new(),
                    privacy_revision: None,
                };
                atomic(&file, &m, MANIFEST_BYTES)?;
                m
            }
            Err(e) => return Err(e),
        };
        let metadata = match read_json(&root.join("metadata.json"), METADATA_BYTES) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Metadata::default(),
            Err(e) => return Err(e),
        };
        let mut out = Self {
            root,
            manifest,
            metadata,
            current: None,
            tail_digest: None,
            _lock: lock,
            _budget: None,
            limit: QUEUE_BYTES,
        };
        if out.metadata.clocks.len() > MAX_METADATA || out.metadata.witnesses.len() > MAX_METADATA {
            return Err(invalid());
        }
        if out.physical_bytes()? > QUEUE_BYTES + SEGMENT_BYTES + 2 * METADATA_BYTES as u64 {
            return Err(invalid());
        }
        out.recover()?;
        Ok(out)
    }

    pub fn queue_id(&self) -> &str {
        &self.manifest.queue_id
    }
    pub fn open_id(&self) -> &str {
        &self.manifest.open_id
    }
    pub fn ack(&self) -> u64 {
        self.manifest.ack
    }
    pub fn next_sequence(&self) -> u64 {
        self.manifest.next_seq
    }
    pub fn rewind_acknowledgement(&mut self, through: u64) -> io::Result<()> {
        let old = self.manifest.ack;
        if through >= old {
            return Err(invalid());
        }
        self.manifest.ack = through;
        // A verified hub backup lost its cursor. Deleted payloads cannot become work again.
        self.lose(through + 1, old, "recovery")
    }
    pub fn retire_all(&mut self, reason: &str) -> io::Result<()> {
        self.lose(self.manifest.ack + 1, self.manifest.next_seq - 1, reason)
    }

    pub fn retire_since(&mut self, first: u64) -> io::Result<()> {
        self.lose(first, self.manifest.next_seq - 1, "recovery")
    }

    pub fn apply_privacy(&mut self, revision: String) -> io::Result<()> {
        if self.manifest.privacy_revision.as_ref() != Some(&revision) {
            self.retire_all("privacy")?;
            self.manifest.privacy_revision = Some(revision);
            self.save()?;
        }
        Ok(())
    }
    pub fn binding(&self) -> Option<&Binding> {
        self.manifest.binding.as_ref()
    }
    fn file(&self, first: u64) -> PathBuf {
        self.root.join(format!("{first:016x}.segment"))
    }
    fn save(&self) -> io::Result<()> {
        atomic(&self.root.join("manifest.json"), &self.manifest, MANIFEST_BYTES)
    }
    pub fn save_metadata(&self) -> io::Result<()> {
        atomic(&self.root.join("metadata.json"), &self.metadata, METADATA_BYTES)
    }

    pub fn bind(&mut self, binding: Binding) -> io::Result<()> {
        if self.manifest.binding.as_ref().is_some_and(|old| {
            old.hub_id != binding.hub_id
                || old.device_id != binding.device_id
                || old.authority_epoch != binding.authority_epoch
        }) {
            return Err(invalid());
        }
        self.manifest.binding = Some(binding);
        self.save()
    }

    fn recover(&mut self) -> io::Result<()> {
        let mut corrupt = None;
        for (index, segment) in self.manifest.segments.iter().enumerate() {
            let mut file = match plain(&self.file(segment.first), true, false) {
                Ok(file) => file,
                Err(e) if e.kind() == io::ErrorKind::NotFound => {
                    corrupt = Some((index, segment.first, 0, segment.end_tick));
                    break;
                }
                Err(e) => return Err(e),
            };
            if file.metadata()?.len() > SEGMENT_BYTES + 2 * BODY_BYTES as u64 {
                return Err(invalid());
            }
            let header: Header = match read_payload(&mut file) {
                Ok(Some(header)) => header,
                _ => {
                    corrupt = Some((index, segment.first, 0, segment.end_tick));
                    break;
                }
            };
            if header.version != 1
                || header.namespace != self.manifest.namespace
                || header.queue_id != self.manifest.queue_id
                || header.clock != segment.clock
                || header.witness != segment.witness
            {
                return Err(invalid());
            }
            let mut expected = segment.first;
            let mut end_tick = segment.end_tick;
            loop {
                let start = file.stream_position()?;
                match read_payload::<Raw>(&mut file) {
                    Ok(Some(raw)) if raw.seq == expected && raw.seq <= segment.last => {
                        if let Some(epoch) = self.metadata.clocks.get_mut(&raw.clock_epoch) {
                            epoch.last_tick = epoch.last_tick.max(epoch.zero_tick.saturating_add(raw.to_tick));
                        }
                        end_tick = raw.to_tick;
                        expected += 1;
                    }
                    Ok(None) if expected == segment.last + 1 => break,
                    // Bytes beyond the published commit were never durable observations.
                    Ok(Some(raw)) if raw.seq > segment.last && expected == segment.last + 1 => {
                        file.set_len(start)?;
                        file.sync_all()?;
                        break;
                    }
                    _ if expected == segment.last + 1 => {
                        file.set_len(start)?;
                        file.sync_all()?;
                        break;
                    }
                    _ => {
                        corrupt = Some((index, expected, start, end_tick));
                        break;
                    }
                }
            }
            if corrupt.is_some() {
                break;
            }
        }
        if let Some((index, first, position, end_tick)) = corrupt {
            let segment = &self.manifest.segments[index];
            if first > segment.first {
                let file = plain(&self.file(segment.first), true, false)?;
                file.set_len(position)?;
                file.sync_all()?;
                self.manifest.segments[index].last = first - 1;
                self.manifest.segments[index].bytes = position;
                self.manifest.segments[index].end_tick = end_tick;
            }
            self.lose(first, self.manifest.next_seq - 1, "corruption")?;
        }
        let mut entries = 0;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            entries += 1;
            if entries > MAX_SEGMENTS + 16 {
                return Err(invalid());
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(hex) = name.strip_suffix(".segment") else {
                continue;
            };
            if hex.len() != 16 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(invalid());
            }
            let first = u64::from_str_radix(hex, 16).map_err(|_| invalid())?;
            if self.manifest.segments.iter().any(|s| s.first == first) {
                continue;
            }
            let mut file = plain(&entry.path(), false, false)?;
            if first < self.manifest.next_seq {
                let header: Header = read_payload(&mut file)?.ok_or_else(invalid)?;
                if header.namespace != self.manifest.namespace || header.queue_id != self.manifest.queue_id {
                    return Err(invalid());
                }
            }
            drop(file);
            fs::remove_file(entry.path())?;
        }
        self.collect()?;
        Ok(())
    }

    fn lose(&mut self, first: u64, last: u64, reason: &str) -> io::Result<()> {
        if last < first || last <= self.manifest.ack {
            return Ok(());
        }
        self.current = None;
        let mut loss = Loss {
            first_seq: first.max(self.manifest.ack + 1),
            last_seq: last,
            from_at: None,
            to_at: None,
            reason: reason.into(),
        };
        self.manifest.losses.retain(|old| {
            if old.last_seq.saturating_add(1) >= loss.first_seq && old.first_seq <= loss.last_seq.saturating_add(1) {
                loss.first_seq = loss.first_seq.min(old.first_seq);
                loss.last_seq = loss.last_seq.max(old.last_seq);
                false
            } else {
                true
            }
        });
        self.manifest.losses.push(loss);
        self.manifest.losses.sort_by_key(|l| l.first_seq);
        if self.manifest.losses.len() > MAX_METADATA {
            let last = self.manifest.losses.last().unwrap().last_seq;
            self.manifest.losses = vec![Loss {
                first_seq: self.manifest.ack + 1,
                last_seq: last,
                from_at: None,
                to_at: None,
                reason: "overflow".into(),
            }];
        }
        // Publish loss before reclaiming any bytes. A crash can only repeat the declaration.
        self.save()?;
        self.collect()
    }

    fn discarded(&self, segment: &Segment) -> bool {
        segment.last <= self.manifest.ack
            || self.manifest.losses.iter().any(|l| l.first_seq <= segment.first && l.last_seq >= segment.last)
    }

    fn collect(&mut self) -> io::Result<()> {
        let removed: Vec<_> = self.manifest.segments.iter().filter(|s| self.discarded(s)).map(|s| s.first).collect();
        if removed.is_empty() {
            return Ok(());
        }
        self.current = None;
        self.manifest.segments.retain(|s| !removed.contains(&s.first));
        self.save()?;
        for first in removed {
            match fs::remove_file(self.file(first)) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        sync_dir(&self.root)?;
        self.metadata_gc()
    }

    pub fn metadata_gc(&mut self) -> io::Result<()> {
        let before = (self.metadata.clocks.len(), self.metadata.releases.len());
        self.metadata.clocks.retain(|id, _| {
            self.metadata.active_clock.as_ref() == Some(id) || self.manifest.segments.iter().any(|s| s.clock == *id)
        });
        let released: Vec<_> = self
            .metadata
            .witnesses
            .keys()
            .filter(|id| {
                self.metadata.active_witness.as_ref() != Some(id)
                    && !self.manifest.segments.iter().any(|s| s.witness.as_ref() == Some(id))
            })
            .cloned()
            .collect();
        for id in released {
            if !self.metadata.releases.contains(&id) {
                self.metadata.releases.push(id);
            }
        }
        if before != (self.metadata.clocks.len(), self.metadata.releases.len()) {
            self.save_metadata()?;
        }
        Ok(())
    }

    pub fn install_clock(&mut self, epoch: Epoch) -> io::Result<()> {
        self.metadata.active_clock = Some(epoch.id.clone());
        self.metadata_gc()?;
        while self.metadata.clocks.len() >= MAX_METADATA && !self.metadata.clocks.contains_key(&epoch.id) {
            let Some(first) = self.manifest.segments.first().cloned() else {
                return Err(invalid());
            };
            self.lose(self.manifest.ack + 1, first.last, "overflow")?;
        }
        self.metadata.clocks.insert(epoch.id.clone(), epoch);
        self.save_metadata()
    }

    pub fn retire_unanchored(&mut self, clock: &str) -> io::Result<()> {
        if self.metadata.clocks.get(clock).is_some_and(|e| e.anchor.is_some()) {
            return Ok(());
        }
        let first = self.manifest.segments.iter().find(|s| s.clock == clock).map(|s| s.first);
        let last = self.manifest.segments.iter().rfind(|s| s.clock == clock).map(|s| s.last);
        if let Some((first, last)) = first.zip(last) {
            self.lose(first, last, "clock")?;
        }
        Ok(())
    }

    pub fn install_witness(&mut self, witness: Option<Witness>) -> io::Result<bool> {
        self.metadata.active_witness = witness.as_ref().map(|w| w.id.clone());
        self.metadata_gc()?;
        if let Some(w) = witness {
            if self.metadata.releases.contains(&w.id)
                || self.metadata.witnesses.len() >= MAX_METADATA && !self.metadata.witnesses.contains_key(&w.id)
            {
                self.metadata.active_witness = None;
                self.save_metadata()?;
                return Ok(false);
            }
            self.metadata.active_witness = Some(w.id.clone());
            self.metadata.witnesses.insert(w.id.clone(), w);
        }
        self.save_metadata()?;
        Ok(true)
    }

    pub fn append(&mut self, state: &State, raw: Raw, witness: Option<String>) -> io::Result<u64> {
        self.append_transaction(vec![(Arc::new(state.clone()), raw, witness)])
    }

    pub fn append_transaction(&mut self, records: Vec<(Arc<State>, Raw, Option<String>)>) -> io::Result<u64> {
        if records.is_empty() || records.len() > 8 || self.manifest.next_seq + records.len() as u64 >= SAFE_INTEGER {
            return Err(invalid());
        }
        let mut reserve = 0;
        for (state, raw, _) in &records {
            if raw.to_tick < raw.from_tick || raw.to_tick - raw.from_tick > super::MAX_FRAME_MS {
                return Err(invalid());
            }
            let size = serde_json::to_vec(raw).map_err(|_| invalid())?.len()
                + serde_json::to_vec(state).map_err(|_| invalid())?.len()
                + super::BODY_RESERVE_BYTES;
            if size > BODY_BYTES {
                return Err(invalid());
            }
            reserve += size as u64;
        }
        self.make_room(reserve, records.len())?;
        let mut seq = 0;
        for (state, mut raw, witness) in records {
            raw.seq = self.manifest.next_seq;
            seq = raw.seq;
            self.write_raw(&state, &raw, witness)?;
            self.manifest.next_seq = seq + 1;
        }
        self.save()?;
        Ok(seq)
    }

    fn write_raw(&mut self, state: &Arc<State>, raw: &Raw, witness: Option<String>) -> io::Result<()> {
        let size = serde_json::to_vec(raw).map_err(|_| invalid())?.len();
        let state_digest = state.digest();
        let rotate = self.current.is_none()
            || self.tail_digest.as_deref() != Some(state_digest.as_str())
            || self.manifest.segments.last().is_none_or(|s| {
                s.clock != raw.clock_epoch || s.witness != witness || s.bytes + size as u64 > SEGMENT_BYTES
            });
        if rotate {
            let path = self.file(raw.seq);
            let mut file = plain(&path, true, true)?;
            write_payload(
                &mut file,
                &Header {
                    version: 1,
                    namespace: self.manifest.namespace.clone(),
                    queue_id: self.manifest.queue_id.clone(),
                    clock: raw.clock_epoch.clone(),
                    witness: witness.clone(),
                    state: state.clone(),
                },
            )?;
            let bytes = file.stream_position()?;
            self.manifest.segments.push(Segment {
                first: raw.seq,
                last: raw.seq,
                clock: raw.clock_epoch.clone(),
                witness,
                bytes,
                end_tick: raw.to_tick,
            });
            self.current = Some(file);
        }
        let file = self.current.as_mut().ok_or_else(invalid)?;
        write_payload(file, raw)?;
        file.sync_all()?;
        let last = self.manifest.segments.last_mut().ok_or_else(invalid)?;
        last.last = raw.seq;
        last.bytes = file.stream_position()?;
        last.end_tick = raw.to_tick;
        self.tail_digest = Some(raw.next_state.as_ref().unwrap_or(state).digest());
        Ok(())
    }

    fn physical_bytes(&self) -> io::Result<u64> {
        Self::directory_bytes(&self.root)
    }

    fn directory_bytes(root: &Path) -> io::Result<u64> {
        let mut bytes = 0;
        let mut count = 0;
        for entry in fs::read_dir(root)? {
            count += 1;
            if count > MAX_SEGMENTS + 16 {
                return Err(invalid());
            }
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(invalid());
            }
            bytes += metadata.len();
        }
        Ok(bytes)
    }

    fn make_room(&mut self, reserve: u64, slots: usize) -> io::Result<()> {
        while self.physical_bytes()?.saturating_add(reserve + 2 * METADATA_BYTES as u64) > self.limit
            || self.manifest.segments.len() + slots > MAX_SEGMENTS
        {
            let Some(first) = self.manifest.segments.first().cloned() else {
                return Err(invalid());
            };
            self.lose(self.manifest.ack + 1, first.last, "overflow")?;
        }
        Ok(())
    }

    pub fn expire(&mut self, now: Millis) -> io::Result<()> {
        let mut through = None;
        for segment in &self.manifest.segments {
            let Some(epoch) = self.metadata.clocks.get(&segment.clock) else {
                break;
            };
            let Some(anchor) = epoch.anchor.as_ref() else {
                break;
            };
            if anchor.project(segment.end_tick).is_none_or(|at| at >= now - AGE_MS) {
                break;
            }
            through = Some(segment.last);
        }
        if let Some(last) = through {
            self.lose(self.manifest.ack + 1, last, "age")?;
        }
        Ok(())
    }

    pub fn prepare(&self) -> io::Result<Batch> {
        let next = self.manifest.ack + 1;
        let skip = self.manifest.losses.iter().find(|l| l.first_seq <= next && l.last_seq >= next).cloned();
        let start = skip.as_ref().map_or(next, |l| l.last_seq + 1);
        let mut batch = Batch {
            clock_anchor: None,
            topology_witness_id: None,
            checkpoint: None,
            frames: Vec::new(),
            skip,
            release_witnesses: self.metadata.releases.iter().take(64).cloned().collect(),
        };
        let mut tail_state: Option<String> = None;
        for segment in self.manifest.segments.iter().filter(|s| s.last >= start && !self.discarded(s)) {
            if !batch.frames.is_empty()
                && (batch.clock_anchor.as_ref().is_none_or(|a| a.clock_epoch != segment.clock)
                    || batch.topology_witness_id != segment.witness)
            {
                break;
            }
            let Some(epoch) = self.metadata.clocks.get(&segment.clock) else {
                break;
            };
            let Some(anchor) = epoch.anchor.as_ref() else {
                break;
            };
            let mut file = plain(&self.file(segment.first), false, false)?;
            let header: Header = read_payload(&mut file)?.ok_or_else(invalid)?;
            let mut raw_digest = header.state.digest();
            if tail_state.as_ref().is_some_and(|digest| *digest != raw_digest) {
                break;
            }
            let mut state = epoch.utc_state(header.state).ok_or_else(invalid)?;
            let mut wire_digest = state.digest();
            while let Some(raw) = read_payload::<Raw>(&mut file)? {
                if raw.seq > segment.last {
                    break;
                }
                if raw.base_state_digest != raw_digest {
                    return Err(invalid());
                }
                let next_digest = raw.next_state.as_ref().map(|s| s.digest());
                let next = raw.next_state.map(|s| epoch.utc_state(s).ok_or_else(invalid)).transpose()?;
                if raw.seq < start {
                    if let Some(next) = next {
                        state = next;
                        wire_digest = state.digest();
                        raw_digest = next_digest.unwrap();
                    }
                    continue;
                }
                if self.manifest.losses.iter().any(|l| l.first_seq <= raw.seq && l.last_seq >= raw.seq) {
                    return Ok(batch);
                }
                if batch.frames.is_empty() {
                    batch.clock_anchor = Some(anchor.clone());
                    batch.topology_witness_id = segment.witness.clone();
                    batch.checkpoint = Some(state.clone());
                }
                let frame = Frame {
                    seq: raw.seq,
                    capture_epoch: raw.capture_epoch,
                    clock_epoch: raw.clock_epoch,
                    from_at: anchor.project(raw.from_tick).ok_or_else(invalid)?,
                    to_at: anchor.project(raw.to_tick).ok_or_else(invalid)?,
                    from_tick: raw.from_tick,
                    to_tick: raw.to_tick,
                    base_state_digest: wire_digest.clone(),
                    next_state: next,
                    complete: raw.complete,
                };
                if let Some(next) = frame.next_state.as_ref() {
                    state = next.clone();
                    wire_digest = state.digest();
                    raw_digest = next_digest.unwrap();
                }
                tail_state = Some(raw_digest.clone());
                batch.frames.push(frame);
                if serde_json::to_vec(&batch).map_err(|_| invalid())?.len() + 4096 > BODY_BYTES {
                    batch.frames.pop();
                    return Ok(batch);
                }
                if batch.frames.len() == MAX_FRAMES {
                    return Ok(batch);
                }
            }
        }
        Ok(batch)
    }

    pub fn acknowledge(&mut self, through: u64, released: &[String]) -> io::Result<()> {
        if through < self.manifest.ack || through >= self.manifest.next_seq {
            return Err(invalid());
        }
        self.manifest.ack = through;
        self.manifest.losses.retain(|l| l.last_seq > through);
        self.save()?;
        let mut changed = false;
        for id in released {
            if self.metadata.releases.contains(id) {
                self.metadata.witnesses.remove(id);
                self.metadata.releases.retain(|old| old != id);
                changed = true;
            }
        }
        if changed {
            self.save_metadata()?;
        }
        self.collect()?;
        self.metadata_gc()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observed::clock::Reading;
    use crate::observed::{Context, Scope};

    struct Stand(PathBuf);
    impl Stand {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("quotum-observed-{}", crate::config::random_hex())))
        }
        fn open(&self) -> Outbox {
            Outbox::open(self.0.clone(), "test-namespace".into()).unwrap()
        }
    }
    impl Drop for Stand {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn state() -> State {
        State {
            tracking: Scope { version: 1, clients: vec!["codex".into()], route_disabled: vec![], complete: true },
            contexts: vec![Context {
                context_id: "1".repeat(32),
                client_id: "codex".into(),
                session_id: Some("2".repeat(32)),
                ordinal: None,
                source: None,
                account_by: None,
                origin: "terminal".into(),
                project: Some("fixture".into()),
                folder: None,
                started_at: 1_800_000_000_000,
                route: None,
                working: Some(true),
                last_worked_at: None,
            }],
        }
    }
    fn epoch() -> Epoch {
        let reading = Reading { boot: Some("test-boot".into()), tick: 0, wall: 1_800_000_000_000 };
        let mut e = Epoch::new(&reading);
        assert!(e.bind(&reading, reading.wall));
        e
    }
    fn raw(e: &Epoch, index: u64) -> Raw {
        Raw {
            seq: 0,
            capture_epoch: "3".repeat(32),
            clock_epoch: e.id.clone(),
            from_tick: index * 2000,
            to_tick: (index + 1) * 2000,
            from_wall: 1_800_000_000_000 + index as i64 * 2000,
            to_wall: 1_800_000_000_000 + (index + 1) as i64 * 2000,
            base_state_digest: state().digest(),
            next_state: None,
            complete: true,
        }
    }
    #[test]
    fn committed_intervals_reopen_with_the_same_sequence_payload_and_clock_mapping() {
        let stand = Stand::new();
        let mut q = stand.open();
        let e = epoch();
        q.install_clock(e.clone()).unwrap();
        for i in 0..60 {
            q.append(&state(), raw(&e, i), None).unwrap();
        }
        let before = serde_json::to_value(q.prepare().unwrap()).unwrap();
        let queue = q.queue_id().to_string();
        drop(q);
        let q = stand.open();
        assert_eq!(q.queue_id(), queue);
        assert_eq!(serde_json::to_value(q.prepare().unwrap()).unwrap(), before);
        assert!(q.physical_bytes().unwrap() < 40_000, "unchanged rosters use small extensions");
    }
    #[test]
    fn lost_ack_replays_an_immutable_prefix_and_ack_removes_only_committed_segments() {
        let stand = Stand::new();
        let mut q = stand.open();
        let e = epoch();
        q.install_clock(e.clone()).unwrap();
        q.append(&state(), raw(&e, 0), None).unwrap();
        let first = serde_json::to_value(q.prepare().unwrap()).unwrap();
        drop(q);
        let mut q = stand.open();
        assert_eq!(serde_json::to_value(q.prepare().unwrap()).unwrap(), first);
        q.acknowledge(1, &[]).unwrap();
        drop(q);
        let q = stand.open();
        assert_eq!(q.ack(), 1);
        assert!(q.prepare().unwrap().frames.is_empty());
        assert_eq!(q.manifest.next_seq, 2);
        assert!(q.manifest.segments.is_empty());
    }
    #[test]
    fn an_unsynced_truncated_tail_cannot_become_work_or_restart_sequence_one() {
        let stand = Stand::new();
        let mut q = stand.open();
        let e = epoch();
        q.install_clock(e.clone()).unwrap();
        q.append(&state(), raw(&e, 0), None).unwrap();
        let path = q.file(1);
        drop(q);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(&[0, 0, 8, 0, 1, 2, 3]).unwrap();
        drop(file);
        let mut q = stand.open();
        assert_eq!(q.prepare().unwrap().frames.len(), 1);
        assert_eq!(q.append(&state(), raw(&e, 1), None).unwrap(), 2);
    }
    #[test]
    fn corruption_in_a_committed_header_retires_the_suffix_explicitly() {
        for missing in [false, true] {
            let stand = Stand::new();
            let mut q = stand.open();
            let e = epoch();
            q.install_clock(e.clone()).unwrap();
            q.append(&state(), raw(&e, 0), None).unwrap();
            q.current = None;
            q.append(&state(), raw(&e, 1), None).unwrap();
            let path = q.file(2);
            drop(q);
            if missing {
                fs::remove_file(&path).unwrap();
            } else {
                let mut file = OpenOptions::new().write(true).open(&path).unwrap();
                file.seek(SeekFrom::Start(8)).unwrap();
                file.write_all(b"corrupt").unwrap();
            }
            let mut q = stand.open();
            assert_eq!(q.prepare().unwrap().frames.len(), 1);
            q.acknowledge(1, &[]).unwrap();
            let batch = q.prepare().unwrap();
            assert!(batch.frames.is_empty());
            assert_eq!(
                batch.skip.unwrap(),
                Loss { first_seq: 2, last_seq: 2, from_at: None, to_at: None, reason: "corruption".into() }
            );
        }
    }
    #[test]
    fn a_binding_fence_keeps_only_the_history_from_before_this_capture_run() {
        let stand = Stand::new();
        let mut q = stand.open();
        let e = epoch();
        q.install_clock(e.clone()).unwrap();
        q.append(&state(), raw(&e, 0), None).unwrap();
        let run = q.next_sequence();
        q.append(&state(), raw(&e, 1), None).unwrap();
        q.retire_since(run).unwrap();
        drop(q);
        let mut q = stand.open();
        assert_eq!(q.prepare().unwrap().frames.len(), 1);
        q.acknowledge(1, &[]).unwrap();
        let loss = q.prepare().unwrap().skip.unwrap();
        assert_eq!((loss.first_seq, loss.last_seq, loss.reason.as_str()), (2, 2, "recovery"));
    }
    #[test]
    fn a_failed_multi_record_capture_cannot_publish_its_first_half() {
        let stand = Stand::new();
        let mut q = stand.open();
        let e = epoch();
        q.install_clock(e.clone()).unwrap();
        let original = Arc::new(state());
        let mut changed = state();
        changed.tracking.complete = false;
        let changed = Arc::new(changed);
        let mut second = raw(&e, 1);
        second.base_state_digest = changed.digest();
        // A regular orphan at the second rotation forces a failure after the first fsync.
        fs::write(q.file(2), b"uncommitted").unwrap();
        assert!(q.append_transaction(vec![(original, raw(&e, 0), None), (changed, second, None)]).is_err());
        drop(q);
        let q = stand.open();
        assert_eq!(q.next_sequence(), 1);
        assert!(q.prepare().unwrap().frames.is_empty());
    }
    #[test]
    fn a_witness_release_ack_is_durable_even_without_any_payload_to_collect() {
        let stand = Stand::new();
        let mut q = stand.open();
        let first =
            Witness { id: "a".repeat(32), topology_version: 1, scope_digest: state().tracking.digest(), issued_at: 0 };
        q.install_witness(Some(first.clone())).unwrap();
        let second = Witness { id: "b".repeat(32), ..first.clone() };
        q.install_witness(Some(second.clone())).unwrap();
        assert_eq!(q.metadata.releases, vec![first.id.clone()]);
        q.acknowledge(0, std::slice::from_ref(&first.id)).unwrap();
        drop(q);
        let q = stand.open();
        assert!(q.metadata.releases.is_empty());
        assert!(!q.metadata.witnesses.contains_key(&first.id));
        assert_eq!(q.metadata.active_witness, Some(second.id));
    }
    #[test]
    fn a_verified_hub_rollback_declares_deleted_acknowledged_payload_unknown() {
        let stand = Stand::new();
        let mut q = stand.open();
        let e = epoch();
        q.install_clock(e.clone()).unwrap();
        for i in 0..3 {
            q.append(&state(), raw(&e, i), None).unwrap();
        }
        q.acknowledge(3, &[]).unwrap();
        assert!(q.manifest.segments.is_empty());
        q.append(&state(), raw(&e, 3), None).unwrap();
        q.rewind_acknowledgement(1).unwrap();
        drop(q);
        let mut q = stand.open();
        assert_eq!(q.ack(), 1);
        let batch = q.prepare().unwrap();
        let loss = batch.skip.unwrap();
        assert_eq!((loss.first_seq, loss.last_seq, loss.reason.as_str()), (2, 3, "recovery"));
        assert_eq!(batch.frames.iter().map(|f| f.seq).collect::<Vec<_>>(), vec![4]);
        q.acknowledge(4, &[]).unwrap();
        assert!(q.prepare().unwrap().skip.is_none());
        assert!(q.rewind_acknowledgement(4).is_err());
    }
    #[test]
    fn bounded_overflow_persists_unknown_loss_before_removing_the_oldest_prefix() {
        let stand = Stand::new();
        let mut q = stand.open();
        let e = epoch();
        q.install_clock(e.clone()).unwrap();
        // Force segment rotation and reclamation with a small bound, including metadata reserve.
        q.limit = 2 * METADATA_BYTES as u64 + 30_000;
        for i in 0..40 {
            q.current = None;
            q.append(&state(), raw(&e, i), None).unwrap();
        }
        let batch = q.prepare().unwrap();
        assert!(batch.skip.is_some());
        assert!(q.physical_bytes().unwrap() < q.limit);
        let skip = batch.skip.unwrap();
        assert_eq!(skip.first_seq, 1);
        assert_eq!(skip.from_at, None);
        assert_eq!(skip.reason, "overflow");
        drop(q);
        let q = stand.open();
        assert_eq!(q.prepare().unwrap().skip.unwrap().last_seq, skip.last_seq);
    }
    #[test]
    fn a_new_clock_bind_keeps_the_anchored_pending_prefix_unchanged() {
        let stand = Stand::new();
        let mut q = stand.open();
        let a = epoch();
        q.install_clock(a.clone()).unwrap();
        q.append(&state(), raw(&a, 0), None).unwrap();
        let before = q.prepare().unwrap().frames[0].from_at;
        let mut b = epoch();
        b.anchor.as_mut().unwrap().anchor_at += 100_000;
        q.install_clock(b.clone()).unwrap();
        q.append(&state(), raw(&b, 1), None).unwrap();
        drop(q);
        let mut q = stand.open();
        assert_eq!(q.prepare().unwrap().frames[0].from_at, before);
        assert_eq!(q.metadata.clocks.len(), 2);
        q.acknowledge(1, &[]).unwrap();
        assert_eq!(q.prepare().unwrap().clock_anchor.unwrap(), b.anchor.unwrap());
    }
    #[test]
    fn calibrated_dates_and_state_references_survive_reopen_without_rewriting_the_journal() {
        let stand = Stand::new();
        let mut q = stand.open();
        let server = 1_800_000_000_000;
        let reading = Reading { boot: Some("fixture".into()), tick: 0, wall: server + 120_000 };
        let mut e = Epoch::new(&reading);
        assert!(e.bind(&reading, server));
        q.install_clock(e.clone()).unwrap();
        let mut local = state();
        local.contexts[0].started_at = reading.wall - 1000;
        local.contexts[0].last_worked_at = Some(reading.wall - 500);
        let mut next = local.clone();
        next.contexts[0].working = Some(false);
        let mut first = raw(&e, 0);
        first.base_state_digest = local.digest();
        first.next_state = Some(Arc::new(next.clone()));
        q.append(&local, first, None).unwrap();
        let mut second = raw(&e, 1);
        second.base_state_digest = next.digest();
        q.append(&next, second, None).unwrap();
        let file = q.file(1);
        let original = fs::read(&file).unwrap();
        let batch = q.prepare().unwrap();
        let checkpoint = batch.checkpoint.as_ref().unwrap();
        assert_eq!(checkpoint.contexts[0].started_at, server - 1000);
        assert_eq!(checkpoint.contexts[0].last_worked_at, Some(server - 500));
        assert_eq!(batch.frames[0].from_at, server);
        assert_eq!(batch.frames[0].base_state_digest, checkpoint.digest());
        assert_eq!(batch.frames[1].base_state_digest, batch.frames[0].next_state.as_ref().unwrap().digest());
        let expected = serde_json::to_value(&batch).unwrap();
        drop(q);
        let q = stand.open();
        assert_eq!(serde_json::to_value(q.prepare().unwrap()).unwrap(), expected);
        assert_eq!(fs::read(file).unwrap(), original);
    }
    #[test]
    fn a_different_remote_binding_cannot_reuse_private_observations() {
        let stand = Stand::new();
        let mut q = stand.open();
        let b = Binding {
            hub_id: "a".repeat(32),
            device_id: "b".repeat(32),
            authority_epoch: "c".repeat(32),
            floor_at: 1000,
        };
        q.bind(b.clone()).unwrap();
        assert!(q.bind(Binding { device_id: "d".repeat(32), ..b }).is_err());
    }
    #[test]
    fn only_one_writer_owns_a_namespace() {
        let stand = Stand::new();
        let _q = stand.open();
        assert!(Outbox::open(stand.0.clone(), "test-namespace".into()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_child_between_fork_and_exec_cannot_keep_a_retired_writer_lock() {
        use std::os::fd::AsRawFd;
        let stand = Stand::new();
        let q = stand.open();
        // SAFETY: fcntl reads flags of a pinned descriptor.
        assert_ne!(unsafe { libc::fcntl(q._lock.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
        let mut pipe = [0; 2];
        // SAFETY: the output array owns exactly two descriptors.
        assert_eq!(unsafe { libc::pipe(pipe.as_mut_ptr()) }, 0);
        // The child performs only async-signal-safe I/O and _exit before exec.
        let pid = unsafe { libc::fork() };
        assert!(pid >= 0);
        if pid == 0 {
            let mut byte = 0u8;
            // SAFETY: the inherited pipe and one-byte stack buffer remain valid.
            unsafe {
                libc::close(pipe[1]);
                libc::read(pipe[0], (&raw mut byte).cast(), 1);
                libc::_exit(0);
            }
        }
        // The child still owns its inherited lock descriptor while its pipe is open.
        unsafe {
            libc::close(pipe[0]);
        }
        drop(q);
        let reopened = Outbox::open(stand.0.clone(), "test-namespace".into());
        // SAFETY: this parent closes its pipe and reaps only its own un-reaped child.
        unsafe {
            libc::close(pipe[1]);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        assert!(reopened.is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn linked_and_pipe_state_never_gets_opened_or_removed() {
        use std::os::unix::fs::symlink;
        let stand = Stand::new();
        directory(&stand.0).unwrap();
        let outside = stand.0.with_extension("outside");
        fs::write(&outside, b"private").unwrap();
        symlink(&outside, stand.0.join("manifest.json")).unwrap();
        assert!(Outbox::open(stand.0.clone(), "test-namespace".into()).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"private");
        fs::remove_file(outside).unwrap();
    }
}
