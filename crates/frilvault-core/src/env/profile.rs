use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[cfg(test)]
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use age::{Decryptor, Encryptor, Identity, Recipient};
use serde::{Deserialize, Serialize};

use crate::{FrilVaultError, FrilVaultResult, constants::VAULT_DIR_NAME, workspace::VaultMode};

use super::{
    ENV_DIR_NAME, ENV_PROFILE_PAYLOAD_VERSION, PROFILE_FILE_EXTENSION, PROFILES_DIR_NAME,
    identity::EnvIdentity,
    recipient::EnvRecipientRegistry,
    storage::atomic_write_ciphertext,
    validation::{validate_profile_name, validate_values},
};

/// A validated, version-1 environment profile payload.
///
/// The values are intentionally not included in this type's `Debug` output.
/// Callers that have authorization to use the values can access them through
/// [`Self::values`].
#[derive(Clone, PartialEq, Eq)]
pub struct EnvProfilePayload {
    values: BTreeMap<String, String>,
}

impl std::fmt::Debug for EnvProfilePayload {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("EnvProfilePayload")
            .field("entry_count", &self.values.len())
            .finish()
    }
}

impl EnvProfilePayload {
    /// Creates a payload after validating keys and values for storage.
    pub fn new(values: BTreeMap<String, String>) -> FrilVaultResult<Self> {
        validate_values(&values)?;

        Ok(Self { values })
    }

    /// Returns the profile's key/value map.
    pub fn values(&self) -> &BTreeMap<String, String> {
        &self.values
    }

