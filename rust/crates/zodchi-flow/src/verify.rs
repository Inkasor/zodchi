use crate::args::{self, Args};
use crate::git::Git;
use serde_json::{json, Value};
use zodchi_core::util::{fail, GatewayError, Result};

pub const CONFIG: &str = ".zodchi/verify.json";
pub const LEGACY_SKILL: &str = ".claude/skills/verify/SKILL.md";
pub const PROJECT_SKILL: &str = ".agents/skills/verify/SKILL.md";

#[derive(Clone, Debug)]
pub struct Plan {
    pub checks: Vec<String>,
    pub verify: Vec<String>,
    pub tools: Vec<String>,
    pub check_source: &'static str,
    pub verify_source: &'static str,
    pub full_local: Vec<String>,
    pub full_in_ci: bool,
}

impl Plan {
    pub fn legacy(args: &Args) -> Self {
        Self {
            checks: args.checks.clone(), verify: args.verify.clone(), tools: vec![],
            check_source: "checks", verify_source: "args.verify",
            full_local: vec![], full_in_ci: false,
        }
    }

    pub fn load(git: &Git, base: &str, args: &Args) -> Result<Self> {
        let mut plan = Self::legacy(args);
        let Some(bytes) = git.show(base, CONFIG)? else {
            if git.exists_at(base, CONFIG)? {
                return fail(format!("{CONFIG} in the base must be a regular file"));
            }
            if args.verify.is_empty() {
                for path in [PROJECT_SKILL, LEGACY_SKILL] {
                    if git.exists_at(base, path)? {
                        return fail(format!("The repository has a verify skill ({path}); pass its commands as args.verify or declare them in {CONFIG}."));
                    }
                }
            }
            return Ok(plan);
        };
        let value: Value = serde_json::from_slice(&bytes).map_err(|e| GatewayError(format!("{CONFIG}: {e}")))?;
        let Some(fields) = value.as_object() else {
            return fail(format!("{CONFIG} must be an object"));
        };
        if let Some(key) = fields.keys().find(|key| !["checks", "verify", "full", "tools"].contains(&key.as_str())) {
            return fail(format!("{CONFIG}: unexpected field {key:?}"));
        }
        let commands = |value, name| args::commands(value, name).map_err(|why| GatewayError(format!("{CONFIG}: {why}")));
        let checks = commands(value.get("checks"), "checks")?;
        let verify = commands(value.get("verify"), "verify")?;
        plan.tools = tools(value.get("tools"))?;
        if plan.checks.is_empty() && !checks.is_empty() {
            plan.checks = checks;
            plan.check_source = "project.checks";
        }
        if plan.verify.is_empty() && !verify.is_empty() {
            plan.verify = verify;
            plan.verify_source = "project.verify";
        }
        if let Some(full) = value.get("full") {
            if full.as_object().is_none_or(|o| o.keys().any(|key| key != "run" && key != "commands")) {
                return fail(format!("{CONFIG}: full is an object with run and optional commands"));
            }
            let full_commands = commands(full.get("commands"), "full.commands")?;
            match full["run"].as_str() {
                Some("local") if !full_commands.is_empty() => plan.full_local = full_commands,
                Some("ci") if full_commands.is_empty() => plan.full_in_ci = true,
                _ => return fail(format!("{CONFIG}: full.run is local with commands, or ci with commands defined by CI")),
            }
        }
        Ok(plan)
    }

    pub fn to_json(&self) -> Value {
        json!({
            "checks": self.checks, "verify": self.verify, "tools": self.tools,
            "checkSource": self.check_source, "verifySource": self.verify_source,
            "fullLocal": self.full_local, "fullInCi": self.full_in_ci
        })
    }

    pub fn from_run(run: &Value, args: &Args) -> Result<Self> {
        let Some(plan) = run.get("verificationPlan") else { return Ok(Self::legacy(args)) };
        let commands = |key| {
            let list = plan.get(key).and_then(Value::as_array)
                .ok_or_else(|| GatewayError(format!("The pinned verification plan has no {key} list.")))?;
            list.iter().map(|command| {
                command.as_str().filter(|s| !s.trim().is_empty()).map(String::from)
                    .ok_or_else(|| GatewayError(format!("The pinned verification plan has an invalid {key} command.")))
            }).collect::<Result<Vec<_>>>()
        };
        let check_source = match plan["checkSource"].as_str() {
            Some("checks") => "checks",
            Some("project.checks") => "project.checks",
            _ => return fail("The pinned verification plan has no valid check source."),
        };
        let verify_source = match plan["verifySource"].as_str() {
            Some("args.verify") => "args.verify",
            Some("project.verify") => "project.verify",
            _ => return fail("The pinned verification plan has no valid verify source."),
        };
        let full_in_ci = plan["fullInCi"].as_bool().ok_or_else(|| GatewayError("The pinned verification plan has no CI policy.".into()))?;
        Ok(Self {
            checks: commands("checks")?, verify: commands("verify")?, tools: tools(plan.get("tools"))?, check_source, verify_source,
            full_local: commands("fullLocal")?, full_in_ci,
        })
    }
}

fn tools(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(value) = value else { return Ok(vec![]) };
    value.as_array().and_then(|list| list.iter().map(|v| v.as_str().filter(|s|
        s.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    ).map(String::from)).collect()).ok_or_else(|| GatewayError(format!("{CONFIG}.tools must list command names found on PATH.")))
}
