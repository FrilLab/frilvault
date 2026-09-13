use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Result, bail};
use frilvault_core::{
    EnvIdentity, EnvManifest, EnvManifestStore, EnvProfileStore, EnvRecipientStore, FrilVaultError,
    validate_profile_name,
};
use serde::Serialize;
use serde_json::Value;

use crate::{
    cli::{env::EnvDoctorCommand, health::HealthCommand},
    output::{OutputFormat, print_json, resolve_format},
};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CheckStatus {
    Ready,
    Configured,
    Missing,
    Invalid,
    Unavailable,
    NotReady,
}

impl CheckStatus {
    fn satisfies_readiness(self) -> bool {
        matches!(self, Self::Ready | Self::Configured)
    }

    fn label(self) -> &'static str {
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

#[derive(Debug, Serialize)]
struct EnvCheck {
    status: CheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remediation: Option<&'static str>,
}

#[derive(Debug, Serialize)]
struct ProfileSummary {
    profile: String,
    status: CheckStatus,
    path: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    remediation: Option<&'static str>,
}

#[derive(Debug, Serialize)]
struct EnvDoctorReport {
    status: CheckStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    checks: BTreeMap<String, EnvCheck>,
    profiles: Vec<ProfileSummary>,
    usable_profiles: Vec<String>,
}

pub fn execute(command: HealthCommand) -> Result<()> {
    execute_with_vault(command, None)
}

pub fn execute_with_vault(command: HealthCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let mut service = vault.workspace()?;
    let health = service.health_check()?;

    let env_report = if EnvProfileStore::new_at_vault_root(vault.vault_root())
        .env_root()
        .exists()
    {
        let (identity, identity_status) = load_identity_status(&vault, None)?;
        Some(build_env_report(
            &vault,
            None,
            identity.as_ref(),
            identity_status,
        ))
    } else {
        None
    };

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        if let Some(env_report) = env_report {
            let mut output = serde_json::to_value(&health)?;
            if let Value::Object(fields) = &mut output {
                fields.insert("env".to_string(), serde_json::to_value(env_report)?);
            }
            print_json(&output)?;
        } else {
            print_json(&health)?;
        }
        return Ok(());
    }

    println!("Workspace Health Check\n");

    if health.missing_source_files.is_empty() {
        println!("No missing source files.");
    } else {
        println!("Missing Source Files\n");

        for file in health.missing_source_files {
            println!("- {}", file);
        }
    }

    if let Some(env_report) = env_report {
        println!();
        print_env_report(&env_report);
    }

    Ok(())
}

pub(crate) fn execute_env(command: EnvDoctorCommand, vault_path: Option<&Path>) -> Result<()> {
    let vault = super::open_vault(vault_path)?;
    let (identity, identity_status) = load_identity_status(&vault, command.identity_file)?;
    let profile_name = command.profile;
    let report = build_env_report(
        &vault,
        Some(&profile_name),
        identity.as_ref(),
        identity_status,
    );

    if matches!(resolve_format(command.format), OutputFormat::Json) {
        print_json(&report)?;
    } else {
        print_env_report(&report);
    }

    if report.status != CheckStatus::Ready {
        bail!("environment profile '{profile_name}' is not ready")
    }

    Ok(())
}

fn load_identity_status(
    vault: &frilvault_core::FrilVault,
    identity_file: Option<PathBuf>,
) -> Result<(Option<EnvIdentity>, CheckStatus)> {
    match crate::command::env::load_identity_for_doctor(vault, identity_file) {
        Ok(Some(identity)) => Ok((Some(identity), CheckStatus::Ready)),
        Ok(None) => Ok((None, CheckStatus::Missing)),
        Err(error) => {
            let status = if error
                .downcast_ref::<FrilVaultError>()
                .is_some_and(|error| matches!(error, FrilVaultError::InvalidEnvIdentity))
            {
                CheckStatus::Invalid
            } else {
                CheckStatus::Unavailable
            };
            Ok((None, status))
        }
    }
}

