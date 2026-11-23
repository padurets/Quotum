//! One volatile, bounded observer queue per runner generation.
use crate::collection::{AccountRef, CollectionOutcome, CollectionResult};
use crate::config::{Config, HookSettings, Paths};
use crate::model::{Provider, ts};
use crate::process::{Client, ProcError};
use crate::stop::{How, Stop};
use serde::Serialize;
use serde_json::json;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
pub struct Diagnostic {
    pub provider: Provider,
    pub hook: &'static str,
    pub account: Option<AccountRef>,
    pub code: &'static str,
}
impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {} {}: {}",
            self.provider.id(),
            crate::collection::account_label(self.account.as_ref()),
            self.hook,
            self.code
        )
    }
}
struct Job {
    command: HookSettings,
    payload: Vec<u8>,
    stop: Stop,
    diagnostic: Diagnostic,
}
pub(crate) struct Observers {
    send: Option<SyncSender<Job>>,
    pub diagnostics: Receiver<Diagnostic>,
    stop: Stop,
    done: Receiver<()>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Observers {
    pub fn new(paths: &Paths, root: &Stop) -> Self {
        let (send, receive) = mpsc::sync_channel::<Job>(32);
        let (diag, diagnostics) = mpsc::channel();
        let (done_send, done) = mpsc::channel();
        let stop = root.child();
        let worker_stop = stop.clone();
        let cwd = paths.work.clone();
        let worker = thread::spawn(move || {
            while !worker_stop.requested() {
                let Ok(job) = receive.recv() else { break };
                let stop = Stop::linked(&[worker_stop.clone(), job.stop]);
                if stop.requested() {
                    continue;
                }
                if let Err(error) = Client::command_output(
                    &job.command.path,
                    &job.command.args,
                    Some(job.payload),
                    &cwd,
                    Duration::from_secs(10),
                    &stop,
                    16 * 1024,
                ) {
                    if !stop.requested() {
                        let mut d = job.diagnostic;
                        d.code = match error {
                            ProcError::Timeout => "timeout",
                            ProcError::OutputLimit => "output_limit",
                            ProcError::NotFound => "not_installed",
                            _ => "failed",
                        };
                        let _ = diag.send(d);
                    }
                }
            }
            let _ = done_send.send(());
        });
        Self { send: Some(send), diagnostics, stop, done, worker: Some(worker) }
    }
    pub fn enqueue(&self, config: &Config, result: &CollectionResult, admission: &Stop) -> Option<Diagnostic> {
        let hooks = &config.providers.get(&result.provider)?.hooks;
        let (event, command) = match &result.outcome {
            CollectionOutcome::Observed(_) => ("on_collected", hooks.on_collected.clone()?),
            CollectionOutcome::Failed(_) => ("on_collection_failed", hooks.on_collection_failed.clone()?),
            CollectionOutcome::NoNewData => return None,
        };
        let mut value = json!({"version":1,"event":event,"provider":result.provider,"account":result.account,"attemptId":result.attempt_id,"completedAt":ts::format(result.completed_at)});
        match &result.outcome {
            CollectionOutcome::Observed(snapshot) => {
                let mut measurement = serde_json::to_value(snapshot).expect("snapshot serializes");
                for key in ["provider", "account", "accountName", "via", "client", "staleAfterMs"] {
                    measurement.as_object_mut().unwrap().remove(key);
                }
                value["measurement"] = measurement;
            }
            CollectionOutcome::Failed(failure) => value["error"] = json!({"code":failure.error,"stage":result.stage}),
            CollectionOutcome::NoNewData => return None,
        }
        let diagnostic =
            Diagnostic { provider: result.provider, hook: event, account: result.account.clone(), code: "queue_full" };
        let payload = serde_json::to_vec(&value).expect("observer serializes");
        if payload.len() > 256 * 1024 {
            return Some(Diagnostic { code: "input_limit", ..diagnostic });
        }
        if admission.requested() {
            return None;
        }
        self.send
            .as_ref()?
            .try_send(Job { command, payload, stop: admission.clone(), diagnostic: diagnostic.clone() })
            .err()
            .map(|_| diagnostic)
    }
    pub fn cancel(&self) {
        self.stop.request(How::Exit);
    }

    pub fn finish(&mut self, grace: bool) {
        self.send.take();
        if !grace || self.done.recv_timeout(Duration::from_secs(10)).is_err() {
            self.stop.request(How::Exit);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Observers {
    fn drop(&mut self) {
        if self.worker.is_some() {
            self.finish(false);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::model::Snapshot;
    fn result(provider: Provider, account: Option<AccountRef>) -> CollectionResult {
        CollectionResult {
            version: 1,
            provider,
            account,
            attempt_id: "local-attempt".into(),
            stage: "measure",
            completed_at: 1,
            outcome: CollectionOutcome::Observed(Snapshot {
                provider,
                account: None,
                account_name: None,
                plan: None,
                observed_at: 1,
                via: "native".into(),
                client: Some("version".into()),
                stale_after_ms: 120000,
                windows: vec![],
                resets: None,
                resource_status: None,
                balances: None,
            }),
        }
    }
    #[test]
    fn observers_preserve_unknown_and_default_identity_without_native_or_hub_metadata() {
        let dir = std::env::temp_dir().join(format!("quotum-observer-{}", crate::config::random_hex()));
        std::fs::create_dir(&dir).unwrap();
        let paths = Paths { config: dir.join("config"), state: dir.clone(), work: dir.clone() };
        let output = dir.join("events");
        let command = HookSettings {
            path: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "cat >> \"$1\"; printf '\\n' >> \"$1\"".into(),
                "fixture".into(),
                output.to_str().unwrap().into(),
            ],
        };
        let mut config = Config::default();
        for provider in [Provider::Codex, Provider::Antigravity] {
            config.providers.entry(provider).or_default().hooks.on_collected = Some(command.clone());
        }
        let root = Stop::new();
        let mut observers = Observers::new(&paths, &root);
        assert!(observers.enqueue(&config, &result(Provider::Codex, None), &root).is_none());
        assert!(
            observers
                .enqueue(
                    &config,
                    &result(Provider::Antigravity, Some(AccountRef::Declared { account_name: None })),
                    &root
                )
                .is_none()
        );
        let mut no_data = result(Provider::Codex, None);
        no_data.outcome = CollectionOutcome::NoNewData;
        assert!(observers.enqueue(&config, &no_data, &root).is_none());
        observers.finish(true);
        let text = std::fs::read_to_string(&output).unwrap();
        let events =
            text.lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).collect::<Vec<_>>();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["account"], serde_json::Value::Null);
        assert_eq!(events[1]["account"], json!({"accountName":null}));
        for event in events {
            for key in ["provider", "account", "accountName", "via", "client", "staleAfterMs"] {
                assert!(event["measurement"].get(key).is_none());
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn observer_overflow_is_local_and_stop_cancels_the_whole_queue() {
        let dir = std::env::temp_dir().join(format!("quotum-observer-{}", crate::config::random_hex()));
        std::fs::create_dir(&dir).unwrap();
        let paths = Paths { config: dir.join("config"), state: dir.clone(), work: dir.clone() };
        let mut config = Config::default();
        config.providers.entry(Provider::Codex).or_default().hooks.on_collected =
            Some(HookSettings { path: "/bin/sh".into(), args: vec!["-c".into(), "sleep 30".into()] });
        let root = Stop::new();
        let mut observers = Observers::new(&paths, &root);
        let mut overflow = 0;
        for _ in 0..40 {
            if let Some(d) = observers.enqueue(&config, &result(Provider::Codex, None), &root) {
                assert_eq!(d.code, "queue_full");
                overflow += 1;
            }
        }
        assert!(overflow >= 7);
        let at = std::time::Instant::now();
        root.request(How::Exit);
        observers.finish(false);
        assert!(at.elapsed() < Duration::from_secs(2));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
