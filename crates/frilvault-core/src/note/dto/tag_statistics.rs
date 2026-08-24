use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Optional location grouping for tag statistics.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TagGroupBy {
    File,
    Directory,
}

/// Note count for one file or directory in a tag distribution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TagBreakdown {
    pub path: PathBuf,
    pub note_count: usize,
}

/// Workspace-wide usage and optional location distribution for one tag.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TagStatistic {
    pub tag: String,
    pub note_count: usize,
    pub breakdown: Vec<TagBreakdown>,
}
