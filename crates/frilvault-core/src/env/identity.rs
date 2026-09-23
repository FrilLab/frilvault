use std::{fmt, str::FromStr};

use age::{secrecy::ExposeSecret, x25519};

use crate::{FrilVaultError, FrilVaultResult};

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
