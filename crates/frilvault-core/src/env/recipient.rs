use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
};

use age::x25519;
use serde::{Deserialize, Serialize};

use crate::{FrilVaultError, FrilVaultResult};

use super::{
    ENV_DIR_NAME, ENV_RECIPIENT_REGISTRY_VERSION, RECIPIENTS_FILE_NAME,
    storage::atomic_write_public_text,
};

/// A public age recipient registered under a stable collaborator id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvRecipient {
    pub id: String,
    pub recipient: String,
}

impl EnvRecipient {
    pub fn new(id: &str, recipient: &str) -> FrilVaultResult<Self> {
        validate_recipient_id(id)?;
        let parsed = x25519::Recipient::from_str(recipient.trim())
            .map_err(|_| FrilVaultError::InvalidEnvRecipient)?;

        Ok(Self {
            id: id.to_string(),
            recipient: parsed.to_string(),
        })
    }

    pub fn age_recipient(&self) -> FrilVaultResult<x25519::Recipient> {
        x25519::Recipient::from_str(&self.recipient)
            .map_err(|_| FrilVaultError::InvalidEnvRecipient)
    }
}

/// Deterministic public recipient registry stored below the selected vault.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvRecipientRegistry {
    entries: BTreeMap<String, EnvRecipient>,
}

impl EnvRecipientRegistry {
    pub fn entries(&self) -> impl Iterator<Item = &EnvRecipient> {
        self.entries.values()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn add(&mut self, id: &str, recipient: &str) -> FrilVaultResult<()> {
        let entry = EnvRecipient::new(id, recipient)?;
        if self.entries.contains_key(&entry.id) {
            return Err(FrilVaultError::DuplicateEnvRecipientId(entry.id));
        }
        if self
            .entries
            .values()
            .any(|existing| existing.recipient == entry.recipient)
        {
            return Err(FrilVaultError::DuplicateEnvRecipient);
        }

        self.entries.insert(entry.id.clone(), entry);
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> FrilVaultResult<EnvRecipient> {
        self.entries
            .remove(id)
            .ok_or_else(|| FrilVaultError::EnvRecipientNotFound(id.to_string()))
    }

    pub fn get(&self, id: &str) -> Option<&EnvRecipient> {
        self.entries.get(id)
    }

    pub fn age_recipients(&self) -> FrilVaultResult<Vec<x25519::Recipient>> {
        self.entries
            .values()
            .map(EnvRecipient::age_recipient)
            .collect()
    }

    fn from_entries(entries: Vec<EnvRecipient>) -> FrilVaultResult<Self> {
        let mut registry = Self::default();
        for entry in entries {
            registry.add(&entry.id, &entry.recipient)?;
        }
        Ok(registry)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredEnvRecipientRegistry {
    version: u32,
    #[serde(default)]
    recipients: Vec<EnvRecipient>,
}

#[derive(Clone, Debug)]
pub struct EnvRecipientStore {
    path: PathBuf,
}

impl EnvRecipientStore {
    pub fn new(vault_root: impl Into<PathBuf>) -> Self {
        Self {
            path: vault_root
                .into()
                .join(ENV_DIR_NAME)
                .join(RECIPIENTS_FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> FrilVaultResult<EnvRecipientRegistry> {
        let contents = match fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(EnvRecipientRegistry::default());
            }
            Err(error) => return Err(error.into()),
        };
        let stored: StoredEnvRecipientRegistry =
            toml::from_str(&contents).map_err(|_| FrilVaultError::InvalidEnvRecipientRegistry)?;
        if stored.version != ENV_RECIPIENT_REGISTRY_VERSION {
            return Err(FrilVaultError::UnsupportedEnvRecipientRegistryVersion(
                stored.version,
            ));
        }

        EnvRecipientRegistry::from_entries(stored.recipients)
    }

    pub fn save(&self, registry: &EnvRecipientRegistry) -> FrilVaultResult<()> {
        let stored = StoredEnvRecipientRegistry {
            version: ENV_RECIPIENT_REGISTRY_VERSION,
            recipients: registry.entries().cloned().collect(),
        };
        let contents = toml::to_string_pretty(&stored)
            .map_err(|_| FrilVaultError::InvalidEnvRecipientRegistry)?;
        atomic_write_public_text(&self.path, contents.as_bytes())
    }

    pub fn add(&self, id: &str, recipient: &str) -> FrilVaultResult<EnvRecipient> {
        let mut registry = self.load()?;
        registry.add(id, recipient)?;
        let entry = registry
            .get(id)
            .cloned()
            .ok_or_else(|| FrilVaultError::EnvRecipientNotFound(id.to_string()))?;
        self.save(&registry)?;
        Ok(entry)
    }

    pub fn remove(&self, id: &str) -> FrilVaultResult<EnvRecipient> {
        let mut registry = self.load()?;
        let removed = registry.remove(id)?;
        self.save(&registry)?;
        Ok(removed)
    }
}

fn validate_recipient_id(id: &str) -> FrilVaultResult<()> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if !valid {
        return Err(FrilVaultError::InvalidEnvRecipientId(id.to_string()));
    }
    Ok(())
}
