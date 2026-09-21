//! Encrypted environment profile storage.
//!
//! Environment profiles are persisted as age ciphertext under:
//!
//! ```text
//! .vault/env/
//! ├── manifest.toml
//! ├── recipients.toml
//! └── profiles/
//!     └── <profile>.age
//! ```
//!
//! This module owns the manifest/profile validation and ciphertext boundaries.
//! `recipients.toml` and private identity storage remain separate concerns.
//! Callers provide public recipients for encryption and identities for
//! decryption.
//!
//! The decrypted payload is UTF-8 JSON with this versioned shape:
//!
//! ```json
//! {"version":1,"values":{"EXAMPLE":"value"}}
//! ```
//!
//! Version `1` is the only accepted version. Unknown versions are rejected so a
//! future migration can be explicit. Plaintext is kept in memory only; writes
//! encrypt before creating a temporary file, then atomically rename the
//! ciphertext into place.

use std::{
    collections::BTreeMap,
    fmt,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    str::FromStr,
};

#[cfg(test)]
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use age::{Decryptor, Encryptor, Identity, Recipient, secrecy::ExposeSecret, x25519};
use serde::{Deserialize, Serialize};

use crate::{FrilVaultError, FrilVaultResult, constants::VAULT_DIR_NAME, workspace::VaultMode};

/// Current version of the JSON payload encrypted into a profile file.
pub const ENV_PROFILE_PAYLOAD_VERSION: u32 = 1;
pub const ENV_RECIPIENT_REGISTRY_VERSION: u32 = 1;
pub const ENV_MANIFEST_VERSION: u32 = 1;

const ENV_DIR_NAME: &str = "env";
const PROFILES_DIR_NAME: &str = "profiles";
const PROFILE_FILE_EXTENSION: &str = "age";
const MANIFEST_FILE_NAME: &str = "manifest.toml";
const RECIPIENTS_FILE_NAME: &str = "recipients.toml";
const WINDOWS_INVALID_NAME_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

/// Value-free status used by environment readiness diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvReadinessStatus {
    Ready,
    Configured,
    Missing,
    Invalid,
    Unavailable,
    NotReady,
}

impl EnvReadinessStatus {
    pub fn satisfies_readiness(self) -> bool {
        matches!(self, Self::Ready | Self::Configured)
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Configured => "configured",
            Self::Missing => "missing",
            Self::Invalid => "invalid",
            Self::Unavailable => "unavailable",
            Self::NotReady => "not ready",
        }
    }
}

/// A value-free environment readiness check.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EnvReadinessCheck {
    pub status: EnvReadinessStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<&'static str>,
}

/// A value-free summary of one environment profile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EnvProfileReadiness {
    pub profile: String,
    pub status: EnvReadinessStatus,
    pub path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<&'static str>,
}

/// The complete environment readiness result shared by CLI and integrations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EnvReadinessReport {
    pub status: EnvReadinessStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    pub checks: BTreeMap<String, EnvReadinessCheck>,
    pub profiles: Vec<EnvProfileReadiness>,
    pub usable_profiles: Vec<String>,
}

/// A manifest declaration for one child-process environment variable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvVariableSpec {
    pub required: bool,
    pub secret: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub default: Option<String>,
}

/// The validated environment manifest stored in `env/manifest.toml`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EnvManifest {
    variables: BTreeMap<String, EnvVariableSpec>,
}

impl EnvManifest {
    /// Creates a manifest after validating variable names and default policy.
    pub fn new(variables: BTreeMap<String, EnvVariableSpec>) -> FrilVaultResult<Self> {
        for (name, spec) in &variables {
            validate_env_variable_name(name)?;

            if spec.required && spec.default.is_some()
                || spec.secret && spec.default.is_some()
                || spec
                    .description
                    .as_deref()
                    .is_some_and(|description| description.contains('\0'))
                || spec
                    .default
                    .as_deref()
                    .is_some_and(|value| value.contains('\0'))
            {
                return Err(FrilVaultError::InvalidEnvManifestDefinition);
            }
        }

        Ok(Self { variables })
    }

    /// Returns manifest variables in deterministic name order.
    pub fn variables(&self) -> &BTreeMap<String, EnvVariableSpec> {
        &self.variables
    }

    /// Validates a decrypted profile and resolves non-secret manifest defaults.
    ///
    /// Required values must be present in the selected profile itself. The
    /// caller may then overlay the returned values on the inherited process
    /// environment before adding the child process profile values. Consuming
    /// the payload avoids retaining a second copy of its secret values.
    pub fn resolve_profile(
        &self,
        profile: EnvProfilePayload,
    ) -> FrilVaultResult<BTreeMap<String, String>> {
        let profile_values = profile.into_values();

        for name in profile_values.keys() {
            if !self.variables.contains_key(name) {
                return Err(FrilVaultError::UnknownEnvProfileVariable(name.clone()));
            }
        }

        for (name, spec) in &self.variables {
            if spec.required && !profile_values.contains_key(name) {
                return Err(FrilVaultError::MissingRequiredEnvVariable(name.clone()));
            }
        }

        let mut values = self
            .variables
            .iter()
            .filter_map(|(name, spec)| spec.default.clone().map(|value| (name.clone(), value)))
            .collect::<BTreeMap<_, _>>();
        values.extend(profile_values);
        Ok(values)
    }
}

/// Reads and validates the selected vault's environment manifest.
#[derive(Clone, Debug)]
pub struct EnvManifestStore {
    path: PathBuf,
}

