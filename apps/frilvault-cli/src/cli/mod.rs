//! CLI argument definitions and command routing.
//!
//! CLI 인자 정의와 command routing입니다.

use clap::{Parser, Subcommand};

pub mod add;
pub mod attach;
pub mod delete;
pub mod explorer;
pub mod format;
pub mod gitignore;
pub mod health;
pub mod index;
pub mod list;
pub mod repair;
pub mod resolve_uri;
pub mod search;
pub mod stats;
pub mod sync;
pub mod tag;
pub mod update;

use add::AddCommand;
use attach::AttachCommand;
use delete::DeleteCommand;
use explorer::ExplorerCommand;
use gitignore::GitignoreCommand;
use health::HealthCommand;
use index::IndexCommand;
use list::ListCommand;
use repair::RepairCommand;
use resolve_uri::ResolveUriCommand;
use search::SearchCommand;
use stats::StatsCommand;
use sync::SyncCommand;
use tag::TagCommand;
use update::UpdateCommand;

#[derive(Parser)]
#[command(name = "flvt", version, about = "Personal note vault for source code")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    Add(AddCommand),
    Attach(AttachCommand),
    List(ListCommand),
    Update(UpdateCommand),
    Delete(DeleteCommand),
    Search(SearchCommand),
    Repair(RepairCommand),
    ResolveUri(ResolveUriCommand),
    Doctor(HealthCommand),
    Health(HealthCommand),
    Stats(StatsCommand),
    Index(IndexCommand),
    Explorer(ExplorerCommand),
    Sync(SyncCommand),
    Gitignore(GitignoreCommand),
    Tag(TagCommand),
}
