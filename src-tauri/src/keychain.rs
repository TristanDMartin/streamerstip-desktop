pub fn save(service: &str, account: &str, secret: &str) -> Result<(), String> {
    if service.is_empty() || account.is_empty() || secret.is_empty() {
        return Err("keychain_rejected".to_string());
    }
    let entry = keyring::Entry::new(service, account).map_err(|_| "keychain_unavailable".to_string())?;
    entry.set_password(secret).map_err(|_| "keychain_unavailable".to_string())
}

pub fn load(service: &str, account: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(service, account).map_err(|_| "keychain_unavailable".to_string())?;
    entry.get_password().map_err(|_| "keychain_unavailable".to_string())
}

pub fn clear(service: &str, account: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, account).map_err(|_| "keychain_unavailable".to_string())?;
    entry.delete_credential().map_err(|_| "keychain_unavailable".to_string())
}
