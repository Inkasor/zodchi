use crate::research_material::Privacy;
use serde_json::{json, Value};
use std::{collections::HashSet, fs, path::Path};
use zodchi_core::util::{fail, sha256_hex, GatewayError, Result};

pub fn ledger(file: &Path) -> Result<(Value, String)> {
    let bytes = match fs::read(file) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error.into()),
    };
    let data = if bytes.is_empty() {
        json!({"version": 1, "appliedRounds": [], "entries": []})
    } else {
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| GatewayError("The decisions ledger must be valid JSON.".into()))?
    };
    if data["version"] != 1
        || !data["appliedRounds"]
            .as_array()
            .is_some_and(|rounds| rounds.iter().enumerate().all(|(i, n)| n == &(i + 1)))
        || !data["entries"].as_array().is_some_and(|entries| {
            let mut ids = HashSet::new();
            entries.iter().all(|entry| {
                entry["id"].as_str().is_some_and(|id| ids.insert(id))
                    && entry["text"].as_str().is_some_and(|text| !text.is_empty())
                    && matches!(
                        entry["state"].as_str(),
                        Some("open" | "accepted" | "rejected" | "superseded")
                    )
            })
        })
    {
        return fail("The decisions ledger has an invalid history.");
    }
    Ok((data, sha256_hex(bytes)))
}

pub fn for_model(ledger: &Value, privacy: &Privacy) -> Vec<Value> {
    ledger["entries"].as_array().into_iter().flatten().map(|entry|
        json!({"id":entry["id"], "state":entry["state"], "text": privacy.text(entry["text"].as_str().unwrap_or(""))})
    ).collect()
}

pub fn markdown(round: u64, lines: &[Value]) -> String {
    let mut text = format!("# Исследование — раунд {round}\n");
    for row in lines {
        let display = row["text"].as_str().unwrap_or("");
        let group = row["group"].as_str().unwrap_or("");
        let n = row["n"].as_u64().unwrap_or(0);
        let kind = if row["kind"] == "assumption" {
            "Допущение"
        } else {
            "Решение"
        };
        text.push_str(&format!("\n{n}. **{kind}** ({group}) {display}\n"));
        if let Some(why) = row
            .get("why")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
        {
            text.push_str(&format!("   Основание — {why}\n"));
        }
        for prior in row["replaces"].as_array().into_iter().flatten() {
            text.push_str(&format!(
                "   Заменяет {} — {}\n",
                prior["id"].as_str().unwrap_or(""),
                prior["text"].as_str().unwrap_or("")
            ));
        }
    }
    text
}

pub fn parse_reply(reply: &str) -> Result<Vec<Value>> {
    serde_json::from_str(reply)
        .map_err(|_| GatewayError("The reply must be a JSON array of verdicts.".into()))
}

pub fn scrub_corrections(actions: &mut [Value], privacy: &Privacy) {
    for action in actions {
        if let Some(text) = action["text"].as_str() {
            action["text"] = json!(privacy.text(text.trim()));
        }
    }
}

pub fn apply(
    mut ledger: Value,
    actions: &[Value],
    round: u64,
    lines: &[Value],
) -> Result<Value> {
    let entries = ledger["entries"].as_array_mut().expect("validated entries");
    for line in lines {
        let mut entry = line.clone();
        if let Some(replaces) = entry
            .as_object_mut()
            .expect("list entry")
            .remove("replaces")
        {
            let ids: Vec<_> = replaces
                .as_array()
                .into_iter()
                .flatten()
                .map(|target| &target["id"])
                .collect();
            if !ids.is_empty() {
                entry["replaces"] = json!(ids);
            }
        }
        entry["round"] = json!(round);
        entry["state"] = json!("open");
        entries.push(entry);
    }
    let mut unique = HashSet::new();
    for action in actions {
        if action.as_object().is_none_or(|fields| {
            fields
                .keys()
                .any(|key| !["n", "id", "text", "verdict"].contains(&key.as_str()))
        }) {
            return fail("A verdict needs n or id, verdict and text for fix.");
        }
        let id = match (action["n"].as_u64(), action["id"].as_str()) {
            (Some(n), None) if action.get("id").is_none() && n > 0 && n <= lines.len() as u64 => {
                format!("{round}.{n}")
            }
            (None, Some(id)) if action.get("n").is_none() => id.into(),
            _ => return fail("Name a current number or one earlier open ID per verdict."),
        };
        if !unique.insert(id.clone()) {
            return fail("A decision received more than one verdict.");
        }
        let entry = entries
            .iter_mut()
            .find(|entry| entry["id"] == id && entry["state"] == "open")
            .ok_or_else(|| GatewayError("The reply names a decision that is not open.".into()))?;
        match (action["verdict"].as_str(), action.get("text")) {
            (Some("accept"), None) => entry["state"] = json!("accepted"),
            (Some("drop"), None) => entry["state"] = json!("rejected"),
            (Some("fix"), Some(Value::String(text))) if !text.trim().is_empty() => {
                entry["state"] = json!("accepted");
                entry["was"] = entry["text"].clone();
                entry["text"] = json!(text);
            }
            _ => return fail("Use accept or drop, or fix with replacement text."),
        }
        entry["decidedInRound"] = json!(round);
    }
    // Earlier proposals get first claim if several newly accepted entries name the same target.
    for index in 0..entries.len() {
        if entries[index]["state"] != "accepted" || entries[index]["decidedInRound"] != round {
            continue;
        }
        let id = entries[index]["id"].clone();
        for target in entries[index]["replaces"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            if let Some(entry) = entries.iter_mut().find(|entry| {
                entry["id"] == target
                    && matches!(entry["state"].as_str(), Some("open" | "accepted"))
            }) {
                entry["state"] = json!("superseded");
                entry["supersededBy"] = id.clone();
                entry
                    .as_object_mut()
                    .expect("decision entry")
                    .remove("decidedInRound");
            }
        }
    }
    ledger["appliedRounds"]
        .as_array_mut()
        .expect("validated rounds")
        .push(json!(round));
    Ok(ledger)
}

pub fn ledger_markdown(value: &Value, privacy: &Privacy) -> String {
    let round = value["appliedRounds"].as_array().map(Vec::len).unwrap_or(0);
    let mut text = format!("# Список решений (после раунда {round})\n");
    for (state, heading) in [
        ("accepted", "Принято"),
        ("open", "Открыто"),
        ("rejected", "Отклонено"),
        ("superseded", "Заменено"),
    ] {
        text.push_str(&format!("\n## {heading}\n"));
        for item in value["entries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|entry| entry["state"] == state)
        {
            text.push_str(&format!(
                "\n- {} {}\n",
                item["id"].as_str().unwrap_or(""),
                privacy.text(item["text"].as_str().unwrap_or(""))
            ));
        }
    }
    text
}