fn build_env_report(
    vault: &frilvault_core::FrilVault,
    selected_profile: Option<&str>,
    identity: Option<&EnvIdentity>,
    identity_status: CheckStatus,
) -> EnvDoctorReport {
    let profile_store = EnvProfileStore::new_at_vault_root(vault.vault_root());
    let manifest_store = EnvManifestStore::new(vault.vault_root());
    let recipient_store = EnvRecipientStore::new(vault.vault_root());

    let (manifest, manifest_check) = load_manifest(&manifest_store);
    let recipients_check = load_recipients(&recipient_store);
    let plaintext_check = check_plaintext_export_path(profile_store.env_root());
    let (profile_names, mut profiles_check) = list_profiles(&profile_store);

    let selected_name_status = selected_profile.map(|profile| {
        if validate_profile_name(profile).is_ok() {
            check(CheckStatus::Ready, None, None)
        } else {
            check(
                CheckStatus::Invalid,
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
    let selected_profile_check = selected_path.as_deref().map(check_file_exists).or_else(|| {
        selected_profile.map(|_| {
            check(
                CheckStatus::Missing,
                None,
                Some("Create or import the encrypted profile before running the doctor."),
            )
        })
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
            Ok(()) => CheckStatus::Ready,
            Err(error) => profile_ciphertext_status(&error),
        };

        let mut runtime_status = structural;
        let mut decryption_status = None;
        let mut required_status = None;

        if structural == CheckStatus::Ready {
            if let Some(identity) = identity {
                decryption_attempted = true;
                match profile_store.load_profile(profile_name, &[identity.age_identity()]) {
                    Ok(payload) => {
                        decryption_status = Some(CheckStatus::Ready);
                        if let Some(manifest) = &manifest {
                            required_attempted = true;
                            match manifest.resolve_profile(payload) {
                                Ok(_) => {
                                    required_status = Some(CheckStatus::Ready);
                                    usable_profiles.push(profile_name.clone());
                                    runtime_status = CheckStatus::Ready;
                                }
                                Err(error) => {
                                    let status = required_variables_status(&error);
                                    required_status = Some(status);
                                    all_required_ready = false;
                                    required_missing |= status == CheckStatus::Missing;
                                    required_invalid |= status == CheckStatus::Invalid;
                                    runtime_status = status;
                                }
                            }
                        } else {
                            all_required_ready = false;
                            runtime_status = CheckStatus::Configured;
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
                runtime_status = CheckStatus::Configured;
            }
        } else {
            all_decryption_ready = false;
            decryption_failed = true;
        }

        if let Some(selected_profile) = selected_profile
            && selected_profile == profile_name
        {
            selected_decryption = decryption_status;
            selected_required = required_status;
        }

        profiles.push(ProfileSummary {
            profile: profile_name.clone(),
            status: runtime_status,
            path,
            remediation: profile_status_remediation(runtime_status),
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
            .unwrap_or(CheckStatus::Missing);
        profiles_check = check(
            selected_status,
            Some(profile_store.profiles_root()),
            profile_status_remediation(selected_status),
        );
    } else if profiles
        .iter()
        .any(|profile| profile.status == CheckStatus::Invalid)
    {
        profiles_check = check(
            CheckStatus::Invalid,
            Some(profile_store.profiles_root()),
            Some("Repair invalid profile ciphertext or profile metadata."),
        );
    } else if profiles
        .iter()
        .any(|profile| profile.status == CheckStatus::Unavailable)
    {
        profiles_check = check(
            CheckStatus::Unavailable,
            Some(profile_store.profiles_root()),
            Some("Check permissions and access to the profiles directory."),
        );
    } else if profiles
        .iter()
        .any(|profile| profile.status == CheckStatus::Missing)
    {
        profiles_check = check(
            CheckStatus::Missing,
            Some(profile_store.profiles_root()),
            Some("Restore the missing profile ciphertext file."),
        );
    }

    let decryption_check = if selected_profile.is_some() {
        selected_decryption
            .map(|status| runtime_check(status, selected_path.clone()))
            .unwrap_or_else(|| {
                let status = if identity_status != CheckStatus::Ready {
                    identity_status
                } else if selected_profile_check
                    .as_ref()
                    .is_some_and(|check| check.status != CheckStatus::Ready)
                {
                    CheckStatus::Unavailable
                } else {
                    CheckStatus::Invalid
                };
                runtime_check(status, selected_path.clone())
            })
    } else if profile_names.is_empty() {
        check(CheckStatus::Configured, None, None)
    } else if identity_status != CheckStatus::Ready {
        check(
            identity_status,
            None,
            Some("Run `flvt env identity create` or provide --identity-file."),
        )
    } else if decryption_failed || !all_decryption_ready || !decryption_attempted {
        check(
            CheckStatus::Invalid,
            None,
            Some(
                "Verify the identity and profile ciphertext, then re-encrypt the profile if needed.",
            ),
        )
    } else {
        check(CheckStatus::Ready, None, None)
    };

    let required_check = if selected_profile.is_some() {
        selected_required
            .map(|status| runtime_check(status, selected_path.clone()))
            .unwrap_or_else(|| {
                let status = if manifest.is_none()
                    || identity_status != CheckStatus::Ready
                    || selected_profile_check
                        .as_ref()
                        .is_some_and(|check| check.status != CheckStatus::Ready)
                {
                    CheckStatus::Unavailable
                } else {
                    CheckStatus::Invalid
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
        check(CheckStatus::Configured, None, None)
    } else if manifest.is_none() || identity_status != CheckStatus::Ready {
        check(
            CheckStatus::Unavailable,
            manifest_check.path.clone(),
            Some("Resolve the manifest and identity checks before validating profile variables."),
        )
    } else if required_invalid {
        check(
            CheckStatus::Invalid,
            manifest_check.path.clone(),
            Some("Remove undeclared variables and keep profile values valid for the manifest."),
        )
    } else if required_missing || !all_required_ready || !required_attempted {
        check(
            CheckStatus::Missing,
            manifest_check.path.clone(),
            Some("Add the required variables to the encrypted profile."),
        )
    } else {
        check(CheckStatus::Ready, None, None)
    };

    let mut checks = BTreeMap::new();
    checks.insert("manifest".to_string(), manifest_check);
    checks.insert(
        "profile_name".to_string(),
        selected_name_status.unwrap_or_else(|| check(CheckStatus::Configured, None, None)),
    );
    checks.insert(
        "profile".to_string(),
        selected_profile_check.unwrap_or_else(|| check(CheckStatus::Configured, None, None)),
    );
    checks.insert("recipients".to_string(), recipients_check);
    checks.insert(
        "identity".to_string(),
        check(
            identity_status,
            None,
            (identity_status != CheckStatus::Ready)
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
        CheckStatus::Ready
    } else {
        CheckStatus::NotReady
    };

    EnvDoctorReport {
        status,
        profile: selected_profile.map(str::to_string),
        checks,
        profiles,
        usable_profiles,
    }
}

fn load_manifest(store: &EnvManifestStore) -> (Option<EnvManifest>, EnvCheck) {
    let path = store.path().to_path_buf();
    match store.load() {
        Ok(manifest) => (Some(manifest), check(CheckStatus::Ready, Some(path), None)),
        Err(FrilVaultError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => (
            None,
            check(
                CheckStatus::Missing,
                Some(path),
                Some("Create .vault/env/manifest.toml using the versioned manifest schema."),
            ),
        ),
        Err(
            FrilVaultError::InvalidEnvManifest(_)
            | FrilVaultError::UnsupportedEnvManifestVersion(_),
        ) => (
            None,
            check(
                CheckStatus::Invalid,
                Some(path),
                Some("Repair the manifest TOML and use a supported manifest version."),
            ),
        ),
        Err(_) => (
            None,
            check(
                CheckStatus::Unavailable,
                Some(path),
                Some("Check permissions and access to the manifest file."),
            ),
        ),
    }
}

fn load_recipients(store: &EnvRecipientStore) -> EnvCheck {
    let path = store.path().to_path_buf();
    match store.load() {
        Ok(_) if !path.exists() => check(CheckStatus::Configured, Some(path), None),
        Ok(_) => check(CheckStatus::Ready, Some(path), None),
        Err(
            FrilVaultError::InvalidEnvRecipientRegistry
            | FrilVaultError::InvalidEnvRecipientId(_)
            | FrilVaultError::InvalidEnvRecipient
            | FrilVaultError::DuplicateEnvRecipientId(_)
            | FrilVaultError::DuplicateEnvRecipient
            | FrilVaultError::UnsupportedEnvRecipientRegistryVersion(_),
        ) => check(
            CheckStatus::Invalid,
            Some(path),
            Some("Repair recipients.toml with valid IDs and public age recipients."),
        ),
        Err(FrilVaultError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            check(CheckStatus::Configured, Some(path), None)
        }
        Err(_) => check(
            CheckStatus::Unavailable,
            Some(path),
            Some("Check permissions and access to recipients.toml."),
        ),
    }
}

fn list_profiles(store: &EnvProfileStore) -> (Vec<String>, EnvCheck) {
    let path = store.profiles_root();
    match store.list_profile_names() {
        Ok(names) if names.is_empty() => (
            names,
            check(
                CheckStatus::Configured,
                Some(path),
                Some("Create or import an encrypted environment profile."),
            ),
        ),
        Ok(names) => (names, check(CheckStatus::Ready, Some(path), None)),
        Err(FrilVaultError::InvalidEnvProfileName(_)) => (
            Vec::new(),
            check(
                CheckStatus::Invalid,
                Some(path),
                Some("Rename profiles to portable names before running the doctor."),
            ),
        ),
        Err(_) => (
            Vec::new(),
            check(
                CheckStatus::Unavailable,
                Some(path),
                Some("Check permissions and access to the profiles directory."),
            ),
        ),
    }
}

fn check_plaintext_export_path(env_root: &Path) -> EnvCheck {
    let path = env_root.join(".env");
    match fs::metadata(&path) {
        Ok(_) => check(
            CheckStatus::Invalid,
            Some(path),
            Some("Remove the plaintext export and use `flvt env run --profile NAME -- COMMAND`."),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => check(
            CheckStatus::Ready,
            None,
            Some("Plaintext export is unsupported; profiles stay encrypted on disk."),
        ),
        Err(_) => check(
            CheckStatus::Unavailable,
            Some(path),
            Some("Check access to the environment directory."),
        ),
    }
}

fn check_file_exists(path: &Path) -> EnvCheck {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            check(CheckStatus::Ready, Some(path.to_path_buf()), None)
        }
        Ok(_) => check(
            CheckStatus::Invalid,
            Some(path.to_path_buf()),
            Some("Replace the profile path with a regular encrypted ciphertext file."),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => check(
            CheckStatus::Missing,
            Some(path.to_path_buf()),
            Some("Create or import the encrypted profile before running the doctor."),
        ),
        Err(_) => check(
            CheckStatus::Unavailable,
            Some(path.to_path_buf()),
            Some("Check permissions and access to the profile file."),
        ),
    }
}

fn profile_ciphertext_status(error: &FrilVaultError) -> CheckStatus {
    match error {
        FrilVaultError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => {
            CheckStatus::Missing
        }
        FrilVaultError::Io(_) => CheckStatus::Unavailable,
        _ => CheckStatus::Invalid,
    }
}

fn required_variables_status(error: &FrilVaultError) -> CheckStatus {
    match error {
        FrilVaultError::MissingRequiredEnvVariable(_) => CheckStatus::Missing,
        FrilVaultError::UnknownEnvProfileVariable(_) => CheckStatus::Invalid,
        _ => CheckStatus::Invalid,
    }
}

fn profile_status_remediation(status: CheckStatus) -> Option<&'static str> {
    match status {
        CheckStatus::Ready => None,
        CheckStatus::Configured => Some(
            "Provide an identity and valid manifest to determine whether this profile is runnable.",
        ),
        CheckStatus::Missing => Some("Create or import the encrypted profile."),
        CheckStatus::Invalid => Some("Repair the profile ciphertext and manifest metadata."),
        CheckStatus::Unavailable => Some("Check permissions and access to the profile file."),
        CheckStatus::NotReady => Some("Resolve the failed environment checks."),
    }
}

fn runtime_check(status: CheckStatus, path: Option<PathBuf>) -> EnvCheck {
    check(status, path, profile_status_remediation(status))
}

fn check(
    status: CheckStatus,
    path: Option<PathBuf>,
    remediation: Option<&'static str>,
) -> EnvCheck {
    EnvCheck {
        status,
        path,
        remediation,
    }
}

fn print_env_report(report: &EnvDoctorReport) {
    println!("Environment Readiness");
    if let Some(profile) = &report.profile {
        println!("Profile: {profile}");
    }
    println!("Status: {}\n", report.status.label());

    for (name, check) in &report.checks {
        print!("{name}: {}", check.status.label());
        if let Some(path) = &check.path {
            print!(" ({})", path.display());
        }
        println!();
        if let Some(remediation) = check.remediation {
            println!("  Remediation: {remediation}");
        }
    }

    println!("\nProfiles:");
    if report.profiles.is_empty() {
        println!("- none");
    } else {
        for profile in &report.profiles {
            println!(
                "- {}: {} ({})",
                profile.profile,
                profile.status.label(),
                profile.path.display()
            );
        }
    }

    if report.usable_profiles.is_empty() {
        println!("\nCurrent usable profiles: none");
    } else {
        println!(
            "\nCurrent usable profiles: {}",
            report.usable_profiles.join(", ")
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_status_labels_are_stable() {
        assert_eq!(CheckStatus::Ready.label(), "ready");
        assert_eq!(CheckStatus::NotReady.label(), "not ready");
    }
}
