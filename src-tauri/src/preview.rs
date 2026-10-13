use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

const PREFIX: &str = "/v/";

/// Loopback file server for the preview `<video>` element.
///
/// WebKitGTK hands media URLs to GStreamer. GStreamer can read `http://127.0.0.1`
/// and `file://`, but not Tauri's `asset://` scheme, which is why images load
/// and the same MPEG-4 proxy does not.
pub fn serve(root: PathBuf) -> std::io::Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    let root = root.canonicalize().unwrap_or(root);
    thread::Builder::new()
        .name("tippy-preview".into())
        .spawn(move || accept_loop(listener, root))?;
    Ok(format!("http://127.0.0.1:{port}"))
}

fn accept_loop(listener: TcpListener, root: PathBuf) {
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else {
            continue;
        };
        let root = root.clone();
        let _ = thread::spawn(move || {
            let _ = handle_client(stream, &root);
        });
    }
}

fn handle_client(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
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
            Err(err)
                if err.kind() == std::io::ErrorKind::WouldBlock
                    || err.kind() == std::io::ErrorKind::TimedOut =>
            {
                break
            }
            Err(err) => return Err(err),
        }
    }
    let header = String::from_utf8_lossy(&buffer[..filled]);
    let mut lines = header.lines();
    let Some(request) = lines.next() else {
        return write_status(&mut stream, 400, "Bad Request");
    };
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "GET" && method != "HEAD" {
        return write_status(&mut stream, 405, "Method Not Allowed");
    }
    let range = header
        .lines()
        .find_map(|line| {
            line.strip_prefix("Range:")
                .or_else(|| line.strip_prefix("range:"))
        })
        .map(str::trim);
    let path = match resolve_media(root, target) {
        Ok(path) => path,
        Err(status) => {
            let reason = if status == 403 {
                "Forbidden"
            } else {
                "Not Found"
            };
            return write_status(&mut stream, status, reason);
        }
    };
    let mut file = File::open(&path)?;
    let len = file.metadata()?.len();
    let span = match parse_byte_range(range, len) {
        Ok(span) => span,
        Err(()) => return write_status(&mut stream, 416, "Range Not Satisfiable"),
    };
    let (start, end) = span.unwrap_or((0, len.saturating_sub(1)));
    let count = if len == 0 { 0 } else { end - start + 1 };
    let status = if span.is_some() { 206 } else { 200 };
    let reason = if status == 206 {
        "Partial Content"
    } else {
        "OK"
    };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {}\r\nContent-Length: {count}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n",
        content_type(&path)
    );
    if status == 206 {
        head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    if method == "HEAD" || count == 0 {
        return Ok(());
    }
    file.seek(SeekFrom::Start(start))?;
    let mut remaining = count;
    let mut chunk = [0_u8; 65536];
    while remaining > 0 {
        let want = remaining.min(chunk.len() as u64) as usize;
        let read = file.read(&mut chunk[..want])?;
        if read == 0 {
            break;
        }
        stream.write_all(&chunk[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn write_status(stream: &mut TcpStream, status: u16, reason: &str) -> std::io::Result<()> {
    let body = reason.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}

pub fn resolve_media(root: &Path, target: &str) -> Result<PathBuf, u16> {
    let path = target.split('?').next().unwrap_or(target);
    let encoded = path.strip_prefix(PREFIX).ok_or(404_u16)?;
    let decoded = percent_decode(encoded).ok_or(400_u16)?;
    let candidate = PathBuf::from(&decoded);
    if !candidate.is_absolute() {
        return Err(400);
    }
    let extension = candidate
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "png" | "wav"
    ) {
        return Err(404);
    }
    let root = root.canonicalize().map_err(|_| 404_u16)?;
    let full = candidate.canonicalize().map_err(|_| 404_u16)?;
    if !full.starts_with(&root) || !full.is_file() {
        return Err(403);
    }
    Ok(full)
}

pub fn parse_byte_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(header) = header else {
        return Ok(None);
    };
    if len == 0 {
        return Err(());
    }
    let spec = header.trim().strip_prefix("bytes=").ok_or(())?;
    if spec.contains(',') {
        return Err(());
    }
    let (start_text, end_text) = spec.split_once('-').ok_or(())?;
    if start_text.is_empty() {
        return Err(());
    }
    let start: u64 = start_text.parse().map_err(|_| ())?;
    if start >= len {
        return Err(());
    }
    let end = if end_text.is_empty() {
        len - 1
    } else {
        end_text.parse::<u64>().map_err(|_| ())?.min(len - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(Some((start, end)))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "png" => "image/png",
        "wav" => "audio/wav",
        _ => "video/mp4",
    }
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn resolve_allows_only_files_inside_the_data_dir() {
        let root = std::env::temp_dir().join(format!("tippy-preview-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("derived")).unwrap();
        let media = root.join("derived").join("proxy.mp4");
        let mut file = File::create(&media).unwrap();
        file.write_all(b"mp4").unwrap();
        let outside =
            std::env::temp_dir().join(format!("tippy-outside-{}.mp4", std::process::id()));
        File::create(&outside).unwrap().write_all(b"no").unwrap();
        let encoded = format!("/v/{}", percent_encode(&media.display().to_string()));
        let resolved = resolve_media(&root, &encoded).unwrap();
        assert_eq!(resolved, media.canonicalize().unwrap());
        let blocked = format!("/v/{}", percent_encode(&outside.display().to_string()));
        assert_eq!(resolve_media(&root, &blocked).unwrap_err(), 403);
        assert!(resolve_media(&root, "/v/relative.mp4").is_err());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn parse_byte_range_covers_open_and_closed_ranges() {
        assert_eq!(parse_byte_range(None, 10).unwrap(), None);
        assert_eq!(
            parse_byte_range(Some("bytes=0-"), 10).unwrap(),
            Some((0, 9))
        );
        assert_eq!(
            parse_byte_range(Some("bytes=2-4"), 10).unwrap(),
            Some((2, 4))
        );
        assert!(parse_byte_range(Some("bytes=10-"), 10).is_err());
    }

    fn percent_encode(value: &str) -> String {
        value.bytes().map(|byte| format!("%{byte:02X}")).collect()
    }
}
