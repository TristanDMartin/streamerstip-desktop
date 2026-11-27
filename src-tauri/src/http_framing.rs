const MAX_BODY: usize = 8192;

pub fn assemble_http_request(buffer: &[u8]) -> Result<Option<Vec<u8>>, &'static str> {
    let Some(header_end) = find_header_end(buffer) else {
        return Ok(None);
    };
    let header = std::str::from_utf8(&buffer[..header_end]).map_err(|_| "headers are not utf-8")?;
    let body_at = header_end + 4;
    match content_length(header) {
        Some(len) if len > MAX_BODY => Err("body too large"),
        Some(len) if buffer.len() < body_at + len => Ok(None),
        Some(len) => Ok(Some(buffer[..body_at + len].to_vec())),
        None if buffer.len() > body_at => {
            let len = buffer.len() - body_at;
            if len > MAX_BODY {
                Err("body too large")
            } else {
                Ok(Some(buffer.to_vec()))
            }
        }
        None => Ok(None),
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|item| item == b"\r\n\r\n")
}

fn content_length(header: &str) -> Option<usize> {
    header.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.eq_ignore_ascii_case("content-length") {
            value.trim().parse().ok()
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_split_body_is_not_complete_until_content_length_arrives() {
        let head = b"POST /capture HTTP/1.1\r\nx-tippy-local: 1\r\nContent-Length: 26\r\n\r\n";
        assert!(assemble_http_request(head).unwrap().is_none());
        let mut both = head.to_vec();
        both.extend_from_slice(b"{\"idempotencyKey\":\"bot-1\"}extra");
        let full = assemble_http_request(&both).unwrap().unwrap();
        let text = String::from_utf8(full).unwrap();
        assert!(text.contains("bot-1"));
        assert!(!text.contains("extra"));
    }

    #[test]
    fn one_packet_with_a_length_still_parses() {
        let raw = b"POST /capture HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}";
        let full = assemble_http_request(raw).unwrap().unwrap();
        assert_eq!(&full[full.len() - 2..], b"{}");
    }
}
