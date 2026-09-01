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

fn main() -> Result<()> {
    run(Cli::parse())
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