impl EnvManifestStore {
    pub fn new(vault_root: impl Into<PathBuf>) -> Self {
        Self {
            path: vault_root
                .into()
                .join(ENV_DIR_NAME)
                .join(MANIFEST_FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> FrilVaultResult<EnvManifest> {
        let contents = fs::read_to_string(&self.path)?;
        let stored: StoredEnvManifest = toml::from_str(&contents)
            .map_err(|_| FrilVaultError::InvalidEnvManifest(self.path.clone()))?;

        if stored.version != ENV_MANIFEST_VERSION {
            return Err(FrilVaultError::UnsupportedEnvManifestVersion(
                stored.version,
            ));
        }

        EnvManifest::new(stored.variables)
            .map_err(|_| FrilVaultError::InvalidEnvManifest(self.path.clone()))
    }

    /// Creates the environment directory, profiles directory, and an empty
    /// versioned manifest without replacing existing metadata.
    pub fn initialize(&self) -> FrilVaultResult<bool> {
        let Some(env_root) = self.path.parent() else {
            return Err(FrilVaultError::InvalidEnvManifest(self.path.clone()));
        };
        fs::create_dir_all(env_root.join(PROFILES_DIR_NAME))?;

        let stored = StoredEnvManifest {
            version: ENV_MANIFEST_VERSION,
            variables: BTreeMap::new(),
        };
        let contents = toml::to_string_pretty(&stored)
            .map_err(|_| FrilVaultError::InvalidEnvManifest(self.path.clone()))?;

        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        match options.open(&self.path) {
            Ok(mut file) => {
                file.write_all(contents.as_bytes())?;
                file.sync_all()?;
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredEnvManifest {
    version: u32,
    variables: BTreeMap<String, EnvVariableSpec>,
}

/// A generated or loaded age identity.
///
/// The private identity is intentionally not included in `Debug` output. It can
/// be passed to an injectable [`EnvIdentityStore`] without exposing its encoded
/// form to callers that only need the public recipient.
#[derive(Clone)]
pub struct EnvIdentity {
    inner: x25519::Identity,
}

impl fmt::Debug for EnvIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EnvIdentity")
            .field("private_material", &"<redacted>")
            .field("recipient", &self.public_recipient())
            .finish()
    }
}

impl EnvIdentity {
    /// Generates a new age X25519 identity using the age implementation.
    pub fn generate() -> Self {
        Self {
            inner: x25519::Identity::generate(),
        }
    }

    /// Loads an identity from its canonical age encoding.
    pub fn from_encoded(encoded: &str) -> FrilVaultResult<Self> {
        let encoded = encoded.trim();
        if encoded.is_empty() {
            return Err(FrilVaultError::InvalidEnvIdentity);
        }

        let inner =
            x25519::Identity::from_str(encoded).map_err(|_| FrilVaultError::InvalidEnvIdentity)?;

        Ok(Self { inner })
    }

    /// Runs a callback with the private identity encoding.
    ///
    /// The encoding is only materialized for the duration of the callback so
    /// storage adapters can persist it without making it part of a public data
    /// structure or a debug representation.
    pub fn with_encoded<R>(&self, callback: impl FnOnce(&str) -> R) -> R {
        let encoded = self.inner.to_string();
        callback(encoded.expose_secret())
    }

    /// Returns the public age recipient corresponding to this identity.
    pub fn public_recipient(&self) -> x25519::Recipient {
        self.inner.to_public()
    }

    /// Returns the identity for the age decryption boundary.
    pub fn age_identity(&self) -> &x25519::Identity {
        &self.inner
    }
}

/// Injectable private identity storage boundary.
pub trait EnvIdentityStore {
    fn load_identity(&self) -> FrilVaultResult<Option<EnvIdentity>>;
    fn save_identity(&self, identity: &EnvIdentity) -> FrilVaultResult<()>;
}

/// Creates or loads one identity through an injected storage adapter.
pub struct EnvIdentityManager<S> {
    store: S,
}

impl<S> EnvIdentityManager<S>
where
    S: EnvIdentityStore,
{
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn load(&self) -> FrilVaultResult<Option<EnvIdentity>> {
        self.store.load_identity()
    }

    pub fn create_or_reuse(&self) -> FrilVaultResult<(EnvIdentity, bool)> {
        if let Some(identity) = self.store.load_identity()? {
            return Ok((identity, false));
        }

        let identity = EnvIdentity::generate();
        self.store.save_identity(&identity)?;
        Ok((identity, true))
    }

    /// Imports an identity without replacing an existing decryption key.
    ///
    /// An identical public recipient is treated as a no-op and returns the
    /// stored identity. A different identity is rejected so an import cannot
    /// make already-encrypted profiles undecryptable.
    pub fn import_or_reuse(&self, candidate: EnvIdentity) -> FrilVaultResult<(EnvIdentity, bool)> {
        if let Some(existing) = self.store.load_identity()? {
            if existing.public_recipient() == candidate.public_recipient() {
                return Ok((existing, false));
            }
            return Err(FrilVaultError::EnvIdentityAlreadyConfigured);
        }

        self.store.save_identity(&candidate)?;
        Ok((candidate, true))
    }
}

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

/// Validates a logical profile name before it is used as a file name.
///
/// Names are a single path component. Both slash styles are rejected so a
/// vault created on one platform cannot become unsafe when checked out on
/// another. Dots are allowed inside a name, while `.` and `..` are rejected as
/// ambiguous path components. Names are also restricted to the intersection of
/// Unix and Windows file names, including Windows device-name rules.
pub fn validate_profile_name(profile_name: &str) -> FrilVaultResult<()> {
    if profile_name.is_empty()
        || profile_name == "."
        || profile_name == ".."
        || profile_name.contains('/')
        || profile_name.contains('\\')
        || profile_name.contains('\0')
        || profile_name.chars().any(char::is_control)
        || profile_name
            .chars()
            .any(|character| WINDOWS_INVALID_NAME_CHARS.contains(&character))
        || profile_name.ends_with(['.', ' '])
        || is_windows_reserved_device_name(profile_name)
    {
        return Err(FrilVaultError::InvalidEnvProfileName(
            profile_name.to_string(),
        ));
    }

    Ok(())
}

fn is_windows_reserved_device_name(profile_name: &str) -> bool {
    let device_name = profile_name
        .split('.')
        .next()
        .unwrap_or(profile_name)
        .to_ascii_uppercase();

    matches!(device_name.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((device_name.starts_with("COM") || device_name.starts_with("LPT"))
            && device_name.len() == 4
            && matches!(device_name.as_bytes()[3], b'1'..=b'9'))
}

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
    fn fail_next_replacement(&self) {
        self.fail_replacement.store(true, Ordering::SeqCst);
    }
}

/// Evaluates environment readiness without exposing profile values or
/// ciphertext. Identity loading remains an integration concern; callers pass
/// the available identity and its value-free status into this evaluator.
pub struct EnvReadiness;

impl EnvReadiness {
    pub fn inspect(
        vault_root: impl AsRef<Path>,
        selected_profile: Option<&str>,
        identity: Option<&EnvIdentity>,
        identity_status: EnvReadinessStatus,
    ) -> EnvReadinessReport {
        let vault_root = vault_root.as_ref();
        let profile_store = EnvProfileStore::new_at_vault_root(vault_root);
        let manifest_store = EnvManifestStore::new(vault_root);
        let recipient_store = EnvRecipientStore::new(vault_root);

        let (manifest, manifest_check) = load_manifest_check(&manifest_store);
        let recipients_check = load_recipients_check(&recipient_store);
        let plaintext_check = check_plaintext_export_path(profile_store.env_root());
        let (profile_names, invalid_profile_names, mut profiles_check) =
            list_profiles_check(&profile_store);

        let selected_name_check = selected_profile.map(|profile| {
            if validate_profile_name(profile).is_ok() {
                env_check(EnvReadinessStatus::Ready, None, None)
            } else {
                env_check(
                    EnvReadinessStatus::Invalid,
                    None,
                    Some(
                        "Use a portable profile name without path separators or reserved device names.",
                    ),
                )
            }
        });

        let selected_path = selected_profile
            .filter(|profile| validate_profile_name(profile).is_ok())
            .and_then(|profile| profile_store.profile_path(profile).ok());
        let selected_profile_check = selected_profile.map(|profile| {
            if validate_profile_name(profile).is_err() {
                env_check(
                    EnvReadinessStatus::Invalid,
                    None,
                    Some("Use a portable profile name without path separators or reserved device names."),
                )
            } else {
                selected_path
                    .as_deref()
                    .map(check_file_exists)
                    .unwrap_or_else(|| {
                        env_check(
                            EnvReadinessStatus::Missing,
                            None,
                            Some("Create or import the encrypted profile before running the doctor."),
                        )
                    })
            }
        });

        let mut profiles = Vec::new();
        let mut usable_profiles = Vec::new();
        let mut all_decryption_ready = true;
        let mut decryption_attempted = false;
        let mut decryption_failed = false;
        let mut all_required_ready = true;
        let mut required_missing = false;
        let mut required_invalid = false;
        let mut required_attempted = false;
        let mut selected_decryption = None;
        let mut selected_required = None;

        for profile_name in &profile_names {
            let path = match profile_store.profile_path(profile_name) {
                Ok(path) => path,
                Err(_) => continue,
            };
            let structural = match profile_store.validate_profile_ciphertext(profile_name) {
                Ok(()) => EnvReadinessStatus::Ready,
                Err(error) => profile_ciphertext_status(&error),
            };

            let mut runtime_status = structural;
            let mut decryption_status = None;
            let mut required_status = None;

            if structural == EnvReadinessStatus::Ready {
                if let Some(identity) = identity {
                    decryption_attempted = true;
                    match profile_store.load_profile(profile_name, &[identity.age_identity()]) {
                        Ok(payload) => {
                            decryption_status = Some(EnvReadinessStatus::Ready);
                            if let Some(manifest) = &manifest {
                                required_attempted = true;
                                match manifest.resolve_profile(payload) {
                                    Ok(_) => {
                                        required_status = Some(EnvReadinessStatus::Ready);
                                        usable_profiles.push(profile_name.clone());
                                        runtime_status = EnvReadinessStatus::Ready;
                                    }
                                    Err(error) => {
                                        let status = required_variables_status(&error);
                                        required_status = Some(status);
                                        all_required_ready = false;
                                        required_missing |= status == EnvReadinessStatus::Missing;
                                        required_invalid |= status == EnvReadinessStatus::Invalid;
                                        runtime_status = status;
                                    }
                                }
                            } else {
                                all_required_ready = false;
                                runtime_status = EnvReadinessStatus::Configured;
                            }
                        }
                        Err(error) => {
                            let status = profile_ciphertext_status(&error);
                            decryption_status = Some(status);
                            decryption_failed = true;
                            all_decryption_ready = false;
                            runtime_status = status;
                        }
                    }
                } else {
                    all_decryption_ready = false;
                    runtime_status = EnvReadinessStatus::Configured;
                }
            } else {
                all_decryption_ready = false;
                decryption_failed = true;
            }

            if selected_profile.is_some_and(|selected| selected == profile_name) {
                selected_decryption = decryption_status;
                selected_required = required_status;
            }

            profiles.push(EnvProfileReadiness {
                profile: profile_name.clone(),
                status: runtime_status,
                path,
                remediation: profile_status_remediation(runtime_status),
            });
        }

        for invalid_name in &invalid_profile_names {
            profiles.push(EnvProfileReadiness {
                profile: invalid_name.clone(),
                status: EnvReadinessStatus::Invalid,
                path: profile_store
                    .profiles_root()
                    .join(format!("{invalid_name}.age")),
                remediation: profile_status_remediation(EnvReadinessStatus::Invalid),
            });
        }

        if profile_names.is_empty() {
            all_decryption_ready = false;
            all_required_ready = false;
        }

        if let Some(selected_profile) = selected_profile {
            let selected_status = profiles
                .iter()
                .find(|profile| profile.profile == selected_profile)
                .map(|profile| profile.status)
                .or_else(|| selected_profile_check.as_ref().map(|check| check.status))
                .unwrap_or(EnvReadinessStatus::Missing);
            profiles_check = env_check(
                selected_status,
                Some(profile_store.profiles_root()),
                profile_status_remediation(selected_status),
            );
        } else if !invalid_profile_names.is_empty()
            || profiles
                .iter()
                .any(|profile| profile.status == EnvReadinessStatus::Invalid)
        {
            profiles_check = env_check(
                EnvReadinessStatus::Invalid,
                Some(profile_store.profiles_root()),
                Some("Repair invalid profile ciphertext or profile metadata."),
            );
        } else if profiles
            .iter()
            .any(|profile| profile.status == EnvReadinessStatus::Unavailable)
        {
            profiles_check = env_check(
                EnvReadinessStatus::Unavailable,
                Some(profile_store.profiles_root()),
                Some("Check permissions and access to the profiles directory."),
            );
        } else if profiles
            .iter()
            .any(|profile| profile.status == EnvReadinessStatus::Missing)
        {
            profiles_check = env_check(
                EnvReadinessStatus::Missing,
                Some(profile_store.profiles_root()),
                Some("Restore the missing profile ciphertext file."),
            );
        }

        let decryption_check = if selected_profile.is_some() {
            selected_decryption
                .map(|status| runtime_check(status, selected_path.clone()))
                .unwrap_or_else(|| {
                    let status = if identity_status != EnvReadinessStatus::Ready {
                        identity_status
                    } else if selected_profile_check
                        .as_ref()
                        .is_some_and(|check| check.status != EnvReadinessStatus::Ready)
                    {
                        EnvReadinessStatus::Unavailable
                    } else {
                        EnvReadinessStatus::Invalid
                    };
                    runtime_check(status, selected_path.clone())
                })
        } else if profile_names.is_empty() {
            env_check(
                if invalid_profile_names.is_empty() {
                    EnvReadinessStatus::Missing
                } else {
                    EnvReadinessStatus::Invalid
                },
                None,
                Some("Create or import an encrypted environment profile."),
            )
        } else if identity_status != EnvReadinessStatus::Ready {
            env_check(
                identity_status,
                None,
                Some("Run `flvt env identity create` or provide --identity-file."),
            )
        } else if decryption_failed || !all_decryption_ready || !decryption_attempted {
            env_check(
                EnvReadinessStatus::Invalid,
                None,
                Some(
                    "Verify the identity and profile ciphertext, then re-encrypt the profile if needed.",
                ),
            )
        } else {
            env_check(EnvReadinessStatus::Ready, None, None)
        };

        let required_check = if selected_profile.is_some() {
            selected_required
                .map(|status| runtime_check(status, selected_path.clone()))
                .unwrap_or_else(|| {
                    let status = if manifest.is_none()
                        || identity_status != EnvReadinessStatus::Ready
                        || selected_profile_check
                            .as_ref()
                            .is_some_and(|check| check.status != EnvReadinessStatus::Ready)
                    {
                        EnvReadinessStatus::Unavailable
                    } else {
                        EnvReadinessStatus::Invalid
                    };
                    runtime_check(
                        status,
                        manifest_check
                            .path
                            .clone()
                            .or_else(|| selected_path.clone()),
                    )
                })
        } else if profile_names.is_empty() {
            env_check(
                if invalid_profile_names.is_empty() {
                    EnvReadinessStatus::Missing
                } else {
                    EnvReadinessStatus::Invalid
                },
                None,
                Some("Create or import an encrypted environment profile."),
            )
        } else if manifest.is_none() || identity_status != EnvReadinessStatus::Ready {
            env_check(
                EnvReadinessStatus::Unavailable,
                manifest_check.path.clone(),
                Some(
                    "Resolve the manifest and identity checks before validating profile variables.",
                ),
            )
        } else if required_invalid {
            env_check(
                EnvReadinessStatus::Invalid,
                manifest_check.path.clone(),
                Some("Remove undeclared variables and keep profile values valid for the manifest."),
            )
        } else if required_missing || !all_required_ready || !required_attempted {
            env_check(
                EnvReadinessStatus::Missing,
                manifest_check.path.clone(),
                Some("Add the required variables to the encrypted profile."),
            )
        } else {
            env_check(EnvReadinessStatus::Ready, None, None)
        };

        let mut checks = BTreeMap::new();
        checks.insert("manifest".to_string(), manifest_check);
        checks.insert(
            "profile_name".to_string(),
            selected_name_check
                .unwrap_or_else(|| env_check(EnvReadinessStatus::Configured, None, None)),
        );
        checks.insert(
            "profile".to_string(),
            selected_profile_check
                .unwrap_or_else(|| env_check(EnvReadinessStatus::Configured, None, None)),
        );
        checks.insert("recipients".to_string(), recipients_check);
        checks.insert(
            "identity".to_string(),
            env_check(
                identity_status,
                None,
                (identity_status != EnvReadinessStatus::Ready)
                    .then_some("Run `flvt env identity create` or provide --identity-file."),
            ),
        );
        checks.insert("decryption".to_string(), decryption_check);
        checks.insert("required_variables".to_string(), required_check);
        checks.insert("profiles".to_string(), profiles_check);
        checks.insert("plaintext_export".to_string(), plaintext_check);

        let status = if checks
            .values()
            .all(|check| check.status.satisfies_readiness())
        {
            EnvReadinessStatus::Ready
        } else {
            EnvReadinessStatus::NotReady
        };

        EnvReadinessReport {
            status,
            profile: selected_profile.map(str::to_string),
            checks,
            profiles,
            usable_profiles,
        }
    }
}

fn load_manifest_check(store: &EnvManifestStore) -> (Option<EnvManifest>, EnvReadinessCheck) {
    let path = store.path().to_path_buf();
    match store.load() {
        Ok(manifest) => (
            Some(manifest),
            env_check(EnvReadinessStatus::Ready, Some(path), None),
        ),
        Err(FrilVaultError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => (
            None,
            env_check(
                EnvReadinessStatus::Missing,
                Some(path),
                Some("Create .vault/env/manifest.toml using the versioned manifest schema."),
            ),
        ),
        Err(
            FrilVaultError::InvalidEnvManifest(_)
            | FrilVaultError::UnsupportedEnvManifestVersion(_),
        ) => (
            None,
            env_check(
                EnvReadinessStatus::Invalid,
                Some(path),
                Some("Repair the manifest TOML and use a supported manifest version."),
            ),
        ),
        Err(_) => (
            None,
            env_check(
                EnvReadinessStatus::Unavailable,
                Some(path),
                Some("Check permissions and access to the manifest file."),
            ),
        ),
    }
}

fn load_recipients_check(store: &EnvRecipientStore) -> EnvReadinessCheck {
    let path = store.path().to_path_buf();
    match store.load() {
        Ok(_) if !path.exists() => env_check(EnvReadinessStatus::Configured, Some(path), None),
        Ok(_) => env_check(EnvReadinessStatus::Ready, Some(path), None),
        Err(
            FrilVaultError::InvalidEnvRecipientRegistry
            | FrilVaultError::InvalidEnvRecipientId(_)
            | FrilVaultError::InvalidEnvRecipient
            | FrilVaultError::DuplicateEnvRecipientId(_)
            | FrilVaultError::DuplicateEnvRecipient
            | FrilVaultError::UnsupportedEnvRecipientRegistryVersion(_),
        ) => env_check(
            EnvReadinessStatus::Invalid,
            Some(path),
            Some("Repair recipients.toml with valid IDs and public age recipients."),
        ),
        Err(FrilVaultError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            env_check(EnvReadinessStatus::Configured, Some(path), None)
        }
        Err(_) => env_check(
            EnvReadinessStatus::Unavailable,
            Some(path),
            Some("Check permissions and access to recipients.toml."),
        ),
    }
}

fn list_profiles_check(store: &EnvProfileStore) -> (Vec<String>, Vec<String>, EnvReadinessCheck) {
    let path = store.profiles_root();
    match store.list_profile_listing() {
        Ok(listing) if !listing.invalid_names().is_empty() => (
            listing.valid_names().to_vec(),
            listing.invalid_names().to_vec(),
            env_check(
                EnvReadinessStatus::Invalid,
                Some(path),
                Some("Rename profiles to portable names before running the doctor."),
            ),
        ),
        Ok(listing) if listing.valid_names().is_empty() => (
            Vec::new(),
            Vec::new(),
            env_check(
                EnvReadinessStatus::Missing,
                Some(path),
                Some("Create or import an encrypted environment profile."),
            ),
        ),
        Ok(listing) => (
            listing.valid_names().to_vec(),
            Vec::new(),
            env_check(EnvReadinessStatus::Ready, Some(path), None),
        ),
        Err(_) => (
            Vec::new(),
            Vec::new(),
            env_check(
                EnvReadinessStatus::Unavailable,
                Some(path),
                Some("Check permissions and access to the profiles directory."),
            ),
        ),
    }
}

fn check_plaintext_export_path(env_root: &Path) -> EnvReadinessCheck {
    let path = env_root.join(".env");
    match fs::metadata(&path) {
        Ok(_) => env_check(
            EnvReadinessStatus::Invalid,
            Some(path),
            Some("Remove the plaintext export and use `flvt env run --profile NAME -- COMMAND`."),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => env_check(
            EnvReadinessStatus::Ready,
            None,
            Some("Plaintext export is unsupported; profiles stay encrypted on disk."),
        ),
        Err(_) => env_check(
            EnvReadinessStatus::Unavailable,
            Some(path),
            Some("Check access to the environment directory."),
        ),
    }
}

fn check_file_exists(path: &Path) -> EnvReadinessCheck {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            env_check(EnvReadinessStatus::Ready, Some(path.to_path_buf()), None)
        }
        Ok(_) => env_check(
            EnvReadinessStatus::Invalid,
            Some(path.to_path_buf()),
            Some("Replace the profile path with a regular encrypted ciphertext file."),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => env_check(
            EnvReadinessStatus::Missing,
            Some(path.to_path_buf()),
            Some("Create or import the encrypted profile before running the doctor."),
        ),
        Err(_) => env_check(
            EnvReadinessStatus::Unavailable,
            Some(path.to_path_buf()),
            Some("Check permissions and access to the profile file."),
        ),
    }
}

fn profile_ciphertext_status(error: &FrilVaultError) -> EnvReadinessStatus {
    match error {
        FrilVaultError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            EnvReadinessStatus::Missing
        }
        FrilVaultError::Io(_) => EnvReadinessStatus::Unavailable,
        _ => EnvReadinessStatus::Invalid,
    }
}

fn required_variables_status(error: &FrilVaultError) -> EnvReadinessStatus {
    match error {
        FrilVaultError::MissingRequiredEnvVariable(_) => EnvReadinessStatus::Missing,
        FrilVaultError::UnknownEnvProfileVariable(_) => EnvReadinessStatus::Invalid,
        _ => EnvReadinessStatus::Invalid,
    }
}

fn profile_status_remediation(status: EnvReadinessStatus) -> Option<&'static str> {
    match status {
        EnvReadinessStatus::Ready => None,
        EnvReadinessStatus::Configured => Some(
            "Provide an identity and valid manifest to determine whether this profile is runnable.",
        ),
        EnvReadinessStatus::Missing => Some("Create or import the encrypted profile."),
        EnvReadinessStatus::Invalid => Some("Repair the profile ciphertext and manifest metadata."),
        EnvReadinessStatus::Unavailable => {
            Some("Check permissions and access to the profile file.")
        }
        EnvReadinessStatus::NotReady => Some("Resolve the failed environment checks."),
    }
}

fn runtime_check(status: EnvReadinessStatus, path: Option<PathBuf>) -> EnvReadinessCheck {
    env_check(status, path, profile_status_remediation(status))
}

fn env_check(
    status: EnvReadinessStatus,
    path: Option<PathBuf>,
    remediation: Option<&'static str>,
) -> EnvReadinessCheck {
    EnvReadinessCheck {
        status,
        path,
        remediation,
    }
}

fn validate_values(values: &BTreeMap<String, String>) -> FrilVaultResult<()> {
    for (key, value) in values {
        validate_env_variable_name(key)?;
        if value.contains('\0') {
            return Err(FrilVaultError::InvalidEnvProfilePayload);
        }
    }

    Ok(())
}

/// Validates a portable environment variable name before file or process use.
pub fn validate_env_variable_name(name: &str) -> FrilVaultResult<()> {
    let mut bytes = name.bytes();
    let valid = matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');

    if !valid {
        return Err(FrilVaultError::InvalidEnvVariableName(name.to_string()));
    }

    Ok(())
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

fn atomic_write_public_text(path: &Path, contents: &[u8]) -> FrilVaultResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(RECIPIENTS_FILE_NAME);
    let temp_path = parent.join(format!(".{file_name}.tmp.{}", uuid::Uuid::new_v4()));

    let write_result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);

        let mut file = options.open(&temp_path)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp_path, path)
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(FrilVaultError::Io(error));
    }

    Ok(())
}

#[cfg(unix)]
fn configure_private_file(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;

    options.mode(0o600);
}

#[cfg(not(unix))]
fn configure_private_file(_options: &mut OpenOptions) {}

fn atomic_write_ciphertext(
    path: &Path,
    ciphertext: &[u8],
    #[cfg(test)] fail_replacement: &Arc<AtomicBool>,
) -> FrilVaultResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("profile.age");
    let temp_path = parent.join(format!(".{file_name}.tmp.{}", uuid::Uuid::new_v4()));

