use super::{Entry, StatusHooks, NO_STATUS};
use crate::{cleanup, control, read_args, Exit, USAGE};
use serde_json::json;
use std::path::Path;
use zodchi_core::util::{fail, GatewayError, Result};
use zodchi_flow_engine::verify::{self, Selection};

pub(super) const ENTRY: Entry = Entry {
    special: Some(special),
    status: StatusHooks {
        details: Some(|run, _, status| {
            status["commit"] = run["commit"].clone();
            status["tree"] = run["tree"].clone();
        }),
        ..NO_STATUS
    },
    finished_approved: Some(|result| result["verdict"] == "passed"),
    ..Entry::new(
        verify::NAME,
        verify::VERSION,
        |_, _| fail(USAGE),
        verify::resume,
    )
};

struct Options<'a> {
    reference: &'a str,
    repo: Option<&'a Path>,
    file: Option<&'a str>,
    selection: Selection,
    detach: bool,
}

impl<'a> Options<'a> {
    fn parse(args: &'a [String]) -> Result<Self> {
        let mut args = args.iter().map(String::as_str);
        let reference = args
            .next()
            .filter(|arg| !arg.is_empty() && !arg.starts_with('-'))
            .ok_or_else(|| GatewayError(USAGE.into()))?;
        let mut options = Self {
            reference,
            repo: None,
            file: None,
            selection: Selection::All,
            detach: false,
        };
        while let Some(flag) = args.next() {
            let value = || GatewayError(format!("Missing value for {flag}\n{USAGE}"));
            match flag {
                "--repo" if options.repo.is_none() => {
                    options.repo = Some(Path::new(
                        args.next()
                            .filter(|arg| !arg.is_empty() && !arg.starts_with("--"))
                            .ok_or_else(value)?,
                    ));
                }
                "--args" if options.file.is_none() => {
                    options.file = Some(
                        args.next()
                            .filter(|arg| !arg.is_empty() && !arg.starts_with("--"))
                            .ok_or_else(value)?,
                    );
                }
                "--only" if matches!(options.selection, Selection::All) => {
                    options.selection = match args.next() {
                        Some("checks") => Selection::Checks,
                        Some("verify") => Selection::Verify,
                        _ => return fail(format!("--only accepts checks or verify.\n{USAGE}")),
                    };
                }
                "--detach" if !options.detach => options.detach = true,
                _ => return Err(crate::unexpected(flag)),
            }
        }
        Ok(options)
    }
}

pub(crate) fn starts_run(args: &[String]) -> bool {
    Options::parse(args).is_ok()
}

fn special(args: &[String]) -> Option<Result<Exit>> {
    // Leading flags use the common resume parser. Starting requires the positional commit first.
    args.first().filter(|arg| !arg.starts_with("--"))?;
    Some(Options::parse(args).and_then(start))
}

fn start(options: Options<'_>) -> Result<Exit> {
    let wrong_call = |error: GatewayError| GatewayError(format!("{}\n{USAGE}", error.0));
    let overrides = options
        .file
        .map(read_args)
        .transpose()
        .map_err(wrong_call)?
        .unwrap_or_else(|| json!({}));
    let (id, journal) = verify::prepare(
        options.reference,
        options.repo,
        &overrides,
        options.selection,
    )
    .map_err(wrong_call)?;
    if options.detach {
        return control::launch_start(&journal, &id);
    }
    verify::resume(&id, None, None).map(cleanup::after_run)
}
