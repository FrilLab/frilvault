use std::{
    collections::hash_map::DefaultHasher,
    fs::{File, OpenOptions},
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

/// Cross-process exclusive mutation lock shared by all FrilVault frontends.
#[derive(Debug, Clone)]
pub struct VaultMutationLock {
    path: PathBuf,
}

impl VaultMutationLock {
    pub fn new(vault_root: impl AsRef<Path>) -> Self {
        let mut hasher = DefaultHasher::new();
        let vault_root = vault_root.as_ref();
        let normalized_root = std::fs::canonicalize(vault_root).unwrap_or_else(|_| {
            if vault_root.is_absolute() {
                vault_root.to_path_buf()
            } else {
                std::env::current_dir().unwrap_or_default().join(vault_root)
            }
        });
        normalized_root.hash(&mut hasher);
        current_user_scope().hash(&mut hasher);
        let path = std::env::temp_dir().join(format!("frilvault-{:016x}.lock", hasher.finish(),));

        Self { path }
    }

    pub fn acquire(&self) -> std::io::Result<File> {
        let mut options = OpenOptions::new();
        options.create(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }

        let file = options.open(&self.path)?;
        file.lock()?;
        Ok(file)
    }
}

#[cfg(unix)]
fn current_user_scope() -> String {
    std::env::var("UID").unwrap_or_else(|_| "user".to_string())
}

#[cfg(windows)]
fn current_user_scope() -> String {
    std::env::var("USERNAME").unwrap_or_else(|_| "user".to_string())
}

#[cfg(not(any(unix, windows)))]
fn current_user_scope() -> String {
    "user".to_string()
}
