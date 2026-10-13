use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::atomic::write_json;
use crate::error::{DesktopError, DesktopResult};

pub const IDENTITY_LABEL: &str = "Waiting for the shared StreamersTip identity contract";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalAccount {
    pub owner_id: String,
    pub status: String,
    pub label: String,
}

impl LocalAccount {
    fn create() -> Self {
        Self {
            owner_id: format!("owner_{}", uuid::Uuid::new_v4().simple()),
            status: "waiting_for_identity_contract".into(),
            label: IDENTITY_LABEL.into(),
        }
    }
}

pub fn load_or_create(path: &Path) -> DesktopResult<LocalAccount> {
    if path.exists() {
        let bytes = std::fs::read(path)?;
        let account: LocalAccount = serde_json::from_slice(&bytes)
            .map_err(|err| DesktopError::Message(format!("account file is invalid: {err}")))?;
        if account.owner_id.trim().is_empty() {
            return Err(DesktopError::Message(
                "account file is missing an owner id".into(),
            ));
        }
        return Ok(account);
    }
    let account = LocalAccount::create();
    write_json(path, &account)?;
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_owner_id_is_reused() {
        let dir =
            std::env::temp_dir().join(format!("tippy-account-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("account.json");
        let first = load_or_create(&path).unwrap();
        let second = load_or_create(&path).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.label, IDENTITY_LABEL);
        assert!(first.owner_id.starts_with("owner_"));
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw.matches("owner_").count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
