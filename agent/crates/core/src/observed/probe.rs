//! Explicit isolated probes for recovery, capture cost and the actual Runner lifecycle.

use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::State;
use super::clock::Epoch;
use super::outbox::{Binding, Outbox, Raw};
use crate::activity::Activity;
use crate::config::{Config, Hub, Paths};
use crate::model::{ErrorKind, Failure, Machine, Outcome, Provider};
use crate::providers::{Collector, Context};
use crate::runner::Runner;
use crate::sink::HubSink;
use crate::stop::{How, Stop};

pub(crate) static CONTEXT_CPU_NS: AtomicU64 = AtomicU64::new(0);
type Costs = std::collections::BTreeMap<&'static str, Vec<(u64, f64, f64)>>;
static COSTS: OnceLock<Mutex<Costs>> = OnceLock::new();
static RUN_START: OnceLock<Instant> = OnceLock::new();
static SYNC_DELAYED: AtomicBool = AtomicBool::new(false);
pub(crate) fn before_sync() {
    let Some(start) = RUN_START.get() else {
        return;
    };
    if start.elapsed() < Duration::from_secs(45) || SYNC_DELAYED.load(Ordering::Relaxed) {
        return;
    }
    let delay = std::env::var("OBSERVED_SYNC_DELAY_MS").ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0).min(5000);
    if delay > 0 && !SYNC_DELAYED.swap(true, Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(delay));
    }
}
pub(crate) fn cost(name: &'static str, cpu_ns: u64, wall_ms: f64) {
    let mut costs = COSTS.get_or_init(Mutex::default).lock().unwrap();
    let entries = costs.entry(name).or_default();
    if entries.len() < 4096 {
        entries.push((cpu_ns, wall_ms, RUN_START.get().map_or(0.0, |at| at.elapsed().as_secs_f64() * 1000.0)));
    }
}
fn costs() -> Value {
    let costs = COSTS.get_or_init(Mutex::default).lock().unwrap();
    let rows = costs.iter().map(|(name, entries)| {
        let mut cpu: Vec<_> = entries.iter().map(|v| v.0 as f64 / 1e6).collect();
        let mut wall: Vec<_> = entries.iter().map(|v| v.1).collect();
        cpu.sort_by(f64::total_cmp);
        wall.sort_by(f64::total_cmp);
            (name.to_string(), json!({"count":cpu.len(),"periodsMs":entries.windows(2).map(|v|[v[1].2,v[1].2-v[0].2]).collect::<Vec<_>>(),"cpuMs":{"sum":cpu.iter().sum::<f64>(),"p50":quantile(&cpu,0.5),"p95":quantile(&cpu,0.95),"max":cpu.last()},
            "wallMs":{"p50":quantile(&wall,0.5),"p95":quantile(&wall,0.95),"max":wall.last()}}))
    }).collect::<serde_json::Map<_,_>>();
    Value::Object(rows)
}
pub(crate) fn cpu() -> u64 {
    // SAFETY: a scalar read writes only the owned timespec.
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) }, 0);
    time.tv_sec as u64 * 1_000_000_000 + time.tv_nsec as u64
}

pub fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    match args.get(1).map(String::as_str) {
        Some("queue") => queue(PathBuf::from(&args[2]), args.get(3).cloned().unwrap_or_else(|| "a".repeat(64))),
        Some("capture") => capture(&args),
        Some("run") => run(&args),
        _ => panic!("expected queue, capture or run"),
    }
}

