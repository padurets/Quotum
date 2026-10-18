//! Recorded numeric counters exercise the real classifier without starting clients.
use super::*;
use crate::observed::cadence::Cadence;
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    client: String,
    duration_ms: f64,
    truth: Vec<[f64; 2]>,
    samples: Vec<[f64; 2]>,
    phases: Vec<(String, f64, f64)>,
    recorded15: Vec<(f64, Option<bool>)>,
}
type Span = (f64, f64, Option<bool>);

fn counter(case: &Case, at: f64) -> u64 {
    let next = case.samples.partition_point(|s| s[0] <= at);
    let previous = case.samples[next.saturating_sub(1)];
    let Some(after) = case.samples.get(next) else {
        return previous[1] as u64;
    };
    (previous[1] + (after[1] - previous[1]) * (at - previous[0]) / (after[0] - previous[0])) as u64
}

fn replay(case: &Case, slots: u64, adaptive: bool, fast_judgement: bool) -> Vec<Span> {
    let client = ClientId::ALL.into_iter().find(|id| id.id() == case.client).expect("known fixture client");
    let origin = Instant::now();
    let mut cadence = Cadence::new();
    let mut before = None;
    let mut at = 0;
    let mut spans = Vec::new();
    loop {
        let judge = fast_judgement || cadence.should_judge(at);
        let next = judged_capture(
            before.as_ref(),
            counter(case, at as f64),
            origin + Duration::from_millis(at),
            at as Millis,
            working_share(client),
            judge,
        );
        if judge {
            cadence.judged(at);
        }
        let idle = next.working == Some(false);
        let working = next.working;
        before = Some(next);
        let end = if adaptive {
            // Deterministic costs force both the ordinary and pressure branches.
            let pressure = slots == 2;
            let cost = if pressure { 48 } else { 3 };
            cadence.completed(at + cost, cost as f64, false, idle, pressure);
            cadence.due(at + cost)
        } else {
            at + 15_000 / slots
        };
        spans.push((at as f64, (end as f64).min(case.duration_ms), working));
        if end as f64 >= case.duration_ms {
            break;
        }
        at = end;
    }
    spans
}

fn overlap(a: f64, b: f64, c: f64, d: f64) -> f64 {
    (b.min(d) - a.max(c)).max(0.0)
}
fn metrics(case: &Case, spans: &[Span], from: f64, to: f64) -> [f64; 7] {
    let mut work = 0.0;
    let mut correct = 0.0;
    let mut unknown = 0.0;
    for &(a, b, working) in spans {
        let a = a.max(from);
        let b = b.min(to);
        if b <= a {
            continue;
        }
        if working == Some(true) {
            work += b - a;
            correct += case.truth.iter().map(|t| overlap(a, b, t[0], t[1])).sum::<f64>();
        } else if working.is_none() {
            unknown += b - a;
        }
    }
    let truth: f64 = case.truth.iter().map(|t| overlap(from, to, t[0], t[1])).sum();
    let events = case.truth.iter().filter(|t| overlap(from, to, t[0], t[1]) > 0.0).count();
    let found = case
        .truth
        .iter()
        .filter(|t| {
            overlap(from, to, t[0], t[1]) > 0.0
                && spans.iter().any(|&(a, b, w)| w == Some(true) && overlap(a.max(from), b.min(to), t[0], t[1]) > 0.0)
        })
        .count();
    [truth - correct, work - correct, unknown, found as f64, events as f64, truth, work]
}

fn boundaries(case: &Case, spans: &[Span]) -> Vec<Option<[f64; 2]>> {
    let mut work = Vec::<(f64, f64)>::new();
    for &(a, b, working) in spans {
        if working != Some(true) {
            continue;
        }
        if let Some(previous) = work.last_mut().filter(|p| p.1 == a) {
            previous.1 = b;
        } else {
            work.push((a, b));
        }
    }
    case.truth
        .iter()
        .map(|truth| {
            let mut overlapping = work.iter().filter(|&&(a, b)| overlap(a, b, truth[0], truth[1]) > 0.0);
            let first = overlapping.next()?;
            let last = overlapping.next_back().unwrap_or(first);
            Some([first.0 - truth[0], last.1 - truth[1]])
        })
        .collect()
}

#[test]
fn recorded_work_idle_typing_and_tool_traces_keep_the_fifteen_second_classifier() {
    let corpus: Corpus = serde_json::from_str(include_str!("../../../../bench/observed/corpus.json")).unwrap();
    assert_eq!(corpus.cases.len(), 41);
    let mut rows = Vec::new();
    let mut distinguishes_short_window_regression = false;
    for case in &corpus.cases {
        let baseline = replay(case, 1, false, false);
        let full = metrics(case, &baseline, 0.0, case.duration_ms);
        let warm = metrics(case, &baseline, 30_000.0, case.duration_ms);
        let mut windows = vec![("startup", 0.0, 30_000.0), ("after30s", 30_000.0, case.duration_ms)];
        for (name, from, to) in &case.phases {
            windows.push((name, *from, *to));
        }
        if let Some(end) = case.truth.last().map(|t| t[1]) {
            windows.push(("post-work tail", end, case.duration_ms));
        }
        for (name, slots, adaptive) in [("fast", 8, false), ("adaptive", 8, true), ("pressure", 2, true)] {
            let predicted = replay(case, slots, adaptive, false);
            for &(_, from, to) in &windows {
                let expected = metrics(case, &baseline, from, to);
                let actual = metrics(case, &predicted, from, to);
                for (a, b) in actual.into_iter().zip(expected) {
                    assert!((a - b).abs() < 0.001, "{} {name} at {from}: {actual:?} != {expected:?}", case.name);
                }
            }
            assert_eq!(boundaries(case, &predicted), boundaries(case, &baseline), "{} {name} boundaries", case.name);
        }
        if case.truth.is_empty() {
            let mutation = replay(case, 8, false, true);
            distinguishes_short_window_regression |=
                metrics(case, &mutation, 30_000.0, case.duration_ms)[1] > warm[1] + 500.0;
        }
        let recorded = case
            .recorded15
            .iter()
            .enumerate()
            .map(|(i, &(at, working))| (at, case.recorded15.get(i + 1).map_or(case.duration_ms, |v| v.0), working))
            .collect::<Vec<_>>();
        rows.push(json!({"case":case.name,"fullMs":full,"after30sMs":warm,"boundaryErrorsMs":boundaries(case,&baseline),
            "phases":windows.iter().map(|&(name,a,b)|json!({"phase":name,"metrics":metrics(case,&baseline,a,b)})).collect::<Vec<_>>(),
            "recorded15Ms":(!recorded.is_empty()).then(||metrics(case,&recorded,0.0,case.duration_ms))}));
    }
    assert!(
        distinguishes_short_window_regression,
        "the corpus must reject judging every fast capture on warmed negatives"
    );
    // Metrics retain existing missed work and false work; a higher frequency cannot hide them.
    println!(
        "activity-corpus {}",
        json!({"columns":["missedWorkMs","falseWorkMs","unknownMs","eventsFound","events","oracleWorkMs","classifiedWorkMs"],"cases":rows})
    );
}
