use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::FrilVaultError;

use super::{
    EnvIdentity, EnvManifest, EnvManifestStore, EnvProfileStore, EnvRecipientStore,
    validate_profile_name,
};

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
