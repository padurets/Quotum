//! `agent-limits`: the subscription limits of the coding agents on this machine.

use std::io::{IsTerminal, Write};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;

use agent_limits_core::config::{Config, Paths, machine};
use agent_limits_core::model::{Batch, ErrorKind, INGEST_VERSION, Kind, Millis, Outcome, Provider, Window, now_ms};
use agent_limits_core::process::find_program;
use agent_limits_core::providers::adapter;
use agent_limits_core::runner::Runner;
use agent_limits_core::sink::{Discard, HubSink, Sink};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "agent-limits",
    version,
    about = "Subscription limits of your coding agents: Claude Code, Codex, Antigravity."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    /// Print JSON in the hub's ingest format instead of a table.
    #[arg(long, global = true)]
    json: bool,
    /// Only these providers, comma-separated: claude, codex, antigravity.
    #[arg(long, global = true, value_delimiter = ',')]
    only: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Measure once and show the limits (the default).
    Status,
    /// Keep measuring on the schedule and deliver to the hub, if one is configured.
    Run,
    /// Show where the settings live and what is in effect.
    Config,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let mut only = Vec::new();
    for name in &cli.only {
        match Provider::parse(name.trim()) {
            Some(p) => only.push(p),
            None => return fail(&format!("unknown provider `{name}` (claude, codex, antigravity)")),
        }
    }
    let paths = Paths::resolve();
    let config = match Config::load(&paths.config) {
        Ok(config) => config,
        Err(e) => return fail(&e),
    };
    if let Err(e) = paths.ensure() {
        return fail(&format!("{}: {e}", paths.state.display()));
    }
    match cli.command.unwrap_or(Command::Status) {
        Command::Status => status(config, paths, &only, cli.json),
        Command::Run => run(config, paths, &only),
        Command::Config => show_config(&config, &paths),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("agent-limits: {message}");
    ExitCode::FAILURE
}

fn status(config: Config, paths: Paths, only: &[Provider], json: bool) -> ExitCode {
    let machine = json.then(|| machine(&paths, &config));
    let mut runner = Runner::new(config, paths, only);
    let style = Style::detect();
    let mut outcomes = Vec::new();
    if !json {
        println!("{}", style.dim(&format!("{:<14}{:<20}{:>5}  {}", "", "", "left", "resets")));
    }
    runner.measure_all(|outcome| {
        if !json {
            print_outcome(outcome, &style);
            let _ = std::io::stdout().flush();
        }
        outcomes.push(outcome.clone());
    });
    if let Some(machine) = machine {
        let (snapshots, failures) = outcomes.into_iter().partition::<Vec<_>, _>(|o| o.is_ok());
        let batch = Batch {
            version: INGEST_VERSION,
            agent: concat!("agent-limits/", env!("CARGO_PKG_VERSION")).into(),
            machine,
            sent_at: now_ms(),
            snapshots: snapshots.into_iter().filter_map(Result::ok).collect(),
            failures: failures.into_iter().filter_map(Result::err).collect(),
        };
        println!("{}", serde_json::to_string_pretty(&batch).unwrap_or_default());
    }
    ExitCode::SUCCESS
}

fn run(config: Config, paths: Paths, only: &[Provider]) -> ExitCode {
    let log = |line: &str| eprintln!("{} {line}", clock(now_ms()));
    let mut sink: Box<dyn Sink> = match &config.hub {
        Some(hub) => {
            log(&format!("delivering to {}", hub.url));
            Box::new(HubSink::new(hub, machine(&paths, &config), paths.state.join("spool.jsonl"), Box::new(log)))
        }
        None => {
            log("no hub configured: measuring and logging only");
            Box::new(Discard)
        }
    };
    let mut runner = Runner::new(config, paths, only);
    if runner.providers().is_empty() {
        return fail("every provider is disabled");
    }
    let stop = AtomicBool::new(false);
    runner.run(sink.as_mut(), &stop, |outcome, next| {
        let summary = match outcome {
            Ok(s) => s
                .windows
                .iter()
                .map(|w| format!("{} {}%", window_name(w), fmt_percent(w.remaining())))
                .collect::<Vec<_>>()
                .join(", "),
            Err(f) => {
                format!("{}{}", f.error.describe(), f.detail.as_ref().map(|d| format!(": {d}")).unwrap_or_default())
            }
        };
        let provider = match outcome {
            Ok(s) => s.provider,
            Err(f) => f.provider,
        };
        log(&format!("{}: {summary} (next {})", provider.id(), until(next - now_ms())));
    });
    ExitCode::SUCCESS
}

