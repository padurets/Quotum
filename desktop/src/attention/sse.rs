//! Bounded UTF-8 SSE frames; a byte sequence is decoded only after its line is complete.
#[derive(Default)]
pub struct Decoder {
    line: Vec<u8>,
    event: String,
    data: String,
    cr: bool,
    size: usize,
}
const LIMIT: usize = 256 * 1024;
impl Decoder {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<(String, String)>, &'static str> {
        let mut frames = Vec::new();
        for &byte in bytes {
            if self.cr && byte == b'\n' {
                self.cr = false;
                continue;
            }
            self.cr = byte == b'\r';
            self.size += 1;
            if self.size > LIMIT {
                return Err("attention frame too large");
            }
            if byte != b'\r' && byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            let line = std::str::from_utf8(&self.line).map_err(|_| "invalid attention UTF-8")?;
            if line.is_empty() {
                if !self.data.is_empty() {
                    if self.data.ends_with('\n') {
                        self.data.pop();
                    }
                    frames.push((std::mem::take(&mut self.event), std::mem::take(&mut self.data)));
                }
                self.size = 0;
                self.event.clear();
            } else if !line.starts_with(':') {
                let (field, value) = line.split_once(':').unwrap_or((line, ""));
                let value = value.strip_prefix(' ').unwrap_or(value);
                match field {
                    "event" => self.event = value.into(),
                    "data" => {
                        self.data.push_str(value);
                        self.data.push('\n');
                    }
                    _ => {}
                }
            }
            self.line.clear();
        }
        Ok(frames)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_utf8_split_and_line_ending() {
        for ending in ["\n", "\r\n", "\r"] {
            let text = format!("event: attention{ending}data: Привет{ending}{ending}");
            for split in 0..text.len() {
                let mut decoder = Decoder::default();
                let mut frames = decoder.feed(&text.as_bytes()[..split]).unwrap();
                frames.extend(decoder.feed(&text.as_bytes()[split..]).unwrap());
                assert_eq!(frames, [("attention".into(), "Привет".into())]);
            }
        }
    }
    #[test]
    fn oversized_and_invalid_utf8_are_rejected() {
        assert!(Decoder::default().feed(&vec![b'x'; LIMIT + 1]).is_err());
        assert!(Decoder::default().feed(&[255, b'\n']).is_err());
    }
}