    /// Consumes the payload and returns its key/value map.
    pub fn into_values(self) -> BTreeMap<String, String> {
        self.values
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredEnvProfilePayload {
    version: u32,
    values: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct EnvProfilePayloadVersion {
    version: u32,
}

/// In-memory age encryption and decryption boundary for profile payloads.
pub struct EnvProfileCrypto;

impl EnvProfileCrypto {
    /// Validates the age envelope without attempting decryption.
    ///
    /// This is intentionally separate from [`Self::decrypt`] so workspace
    /// diagnostics can inspect every profile's ciphertext structure without
    /// needing to obtain or expose an identity.
    pub fn validate_ciphertext(ciphertext: &[u8]) -> FrilVaultResult<()> {
        Decryptor::new(ciphertext)
            .map(|_| ())
            .map_err(|_| FrilVaultError::EnvProfileDecryptionFailed)
    }

    /// Encrypts a profile payload for every supplied recipient.
    ///
    /// Each recipient can independently decrypt the resulting ciphertext. No
    /// recipient or identity is persisted by this type.
    pub fn encrypt(
        payload: &EnvProfilePayload,
        recipients: &[&dyn Recipient],
    ) -> FrilVaultResult<Vec<u8>> {
        let serialized = serialize_payload(payload)?;
        let encryptor = Encryptor::with_recipients(recipients.iter().copied())
            .map_err(|_| FrilVaultError::EnvProfileEncryptionFailed)?;

        let mut ciphertext = Vec::new();
        let mut writer = encryptor
            .wrap_output(&mut ciphertext)
            .map_err(|_| FrilVaultError::EnvProfileEncryptionFailed)?;

        writer
            .write_all(&serialized)
            .map_err(|_| FrilVaultError::EnvProfileEncryptionFailed)?;
        writer
            .finish()
            .map_err(|_| FrilVaultError::EnvProfileEncryptionFailed)?;

        Ok(ciphertext)
    }

    /// Encrypts a profile while enforcing Shared-mode recipient policy.
    pub fn encrypt_for_mode(
        payload: &EnvProfilePayload,
        mode: VaultMode,
        recipients: &[&dyn Recipient],
    ) -> FrilVaultResult<Vec<u8>> {
        validate_profile_recipients(mode, recipients)?;
        Self::encrypt(payload, recipients)
    }

    /// Decrypts and validates a profile ciphertext with any matching identity.
    ///
    /// Decrypted plaintext is returned in memory and is never written to disk.
    pub fn decrypt(
        ciphertext: &[u8],
        identities: &[&dyn Identity],
    ) -> FrilVaultResult<EnvProfilePayload> {
        let decryptor =
            Decryptor::new(ciphertext).map_err(|_| FrilVaultError::EnvProfileDecryptionFailed)?;
        let mut reader = decryptor
            .decrypt(identities.iter().copied())
            .map_err(|_| FrilVaultError::EnvProfileDecryptionFailed)?;
        let mut plaintext = Vec::new();

        reader
            .read_to_end(&mut plaintext)
            .map_err(|_| FrilVaultError::EnvProfileDecryptionFailed)?;

        let plaintext =
            String::from_utf8(plaintext).map_err(|_| FrilVaultError::InvalidEnvProfileUtf8)?;
        let version: EnvProfilePayloadVersion = serde_json::from_str(&plaintext)
            .map_err(|_| FrilVaultError::InvalidEnvProfilePayload)?;

        if version.version != ENV_PROFILE_PAYLOAD_VERSION {
            return Err(FrilVaultError::UnsupportedEnvProfilePayloadVersion(
                version.version,
            ));
        }

        let stored: StoredEnvProfilePayload = serde_json::from_str(&plaintext)
            .map_err(|_| FrilVaultError::InvalidEnvProfilePayload)?;

        EnvProfilePayload::new(stored.values)
    }
}

/// Persists encrypted environment profiles below a workspace's `.vault`.
///
/// The caller owns recipient and identity lifetimes. This store only reads
/// ciphertext and writes ciphertext; private identities never cross the file
/// system boundary.
#[derive(Clone, Debug)]
pub struct EnvProfileStore {
    env_root: PathBuf,
    #[cfg(test)]
    fail_replacement: Arc<AtomicBool>,
}

/// The profile names found in a vault, including invalid names that should be
/// reported without hiding otherwise valid profiles.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvProfileListing {
    valid_names: Vec<String>,
    invalid_names: Vec<String>,
}

impl EnvProfileListing {
    pub fn valid_names(&self) -> &[String] {
        &self.valid_names
    }

    pub fn invalid_names(&self) -> &[String] {
        &self.invalid_names
    }
}

impl EnvProfileStore {
    /// Creates a store for a workspace root.
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self::new_at_vault_root(workspace_root.into().join(VAULT_DIR_NAME))
    }

    /// Creates a store for an already-selected vault root.
    pub fn new_at_vault_root(vault_root: impl Into<PathBuf>) -> Self {
        Self {
            env_root: vault_root.into().join(ENV_DIR_NAME),
            #[cfg(test)]
            fail_replacement: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Returns the `.vault/env` root without creating it.
    pub fn env_root(&self) -> &Path {
        &self.env_root
    }

    /// Returns the profile directory without creating it.
    pub fn profiles_root(&self) -> PathBuf {
        self.env_root.join(PROFILES_DIR_NAME)
    }

    /// Lists valid profile names from the profiles directory in deterministic
    /// order. Invalid names preserve the original validation error; callers
    /// that need to inspect valid and invalid entries together should use
    /// [`Self::list_profile_listing`].
    pub fn list_profile_names(&self) -> FrilVaultResult<Vec<String>> {
        let listing = self.list_profile_listing()?;
        if let Some(name) = listing.invalid_names.first() {
            return Err(FrilVaultError::InvalidEnvProfileName(name.clone()));
        }
        Ok(listing.valid_names)
    }

    /// Lists profile names while retaining invalid names for diagnostics.
    ///
    /// Only regular files with the canonical `.age` extension are profiles.
    /// A malformed name does not prevent valid profiles from being inspected.
    pub fn list_profile_listing(&self) -> FrilVaultResult<EnvProfileListing> {
        let entries = match fs::read_dir(self.profiles_root()) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(EnvProfileListing::default());
            }
            Err(error) => return Err(error.into()),
        };

        let mut listing = EnvProfileListing::default();
        for entry in entries {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let path = entry.path();

            if !file_type.is_file()
                || path.extension().and_then(|extension| extension.to_str())
                    != Some(PROFILE_FILE_EXTENSION)
            {
                continue;
            }

            let name = path.file_stem().and_then(|stem| stem.to_str());
            let Some(name) = name else {
                listing.invalid_names.push("<non-utf8>".to_string());
                continue;
            };

            if validate_profile_name(name).is_ok() {
                listing.valid_names.push(name.to_string());
            } else {
                listing.invalid_names.push(name.to_string());
            }
        }

        listing.valid_names.sort();
        listing.invalid_names.sort();
        Ok(listing)
    }

    /// Reads and structurally validates a profile's age ciphertext.
    pub fn validate_profile_ciphertext(&self, profile_name: &str) -> FrilVaultResult<()> {
        let profile_path = self.profile_path(profile_name)?;
        let ciphertext = fs::read(profile_path)?;

        EnvProfileCrypto::validate_ciphertext(&ciphertext)
    }

    /// Resolves a validated logical profile name to its `.age` path.
    pub fn profile_path(&self, profile_name: &str) -> FrilVaultResult<PathBuf> {
        validate_profile_name(profile_name)?;

        Ok(self
            .profiles_root()
            .join(format!("{profile_name}.{PROFILE_FILE_EXTENSION}")))
    }

    /// Encrypts and atomically stores a key/value profile.
    pub fn save_profile(
        &self,
        profile_name: &str,
        values: &BTreeMap<String, String>,
        recipients: &[&dyn Recipient],
    ) -> FrilVaultResult<()> {
        let payload = EnvProfilePayload::new(values.clone())?;
        self.save_payload(profile_name, &payload, recipients)
    }

    /// Encrypts and atomically stores an already validated profile payload.
    pub fn save_payload(
        &self,
        profile_name: &str,
        payload: &EnvProfilePayload,
        recipients: &[&dyn Recipient],
    ) -> FrilVaultResult<()> {
        self.save_payload_for_mode(profile_name, payload, VaultMode::Local, recipients)
    }

    /// Encrypts and atomically stores a profile while enforcing Shared-mode
    /// recipient policy separately from the workspace Git-tracking mode.
    pub fn save_payload_for_mode(
        &self,
        profile_name: &str,
        payload: &EnvProfilePayload,
        mode: VaultMode,
        recipients: &[&dyn Recipient],
    ) -> FrilVaultResult<()> {
        let profile_path = self.profile_path(profile_name)?;
        let ciphertext = EnvProfileCrypto::encrypt_for_mode(payload, mode, recipients)?;

        atomic_write_ciphertext(
            &profile_path,
            &ciphertext,
            #[cfg(test)]
            &self.fail_replacement,
        )
    }

    /// Encrypts and atomically stores a profile with an explicit vault mode.
    pub fn save_profile_for_mode(
        &self,
        profile_name: &str,
        values: &BTreeMap<String, String>,
        mode: VaultMode,
        recipients: &[&dyn Recipient],
    ) -> FrilVaultResult<()> {
        let payload = EnvProfilePayload::new(values.clone())?;
        self.save_payload_for_mode(profile_name, &payload, mode, recipients)
    }

    /// Encrypts a profile for the selected vault policy using the caller's
    /// identity for Local vaults or the public recipient registry for Shared
    /// vaults.
    pub fn save_profile_for_environment(
        &self,
        profile_name: &str,
        values: &BTreeMap<String, String>,
        mode: VaultMode,
        identity: &EnvIdentity,
        registry: &EnvRecipientRegistry,
    ) -> FrilVaultResult<()> {
        let recipients = if mode == VaultMode::Local {
            vec![identity.public_recipient()]
        } else {
            registry.age_recipients()?
        };
        let recipient_refs: Vec<&dyn Recipient> = recipients
            .iter()
            .map(|recipient| recipient as &dyn Recipient)
            .collect();
        self.save_profile_for_mode(profile_name, values, mode, &recipient_refs)
    }

    /// Reads, decrypts, and validates a profile ciphertext.
    pub fn load_profile(
        &self,
        profile_name: &str,
        identities: &[&dyn Identity],
    ) -> FrilVaultResult<EnvProfilePayload> {
        let profile_path = self.profile_path(profile_name)?;
        let ciphertext = fs::read(profile_path)?;

        EnvProfileCrypto::decrypt(&ciphertext, identities)
    }

    /// Re-encrypts a profile for the current recipient registry.
    ///
    /// The existing ciphertext is read and decrypted before any replacement is
    /// attempted. Plaintext remains in memory only long enough to produce the
    /// new ciphertext, and the existing atomic ciphertext replacement path is
    /// used for the final write.
    pub fn rotate_profile(
        &self,
        profile_name: &str,
        identity: &EnvIdentity,
        registry: &EnvRecipientRegistry,
    ) -> FrilVaultResult<()> {
        if registry.is_empty() {
            return Err(FrilVaultError::EmptyEnvRecipients);
        }

        let profile_path = self.profile_path(profile_name)?;
        let ciphertext = fs::read(&profile_path)?;
        let payload = EnvProfileCrypto::decrypt(&ciphertext, &[identity.age_identity()])?;
        let recipients = registry.age_recipients()?;
        let recipient_refs: Vec<&dyn Recipient> = recipients
            .iter()
            .map(|recipient| recipient as &dyn Recipient)
            .collect();
        let rotated_ciphertext = EnvProfileCrypto::encrypt(&payload, &recipient_refs)?;

        atomic_write_ciphertext(
            &profile_path,
            &rotated_ciphertext,
            #[cfg(test)]
            &self.fail_replacement,
        )
    }

    #[cfg(test)]
    pub(crate) fn fail_next_replacement(&self) {
        self.fail_replacement.store(true, Ordering::SeqCst);
    }
}

fn serialize_payload(payload: &EnvProfilePayload) -> FrilVaultResult<Vec<u8>> {
    let stored = StoredEnvProfilePayload {
        version: ENV_PROFILE_PAYLOAD_VERSION,
        values: payload.values.clone(),
    };

    serde_json::to_vec(&stored).map_err(|_| FrilVaultError::InvalidEnvProfilePayload)
}

fn validate_profile_recipients(
    mode: VaultMode,
    recipients: &[&dyn Recipient],
) -> FrilVaultResult<()> {
    if mode == VaultMode::Shared && recipients.is_empty() {
        return Err(FrilVaultError::EmptySharedEnvRecipients);
    }
    Ok(())
}
