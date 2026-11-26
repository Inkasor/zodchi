//! Deterministic checks on incident classification. The evidence bundle is data; model
//! wording is kept separately from the actionable findings and reporter reply.

use serde_json::{json, Value};
use std::collections::HashMap;

const KINDS: &[&str] = &[
    "stale",
    "user-action",
    "product-bug",
    "missing-tool",
    "infra",
    "owner-decision",
    "unknown",
];
const ROUTES: &[&str] = &[
    "reply",
    "fix-brief",
    "awaiting-owner",
    "awaiting-operator",
    "needs-evidence",
];

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|v| v.as_str().map(str::to_owned))
        .collect()
}

// The same actionable-text tests as the legacy helper. A prohibition removes only
// its own negated verb, so a later affirmative request remains visible.
fn unsafe_action(text: &str) -> bool {
    static RULES: std::sync::OnceLock<Vec<regress::Regex>> = std::sync::OnceLock::new();
    let rules = RULES.get_or_init(|| {
        vec![
            regress::Regex::with_flags(r#"\b(grant|give|provide|request|ask for|need|open|extend|widen)\b[^.\n]{0,40}\b(access|permissions?|rights|credentials?|sudo)\b|\b(no|without|lacks?|lacking|don't have|do not have|haven't got)\s+(the\s+|any\s+)?(access|permissions?|rights)\b|(нет|без)\s+доступа|(дай|дайте|выдай|выдайте|нужен|нужно|открой|откройте|предоставь|предоставьте|расширь|расширьте)[^.\n]{0,30}(доступ|права)"#, "i").expect("shipped ACCESS_ASK pattern"),
            regress::Regex::with_flags(r#"\b(work(?:s|ed|ing)?\s+around|bypass\w*|circumvent\w*|sidestep\w*|get(?:s|ting)?\s+around)\b[^.\n]{0,40}\b(refus\w*|denied|denials?|restrictions?|allow-?lists?|permissions?|polic(?:y|ies)|classifiers?|sandbox|access|blocks?)\b|обой\w*[^.\n]{0,30}(запрет|ограничен|отказ|доступ|блокир)"#, "i").expect("shipped WORKAROUND pattern"),
            regress::Regex::with_flags(r#"\b(?:must not|mustn't|must never|may not|should not|shouldn't|shall not|does not|doesn't|do not|don't|did not|didn't|will not|won't|cannot|can't|never|without)\s+(?:(?:be|ever|silently|directly|automatically|quietly)\s+)?(?!(?:ha(?:ve|s|d|ving)|access|permissions?|rights|credentials?|the|any)\b)\w+(?:\s+(?:for|around))?"#, "i").expect("shipped PROHIBITION pattern"),
            regress::Regex::with_flags(r#"(?<![\p{L}])не\s+(?:(?:нужн|надо|долж|след|мож|стои)\p{L}*\s+)?\p{L}+"#, "iu").expect("shipped PROHIBITION_RU pattern"),
        ]
    });
    let english = rules[2].replace_all(text, " ");
    let affirmative = rules[3].replace_all(&english, " ");
    rules[0].find(&affirmative).is_some() || rules[1].find(&affirmative).is_some()
}

fn refused(reason: impl Into<String>) -> Value {
    json!({"refused": [reason.into()], "notes": []})
}

fn is_covered(ids: &[String], by_id: &HashMap<String, &Value>, kinds: &[&str]) -> bool {
    !ids.is_empty()
        && ids.iter().all(|id| {
            by_id.get(id).is_some_and(|item| {
                item["outcome"] == "ok"
                    && item["provides"].as_array().is_some_and(|provided| {
                        provided
                            .iter()
                            .any(|v| v.as_str().is_some_and(|kind| kinds.contains(&kind)))
                    })
            })
        })
}

/// The returned object contains either `refused` reasons or a checked classification.
pub(super) fn judge(answer: &Value, bundle: &Value, adapter: &Value) -> Value {
    let Some(items) = bundle["items"].as_array() else {
        return refused("The evidence bundle has no items.");
    };
    let mut by_id = HashMap::new();
    for item in items {
        let id = s(item, "id");
        if id.is_empty() || by_id.insert(id.to_owned(), item).is_some() {
            return refused("The evidence bundle has missing or duplicate IDs.");
        }
    }
    let Some(findings_in) = answer["findings"].as_array() else {
        return refused("The answer has no findings list.");
    };
    let Some(gaps_in) = answer["gaps"].as_array() else {
        return refused("The answer has no gaps list.");
    };
    let mut findings = Vec::new();
    let mut summaries = Vec::new();
    let mut capability_missing: Vec<(&str, Vec<String>)> = Vec::new();
    for (i, f) in findings_in.iter().enumerate() {
        let kind = s(f, "kind");
        if !KINDS.contains(&kind) {
            return refused(format!("finding {} has an unknown kind", i + 1));
        }
        let Some(evidence) = strings(&f["evidence"]) else {
            return refused("A finding has invalid evidence IDs.");
        };
        let Some(fixed) = strings(&f["fixedBy"]) else {
            return refused("A finding has invalid fixedBy IDs.");
        };
        let Some(deployed) = strings(&f["deployedIn"]) else {
            return refused("A finding has invalid deployedIn IDs.");
        };
        if evidence
            .iter()
            .chain(&fixed)
            .chain(&deployed)
            .any(|id| !by_id.contains_key(id))
        {
            return refused(format!("finding {} cites an unknown evidence ID", i + 1));
        }
        if evidence.is_empty() && kind != "unknown" {
            return refused(format!("finding {} cites no evidence", i + 1));
        }
        let about = if ["code", "capability", "data", "process", "other"].contains(&s(f, "about")) {
            s(f, "about")
        } else {
            "other"
        };
        if about == "capability" {
            let sources: Vec<_> = evidence.iter().map(|id| by_id[id])
                .filter(|item| item["outcome"] == "ok")
                .map(|item| s(item, "source")).collect();
            if !sources.contains(&"agentSkill")
                || !sources
                    .iter()
                    .any(|source| source.starts_with("allowList:"))
            {
                for (label, present) in [("agent skill", sources.contains(&"agentSkill")),
                    ("effective allow-list", sources.iter().any(|source| source.starts_with("allowList:")))] {
                    if !present {
                        let ids = evidence.iter().filter(|id| {
                            let source = s(by_id[*id], "source");
                            if label == "agent skill" { source == "agentSkill" } else { source.starts_with("allowList:") }
                        }).cloned().collect();
                        capability_missing.push((label, ids));
                    }
                }
                findings.push(json!({"kind":"unknown", "hypothesis":"", "about":"capability", "confidence":"low", "evidence":evidence, "fixedBy":[], "deployedIn":[], "note":"Capability diagnosis withheld until both sources are read successfully."}));
                summaries.push(String::new());
                continue;
            }
        }
        let hypothesis = s(f, "hypothesis");
        let hypothesis = if KINDS[..KINDS.len() - 1].contains(&hypothesis) {
            hypothesis
        } else {
            ""
        };
        let confidence = if ["high", "medium", "low"].contains(&s(f, "confidence")) {
            s(f, "confidence")
        } else {
            "low"
        };
        findings.push(json!({"kind":kind, "hypothesis":hypothesis, "about":about, "confidence":confidence, "evidence":evidence, "fixedBy":fixed, "deployedIn":deployed}));
        summaries.push(s(f, "summary").trim().to_owned());
    }
    let mut gaps = Vec::new();
    for g in gaps_in {
        let Some(evidence) = strings(&g["evidence"]) else {
            return refused("A gap has invalid evidence IDs.");
        };
        if evidence.iter().any(|id| !by_id.contains_key(id)) {
            return refused("A gap cites an unknown evidence ID.");
        }
        gaps.push(json!({"what":s(g,"what"), "evidence":evidence, "operation":s(g,"operation"), "proposal":s(g,"proposal")}));
    }
    let mut next = answer["next"].clone();
    if !ROUTES.contains(&s(&next, "route")) {
        return refused("The answer has an unknown route.");
    }
    let mut brief = answer["fixBrief"].clone();
    if !brief.is_object() {
        return refused("The answer has no fix brief.");
    }
    let mut texts = vec![
        s(&next, "question"),
        s(&next, "role"),
        s(&brief, "goal"),
        s(&brief, "agentSkillChange"),
    ];
    for key in ["files", "done", "checks"] {
        let Some(entries) = brief[key].as_array() else {
            return refused(format!("fixBrief.{key} is not a list"));
        };
        for entry in entries {
            let Some(text) = entry.as_str() else {
                return refused(format!("fixBrief.{key} contains a non-string"));
            };
            texts.push(text);
        }
    }
    for gap in &gaps {
        texts.push(s(gap, "what"));
        texts.push(s(gap, "proposal"));
    }
    if texts.iter().any(|text| unsafe_action(text)) {
        return refused("Actionable text asks for access or proposes a workaround.");
    }
    let retry = answer["recommendRetry"] == true;
    if retry && !adapter["retry"].is_object() {
        return refused("The answer recommends an undocumented retry.");
    }
    let mut notes = Vec::<String>::new();
    let mut missing = Vec::<(&str, Vec<String>)>::new();
    let mut discarded = !capability_missing.is_empty();
    for f in &mut findings {
        if f["kind"] != "stale" {
            continue;
        }
        let fixed = strings(&f["fixedBy"]).unwrap();
        let deployed = strings(&f["deployedIn"]).unwrap();
        let has_fix = is_covered(&fixed, &by_id, &["release", "changelog"]);
        let has_deployment = is_covered(&deployed, &by_id, &["release"]);
        if !has_fix || !has_deployment {
            discarded = true;
            f["kind"] = json!("unknown");
            f["hypothesis"] = json!("stale");
            f["note"] = json!("May be stale, not confirmed by the collected evidence.");
            if !has_fix {
                missing.push(("a release that fixes this error signature", fixed));
            }
            if !has_deployment {
                missing.push((
                    "the deployment of the fix in the affected environment (the release it runs)",
                    deployed,
                ));
            }
        }
    }
    let operations = adapter["operations"].as_object();
    if discarded {
        for finding in &mut findings {
            if finding["note"].is_null() {
                finding["note"] = json!("Withheld: written in the same answer as an unsupported finding.");
            }
        }
        summaries.fill(String::new());
        gaps.clear();
        next = json!({"route":"needs-evidence", "role":"", "question":"", "reason":""});
        brief = json!({"goal":"", "files":[], "done":[], "checks":[], "agentsAffected":false, "agentSkillChange":""});
        let mut merged: Vec<(&str, Vec<String>)> = Vec::new();
        for (what, evidence) in missing {
            if let Some((_, ids)) = merged.iter_mut().find(|(existing, _)| *existing == what) {
                for id in evidence {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            } else {
                merged.push((what, evidence));
            }
        }
        for (what, evidence) in merged {
            let kinds: &[&str] = if what.starts_with("a release") {
                &["release", "changelog"]
            } else {
                &["release"]
            };
            let operation = operations
                .into_iter()
                .flat_map(|ops| ops.iter())
                .find(|(_, op)| {
                    op["provides"].as_array().is_some_and(|v| {
                        v.iter()
                            .any(|p| p.as_str().is_some_and(|p| kinds.contains(&p)))
                    })
                })
                .map(|(name, _)| name.as_str())
                .unwrap_or("");
            gaps.push(json!({"what":format!("Missing evidence: {what}."), "evidence":evidence, "operation":operation, "proposal":if operation.is_empty() {format!("a read-only product report of {what}")} else {String::new()}}));
        }
        for (source, evidence) in capability_missing {
            gaps.push(json!({"what":format!("Missing successful read of {source}."), "evidence":evidence, "operation":"", "proposal":"a product report that answers this question without wider access"}));
        }
        notes.push("Unsupported findings became unknown; all model wording and the retry recommendation were discarded.".into());
    }
    for item in items.iter().filter(|item| item["outcome"] == "refused") {
        let id = s(item, "id");
        if !gaps.iter().any(|g| {
            g["evidence"]
                .as_array()
                .is_some_and(|list| list.iter().any(|v| v == id))
        }) {
            gaps.push(json!({"what":format!("{} was refused: no sanctioned tool to learn what it reads",s(item,"source")), "evidence":[id], "operation":"", "proposal":"a product report that answers this question without wider access"}));
            notes.push(format!("The refused read {id} was added as a gap."));
        }
    }
    for gap in &mut gaps {
        let op = s(gap, "operation");
        if !op.is_empty() && !operations.is_some_and(|ops| ops.contains_key(op)) {
            notes.push("A gap named an operation the adapter does not have.".into());
            gap["operation"] = json!("");
        }
    }
    let route = s(&next, "route");
    let carried = match route {
        "reply" => &["stale", "user-action"][..],
        "fix-brief" => &["product-bug", "missing-tool"],
        "awaiting-owner" => &["owner-decision"],
        "awaiting-operator" => &["infra"],
        _ => &[],
    };
    if route != "needs-evidence" && !findings.iter().any(|f| carried.contains(&s(f, "kind"))) {
        notes.push(format!(
            "The route {route} is not carried by the findings; it became needs-evidence."
        ));
        next["route"] = json!("needs-evidence");
    }
    match s(&next, "route") {
        "fix-brief" => {
            if s(&brief, "goal").trim().is_empty()
                || ["files", "done", "checks"].iter().any(|key| {
                    strings(&brief[key]).is_none_or(|list| {
                        list.is_empty() || list.iter().any(|s| s.trim().is_empty())
                    })
                })
            {
                return refused("The fix brief needs a goal and non-empty files, done and checks.");
            }
            if findings
                .iter()
                .any(|f| f["about"] == "capability" || f["kind"] == "missing-tool")
                && brief["agentsAffected"] != true
            {
                brief["agentsAffected"] = json!(true);
                notes.push("The capability change also affects the agent skill.".into());
            }
        }
        "awaiting-owner" => {
            if s(&next, "question").trim().is_empty() {
                return refused("The owner route needs a question.");
            }
            next["role"] = json!(s(adapter, "owner"));
        }
        "awaiting-operator" => {
            if !s(adapter, "operator").is_empty() {
                next["role"] = json!(s(adapter, "operator"));
            }
            if s(&next, "role").trim().is_empty() {
                return refused("The operator route needs a role.");
            }
        }
        _ => {}
    }
    let reply = match s(&next,"route") {
        "reply" => "If anything is still unclear, answer this message.",
        "fix-brief" => "We found a fault in the product and are fixing it. We will write to you when the fix is out.",
        "awaiting-owner" => "This needs a decision of the people responsible for the product. We will write to you once it is made.",
        "awaiting-operator" => "This needs a change on the product's servers. We will write to you once it is done.",
        _ => "We are looking into the error and will write to you with what we find.",
    };
    let recommend_retry = retry && !discarded;
    let reporter_reply = if recommend_retry {
        format!(
            "When you are ready, you can try again: {}. {reply}",
            s(&adapter["retry"], "how")
                .trim()
                .trim_end_matches(['.', '!'])
        )
    } else {
        reply.to_owned()
    };
    let sources: serde_json::Map<String, Value> = items
        .iter()
        .map(|item| (s(item, "id").to_owned(), json!(s(item, "source"))))
        .collect();
    json!({"refused":[], "notes":notes, "findings":findings, "gaps":gaps, "next":next, "fixBrief":brief, "sourceOf":sources, "reporterReply":reporter_reply, "recommendRetry":recommend_retry, "discarded":discarded,
        "modelWording": {"facts":if discarded {""} else {s(answer,"facts").trim()}, "reply":if discarded {""} else {s(answer,"reply").trim()}, "leadLine":if discarded {""} else {s(answer,"leadLine").trim()}, "findingSummaries":summaries}})
}

/// Render only checked fields in actionable sections. Model-authored summaries and
/// suggested messages appear under the separate, explicitly unchecked heading.
pub(super) fn draft_text(
    j: &Value,
    adapter: &Value,
    incident: &str,
    revision: u64,
    evidence_sha: &str,
    classifier: &str,
) -> String {
    let mut lines = vec![
        format!("# Incident {incident}, revision {revision}"), String::new(),
        format!("Product: {}. Classifier: {classifier}. Evidence: rev-{revision}/evidence.json (sha256 {evidence_sha}).", s(adapter,"product")),
        "This is a draft: nothing was sent, no package was started, nothing was released.".into(), String::new(),
    ];
    let list = |values: &Value| -> String {
        values
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|v| format!("- {v}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    if j["refused"]
        .as_array()
        .is_some_and(|reasons| !reasons.is_empty())
    {
        lines.extend(["## No draft".into(), String::new(), "The classifier's answer was refused; nothing below may be sent:".into(), String::new(), list(&j["refused"]), String::new(), "## Next".into(), String::new(), "Run the workflow again with the evidence the answer was missing if that was the cause.".into(), String::new()]);
        return lines.join("\n");
    }
    let route = s(&j["next"], "route");
    let role = s(&j["next"], "role");
    lines.push(format!(
        "Route: {route}{}.",
        if role.is_empty() {
            String::new()
        } else {
            format!(" ({role})")
        }
    ));
    lines.extend([String::new(), "## Reply to the reporter".into(), String::new(), "Assembled by the workflow from fixed text and any documented retry. Put it into the reporter's language and send it yourself; this workflow sends nothing.".into(), String::new(), s(j,"reporterReply").into(), String::new()]);
    if j["recommendRetry"] == true {
        lines.push(format!(
            "It recommends the product's retry: {}. Conditions: {}",
            s(&adapter["retry"], "how"),
            s(&adapter["retry"], "conditions")
        ));
        lines.push(String::new());
    }
    let ids = |value: &Value| -> String {
        let rendered = value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|id| {
                format!(
                    "{} ({})",
                    id,
                    j["sourceOf"][id].as_str().unwrap_or("unknown source")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if rendered.is_empty() {
            "none".into()
        } else {
            rendered
        }
    };
    lines.extend(["## Findings".into(), String::new()]);
    let findings = j["findings"].as_array().cloned().unwrap_or_default();
    if findings.is_empty() {
        lines.push("- none".into());
    }
    for finding in &findings {
        let hypothesis = if s(finding, "kind") == "unknown" && !s(finding, "hypothesis").is_empty()
        {
            format!(" (hypothesis: {})", s(finding, "hypothesis"))
        } else {
            String::new()
        };
        let fixed = if finding["fixedBy"].as_array().is_some_and(|v| !v.is_empty()) {
            format!(" Fixed by: {}.", ids(&finding["fixedBy"]))
        } else {
            String::new()
        };
        let deployed = if finding["deployedIn"]
            .as_array()
            .is_some_and(|v| !v.is_empty())
        {
            format!(" Deployed in: {}.", ids(&finding["deployedIn"]))
        } else {
            String::new()
        };
        lines.push(format!(
            "- {}{}, {} confidence, about {}. Evidence: {}.{}{} {}",
            s(finding, "kind"),
            hypothesis,
            s(finding, "confidence"),
            s(finding, "about"),
            ids(&finding["evidence"]),
            fixed,
            deployed,
            s(finding, "note")
        ));
    }
    lines.extend([String::new(), "## Gaps".into(), String::new()]);
    let gaps = j["gaps"].as_array().cloned().unwrap_or_default();
    if gaps.is_empty() {
        lines.push("- none".into());
    }
    for gap in gaps {
        let operation = if s(&gap, "operation").is_empty() {
            "No sanctioned operation supplies it.".into()
        } else {
            format!("Operation that supplies it: {}.", s(&gap, "operation"))
        };
        let proposal = if s(&gap, "proposal").is_empty() {
            String::new()
        } else {
            format!(" Proposal: {}", s(&gap, "proposal"))
        };
        lines.push(format!(
            "- {} ({}). {}{}",
            s(&gap, "what"),
            ids(&gap["evidence"]),
            operation,
            proposal
        ));
    }
    lines.extend([String::new(), "## Next".into(), String::new()]);
    lines.push(match route {
        "reply" => "Send the reply above to the reporter, then log the note below.".into(),
        "fix-brief" => "Save the fix brief below and run code-package. Merge and release only with an explicit OK of the owner. Meanwhile the reporter gets the reply above.".into(),
        "awaiting-owner" => format!("Ask {role}: {} Nothing is decided before the answer. Meanwhile the reporter gets the reply above.", s(&j["next"],"question")),
        "awaiting-operator" => format!("Hand the findings and gaps above to {role}. Meanwhile the reporter gets the reply above."),
        _ => "The evidence does not settle it. Collect what the gaps name; where no operation exists, build a product report, never request wider access. Meanwhile the reporter gets the reply above.".into(),
    });
    if route == "fix-brief" {
        lines.extend([
            String::new(),
            "## Fix brief".into(),
            String::new(),
            "### Goal".into(),
            String::new(),
            s(&j["fixBrief"], "goal").into(),
        ]);
        for (title, key) in [("Files", "files"), ("Done", "done"), ("Checks", "checks")] {
            lines.extend([
                String::new(),
                format!("### {title}"),
                String::new(),
                list(&j["fixBrief"][key]),
            ]);
        }
        if j["fixBrief"]["agentsAffected"] == true {
            let skill = if s(&adapter["agentSkill"], "path").is_empty() {
                "the agent skill of the product"
            } else {
                s(&adapter["agentSkill"], "path")
            };
            let change = s(&j["fixBrief"], "agentSkillChange").trim();
            lines.extend([String::new(), "## Agent skill: a second package".into(), String::new(), format!("Update {skill} in the same change set. Release both together, the skill not before the capability exists."), String::new(), "### Goal".into(), String::new(), if change.is_empty() { "Make the agent skill describe the changed capability as the product allows it.".into() } else { change.into() }, String::new(), "### Files".into(), String::new(), format!("- {skill}"), String::new(), "### Done".into(), String::new(), "- The skill's commands match the product's allow-lists.".into(), String::new(), "### Checks".into(), String::new(), "- Compare the skill's commands with the product's allow-lists.".into()]);
        }
    }
    let main = findings.first();
    let cause = main
        .map(|f| {
            format!(
                "{}, {} confidence; evidence {}",
                s(f, "kind"),
                s(f, "confidence"),
                ids(&f["evidence"])
            )
        })
        .unwrap_or_else(|| "not settled".into());
    lines.extend([
        String::new(),
        format!(
            "## For the incident log{}",
            if s(adapter, "incidentLog").is_empty() {
                String::new()
            } else {
                format!(" ({})", s(adapter, "incidentLog"))
            }
        ),
        String::new(),
        "Version 1 does not write the log; the lead adds this note when closing:".into(),
        String::new(),
        format!("- Cause: {cause}"),
        format!(
            "- Change: {}",
            if route == "fix-brief" {
                s(&j["fixBrief"], "goal")
            } else {
                "none"
            }
        ),
        format!(
            "- Release: {}",
            if route == "fix-brief" {
                "only with an explicit OK"
            } else {
                "none"
            }
        ),
        if j["recommendRetry"] == true {
            format!(
                "- Who verifies: the reporter, by the product's retry ({}).",
                s(&adapter["retry"], "how")
            )
        } else {
            "- Who verifies: not settled by this draft; name it when closing.".into()
        },
        String::new(),
        "## Model's wording (not checked, do not forward as is)".into(),
        String::new(),
    ]);
    if j["discarded"] == true {
        lines.push("Discarded: a finding is not supported by the required evidence.".into());
    } else {
        let wording = &j["modelWording"];
        lines.extend([
            format!("- Facts for the reporter: {}", s(wording, "facts")),
            format!("- Suggested reply: {}", s(wording, "reply")),
            format!("- Line for the lead: {}", s(wording, "leadLine")),
            format!("- Reason for the route: {}", s(&j["next"], "reason")),
        ]);
        for (i, summary) in wording["findingSummaries"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            lines.push(format!(
                "- Summary of finding {}: {}",
                i + 1,
                summary.as_str().unwrap_or("")
            ));
        }
    }
    if j["notes"].as_array().is_some_and(|notes| !notes.is_empty()) {
        lines.extend([
            String::new(),
            "## Validation notes".into(),
            String::new(),
            list(&j["notes"]),
        ]);
    }
    lines.push(String::new());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn answer() -> Value {
        json!({"findings":[{"kind":"stale","hypothesis":"","about":"code","confidence":"high","summary":"unverified model words","evidence":["E1"],"fixedBy":[],"deployedIn":[]}],"gaps":[],"next":{"route":"reply","role":"","question":"","reason":"unverified"},"facts":"unverified","reply":"unverified","leadLine":"unverified","recommendRetry":false,"fixBrief":{"goal":"","files":[],"done":[],"checks":[],"agentsAffected":false,"agentSkillChange":""}})
    }
    #[test]
    fn stale_without_both_sources_discards_model_words() {
        let result = judge(
            &answer(),
            &json!({"items":[{"id":"E1","source":"report","outcome":"ok","provides":[]}]}),
            &json!({"operations":{}}),
        );
        assert_eq!(result["next"]["route"], "needs-evidence");
        assert_eq!(result["findings"][0]["kind"], "unknown");
        assert_eq!(result["modelWording"]["facts"], "");
        assert_eq!(result["discarded"], true);
        assert_eq!(result["gaps"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn access_requests_and_prohibitions() {
        for s in [
            "grant access",
            "grant-access",
            "do not wait: grant access",
            "do not. Grant access",
            "never; bypass the allow-list refusal",
            "bypass the allow-list refusal",
            "bypass-allow-list",
            "haven't got access",
            "нет доступа",
            "предоставьте доступ",
        ] {
            assert!(unsafe_action(s), "{s}");
        }
        for s in [
            "must not grant access",
            "never bypass the allow-list refusal",
            "не предоставляйте доступ",
        ] {
            assert!(!unsafe_action(s), "{s}");
        }
    }
    #[test]
    fn evidence_and_retry_are_checked() {
        let bundle = json!({"items":[{"id":"E1","source":"report","outcome":"ok","provides":[]}]});
        let mut a = answer();
        a["findings"][0]["evidence"] = json!(["E2"]);
        assert!(!judge(&a, &bundle, &json!({"operations":{}}))["refused"]
            .as_array()
            .unwrap()
            .is_empty());
        let mut a = answer();
        a["recommendRetry"] = json!(true);
        assert!(!judge(&a, &bundle, &json!({"operations":{}}))["refused"]
            .as_array()
            .unwrap()
            .is_empty());
    }
    #[test]
    fn model_wording_is_not_in_the_actionable_draft() {
        let mut a = answer();
        a["findings"][0]["kind"] = json!("user-action");
        let j = judge(
            &a,
            &json!({"items":[{"id":"E1","source":"report","outcome":"ok","provides":[]}]}),
            &json!({"product":"Catalog","operations":{}}),
        );
        let text = draft_text(
            &j,
            &json!({"product":"Catalog","operations":{}}),
            "case",
            1,
            "hash",
            "codex/model",
        );
        let (actionable, wording) = text.split_once("## Model's wording").unwrap();
        assert!(!actionable.contains("unverified"));
        assert!(wording.contains("unverified model words"));
    }
    #[test]
    fn legacy_access_fixtures_distinguish_prohibitions_and_actionable_requests() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/e2e/fixtures/incident-triage/cases");
        let bundle = json!({"items":[
            {"id":"E2","source":"op:status","outcome":"ok","provides":["status"]},
            {"id":"E3","source":"op:processes","outcome":"refused","provides":["other"]},
            {"id":"E5","source":"agentSkill","outcome":"ok","provides":[]},
            {"id":"E6","source":"allowList:lead","outcome":"ok","provides":[]}
        ]});
        let adapter = json!({"product":"Catalog","operations":{}});
        for (case, should_refuse) in [
            ("security-prohibitions", false),
            ("access-in-brief", true),
            ("access-in-gap", true),
            ("access-in-summary", false),
        ] {
            let answer: Value = serde_json::from_slice(
                &std::fs::read(root.join(case).join("classification.json")).unwrap(),
            )
            .unwrap();
            let result = judge(&answer, &bundle, &adapter);
            assert_eq!(
                !result["refused"].as_array().unwrap().is_empty(),
                should_refuse,
                "{case}: {result}"
            );
            if !should_refuse {
                let draft = draft_text(&result, &adapter, "case", 1, "hash", "codex/model");
                let (actionable, _) = draft.split_once("## Model's wording").unwrap();
                if case == "access-in-summary" {
                    assert!(!actionable.contains("Grant the lead"));
                }
            }
        }
    }

    #[test]
    fn capability_requires_successful_reads_of_both_sources() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../scripts/e2e/fixtures/incident-triage/cases/agent-capability/classification.json");
        let answer: Value = serde_json::from_slice(&std::fs::read(root).unwrap()).unwrap();
        let mut bundle = json!({"items":[
            {"id":"E1","source":"report","outcome":"ok","provides":[]},
            {"id":"E2","source":"op:status","outcome":"ok","provides":[]},
            {"id":"E3","source":"op:other","outcome":"ok","provides":[]},
            {"id":"E4","source":"agentSkill","outcome":"ok","provides":[]},
            {"id":"E5","source":"allowList:lead","outcome":"refused","provides":[]}
        ]});
        // Test with explicit citations regardless of the fixture's other findings.
        let mut answer = answer;
        answer["findings"] = json!([{"kind":"product-bug","about":"capability","evidence":["E4","E5"],"fixedBy":[],"deployedIn":[]}]);
        let result = judge(&answer, &bundle, &json!({}));
        assert_eq!(result["next"]["route"], "needs-evidence");
        assert_eq!(result["findings"][0]["kind"], "unknown");
        assert!(result["gaps"].as_array().unwrap().iter().any(|gap| gap["evidence"] == json!(["E5"]) && !gap["proposal"].as_str().unwrap_or("").is_empty()));
        bundle["items"][4]["outcome"] = json!("empty");
        assert_eq!(judge(&answer, &bundle, &json!({}))["next"]["route"], "needs-evidence");
    }
}
