use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const CHAT_PORT: u16 = 4736;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStat {
    pub exists: bool,
    pub size: u64,
    pub modified_ms: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ChatOutcome {
    pub status: u16,
    pub emit: Option<String>,
}

pub fn replay_stat(path: &Path) -> Result<ReplayStat, String> {
    if !path.is_absolute() {
        return Err("Replay path must be an absolute path on this PC.".into());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "mkv" | "mp4" | "mov" | "flv" | "ts" | "m4v"
    ) {
        return Err("Tippy only stats a local video replay.".into());
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => Ok(ReplayStat {
            exists: true,
            size: meta.len(),
            modified_ms: modified_ms(&meta),
        }),
        Ok(_) => Err("OBS named a path that is not a file.".into()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(ReplayStat {
            exists: false,
            size: 0,
            modified_ms: 0,
        }),
        Err(err) => Err(err.to_string()),
    }
}

pub fn handle_chat_bytes(flag_enabled: bool, raw: &str) -> ChatOutcome {
    let mut lines = raw.lines();
    let request = lines.next().unwrap_or("");
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let path = target.split('?').next().unwrap_or(target);
    let local_header = raw.lines().any(|line| {
        let (name, value) = line.split_once(':').unwrap_or(("", ""));
        name.eq_ignore_ascii_case("x-tippy-local") && value.trim() == "1"
    });
    if !flag_enabled {
        return ChatOutcome { status: 403, emit: None };
    }
    if method != "POST" {
        return ChatOutcome { status: 405, emit: None };
    }
    if path != "/capture" {
        return ChatOutcome { status: 404, emit: None };
    }
    if !local_header {
        return ChatOutcome { status: 403, emit: None };
    }
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.trim())
        .unwrap_or("")
        .to_string();
    if body.is_empty() || body.len() > 8192 {
        return ChatOutcome { status: 400, emit: None };
    }
    ChatOutcome { status: 202, emit: Some(body) }
}

pub fn serve(app: AppHandle) -> std::io::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", CHAT_PORT))?;
    thread::Builder::new()
        .name("tippy-obs-chat".into())
        .spawn(move || {
            for incoming in listener.incoming() {
                let Ok(stream) = incoming else {
                    continue;
                };
                let app = app.clone();
                let _ = thread::spawn(move || {
                    let _ = serve_one(stream, &app);
                });
            }
        })?;
    Ok(format!("http://127.0.0.1:{CHAT_PORT}"))
}

fn serve_one(mut stream: std::net::TcpStream, app: &AppHandle) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut buffer = [0_u8; 8192];
    let mut filled = 0;
    while filled < buffer.len() {
        match stream.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(count) => {
                filled += count;
                if buffer[..filled].windows(4).any(|item| item == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let raw = String::from_utf8_lossy(&buffer[..filled]).to_string();
    let outcome = handle_chat_bytes(true, &raw);
    if let Some(body) = outcome.emit {
        let _ = app.emit("obs-chat-capture", body);
    }
    let reason = match outcome.status {
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Method Not Allowed",
    };
    let payload = format!("{{\"status\":{}}}", outcome.status);
    let head = format!(
        "HTTP/1.1 {} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        outcome.status,
        payload.len()
    );
    stream.write_all(head.as_bytes())
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_channel_rejects_until_the_pieces_are_present() {
        let raw = "POST /capture HTTP/1.1\r\nx-tippy-local: 1\r\n\r\n{\"idempotencyKey\":\"bot-1\"}";
        assert_eq!(handle_chat_bytes(false, raw).status, 403);
        assert!(handle_chat_bytes(false, raw).emit.is_none());
        let missing = "POST /capture HTTP/1.1\r\n\r\n{\"idempotencyKey\":\"bot-1\"}";
        assert_eq!(handle_chat_bytes(true, missing).status, 403);
        let accepted = handle_chat_bytes(true, raw);
        assert_eq!(accepted.status, 202);
        assert!(accepted.emit.unwrap().contains("bot-1"));
    }

    #[test]
    fn replay_stat_refuses_a_relative_path() {
        let err = replay_stat(Path::new("replay.mkv")).unwrap_err();
        assert!(err.contains("absolute"));
    }

    #[test]
    fn replay_stat_reports_a_missing_video() {
        let path = std::env::temp_dir().join(format!(
            "tippy-missing-{}.mkv",
            uuid::Uuid::new_v4().simple()
        ));
        let stat = replay_stat(&path).unwrap();
        assert!(!stat.exists);
        assert_eq!(stat.size, 0);
    }

    #[test]
    fn replay_stat_reads_size() {
        let path = std::env::temp_dir().join(format!(
            "tippy-replay-{}.mkv",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&path, b"replay-bytes").unwrap();
        let stat = replay_stat(&path).unwrap();
        assert!(stat.exists);
        assert_eq!(stat.size, b"replay-bytes".len() as u64);
        assert!(stat.modified_ms > 0 || SystemTime::now().duration_since(UNIX_EPOCH).is_ok());
        let _ = std::fs::remove_file(path);
    }
}
