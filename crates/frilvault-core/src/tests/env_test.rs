use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use age::{Encryptor, Identity, Recipient, x25519};

use crate::constants::VAULT_DIR_NAME;
use crate::env::{ENV_DIR_NAME, MANIFEST_FILE_NAME, PROFILES_DIR_NAME};
use crate::{
    EnvIdentity, EnvIdentityManager, EnvIdentityStore, EnvManifest, EnvManifestStore,
    EnvProfileCrypto, EnvProfilePayload, EnvProfileStore, EnvRecipientRegistry, EnvRecipientStore,
    EnvVariableSpec, FrilVaultError, FrilVaultResult, VaultMode, validate_profile_name,
};
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
    let root = std::env::temp_dir().join(format!("frilvault-env-test-{}", uuid::Uuid::new_v4()));
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