fn show_config(config: &Config, paths: &Paths) -> ExitCode {
    println!(
        "config file   {}{}",
        paths.config.display(),
        if paths.config.exists() { "" } else { " (not created; defaults apply)" }
    );
    println!("state         {}", paths.state.display());
    match &config.hub {
        Some(hub) => println!(
            "hub           {} (token …{})",
            hub.url,
            hub.token.chars().rev().take(4).collect::<String>().chars().rev().collect::<String>()
        ),
        None => println!("hub           none: `agent-limits run` only logs"),
    }
    println!("eco mode      {}", if config.eco() { "on" } else { "off" });
    let home = agent_limits_core::config::home();
    for provider in Provider::ALL {
        let a = adapter(provider);
        let client = config
            .program(provider)
            .map(|p| p.to_path_buf())
            .or_else(|| find_program(a.program(), &a.install_dirs(&home)));
        println!(
            "{:<13} {}, every {}s, client {}",
            provider.id(),
            if config.enabled(provider) { "on" } else { "off" },
            config.interval_ms(provider) / 1000,
            client.map(|p| p.display().to_string()).unwrap_or_else(|| "not found".into())
        );
    }
    ExitCode::SUCCESS
}

fn print_outcome(outcome: &Outcome, style: &Style) {
    match outcome {
        Ok(snapshot) => {
            let head = match &snapshot.plan {
                Some(plan) => format!("{} {}", snapshot.provider.name(), plan),
                None => snapshot.provider.name().to_string(),
            };
            for (i, w) in snapshot.windows.iter().enumerate() {
                let left = w.remaining();
                let resets = w.resets_at.map(|at| format!("in {}", until(at - now_ms()))).unwrap_or_default();
                let first = if i == 0 { format!("{head:<14}") } else { " ".repeat(14) };
                let first = if i == 0 { style.bold(&first) } else { first };
                println!(
                    "{first}{:<20}{}  {}",
                    window_name(w),
                    style.level(left, &format!("{:>4}%", fmt_percent(left))),
                    style.dim(&resets)
                );
            }
        }
        Err(failure) => {
            let text = match failure.error {
                ErrorKind::NotInstalled => failure.error.describe().to_string(),
                _ => format!(
                    "{}{}",
                    failure.error.describe(),
                    failure.detail.as_ref().map(|d| format!(": {d}")).unwrap_or_default()
                ),
            };
            println!("{}{}", style.bold(&format!("{:<14}", failure.provider.name())), style.dim(&text));
        }
    }
}

fn window_name(w: &Window) -> String {
    let kind = match w.kind {
        Kind::Session => "5 hours".to_string(),
        Kind::Weekly => "weekly".to_string(),
        Kind::Other => w.minutes.map(|m| format!("{m} min")).unwrap_or_else(|| "window".into()),
    };
    match &w.label {
        Some(label) => format!("{label} {kind}"),
        None => kind,
    }
}

fn fmt_percent(value: f64) -> String {
    if (value - value.round()).abs() < 0.05 { format!("{value:.0}") } else { format!("{value:.1}") }
}

/// "3m", "1h 49m", "5d 11h".
fn until(ms: Millis) -> String {
    let minutes = (ms.max(0) + 59_999) / 60_000;
    match minutes {
        0..=59 => format!("{minutes}m"),
        60..=1439 => format!("{}h {}m", minutes / 60, minutes % 60),
        _ => format!("{}d {}h", minutes / 1440, minutes % 1440 / 60),
    }
}

/// Log timestamps: UTC, RFC 3339, to the second.
fn clock(ms: Millis) -> String {
    agent_limits_core::model::ts::format(ms - ms.rem_euclid(1000))
}

struct Style {
    color: bool,
}

impl Style {
    fn detect() -> Style {
        Style { color: std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none() }
    }

    fn paint(&self, code: &str, text: &str) -> String {
        if self.color { format!("\x1b[{code}m{text}\x1b[0m") } else { text.to_string() }
    }

    fn bold(&self, text: &str) -> String {
        self.paint("1", text)
    }

    fn dim(&self, text: &str) -> String {
        self.paint("2", text)
    }

    /// Canonical status colours: under 10% critical, 30% and below a warning.
    fn level(&self, left: f64, text: &str) -> String {
        let code = if left < 10.0 {
            "31"
        } else if left <= 30.0 {
            "33"
        } else {
            "32"
        };
        self.paint(code, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_are_short_and_round_up() {
        assert_eq!(until(1), "1m");
        assert_eq!(until(109 * 60_000), "1h 49m");
        assert_eq!(until((5 * 1440 + 11 * 60) * 60_000), "5d 11h");
        assert_eq!(fmt_percent(96.28), "96.3");
        assert_eq!(fmt_percent(8.0), "8");
    }
}