    let write_result = (|| -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        configure_private_file(&mut options);

        let mut file = options.open(&temp_path)?;
        file.write_all(ciphertext)?;
        file.sync_all()?;
        drop(file);

        #[cfg(test)]
        if fail_replacement.swap(false, Ordering::SeqCst) {
            return Err(std::io::Error::other(
                "injected profile replacement failure",
            ));
        }

        fs::rename(&temp_path, path)
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(FrilVaultError::Io(error));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        cell::RefCell,
        collections::BTreeMap,
        fs,
        io::Write,
        path::{Path, PathBuf},
    };

    use age::{Encryptor, Identity, Recipient, x25519};

    use super::*;
    struct TestWorkspace {
        root: PathBuf,
    }

    impl TestWorkspace {
        fn root(&self) -> &Path {
            &self.root
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn create_test_workspace() -> TestWorkspace {
        let root =
            std::env::temp_dir().join(format!("frilvault-env-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        TestWorkspace { root }
    }

    fn test_values() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("API_KEY".to_string(), "fixture-api-key".to_string()),
            ("REGION".to_string(), "test-region".to_string()),
        ])
    }

    fn encrypt_raw(recipient: &dyn Recipient, plaintext: &[u8]) -> Vec<u8> {
        let encryptor = Encryptor::with_recipients(std::iter::once(recipient)).unwrap();
        let mut ciphertext = Vec::new();
        let mut writer = encryptor.wrap_output(&mut ciphertext).unwrap();
        writer.write_all(plaintext).unwrap();
        writer.finish().unwrap();
        ciphertext
    }

