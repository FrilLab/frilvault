use chrono::{DateTime, Utc};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultMode {
    #[default]
    Local,
    Shared,
}

impl VaultMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Shared => "shared",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceMetadata {
    pub version: u32,

    #[serde(default)]
    pub mode: VaultMode,

    pub workspace: WorkspaceInfo,

    pub settings: WorkspaceSettings,

    pub created_at: DateTime<Utc>,

    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSettings {
    pub search: SearchSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchSettings {
    pub case_sensitive: bool,
}

impl Default for WorkspaceMetadata {
    fn default() -> Self {
        let now = Utc::now();

        Self {
            version: 1,

            mode: VaultMode::Local,

            workspace: WorkspaceInfo {
                name: "frilvault".to_string(),
            },

            settings: WorkspaceSettings {
                search: SearchSettings {
                    case_sensitive: false,
                },
            },

            created_at: now,

            updated_at: now,
        }
    }
}
