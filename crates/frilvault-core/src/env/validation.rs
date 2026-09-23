use std::collections::BTreeMap;

use crate::{FrilVaultError, FrilVaultResult};

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

pub(super) fn validate_values(values: &BTreeMap<String, String>) -> FrilVaultResult<()> {
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
