use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::atomic::write_json;
use crate::error::DesktopResult;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeatureFlags {
    pub desktop_multi_agent: bool,
    pub desktop_cloud_render: bool,
    pub desktop_auto_reframe: bool,
    pub desktop_creator_memory: bool,
    pub desktop_mobile_approval: bool,
    pub desktop_operator_mode: bool,
}

impl Default for FeatureFlags {
    fn default() -> Self {
        Self {
            desktop_multi_agent: false,
            desktop_cloud_render: false,
            desktop_auto_reframe: false,
            desktop_creator_memory: false,
            desktop_mobile_approval: false,
            desktop_operator_mode: false,
        }
    }
}

pub fn load_or_create(path: &Path) -> DesktopResult<FeatureFlags> {
    if !path.exists() {
        let flags = FeatureFlags::default();
        write_json(path, &flags)?;
        return Ok(flags);
    }
    let bytes = std::fs::read(path)?;
    let flags = serde_json::from_slice(&bytes).unwrap_or_else(|_| FeatureFlags::default());
    Ok(flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_off_until_a_flag_file_enables_one() {
        let dir =
            std::env::temp_dir().join(format!("tippy-flags-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flags.json");
        let flags = load_or_create(&path).unwrap();
        assert_eq!(flags, FeatureFlags::default());
        let mut enabled = flags;
        enabled.desktop_multi_agent = true;
        write_json(&path, &enabled).unwrap();
        assert!(load_or_create(&path).unwrap().desktop_multi_agent);
        let _ = std::fs::remove_dir_all(dir);
    }
}
