use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing parent"))?;
    fs::create_dir_all(parent)?;
    let mut tmp_name = path
        .file_name()
        .ok_or_else(|| io::Error::other("missing file name"))?
        .to_os_string();
    tmp_name.push(".tmp");
    let tmp = parent.join(tmp_name);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Ok(dir) = File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

pub fn write_json(path: &Path, value: &impl serde::Serialize) -> io::Result<()> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|err| io::Error::other(err.to_string()))?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn atomic_write_replaces_the_previous_file() {
        let dir = std::env::temp_dir().join(format!(
            "tippy-atomic-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("project.json");
        atomic_write(&path, b"{\"ok\":1}\n").unwrap();
        atomic_write(&path, b"{\"ok\":2}\n").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"ok\":2}\n");
        assert!(!dir.join("project.json.tmp").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unfinished_temp_file_does_not_replace_the_destination() {
        let dir = std::env::temp_dir().join(format!(
            "tippy-atomic-tmp-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("project.json");
        atomic_write(&path, b"{\"saved\":true}\n").unwrap();
        fs::write(dir.join("project.json.tmp"), b"{\"torn\":").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"saved\":true}\n");
        let _ = fs::remove_dir_all(dir);
    }
}
