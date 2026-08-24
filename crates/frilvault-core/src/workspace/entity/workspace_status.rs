use std::path::PathBuf;

use super::VaultMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceStatus {
    pub vault_path: PathBuf,
    pub mode: VaultMode,
    pub git_tracking: GitTrackingStatus,
    pub note_count: usize,
}
