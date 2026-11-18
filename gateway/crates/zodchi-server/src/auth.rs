//! Who is calling. The server asks an [`Authenticator`] for every request but `/health`; the default one checks
//! `Authorization: Bearer <token>` against the token hashes of `server.json`. A fork puts its own implementation in
//! (for example a company identity service) and changes nothing else: the rest of the server only sees [`Identity`].

use crate::registry;
use std::path::PathBuf;
use zodchi_core::util::is_user_id;

/// The caller as the server knows it. `id` names the user's folder, so it must be `[a-z0-9-]{1,40}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    /// 401: no credentials, or wrong ones. The server answers with its own fixed text (`unauthorized`); this text
    /// is not passed on.
    Unauthorized(String),
    /// 500: the authenticator cannot decide (its registry cannot be read); nobody gets in. The client gets a fixed
    /// `unavailable` error; this text, the details, goes to the server's log.
    Unavailable(String),
}

pub trait Authenticator: Send + Sync {
    /// Request headers as (name, value) pairs, names in any case.
    fn authenticate(&self, headers: &[(String, String)]) -> Result<Identity, Refusal>;
}

/// Bearer tokens checked against `<data>/server.json`, read anew on every request: a removed user or a revoked
/// token fails on the next request, and a registry that cannot be read lets nobody in.
pub struct TokenAuthenticator {
    pub data: PathBuf,
}

/// Equal in time that does not depend on where the two differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn bearer(headers: &[(String, String)]) -> Option<&str> {
    let value = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.trim())?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

impl Authenticator for TokenAuthenticator {
    fn authenticate(&self, headers: &[(String, String)]) -> Result<Identity, Refusal> {
        let users = registry::load(&self.data).map_err(|e| {
            // The reason names the registry's path: it stays in the server's log, the caller gets none of it.
            eprintln!("zodchi-server: the registry of users cannot be read: {e}");
            Refusal::Unavailable("The registry of users cannot be read; nobody gets in. The server's log has the reason.".into())
        })?;
        let Some(token) = bearer(headers) else {
            return Err(Refusal::Unauthorized("Authorization: Bearer <token> is required.".into()));
        };
        let presented = registry::token_hash(token);
        // Every stored hash is compared, whatever matched before it.
        let mut found: Option<&registry::User> = None;
        for user in &users {
            for hash in &user.token_hashes {
                if same(presented.as_bytes(), hash.as_bytes()) && found.is_none() {
                    found = Some(user);
                }
            }
        }
        match found {
            Some(user) if is_user_id(&user.id) => Ok(Identity { id: user.id.clone(), name: user.name.clone() }),
            _ => Err(Refusal::Unauthorized("The token is not valid.".into())),
        }
    }
}
