//! FrilVault command-line interface.
//!
//! The CLI parses arguments, opens the current workspace, invokes `frilvault-core`,
//! and formats results for humans or JSON consumers.
//!
//! FrilVault CLI입니다.
//!
//! CLI는 인자를 파싱하고 현재 workspace를 연 뒤 `frilvault-core`를 호출하여
//! 사람이 읽거나 JSON consumer가 사용할 결과를 출력합니다.
mod cli;
mod command;
mod output;

use anyhow::Result;
use clap::Parser;
use cli::{Cli, Commands};
use frilvault_core::FrilVaultError;
use std::{ffi::OsString, process};

fn main() {
    let json_errors = json_format_requested(std::env::args_os().skip(1));
    if let Err(error) = run(Cli::parse()) {
        if let Some(child_exit) = error.downcast_ref::<command::env::ChildProcessExit>() {
            process::exit(child_exit.exit_code());
        }

        eprintln!("{}", format_error(&error, json_errors));
        process::exit(1);
    }
}

fn json_format_requested(args: impl IntoIterator<Item = OsString>) -> bool {
    let mut args = args.into_iter();
    while let Some(argument) = args.next() {
        if argument == "--" {
            break;
        }
        if argument == "--format=json" {
            return true;
        }
        if argument == "--format" {
            return args.next().is_some_and(|value| value == "json");
        }
    }
    false
}

fn format_error(error: &anyhow::Error, json: bool) -> String {
    let core_error = error
        .chain()
        .find_map(|cause| cause.downcast_ref::<FrilVaultError>());

    if json {
        let code = core_error.map_or("operation_failed", FrilVaultError::code);
        let message = core_error.map_or_else(|| error.to_string(), ToString::to_string);
        return serde_json::json!({
            "error": {
                "code": code,
                "message": message,
            }
        })
        .to_string();
    }

    format!("{error:#}")
}

fn run(cli: Cli) -> Result<()> {
    let Cli { vault, command } = cli;
    let vault_path = vault.as_deref();

    macro_rules! dispatch {
        ($module:ident, $command:expr) => {
            match vault_path {
                Some(vault_path) => {
                    command::$module::execute_with_vault($command, Some(vault_path))
                }
                None => command::$module::execute($command),
            }
        };
    }

    match command {
        Commands::Env(cmd) => dispatch!(env, cmd)?,

        Commands::Init(cmd) => dispatch!(init, cmd)?,

        Commands::Add(cmd) => dispatch!(add, cmd)?,

        Commands::Attach(cmd) => dispatch!(attach, cmd)?,

        Commands::List(cmd) => dispatch!(list, cmd)?,

        Commands::Update(cmd) => dispatch!(update, cmd)?,

        Commands::Delete(cmd) => dispatch!(delete, cmd)?,

        Commands::Search(cmd) => dispatch!(search, cmd)?,
        Commands::Doctor(cmd) => dispatch!(doctor, cmd)?,

        Commands::Health(cmd) => dispatch!(doctor, cmd)?,

        Commands::Stats(cmd) => dispatch!(stats, cmd)?,

        Commands::Status(cmd) => dispatch!(status, cmd)?,

        Commands::Index(cmd) => dispatch!(index, cmd)?,

        Commands::Explorer(cmd) => dispatch!(explorer, cmd)?,

        Commands::Sync(cmd) => dispatch!(sync, cmd)?,

        Commands::Repair(cmd) => dispatch!(repair, cmd)?,

        Commands::ResolveUri(cmd) => dispatch!(resolve_uri, cmd)?,

        Commands::Gitignore(cmd) => dispatch!(gitignore, cmd)?,

        Commands::Tag(cmd) => dispatch!(tag, cmd)?,
    }

    Ok(())
}

#[cfg(test)]
mod error_output_tests {
    use super::{format_error, json_format_requested};
    use std::ffi::OsString;

    #[test]
    fn formats_missing_workspace_errors_as_stable_json() {
        let error = frilvault_core::FrilVaultError::WorkspaceNotFound;
        let error = anyhow::Error::new(error);

        let output = format_error(&error, true);
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["error"]["code"], "workspace_not_found");
        assert_eq!(
            parsed["error"]["message"],
            "No FrilVault workspace found.\nRun `flvt init` to initialize one."
        );
    }

    #[test]
    fn detects_json_format_until_the_child_command_separator() {
        assert!(json_format_requested([
            OsString::from("list"),
            OsString::from("--format"),
            OsString::from("json"),
        ]));
        assert!(json_format_requested([
            OsString::from("list"),
            OsString::from("--format=json"),
        ]));
        assert!(!json_format_requested([
            OsString::from("env"),
            OsString::from("run"),
            OsString::from("--"),
            OsString::from("tool"),
            OsString::from("--format"),
            OsString::from("json"),
        ]));
    }
}

#[cfg(test)]
mod index_command;
#[cfg(test)]
mod tag_command_test;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod test_support {
    use std::sync::Mutex;

    pub static WORKING_DIRECTORY_LOCK: Mutex<()> = Mutex::new(());
}
