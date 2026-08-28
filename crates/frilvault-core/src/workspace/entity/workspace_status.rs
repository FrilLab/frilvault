use std::path::PathBuf;

use serde::Serialize;

use super::VaultMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitTrackingStatus {
    Excluded,
    Trackable,
    Tracked,
    NotGitRepository,
}

impl GitTrackingStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Excluded => "excluded",
            Self::Trackable => "trackable",
            Self::Tracked => "tracked",
            Self::NotGitRepository => "not a Git repository",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorkspaceStatus {
    pub vault_path: PathBuf,
    pub mode: VaultMode,
    pub git_tracking: GitTrackingStatus,
    pub note_count: usize,
}
