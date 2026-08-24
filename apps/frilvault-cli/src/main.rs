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
    match cli.command {
        Commands::Init(cmd) => {
            command::init::execute(cmd)?;
        }

        Commands::Add(cmd) => {
            command::add::execute(cmd)?;
        }

        Commands::Attach(cmd) => {
            command::attach::execute(cmd)?;
        }

        Commands::List(cmd) => {
            command::list::execute(cmd)?;
        }

        Commands::Update(cmd) => {
            command::update::execute(cmd)?;
        }

        Commands::Delete(cmd) => {
            command::delete::execute(cmd)?;
        }

        Commands::Search(cmd) => {
            command::search::execute(cmd)?;
        }
        Commands::Doctor(cmd) => {
            command::doctor::execute(cmd)?;
        }

        Commands::Health(cmd) => {
            command::doctor::execute(cmd)?;
        }

        Commands::Stats(cmd) => command::stats::execute(cmd)?,

        Commands::Status(cmd) => command::status::execute(cmd)?,

        Commands::Index(cmd) => command::index::execute(cmd)?,

        Commands::Explorer(cmd) => command::explorer::execute(cmd)?,

        Commands::Sync(cmd) => command::sync::execute(cmd)?,

        Commands::Repair(cmd) => {
            command::repair::execute(cmd)?;
        }

        Commands::ResolveUri(cmd) => {
            command::resolve_uri::execute(cmd)?;
        }

        Commands::Gitignore(cmd) => {
            command::gitignore::execute(cmd)?;
        }

        Commands::Tag(cmd) => {
            command::tag::execute(cmd)?;
        }
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
