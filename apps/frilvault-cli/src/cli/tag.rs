use clap::{Args, Subcommand, ValueEnum};

use super::format::FormatArg;

#[derive(Debug, Args)]
pub struct TagCommand {
    #[command(subcommand)]
    pub action: TagAction,
}

#[derive(Debug, Subcommand)]
pub enum TagAction {
    Rename(TagRenameCommand),
    Merge(TagMergeCommand),
    Remove(TagRemoveCommand),
    List(TagListCommand),
    Stats(TagStatsCommand),
}

#[derive(Debug, Args)]
pub struct TagRenameCommand {
    /// Source tag to rename
    pub old_tag: String,

    /// New tag name
    pub new_tag: String,

    /// Preview changes without modifying notes
    #[arg(long, short = 'n', alias = "preview")]
    pub dry_run: bool,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Args)]
pub struct TagMergeCommand {
    /// Source tags to merge
    #[arg(required = true, num_args = 1..)]
    pub sources: Vec<String>,

    /// Target tag to merge into
    #[arg(long = "into", required = true)]
    pub into: String,

    /// Preview changes without modifying notes
    #[arg(long, short = 'n', alias = "preview")]
    pub dry_run: bool,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Args)]
pub struct TagRemoveCommand {
    /// Tag to remove across all notes
    pub tag: String,

    /// Skip confirmation prompt and execute removal
    #[arg(long, short = 'y', alias = "force")]
    pub yes: bool,

    /// Preview changes without modifying notes
    #[arg(long, short = 'n', alias = "preview")]
    pub dry_run: bool,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Args)]
pub struct TagListCommand {
    /// Show only unused tags (tags not attached to any note)
    #[arg(long)]
    pub unused: bool,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Args)]
pub struct TagStatsCommand {
    /// Show statistics for one tag only
    #[arg(long)]
    pub tag: Option<String>,

    /// Break down note counts by source file or immediate parent directory
    #[arg(long, value_enum)]
    pub group_by: Option<TagGroupByArg>,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum TagGroupByArg {
    File,
    Directory,
}
