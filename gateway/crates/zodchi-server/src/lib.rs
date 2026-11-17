//! zodchi-server: the gateway over HTTP for several people. Each person signs in to their own ChatGPT
//! subscription by device code, and every job of a person runs only on that person's subscription.
//!
//! - [`api`]: the HTTP routes, admission and the fixed pool of threads.
//! - [`auth`]: the [`auth::Authenticator`] trait and its default, bearer tokens checked against `server.json`.
//! - [`registry`]: the users in `server.json` (token hashes only) and the admin commands.
//! - [`login`]: the device-code sign-in of each user.
//! - [`lock`]: lock files between processes.
//! - [`signal`]: Ctrl+C and SIGTERM.

pub mod api;
pub mod auth;
pub mod lock;
pub mod login;
pub mod registry;
pub mod signal;