fn queue(root: PathBuf, namespace: String) {
    let mut queue = Outbox::open_bounded(root, namespace).expect("isolated queue");
    for line in io::stdin().lock().lines() {
        let value: Value = serde_json::from_str(&line.expect("command")).expect("command JSON");
        let reply = (|| -> io::Result<Value> {
            match value["op"].as_str().unwrap_or("") {
                "status" => Ok(
                    json!({"queueId":queue.queue_id(),"openId":queue.open_id(),"ack":queue.ack(),"nextSeq":queue.next_sequence()}),
                ),
                "credentials" => {
                    queue.check_credentials(value["scope"].as_str().ok_or(io::ErrorKind::InvalidData)?.into())?;
                    Ok(json!({"ok":true}))
                }
                "clock" => {
                    let epoch: Epoch =
                        serde_json::from_value(value["epoch"].clone()).map_err(|_| io::ErrorKind::InvalidData)?;
                    queue.install_clock(epoch)?;
                    Ok(json!({"ok":true}))
                }
                "bind" => {
                    let binding: Binding =
                        serde_json::from_value(value["binding"].clone()).map_err(|_| io::ErrorKind::InvalidData)?;
                    queue.bind(binding)?;
                    let mut epoch = queue.metadata.clocks.get(value["clockEpoch"].as_str().unwrap()).unwrap().clone();
                    let anchor =
                        serde_json::from_value(value["anchor"].clone()).map_err(|_| io::ErrorKind::InvalidData)?;
                    if epoch.anchor.as_ref().is_some_and(|old| old != &anchor) {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    if epoch.anchor.is_none() && !epoch.restore(anchor) {
                        return Err(io::ErrorKind::InvalidData.into());
                    }
                    queue.install_clock(epoch)?;
                    queue.acknowledge(value["ack"].as_u64().unwrap(), &[])?;
                    queue.install_witness(
                        serde_json::from_value(value["witness"].clone()).map_err(|_| io::ErrorKind::InvalidData)?,
                    )?;
                    Ok(json!({"ok":true}))
                }
                "append" => {
                    let state: State =
                        serde_json::from_value(value["state"].clone()).map_err(|_| io::ErrorKind::InvalidData)?;
                    let mut raw: Raw =
                        serde_json::from_value(value["raw"].clone()).map_err(|_| io::ErrorKind::InvalidData)?;
                    raw.base_state_digest = state.digest();
                    let seq = queue.append(&state, raw, value["witnessId"].as_str().map(String::from))?;
                    Ok(json!({"seq":seq}))
                }
                "prepare" => serde_json::to_value(queue.prepare()?).map_err(|_| io::ErrorKind::InvalidData.into()),
                "ack" => {
                    let released: Vec<String> =
                        serde_json::from_value(value["released"].clone()).map_err(|_| io::ErrorKind::InvalidData)?;
                    queue.acknowledge(value["through"].as_u64().unwrap(), &released)?;
                    Ok(json!({"ok":true}))
                }
                "rewind" => {
                    queue.rewind_acknowledgement(value["through"].as_u64().unwrap())?;
                    Ok(json!({"ok":true}))
                }
                "privacy" => {
                    queue.apply_privacy(value["revision"].as_str().unwrap().into())?;
                    Ok(json!({"ok":true}))
                }
                _ => Err(io::ErrorKind::InvalidInput.into()),
            }
        })();
        let reply = reply.unwrap_or_else(|_| json!({"error":"queue_unavailable"}));
        println!("{reply}");
        io::stdout().flush().unwrap();
    }
}

fn quantile(values: &[f64], q: f64) -> Option<f64> {
    (!values.is_empty()).then(|| values[((values.len() - 1) as f64 * q) as usize])
}

fn capture(args: &[String]) {
    let seconds = args[2].parse::<f64>().unwrap();
    let period = args[3].parse::<f64>().unwrap();
    let before = usage(libc::RUSAGE_SELF);
    let start = Instant::now();
    let mut activity = Activity::new(PathBuf::from(&args[4]), true);
    let mut costs = Vec::new();
    let mut walls = Vec::new();
    let mut sizes = Vec::new();
    let mut complete = 0;
    for index in 0.. {
        let due = Duration::from_secs_f64(index as f64 * period);
        if let Some(wait) = due.checked_sub(start.elapsed()) {
            std::thread::sleep(wait);
        }
        if start.elapsed().as_secs_f64() >= seconds {
            break;
        }
        let at = Instant::now();
        let cpu = cpu();
        let sessions = activity.look();
        costs.push((self::cpu() - cpu) as f64 / 1e6);
        walls.push(at.elapsed().as_secs_f64() * 1000.0);
        sizes.push(sessions.len());
        complete += usize::from(activity.complete());
    }
    costs.sort_by(f64::total_cmp);
    walls.sort_by(f64::total_cmp);
    let after = usage(libc::RUSAGE_SELF);
    println!(
        "{}",
        json!({"calls":costs.len(),"wallSeconds":start.elapsed().as_secs_f64(),"cpuMs":after.0-before.0,"oneCoreCPUPercent":(after.0-before.0)/10.0/start.elapsed().as_secs_f64(),
        "captureCPUms":{"p50":quantile(&costs,0.5),"p95":quantile(&costs,0.95),"max":costs.last(),"mean":costs.iter().sum::<f64>()/costs.len()as f64},
        "captureWallMs":{"p50":quantile(&walls,0.5),"p95":quantile(&walls,0.95),"max":walls.last()},"sessionCountMin":sizes.iter().min(),"sessionCountMax":sizes.iter().max(),"completeCalls":complete,
        "voluntaryContextSwitches":after.1-before.1,"involuntaryContextSwitches":after.2-before.2,"memory":memory(),"debugAssertions":cfg!(debug_assertions)})
    );
}

fn usage(who: i32) -> (f64, i64, i64) {
    // SAFETY: getrusage fills a fixed owned output structure.
    let mut value: libc::rusage = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::getrusage(who, &mut value) }, 0);
    (
        (value.ru_utime.tv_sec + value.ru_stime.tv_sec) as f64 * 1000.0
            + (value.ru_utime.tv_usec + value.ru_stime.tv_usec) as f64 / 1000.0,
        value.ru_nvcsw,
        value.ru_nivcsw,
    )
}
fn memory() -> Value {
    let status = std::fs::read_to_string("/proc/self/status").unwrap();
    let values = status
        .lines()
        .filter_map(|l| l.split_once(':'))
        .filter(|(k, _)| ["VmRSS", "VmHWM"].contains(k))
        .map(|(k, v)| (k, v.split_whitespace().next().unwrap().parse::<u64>().unwrap()))
        .collect::<std::collections::BTreeMap<_, _>>();
    json!(values)
}