    #[test]
    fn crypto_round_trip_uses_age_ciphertext() {
        let identity = x25519::Identity::generate();
        let recipient = identity.to_public();
        let payload = EnvProfilePayload::new(test_values()).unwrap();

        let ciphertext = EnvProfileCrypto::encrypt(&payload, &[&recipient]).unwrap();
        let identity: &dyn Identity = &identity;
        let decrypted = EnvProfileCrypto::decrypt(&ciphertext, &[identity]).unwrap();

        assert!(ciphertext.starts_with(b"age-encryption.org/v1"));
        assert!(decrypted.values() == payload.values());
    }

    #[test]
    fn multiple_recipients_can_each_decrypt_the_profile() {
        let identities = vec![x25519::Identity::generate(), x25519::Identity::generate()];
        let recipients = identities
            .iter()
            .map(|identity| identity.to_public())
            .collect::<Vec<_>>();
        let recipient_refs: Vec<&dyn Recipient> = recipients
            .iter()
            .map(|recipient| recipient as &dyn Recipient)
            .collect();
        let payload = EnvProfilePayload::new(test_values()).unwrap();
        let ciphertext = EnvProfileCrypto::encrypt(&payload, &recipient_refs).unwrap();

        for identity in &identities {
            let identity: &dyn Identity = identity;
            let decrypted = EnvProfileCrypto::decrypt(&ciphertext, &[identity]).unwrap();
            assert!(decrypted.values() == payload.values());
        }
    }

