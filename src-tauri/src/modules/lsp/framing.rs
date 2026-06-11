pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

pub fn encode_frame(message: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + 32);
    out.extend_from_slice(b"Content-Length: ");
    out.extend_from_slice(message.len().to_string().as_bytes());
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(message.as_bytes());
    out
}

#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, String> {
        self.buf.extend_from_slice(bytes);
        let mut messages = Vec::new();
        loop {
            let Some(header_end) = find_header_end(&self.buf) else {
                if self.buf.len() > MAX_FRAME_BYTES {
                    return Err("lsp frame header exceeds size cap".to_string());
                }
                break;
            };
            let header = std::str::from_utf8(&self.buf[..header_end])
                .map_err(|_| "lsp frame header is not utf-8".to_string())?;
            let len = parse_content_length(header)?;
            if len > MAX_FRAME_BYTES {
                return Err(format!("lsp frame body of {len} bytes exceeds cap"));
            }
            let body_start = header_end + 4;
            if self.buf.len() < body_start + len {
                break;
            }
            let body = std::str::from_utf8(&self.buf[body_start..body_start + len])
                .map_err(|_| "lsp frame body is not utf-8".to_string())?
                .to_string();
            self.buf.drain(..body_start + len);
            messages.push(body);
        }
        Ok(messages)
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_content_length(header: &str) -> Result<usize, String> {
    for line in header.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("content-length") {
            return value
                .trim()
                .parse()
                .map_err(|_| format!("invalid content-length: {value}"));
        }
    }
    Err("missing content-length header".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_produces_content_length_header() {
        let frame = encode_frame("{}");
        assert_eq!(frame, b"Content-Length: 2\r\n\r\n{}");
    }

    #[test]
    fn decodes_single_complete_frame() {
        let mut d = FrameDecoder::default();
        let msgs = d.push(b"Content-Length: 2\r\n\r\n{}").unwrap();
        assert_eq!(msgs, vec!["{}".to_string()]);
    }

    #[test]
    fn decodes_frame_split_across_pushes_byte_by_byte() {
        let mut d = FrameDecoder::default();
        let frame = encode_frame(r#"{"jsonrpc":"2.0","id":1}"#);
        let mut got = Vec::new();
        for b in frame {
            got.extend(d.push(&[b]).unwrap());
        }
        assert_eq!(got, vec![r#"{"jsonrpc":"2.0","id":1}"#.to_string()]);
    }

    #[test]
    fn decodes_two_frames_in_one_push() {
        let mut d = FrameDecoder::default();
        let mut bytes = encode_frame("{}");
        bytes.extend(encode_frame(r#"{"a":1}"#));
        let msgs = d.push(&bytes).unwrap();
        assert_eq!(msgs, vec!["{}".to_string(), r#"{"a":1}"#.to_string()]);
    }

    #[test]
    fn tolerates_extra_headers_and_case() {
        let mut d = FrameDecoder::default();
        let msgs = d
            .push(b"content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}")
            .unwrap();
        assert_eq!(msgs, vec!["{}".to_string()]);
    }

    #[test]
    fn rejects_missing_content_length() {
        let mut d = FrameDecoder::default();
        assert!(d.push(b"Content-Type: text\r\n\r\n{}").is_err());
    }

    #[test]
    fn rejects_oversized_frame() {
        let mut d = FrameDecoder::default();
        let header = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1);
        assert!(d.push(header.as_bytes()).is_err());
    }
}
