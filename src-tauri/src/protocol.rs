use crate::models::{
    CommandError, CommandResult, EngineEventEnvelope, MAX_EVENT_LINE_BYTES, PROTOCOL_VERSION,
};

pub struct ProtocolValidator {
    job_id: String,
    last_seq: Option<u64>,
}

impl ProtocolValidator {
    pub fn new(job_id: impl Into<String>) -> Self {
        Self {
            job_id: job_id.into(),
            last_seq: None,
        }
    }

    pub fn parse_line(&mut self, bytes: &[u8]) -> CommandResult<EngineEventEnvelope> {
        if bytes.is_empty() {
            return Err(CommandError::new(
                "protocol_empty_line",
                "Engine gửi dòng JSONL rỗng",
            ));
        }
        if bytes.len() > MAX_EVENT_LINE_BYTES {
            return Err(CommandError::new(
                "protocol_line_too_large",
                "Engine event vượt quá 1 MiB",
            ));
        }
        let line = std::str::from_utf8(bytes).map_err(|_| {
            CommandError::new("protocol_invalid_utf8", "Engine event không phải UTF-8")
        })?;
        let event: EngineEventEnvelope = serde_json::from_str(line.trim_end_matches(['\r', '\n']))
            .map_err(|error| {
                CommandError::new(
                    "protocol_invalid_json",
                    format!("Engine JSONL không hợp lệ: {error}"),
                )
            })?;
        if event.protocol_version != PROTOCOL_VERSION {
            return Err(CommandError::new(
                "protocol_version_mismatch",
                format!(
                    "Engine dùng protocol {}, ứng dụng yêu cầu {}",
                    event.protocol_version, PROTOCOL_VERSION
                ),
            ));
        }
        if event.job_id != self.job_id {
            return Err(CommandError::new(
                "protocol_job_mismatch",
                "Engine event không thuộc job hiện tại",
            ));
        }
        match self.last_seq {
            None if event.seq != 1 => {
                return Err(CommandError::new(
                    "protocol_invalid_seq",
                    "Engine phải bắt đầu seq từ 1",
                ));
            }
            Some(previous) if event.seq != previous.saturating_add(1) => {
                return Err(CommandError::new(
                    "protocol_invalid_seq",
                    format!(
                        "Seq không liên tục: nhận {}, mong đợi {}",
                        event.seq,
                        previous.saturating_add(1)
                    ),
                ));
            }
            _ => {}
        }
        if !matches!(
            event.event_type.as_str(),
            "started" | "progress" | "warning" | "result" | "error" | "completed" | "log"
        ) {
            return Err(CommandError::new(
                "protocol_invalid_type",
                format!("Engine event type không hỗ trợ: {}", event.event_type),
            ));
        }
        if event.step.is_empty()
            || event.step.len() > 64
            || event.timestamp.len() > 64
            || event.payload.values().any(|value| contains_nul(value, 0))
        {
            return Err(CommandError::new(
                "protocol_invalid_payload",
                "Engine event chứa dữ liệu không hợp lệ",
            ));
        }
        self.last_seq = Some(event.seq);
        Ok(event)
    }

    pub fn next_seq(&self) -> u64 {
        self.last_seq.map_or(1, |seq| seq.saturating_add(1))
    }
}

fn contains_nul(value: &serde_json::Value, depth: usize) -> bool {
    if depth > 32 {
        return true;
    }
    match value {
        serde_json::Value::String(text) => text.contains('\0'),
        serde_json::Value::Array(items) => items.iter().any(|item| contains_nul(item, depth + 1)),
        serde_json::Value::Object(map) => map
            .iter()
            .any(|(key, item)| key.contains('\0') || contains_nul(item, depth + 1)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(seq: u64, step: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "protocolVersion": 1,
            "jobId": "job-1",
            "seq": seq,
            "type": "progress",
            "step": step,
            "timestamp": "2026-08-10T00:00:00.000Z",
            "payload": {"processed": 1, "total": 2}
        }))
        .expect("json")
    }

    #[test]
    fn accepts_engine_envelope_and_preserves_step() {
        let mut validator = ProtocolValidator::new("job-1");
        let parsed = validator
            .parse_line(&event(1, "sync-preview"))
            .expect("valid");
        assert_eq!(parsed.step, "sync-preview");
        assert_eq!(parsed.seq, 1);
    }

    #[test]
    fn rejects_gap_wrong_job_and_unknown_type() {
        let mut validator = ProtocolValidator::new("job-1");
        validator.parse_line(&event(1, "export")).expect("first");
        assert_eq!(
            validator
                .parse_line(&event(3, "export"))
                .expect_err("gap")
                .code,
            "protocol_invalid_seq"
        );

        let mut other = ProtocolValidator::new("other");
        assert_eq!(
            other.parse_line(&event(1, "export")).expect_err("job").code,
            "protocol_job_mismatch"
        );
    }
}
