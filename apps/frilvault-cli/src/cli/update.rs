use clap::Args;

use super::format::FormatArg;

#[derive(Debug, Args)]
pub struct UpdateCommand {
    #[arg(long)]
    pub file: String,

    #[arg(long)]
    pub id: String,

    #[arg(long)]
    pub content: String,

    #[arg(long = "tag", conflicts_with = "clear_tags")]
    pub tags: Vec<String>,

    /// Remove every existing tag. Without this flag, omitted tags are preserved.
    #[arg(long, conflicts_with = "tags")]
    pub clear_tags: bool,

    #[arg(long)]
    pub expected_updated_at: Option<String>,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}