    #[test]
    fn rotation_reencrypts_for_current_recipients_only() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let current = EnvIdentity::generate();
        let removed = EnvIdentity::generate();
        let current_recipient = current.public_recipient();
        let removed_recipient = removed.public_recipient();
        let mut registry = EnvRecipientRegistry::default();
        registry
            .add("current", &current_recipient.to_string())
            .unwrap();

        store
            .save_profile(
                "development",
                &test_values(),
                &[&current_recipient, &removed_recipient],
            )
            .unwrap();
        let original = fs::read(store.profile_path("development").unwrap()).unwrap();

        store
            .rotate_profile("development", &current, &registry)
            .unwrap();

        let rotated = fs::read(store.profile_path("development").unwrap()).unwrap();
        assert_ne!(rotated, original);
        assert!(
            store
                .load_profile("development", &[current.age_identity()])
                .is_ok()
        );
        assert!(matches!(
            store.load_profile("development", &[removed.age_identity()]),
            Err(FrilVaultError::EnvProfileDecryptionFailed)
        ));
        assert!(
            !rotated
                .windows(b"fixture-api-key".len())
                .any(|window| window == b"fixture-api-key")
        );
    }

    #[test]
    fn rotation_rejects_corrupt_input_empty_recipients_and_wrong_identity() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let current = EnvIdentity::generate();
        let wrong = EnvIdentity::generate();
        let current_recipient = current.public_recipient();
        let mut registry = EnvRecipientRegistry::default();
        registry
            .add("current", &current_recipient.to_string())
            .unwrap();

