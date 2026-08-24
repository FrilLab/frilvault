use std::collections::BTreeMap;

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

    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tags: BTreeMap<String, TagSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchSettings {
    pub case_sensitive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TagColor {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
}

impl TagColor {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Red => "red",
            Self::Orange => "orange",
            Self::Yellow => "yellow",
            Self::Green => "green",
            Self::Blue => "blue",
            Self::Purple => "purple",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagSettings {
    pub color: TagColor,
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
                tags: BTreeMap::new(),
            },

            created_at: now,

            updated_at: now,
        }
    }
}
