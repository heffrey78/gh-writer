//! The app's own settings, in settings.json in its config folder. The writer's work and library live
//! elsewhere (the novels' folders, the server's library.json); these are only how the app runs.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Use the computer's own git instead of the one inside the app.
    pub system_git: bool,
}

impl Settings {
    fn file(dir: &Path) -> PathBuf {
        dir.join("settings.json")
    }

    /// The settings in `dir`, or the defaults if there are none (or they can't be read).
    pub fn load(dir: &Path) -> Settings {
        fs::read_to_string(Self::file(dir)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(Self::file(dir), text).map_err(|e| format!("Couldn't save the app's settings: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    #[test]
    fn keeps_what_it_saved_and_defaults_otherwise() {
        let dir = std::env::temp_dir().join(format!("gh-writer-settings-{}", std::process::id()));
        assert!(!Settings::load(&dir).system_git);
        Settings { system_git: true }.save(&dir).unwrap();
        assert!(Settings::load(&dir).system_git);
        std::fs::write(dir.join("settings.json"), "not json").unwrap();
        assert!(!Settings::load(&dir).system_git);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