        store
            .save_profile("development", &test_values(), &[&current_recipient])
            .unwrap();
        let profile_path = store.profile_path("development").unwrap();
        let original = fs::read(&profile_path).unwrap();

        assert!(matches!(
            store.rotate_profile("development", &wrong, &registry),
            Err(FrilVaultError::EnvProfileDecryptionFailed)
        ));
        assert_eq!(fs::read(&profile_path).unwrap(), original);

        let empty_registry = EnvRecipientRegistry::default();
        assert!(matches!(
            store.rotate_profile("development", &current, &empty_registry),
            Err(FrilVaultError::EmptyEnvRecipients)
        ));
        assert_eq!(fs::read(&profile_path).unwrap(), original);

        fs::write(&profile_path, b"corrupt ciphertext").unwrap();
        let corrupt_original = fs::read(&profile_path).unwrap();
        assert!(matches!(
            store.rotate_profile("development", &current, &registry),
            Err(FrilVaultError::EnvProfileDecryptionFailed)
        ));
        assert_eq!(fs::read(profile_path).unwrap(), corrupt_original);
    }

    #[test]
    fn rotation_replacement_failure_keeps_existing_ciphertext() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let current = EnvIdentity::generate();
        let current_recipient = current.public_recipient();
        let mut registry = EnvRecipientRegistry::default();
        registry
            .add("current", &current_recipient.to_string())
            .unwrap();

        store
            .save_profile("development", &test_values(), &[&current_recipient])
            .unwrap();
        let profile_path = store.profile_path("development").unwrap();
        let original = fs::read(&profile_path).unwrap();
        store.fail_next_replacement();

        assert!(matches!(
            store.rotate_profile("development", &current, &registry),
            Err(FrilVaultError::Io(_))
        ));
        assert_eq!(fs::read(&profile_path).unwrap(), original);
        assert!(
            store
                .profiles_root()
                .read_dir()
                .unwrap()
                .all(|entry| entry.unwrap().file_name() == "development.age")
        );
    }

    #[test]
    fn unrelated_identity_cannot_decrypt_the_profile() {
        let identity = x25519::Identity::generate();
        let unrelated = x25519::Identity::generate();
        let recipient = identity.to_public();
        let payload = EnvProfilePayload::new(test_values()).unwrap();
        let ciphertext = EnvProfileCrypto::encrypt(&payload, &[&recipient]).unwrap();
        let unrelated: &dyn Identity = &unrelated;

        let error = EnvProfileCrypto::decrypt(&ciphertext, &[unrelated]).unwrap_err();

        assert!(matches!(error, FrilVaultError::EnvProfileDecryptionFailed));
        assert!(!error.to_string().contains("fixture-api-key"));
    }

    #[test]
    fn store_writes_only_ciphertext_and_round_trips_the_profile() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let identity = x25519::Identity::generate();
        let recipient = identity.to_public();
        let identity: &dyn Identity = &identity;

        store
            .save_profile("development", &test_values(), &[&recipient])
            .unwrap();

        let profile_path = store.profile_path("development").unwrap();
        let ciphertext = fs::read(&profile_path).unwrap();
        let loaded = store.load_profile("development", &[identity]).unwrap();

        assert!(ciphertext.starts_with(b"age-encryption.org/v1"));
        assert!(
            !ciphertext
                .windows(b"fixture-api-key".len())
                .any(|window| { window == b"fixture-api-key" })
        );
        assert!(loaded.values() == &test_values());
        assert!(
            store
                .profiles_root()
                .read_dir()
                .unwrap()
                .all(|entry| entry.unwrap().file_name() == "development.age")
        );
    }

    #[test]
    fn profile_listing_is_deterministic_and_ciphertext_validation_is_value_free() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let identity = x25519::Identity::generate();
        let recipient = identity.to_public();

        store
            .save_profile("zeta", &test_values(), &[&recipient])
            .unwrap();
        store
            .save_profile("alpha", &test_values(), &[&recipient])
            .unwrap();
        fs::write(store.profiles_root().join("ignored.txt"), b"not a profile").unwrap();

        assert_eq!(store.list_profile_names().unwrap(), ["alpha", "zeta"]);
        assert!(store.validate_profile_ciphertext("alpha").is_ok());

        fs::write(store.profiles_root().join("CON.age"), b"invalid name").unwrap();
        let listing = store.list_profile_listing().unwrap();
        assert_eq!(listing.valid_names(), ["alpha", "zeta"]);
        assert_eq!(listing.invalid_names(), ["CON"]);
        assert!(matches!(
            store.list_profile_names(),
            Err(FrilVaultError::InvalidEnvProfileName(name)) if name == "CON"
        ));

        fs::write(
            store.profile_path("alpha").unwrap(),
            b"not an age ciphertext",
        )
        .unwrap();
        let error = store.validate_profile_ciphertext("alpha").unwrap_err();
        assert!(matches!(error, FrilVaultError::EnvProfileDecryptionFailed));
        assert!(!error.to_string().contains("fixture-api-key"));
    }

    #[test]
    fn profile_names_cannot_escape_the_profiles_directory() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());

        for name in [
            "",
            ".",
            "..",
            "../outside",
            "nested/profile",
            "nested\\profile",
            "dev:local",
            "dev?local",
            "CON",
            "con.env",
            "COM1",
            "LPT9",
            "trailing.",
            "trailing ",
        ] {
            assert!(matches!(
                store.profile_path(name),
                Err(FrilVaultError::InvalidEnvProfileName(_))
            ));
        }

        assert!(store.profile_path("development.local").is_ok());
        assert!(store.profile_path("convention").is_ok());
        assert!(store.profile_path("COM0").is_ok());
        assert!(!workspace.root().join("outside.age").exists());
    }

    #[test]
    fn invalid_values_do_not_replace_existing_ciphertext() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let identity = x25519::Identity::generate();
        let recipient = identity.to_public();
        let profile_path = store.profile_path("stable").unwrap();

        store
            .save_profile("stable", &test_values(), &[&recipient])
            .unwrap();
        let original = fs::read(&profile_path).unwrap();

        let invalid_values = BTreeMap::from([("BAD".to_string(), "bad\0value".to_string())]);
        let error = store
            .save_profile("stable", &invalid_values, &[&recipient])
            .unwrap_err();

        assert!(matches!(error, FrilVaultError::InvalidEnvProfilePayload));
        assert!(fs::read(profile_path).unwrap() == original);
    }

    #[test]
    fn missing_recipients_do_not_replace_existing_ciphertext() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let identity = x25519::Identity::generate();
        let recipient = identity.to_public();
        let profile_path = store.profile_path("stable").unwrap();

        store
            .save_profile("stable", &test_values(), &[&recipient])
            .unwrap();
        let original = fs::read(&profile_path).unwrap();

        let error = store
            .save_profile("stable", &test_values(), &[])
            .unwrap_err();

        assert!(matches!(error, FrilVaultError::EnvProfileEncryptionFailed));
        assert!(fs::read(profile_path).unwrap() == original);
    }

    #[test]
    fn replacement_failure_keeps_existing_ciphertext_and_cleans_temp_file() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let identity = x25519::Identity::generate();
        let recipient = identity.to_public();
        let profile_path = store.profile_path("stable").unwrap();

        store
            .save_profile("stable", &test_values(), &[&recipient])
            .unwrap();
        let original = fs::read(&profile_path).unwrap();
        store.fail_next_replacement();

        let error = store
            .save_profile("stable", &test_values(), &[&recipient])
            .unwrap_err();

        assert!(matches!(error, FrilVaultError::Io(_)));
        assert!(fs::read(&profile_path).unwrap() == original);
        assert!(
            store
                .profiles_root()
                .read_dir()
                .unwrap()
                .all(|entry| entry.unwrap().file_name() == "stable.age")
        );
    }

    #[test]
    fn corrupt_truncated_and_unsupported_payloads_fail_without_plaintext_errors() {
        let identity = x25519::Identity::generate();
        let recipient = identity.to_public();
        let identity: &dyn Identity = &identity;

        let mut corrupt = encrypt_raw(&recipient, br#"{"version":1,"values":{}}"#);
        corrupt[0] ^= 0xff;
        assert!(matches!(
            EnvProfileCrypto::decrypt(&corrupt, &[identity]),
            Err(FrilVaultError::EnvProfileDecryptionFailed)
        ));

        let mut truncated = encrypt_raw(&recipient, br#"{"version":1,"values":{}}"#);
        truncated.truncate(truncated.len() / 2);
        assert!(matches!(
            EnvProfileCrypto::decrypt(&truncated, &[identity]),
            Err(FrilVaultError::EnvProfileDecryptionFailed)
        ));

        let unsupported = encrypt_raw(
            &recipient,
            br#"{"version":999,"entries":[{"name":"SECRET","value":"fixture-api-key"}]}"#,
        );
        let error = EnvProfileCrypto::decrypt(&unsupported, &[identity]).unwrap_err();
        assert!(matches!(
            error,
            FrilVaultError::UnsupportedEnvProfilePayloadVersion(999)
        ));
        assert!(!error.to_string().contains("fixture-api-key"));
    }

    #[test]
    fn invalid_utf8_and_malformed_payloads_are_rejected() {
        let identity = x25519::Identity::generate();
        let recipient = identity.to_public();
        let identity: &dyn Identity = &identity;

        let invalid_utf8 = encrypt_raw(&recipient, &[0xff, 0xfe]);
        assert!(matches!(
            EnvProfileCrypto::decrypt(&invalid_utf8, &[identity]),
            Err(FrilVaultError::InvalidEnvProfileUtf8)
        ));

        let malformed = encrypt_raw(&recipient, br#"{"version":1,"values":"not-a-map"}"#);
        assert!(matches!(
            EnvProfileCrypto::decrypt(&malformed, &[identity]),
            Err(FrilVaultError::InvalidEnvProfilePayload)
        ));
    }

    #[test]
    fn empty_and_nul_profile_names_are_rejected() {
        assert!(validate_profile_name("").is_err());
        assert!(validate_profile_name("bad\0name").is_err());
        assert!(validate_profile_name("bad\nname").is_err());
    }

    #[test]
    fn manifest_resolves_defaults_and_profile_values_without_revealing_them_in_errors() {
        let manifest = EnvManifest::new(BTreeMap::from([
            (
                "REQUIRED_VALUE".to_string(),
                EnvVariableSpec {
                    required: true,
                    secret: true,
                    description: None,
                    default: None,
                },
            ),
            (
                "LOG_LEVEL".to_string(),
                EnvVariableSpec {
                    required: false,
                    secret: false,
                    description: None,
                    default: Some("info".to_string()),
                },
            ),
        ]))
        .unwrap();
        let payload = EnvProfilePayload::new(BTreeMap::from([(
            "REQUIRED_VALUE".to_string(),
            "fixture-secret".to_string(),
        )]))
        .unwrap();

        let resolved = manifest.resolve_profile(payload).unwrap();

        assert_eq!(
            resolved.get("REQUIRED_VALUE"),
            Some(&"fixture-secret".to_string())
        );
        assert_eq!(resolved.get("LOG_LEVEL"), Some(&"info".to_string()));
    }

    #[test]
    fn manifest_rejects_missing_required_and_undeclared_profile_values() {
        let manifest = EnvManifest::new(BTreeMap::from([(
            "REQUIRED_VALUE".to_string(),
            EnvVariableSpec {
                required: true,
                secret: true,
                description: None,
                default: None,
            },
        )]))
        .unwrap();

        let missing = EnvProfilePayload::new(BTreeMap::new()).unwrap();
        assert!(matches!(
            manifest.resolve_profile(missing),
            Err(FrilVaultError::MissingRequiredEnvVariable(name)) if name == "REQUIRED_VALUE"
        ));

        let undeclared = EnvProfilePayload::new(BTreeMap::from([(
            "UNDECLARED".to_string(),
            "fixture-value".to_string(),
        )]))
        .unwrap();
        let error = manifest.resolve_profile(undeclared).unwrap_err();
        assert!(matches!(
            &error,
            FrilVaultError::UnknownEnvProfileVariable(name) if name == "UNDECLARED"
        ));
        assert!(!error.to_string().contains("fixture-value"));
    }

    #[test]
    fn manifest_store_rejects_invalid_toml_without_echoing_contents() {
        let workspace = create_test_workspace();
        let vault_root = workspace.root().join(VAULT_DIR_NAME);
        let manifest_path = vault_root.join(ENV_DIR_NAME).join(MANIFEST_FILE_NAME);
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        fs::write(
            &manifest_path,
            "version = 1\n[variables.BAD]\nrequired = true\nsecret = true\nvalue = \"fixture-secret\"\n",
        )
        .unwrap();

        let error = EnvManifestStore::new(&vault_root).load().unwrap_err();

        assert!(matches!(error, FrilVaultError::InvalidEnvManifest(_)));
        assert!(!error.to_string().contains("fixture-secret"));
    }

    #[test]
    fn manifest_store_initialization_is_idempotent_and_creates_profile_directory() {
        let workspace = create_test_workspace();
        let vault_root = workspace.root().join(VAULT_DIR_NAME);
        let store = EnvManifestStore::new(&vault_root);

        assert!(store.initialize().unwrap());
        let original = fs::read_to_string(store.path()).unwrap();
        assert!(
            vault_root
                .join(ENV_DIR_NAME)
                .join(PROFILES_DIR_NAME)
                .is_dir()
        );

        fs::write(
            store.path(),
            "version = 1\n\n[variables.CUSTOM]\nrequired = false\nsecret = true\n",
        )
        .unwrap();
        assert!(!store.initialize().unwrap());
        assert_eq!(
            fs::read_to_string(store.path()).unwrap(),
            "version = 1\n\n[variables.CUSTOM]\nrequired = false\nsecret = true\n"
        );
        assert_ne!(original, fs::read_to_string(store.path()).unwrap());
    }

    #[derive(Default)]
    struct FakeIdentityStore {
        identity: RefCell<Option<EnvIdentity>>,
    }

    impl EnvIdentityStore for FakeIdentityStore {
        fn load_identity(&self) -> FrilVaultResult<Option<EnvIdentity>> {
            Ok(self.identity.borrow().clone())
        }

        fn save_identity(&self, identity: &EnvIdentity) -> FrilVaultResult<()> {
            *self.identity.borrow_mut() = Some(identity.clone());
            Ok(())
        }
    }

    #[test]
    fn identity_manager_generates_once_and_reuses_through_injected_store() {
        let store = FakeIdentityStore::default();
        let manager = EnvIdentityManager::new(store);

        let (created, was_created) = manager.create_or_reuse().unwrap();
        let (reused, was_created_again) = manager.create_or_reuse().unwrap();

        assert!(was_created);
        assert!(!was_created_again);
        assert_eq!(
            created.public_recipient().to_string(),
            reused.public_recipient().to_string()
        );
        assert!(format!("{created:?}").contains("<redacted>"));
        assert!(!format!("{created:?}").contains("AGE-SECRET-KEY-"));
    }

    #[test]
    fn identity_manager_does_not_replace_a_different_imported_identity() {
        let existing = EnvIdentity::generate();
        let candidate = EnvIdentity::generate();
        let store = FakeIdentityStore {
            identity: RefCell::new(Some(existing.clone())),
        };
        let manager = EnvIdentityManager::new(store);

        let error = manager.import_or_reuse(candidate).unwrap_err();

        assert!(matches!(
            error,
            FrilVaultError::EnvIdentityAlreadyConfigured
        ));
        assert_eq!(
            manager.load().unwrap().unwrap().public_recipient(),
            existing.public_recipient()
        );
    }

    #[test]
    fn identity_manager_reuses_an_identical_imported_identity() {
        let existing = EnvIdentity::generate();
        let candidate = EnvIdentity::from_encoded(&existing.with_encoded(str::to_owned)).unwrap();
        let manager = EnvIdentityManager::new(FakeIdentityStore {
            identity: RefCell::new(Some(existing.clone())),
        });

        let (reused, created) = manager.import_or_reuse(candidate).unwrap();

        assert!(!created);
        assert_eq!(reused.public_recipient(), existing.public_recipient());
    }

    #[test]
    fn identity_encoding_round_trips_without_private_material_in_public_recipient() {
        let identity = EnvIdentity::generate();
        let encoded = identity.with_encoded(str::to_owned);
        let loaded = EnvIdentity::from_encoded(&encoded).unwrap();

        assert_eq!(
            identity.public_recipient().to_string(),
            loaded.public_recipient().to_string()
        );
        assert!(encoded.starts_with("AGE-SECRET-KEY-"));
    }

    #[test]
    fn recipient_registry_validates_duplicates_and_orders_entries_by_id() {
        let first = EnvIdentity::generate().public_recipient().to_string();
        let second = EnvIdentity::generate().public_recipient().to_string();
        let mut registry = EnvRecipientRegistry::default();

        registry.add("zeta", &first).unwrap();
        registry.add("alpha", &second).unwrap();

        assert_eq!(
            registry
                .entries()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "zeta"]
        );
        assert!(matches!(
            registry.add("zeta", &second),
            Err(FrilVaultError::DuplicateEnvRecipientId(_))
        ));
        assert!(matches!(
            registry.add("other", &first),
            Err(FrilVaultError::DuplicateEnvRecipient)
        ));
        assert!(matches!(
            registry.add("bad id", &second),
            Err(FrilVaultError::InvalidEnvRecipientId(_))
        ));
        assert!(matches!(
            registry.add("invalid-key", "not-an-age-recipient"),
            Err(FrilVaultError::InvalidEnvRecipient)
        ));
    }

    #[test]
    fn recipient_store_writes_public_deterministic_toml_and_preserves_on_validation_failure() {
        let workspace = create_test_workspace();
        let store = EnvRecipientStore::new(workspace.root().join(VAULT_DIR_NAME));
        let first = EnvIdentity::generate().public_recipient().to_string();
        let second = EnvIdentity::generate().public_recipient().to_string();

        store.add("zeta", &first).unwrap();
        store.add("alpha", &second).unwrap();
        let path = store.path().to_path_buf();
        let original = fs::read_to_string(&path).unwrap();
        let error = store.add("duplicate", &first).unwrap_err();

        assert!(matches!(error, FrilVaultError::DuplicateEnvRecipient));
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        assert!(original.contains("version = 1"));
        assert!(original.contains("age1"));
        assert!(!original.contains("AGE-SECRET-KEY-"));
        assert_eq!(
            store
                .load()
                .unwrap()
                .entries()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "zeta"]
        );
    }

    #[test]
    fn shared_profile_rejects_empty_recipients_before_writing() {
        let workspace = create_test_workspace();
        let store = EnvProfileStore::new(workspace.root());
        let payload = EnvProfilePayload::new(test_values()).unwrap();

        let error = store
            .save_payload_for_mode("shared", &payload, VaultMode::Shared, &[])
            .unwrap_err();

        assert!(matches!(error, FrilVaultError::EmptySharedEnvRecipients));
        assert!(!store.profile_path("shared").unwrap().exists());
    }
}
