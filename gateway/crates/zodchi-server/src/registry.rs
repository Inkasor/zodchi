//! The users of the server: `<data>/server.json` = `{"users": [{id, name, tokenHashes, createdAt}]}`. Only SHA-256
//! hashes of the tokens are stored. The file is replaced atomically, and every read-modify-write (the admin
//! commands) runs under `server.json.lock`, so two admin commands at once never lose a user.

use crate::lock::PidLock;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use zodchi_core::util::{fail, is_user_id, iso, sha256_hex, write_json_atomic, GatewayError, Result};

#[derive(Debug, Clone, PartialEq)]
pub struct User {
    pub id: String,
    pub name: String,
    pub token_hashes: Vec<String>,
    pub created_at: String,
}

impl User {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "tokenHashes": self.token_hashes, "createdAt": self.created_at })
    }
}

pub fn registry_file(data: &Path) -> PathBuf {
    data.join("server.json")
}

pub fn user_dir(data: &Path, id: &str) -> PathBuf {
    data.join("users").join(id)
}

/// A new token: 32 random bytes, shown once to the admin and never stored.
pub fn new_token() -> String {
    format!("zs_{}", hex::encode(rand::random::<[u8; 32]>()))
}

pub fn token_hash(token: &str) -> String {
    sha256_hex(token.as_bytes())
}

fn parse(text: &str, file: &Path) -> Result<Vec<User>> {
    let broken = || GatewayError(format!("{} is not a registry of users.", file.display()));
    let value: Value = serde_json::from_str(text).map_err(|_| broken())?;
    let mut users = Vec::new();
    for entry in value.get("users").and_then(Value::as_array).ok_or_else(broken)? {
        let text_of = |k: &str| entry.get(k).and_then(Value::as_str).map(String::from);
        let (Some(id), Some(name), Some(created_at)) = (text_of("id"), text_of("name"), text_of("createdAt")) else { return Err(broken()) };
        let hashes = entry.get("tokenHashes").and_then(Value::as_array).ok_or_else(broken)?;
        let token_hashes: Vec<String> = hashes.iter().filter_map(|h| h.as_str().map(String::from)).collect();
        if !is_user_id(&id) || token_hashes.len() != hashes.len() || users.iter().any(|u: &User| u.id == id) {
            return Err(broken());
        }
        users.push(User { id, name, token_hashes, created_at });
    }
    Ok(users)
}

/// The users as the file says now. A missing or broken file is an error: whoever reads it fails closed.
pub fn load(data: &Path) -> Result<Vec<User>> {
    let file = registry_file(data);
    let text = fs::read_to_string(&file).map_err(|e| GatewayError(format!("{}: {e}", file.display())))?;
    parse(&text, &file)
}

/// One read-modify-write of the registry under its lock. A missing file is an empty registry here (the first
/// admin command creates it); a broken one is never overwritten.
pub fn modify<T>(data: &Path, change: impl FnOnce(&mut Vec<User>) -> Result<T>) -> Result<T> {
    fs::create_dir_all(data)?;
    let _lock = PidLock::acquire(&data.join("server.json.lock"), Duration::from_secs(30))?;
    let file = registry_file(data);
    let mut users = match fs::read_to_string(&file) {
        Ok(text) => parse(&text, &file)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return fail(format!("{}: {e}", file.display())),
    };
    let out = change(&mut users)?;
    write_json_atomic(&file, &json!({ "users": users.iter().map(User::to_json).collect::<Vec<_>>() }))?;
    Ok(out)
}

/// Makes sure the registry exists (an empty one when there is none).
pub fn ensure(data: &Path) -> Result<()> {
    if registry_file(data).exists() {
        return load(data).map(|_| ());
    }
    modify(data, |_| Ok(()))
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= 24 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "user".into() } else { out }
}

/// Adds a user and returns it with its token. The id comes from the name with a random tail and is never one whose
/// folder is still on disk (a removed user's jobs and sign-in are not handed to someone new).
pub fn add(data: &Path, name: &str) -> Result<(User, String)> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 || name.chars().any(char::is_control) {
        return fail("A user name is 1-100 characters without control characters.");
    }
    let token = new_token();
    let user = modify(data, |users| {
        let id = loop {
            let id = format!("{}-{}", slug(name), hex::encode(rand::random::<[u8; 3]>()));
            if !users.iter().any(|u| u.id == id) && !user_dir(data, &id).exists() {
                break id;
            }
        };
        let user = User { id, name: name.to_string(), token_hashes: vec![token_hash(&token)], created_at: iso() };
        fs::create_dir_all(user_dir(data, &user.id).join("codex-home"))?;
        fs::create_dir_all(user_dir(data, &user.id).join("jobs"))?;
        users.push(user.clone());
        Ok(user)
    })?;
    Ok((user, token))
}

/// Removes a user from the registry. Their folder stays on disk until the admin deletes it.
pub fn remove(data: &Path, id: &str) -> Result<User> {
    modify(data, |users| {
        let Some(at) = users.iter().position(|u| u.id == id) else { return fail(format!("No user {id}.")) };
        Ok(users.remove(at))
    })
}

/// A new token for a user; every earlier token of the user stops working.
pub fn reissue(data: &Path, id: &str) -> Result<String> {
    let token = new_token();
    modify(data, |users| {
        let Some(user) = users.iter_mut().find(|u| u.id == id) else { return fail(format!("No user {id}.")) };
        user.token_hashes = vec![token_hash(&token)];
        Ok(())
    })?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_letters_and_digits() {
        assert_eq!(slug("Ada Lovelace"), "ada-lovelace");
        assert_eq!(slug("  !!"), "user");
        assert!(slug(&"x".repeat(80)).len() <= 24);
    }

    #[test]
    fn a_broken_registry_is_refused() {
        let file = Path::new("server.json");
        assert!(parse("{", file).is_err());
        assert!(parse("{\"users\": [{\"id\": \"../x\", \"name\": \"a\", \"createdAt\": \"t\", \"tokenHashes\": []}]}", file).is_err());
        assert!(parse("{\"users\": []}", file).unwrap().is_empty());
    }
}
