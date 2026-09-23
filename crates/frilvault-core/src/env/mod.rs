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
//! The environment domain is split into manifest, identity, recipient,
//! encrypted profile, readiness, validation, and atomic storage boundaries.

pub const ENV_PROFILE_PAYLOAD_VERSION: u32 = 1;
pub const ENV_RECIPIENT_REGISTRY_VERSION: u32 = 1;
pub const ENV_MANIFEST_VERSION: u32 = 1;

pub(crate) const ENV_DIR_NAME: &str = "env";
pub(crate) const PROFILES_DIR_NAME: &str = "profiles";
pub(crate) const PROFILE_FILE_EXTENSION: &str = "age";
pub(crate) const MANIFEST_FILE_NAME: &str = "manifest.toml";
pub(crate) const RECIPIENTS_FILE_NAME: &str = "recipients.toml";

mod identity;
mod manifest;
mod profile;
mod readiness;
mod recipient;
mod storage;
mod validation;

pub use identity::{EnvIdentity, EnvIdentityManager, EnvIdentityStore};
pub use manifest::{EnvManifest, EnvManifestStore, EnvVariableSpec};
pub use profile::{EnvProfileCrypto, EnvProfileListing, EnvProfilePayload, EnvProfileStore};
pub use readiness::{
    EnvProfileReadiness, EnvReadiness, EnvReadinessCheck, EnvReadinessReport, EnvReadinessStatus,
};
pub use recipient::{EnvRecipient, EnvRecipientRegistry, EnvRecipientStore};
pub use validation::{validate_env_variable_name, validate_profile_name};
