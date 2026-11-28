//! A limit on new model submissions. Recorded calls and known outcomes are still recoverable at the limit.

use crate::{boundary::{Exit, REVIEWER_GATEWAY_ROLE}, journal::Journal};
use serde_json::{json, Value};
use zodchi_core::{
    config::Config,
    util::{fail, now_ms, parse_iso_ms, GatewayError, Result},
};

const MINUTE: i128 = 60_000;

#[derive(Clone, Copy, Debug)]
pub struct Budget {
    calls: u32,
    minutes: Option<u32>,
}

struct Usage {
    limit: u64,
    writer: usize,
    reviewer: usize,
    checks: usize,
    deadline: Option<i128>,
}

impl Budget {
    pub fn parse(value: &Value) -> std::result::Result<Self, String> {
        let number = |key: &str| {
            value[key]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n > 0)
        };
        if value
            .as_object()
            .is_none_or(|o| o.keys().any(|k| k != "calls" && k != "minutes"))
        {
            return Err("args.budget is an object with calls and optional minutes".into());
        }
        let calls = number("calls").ok_or("args.budget.calls is a positive whole number")?;
        let minutes = number("minutes");
        if value.get("minutes").is_some() && minutes.is_none() {
            return Err("args.budget.minutes is a positive whole number".into());
        }
        Ok(Self { calls, minutes })
    }

    fn usage(self, events: &[Value]) -> Usage {
        let jobs: Vec<_> = events
            .iter()
            .filter(|e| e["kind"] == "intent" && e["effect"] == "gateway job")
            .collect();
        let reviewer = jobs
            .iter()
            .filter(|e| e["role"] == REVIEWER_GATEWAY_ROLE)
            .count();
        let first = jobs
            .first()
            .and_then(|e| e["at"].as_str())
            .and_then(parse_iso_ms);
        let mut deadline = first
            .zip(self.minutes)
            .map(|(at, minutes)| at + i128::from(minutes) * MINUTE);
        let mut limit = u64::from(self.calls);
        for grant in events.iter().filter(|e| e["kind"] == "budget extended") {
            limit = limit.saturating_add(grant["calls"].as_u64().unwrap_or(0));
            if let Some(expiry) = grant["deadlineMs"].as_i64() {
                deadline = Some(i128::from(expiry));
            }
        }
        Usage {
            limit,
            writer: jobs.len() - reviewer,
            reviewer,
            checks: events
                .iter()
                .filter(|e| e["effect"] == "run checks")
                .count(),
            deadline,
        }
    }

    pub fn exhausted(self, journal: &Journal) -> bool {
        let usage = self.usage(journal.events());
        (usage.writer + usage.reviewer) as u64 >= usage.limit
            || usage.deadline.is_some_and(|d| now_ms() >= d)
    }

    pub fn report(self, events: &[Value]) -> Value {
        let usage = self.usage(events);
        json!({ "callLimit": usage.limit, "writerCalls": usage.writer, "reviewerCalls": usage.reviewer,
            "checkRuns": usage.checks, "minutesRemaining": usage.deadline.map(|d| ((d - now_ms()).max(0) + MINUTE - 1) / MINUTE),
        })
    }
}

pub fn extend(
    id: &str,
    calls: Option<u32>,
    minutes: Option<u32>,
    supports_budget: impl FnOnce(&Value) -> bool,
) -> Result<Exit> {
    let (mut journal, run) = Journal::open(&Config::new(None)?.home, id)?;
    let _lock = journal.lock()?;
    journal.load()?;
    if !supports_budget(&run)
        || journal.file("result.json").is_file()
        || !journal
            .last_event()
            .is_some_and(|e| e["kind"] == "waiting" && e["reason"] == "budget")
    {
        return fail(format!("Run {id} is not waiting for a budget decision."));
    }
    let policy = Budget::parse(&run["inputs"]["args"]["budget"]).map_err(GatewayError)?;
    let usage = policy.usage(journal.events());
    if minutes.is_some() && policy.minutes.is_none() {
        return fail("This run has no time limit to extend.");
    }
    let now = now_ms();
    let deadline = minutes.map(|n| usage.deadline.unwrap_or(now).max(now) + i128::from(n) * MINUTE);
    let step = journal
        .last_event()
        .and_then(|e| e["step"].as_str())
        .unwrap_or("")
        .to_string();
    journal.append(json!({ "kind": "budget extended", "step": step, "calls": calls.unwrap_or(0), "deadlineMs": deadline }))?;
    Ok(Exit {
        code: 0,
        result: json!({ "runId": id, "status": "ready", "budget": policy.report(journal.events()) }),
    })
}
