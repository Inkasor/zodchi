//! zodchi-core: the gateway through which agents call Codex models by role.
//!
//! - [`role`]: roles and their checks; the rubric verdict of a decisions call.
//! - [`job`]: the job folder, idempotency keys, the queue, the worker, settling dead workers, the subscription pool.
//! - [`appserver`]: the Codex app-server protocol (JSON-RPC over stdio) for one job.
//! - [`decisions`]: the Decisions API on the caller's API key.
//! - [`process`]: processes by pid and start time, stopping process trees.
//! - [`config`]: where the repository, the roles, Codex and the subscriptions are.

pub mod appserver;
pub mod config;
pub mod decisions;
pub mod job;
pub mod process;
pub mod role;
pub mod util;

pub use util::{GatewayError, Result};
