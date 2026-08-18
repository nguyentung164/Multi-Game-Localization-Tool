use crate::models::{valid_key_id, CommandError, CommandResult};

const CREDENTIAL_SERVICE: &str = "com.nqt.localization-tool.api-keys";
const LEGACY_CREDENTIAL_SERVICE: &str = "com.nqt.civ7-localization-tool.api-keys";

fn validate_id(id: &str) -> CommandResult<()> {
    if valid_key_id(id) {
        Ok(())
    } else {
        Err(CommandError::new(
            "invalid_key_id",
            "API key metadata ID không hợp lệ",
        ))
    }
}

#[cfg(windows)]
fn entry_for(service: &str, id: &str) -> CommandResult<keyring::Entry> {
    keyring::Entry::new(service, id).map_err(|error| {
        CommandError::new(
            "credential_manager_error",
            format!("Không mở được Windows Credential Manager: {error}"),
        )
    })
}

#[cfg(windows)]
fn entry(id: &str) -> CommandResult<keyring::Entry> {
    validate_id(id)?;
    entry_for(CREDENTIAL_SERVICE, id)
}

#[cfg(windows)]
pub fn set_secret(id: &str, secret: &str) -> CommandResult<()> {
    entry(id)?.set_password(secret).map_err(|error| {
        CommandError::new(
            "credential_write_failed",
            format!("Không lưu được secret vào Windows Credential Manager: {error}"),
        )
    })?;
    if let Ok(legacy) = entry_for(LEGACY_CREDENTIAL_SERVICE, id) {
        let _ = legacy.delete_credential();
    }
    Ok(())
}

#[cfg(windows)]
pub fn get_secret(id: &str) -> CommandResult<String> {
    let current = entry(id)?;
    match current.get_password() {
        Ok(secret) => return Ok(secret),
        Err(keyring::Error::NoEntry) => {}
        Err(error) => {
            return Err(CommandError::new(
                "credential_read_failed",
                format!("Không đọc được secret từ Windows Credential Manager: {error}"),
            ));
        }
    }

    let legacy = entry_for(LEGACY_CREDENTIAL_SERVICE, id)?;
    let secret = legacy.get_password().map_err(|error| {
        let code = if matches!(error, keyring::Error::NoEntry) {
            "credential_not_found"
        } else {
            "credential_read_failed"
        };
        CommandError::new(
            code,
            format!("Không đọc được secret từ Windows Credential Manager: {error}"),
        )
    })?;
    if current.set_password(&secret).is_ok() {
        let _ = legacy.delete_credential();
    }
    Ok(secret)
}

#[cfg(windows)]
pub fn delete_secret(id: &str) -> CommandResult<()> {
    validate_id(id)?;
    for service in [CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_SERVICE] {
        match entry_for(service, id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(CommandError::new(
                    "credential_delete_failed",
                    format!("Không xóa được secret khỏi Windows Credential Manager: {error}"),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_secret(id: &str, _secret: &str) -> CommandResult<()> {
    validate_id(id)?;
    Err(CommandError::new(
        "credential_store_unsupported",
        "Bản build này chỉ hỗ trợ Windows Credential Manager",
    ))
}

#[cfg(not(windows))]
pub fn get_secret(id: &str) -> CommandResult<String> {
    validate_id(id)?;
    Err(CommandError::new(
        "credential_store_unsupported",
        "Bản build này chỉ hỗ trợ Windows Credential Manager",
    ))
}

#[cfg(not(windows))]
pub fn delete_secret(id: &str) -> CommandResult<()> {
    validate_id(id)?;
    Err(CommandError::new(
        "credential_store_unsupported",
        "Bản build này chỉ hỗ trợ Windows Credential Manager",
    ))
}
