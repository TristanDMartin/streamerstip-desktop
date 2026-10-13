use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use chrono::Utc;

pub fn log_line(path: &Path, level: &str, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let line = format!(
        "{} {} {}\n",
        Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        level,
        message.replace('\n', " ")
    );
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
    eprint!("{line}");
}
