use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{FrilVaultError, FrilVaultResult};

use super::{
    ENV_DIR_NAME, ENV_MANIFEST_VERSION, MANIFEST_FILE_NAME, PROFILES_DIR_NAME,
    profile::EnvProfilePayload, validation::validate_env_variable_name,
};

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
