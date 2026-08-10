use crate::models::{valid_key_id, CommandError, CommandResult};

const CREDENTIAL_SERVICE: &str = "com.nqt.civ7-localization-tool.api-keys";

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
fn entry(id: &str) -> CommandResult<keyring::Entry> {
    validate_id(id)?;
    keyring::Entry::new(CREDENTIAL_SERVICE, id).map_err(|error| {
        CommandError::new(
            "credential_manager_error",
            format!("Không mở được Windows Credential Manager: {error}"),
        )
    })
}

#[cfg(windows)]
pub fn set_secret(id: &str, secret: &str) -> CommandResult<()> {
    entry(id)?.set_password(secret).map_err(|error| {
        CommandError::new(
            "credential_write_failed",
            format!("Không lưu được secret vào Windows Credential Manager: {error}"),
        )
    })
}

#[cfg(windows)]
pub fn get_secret(id: &str) -> CommandResult<String> {
    entry(id)?.get_password().map_err(|error| {
        let code = if matches!(error, keyring::Error::NoEntry) {
            "credential_not_found"
        } else {
            "credential_read_failed"
        };
        CommandError::new(
            code,
            format!("Không đọc được secret từ Windows Credential Manager: {error}"),
        )
    })
}

#[cfg(windows)]
pub fn delete_secret(id: &str) -> CommandResult<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(CommandError::new(
            "credential_delete_failed",
            format!("Không xóa được secret khỏi Windows Credential Manager: {error}"),
        )),
    }
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
