use clap::Args;

use super::format::FormatArg;

#[derive(Debug, Args)]
pub struct SearchCommand {
    pub keyword: Option<String>,

    #[arg(long)]
    pub file: Option<String>,

    /// Require every repeated tag (AND semantics).
    #[arg(long = "tag", conflicts_with = "tag_query")]
    pub tags: Vec<String>,

    /// Boolean tag expression using AND, OR, NOT, and parentheses.
    #[arg(long, conflicts_with = "tags")]
    pub tag_query: Option<String>,

    #[arg(long, value_enum)]
    pub format: Option<FormatArg>,
}