struct Delayed {
    millis: u64,
}
impl Collector for Delayed {
    fn activity_paths(&self, _home: &std::path::Path) -> Vec<PathBuf> {
        Vec::new()
    }
    fn provider(&self) -> Provider {
        Provider::Codex
    }
    fn identifies_account(&self) -> bool {
        false
    }
    fn measure(&mut self, context: &Context) -> Outcome {
        let until = Instant::now() + Duration::from_millis(self.millis);
        while Instant::now() < until && !context.stop.requested() {
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(Failure::new(Provider::Codex, ErrorKind::Unsupported, "isolated delayed fixture"))
    }
}
fn run(args: &[String]) {
    let duration = args[2].parse::<u64>().unwrap();
    let root = PathBuf::from(&args[3]);
    let url = args[4].clone();
    let client = PathBuf::from(&args[5]);
    let delay = args.get(6).map_or(0, |s| s.parse::<u64>().unwrap());
    std::fs::create_dir_all(root.join("home")).unwrap();
    std::fs::create_dir_all(root.join("work")).unwrap();
    let config=Config::parse(&format!("sessions=true\n[clients.claude]\nenabled=false\n[clients.antigravity]\nenabled=false\n[clients.opencode]\nenabled=false\n[clients.codex]\npath={client:?}\n")).unwrap();
    let paths = Paths { state: root.join("state"), work: root.join("work"), config: root.join("config.toml") };
    std::fs::create_dir_all(&paths.state).unwrap();
    let stop = Stop::new();
    let end = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(duration));
        end.request(How::Exit);
    });
    let machine = Machine {
        id: "activity-fixture-machine".into(),
        name: "Fixture".into(),
        os: "linux".into(),
        arch: std::env::consts::ARCH.into(),
    };
    let mut sink = HubSink::new(
        &Hub {
            url,
            token: std::env::var("OBSERVED_TEST_TOKEN").unwrap_or_else(|_| "qt_m_synthetic_activity_fixture".into()),
        },
        machine,
        root.join("measurements"),
        Box::new(|line| eprintln!("{line}")),
    );
    let adapters: Vec<Box<dyn Collector>> =
        if delay == 0 { Vec::new() } else { vec![Box::new(Delayed { millis: delay })] };
    let mut runner = Runner::with_adapters(config, paths, adapters, root.join("home"), stop);
    let before = usage(libc::RUSAGE_SELF);
    let children = usage(libc::RUSAGE_CHILDREN);
    let start = Instant::now();
    let _ = RUN_START.set(start);
    runner.run(&mut sink, |_| {});
    let after = usage(libc::RUSAGE_SELF);
    let child_after = usage(libc::RUSAGE_CHILDREN);
    println!(
        "{}",
        json!({"cpuMs":after.0-before.0,"childCPUms":child_after.0-children.0,"wallSeconds":start.elapsed().as_secs_f64(),"voluntaryContextSwitches":after.1-before.1,
        "cadenceCostUsesCPU":super::cost::cpu().is_some(),"syncDelayInjected":SYNC_DELAYED.load(Ordering::Relaxed),
        "involuntaryContextSwitches":after.2-before.2,"contextCPUms":CONTEXT_CPU_NS.load(Ordering::Relaxed)as f64/1e6,"memoryKiB":memory(),"costs":costs(),"debugAssertions":cfg!(debug_assertions)})
    );
}
