use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

#[cfg(test)]
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use crate::{FrilVaultError, FrilVaultResult};

use super::RECIPIENTS_FILE_NAME;

pub(super) fn atomic_write_public_text(path: &Path, contents: &[u8]) -> FrilVaultResult<()> {
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

pub(super) fn atomic_write_ciphertext(
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
