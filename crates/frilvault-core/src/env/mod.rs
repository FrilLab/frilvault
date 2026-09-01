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
//! This module owns the profile payload and ciphertext boundary. `manifest.toml`
//! and `recipients.toml` are metadata managed by the environment-profile
//! integration work; this module deliberately does not persist recipient or
//! identity material. Callers provide public recipients for encryption and
//! identities for decryption.
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
    fs::{self, OpenOptions},
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

use crate::{FrilVaultError, FrilVaultResult, constants::VAULT_DIR_NAME};

/// Current version of the JSON payload encrypted into a profile file.
pub const ENV_PROFILE_PAYLOAD_VERSION: u32 = 1;

const ENV_DIR_NAME: &str = "env";
const PROFILES_DIR_NAME: &str = "profiles";
const PROFILE_FILE_EXTENSION: &str = "age";
const WINDOWS_INVALID_NAME_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*'];

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

impl EnvProfileStore {
    /// Creates a store for a workspace root.
    pub fn new(workspace_root: impl Into<PathBuf>) -> Self {
        Self {
            env_root: workspace_root
                .into()
                .join(VAULT_DIR_NAME)
                .join(ENV_DIR_NAME),
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
        let profile_path = self.profile_path(profile_name)?;
        let ciphertext = EnvProfileCrypto::encrypt(payload, recipients)?;

        atomic_write_ciphertext(
            &profile_path,
            &ciphertext,
            #[cfg(test)]
            &self.fail_replacement,
        )
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

    #[cfg(test)]
    fn fail_next_replacement(&self) {
        self.fail_replacement.store(true, Ordering::SeqCst);
    }
}

fn validate_values(values: &BTreeMap<String, String>) -> FrilVaultResult<()> {
    if values
        .iter()
        .any(|(key, value)| key.contains('\0') || value.contains('\0'))
    {
        return Err(FrilVaultError::InvalidEnvProfilePayload);
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
}
