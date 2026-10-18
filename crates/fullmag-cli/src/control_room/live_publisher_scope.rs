use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub(crate) const HEADER_NAME: &str = "x-fullmag-session-scope";
pub(crate) const ATTACHED_SCOPE_ENV: &str = "FULLMAG_ATTACHED_SESSION_SCOPE";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ExpectedSessionScope {
    pub(crate) session_id: String,
    pub(crate) session_epoch: String,
    pub(crate) request_scope_epoch: String,
}
impl ExpectedSessionScope {
    pub(crate) fn validate(&self, session_id: &str) -> Result<()> {
        let prefix = format!("{session_id}@");
        let incarnation = self.request_scope_epoch.rsplit_once(':');
        if self.session_id != session_id || !self.session_epoch.starts_with(&prefix)
            || self.session_epoch.len() == prefix.len()
            || !incarnation.is_some_and(|(instance, epoch)| !instance.is_empty()
                && epoch.parse::<u64>().is_ok_and(|epoch| epoch != 0))
        { bail!("publisher session scope is incomplete or belongs to another session"); }
        Ok(())
    }
    fn header(&self) -> String {
        format!("session={}&epoch={}&request_scope_epoch={}",
            encode_uri_component(&self.session_id), encode_uri_component(&self.session_epoch),
            encode_uri_component(&self.request_scope_epoch))
    }
}
#[derive(Deserialize)]
struct PublicationAcknowledgement { session_scope: ExpectedSessionScope, revision: u64 }
pub(crate) struct LivePublisherScope {
    binding: Mutex<std::result::Result<Option<ExpectedSessionScope>, String>>,
}
impl LivePublisherScope {
    pub(crate) fn new(session_id: &str) -> Self {
        let binding = if std::env::var("FULLMAG_ATTACHED_SESSION_ID").ok().as_deref() == Some(session_id) {
            std::env::var(ATTACHED_SCOPE_ENV).map_err(|error| error.to_string())
                .and_then(|value| parse_expected_session_scope(&value).map_err(str::to_string))
                .and_then(|scope| scope.validate(session_id).map(|()| Some(scope))
                    .map_err(|error| error.to_string()))
        } else { Ok(None) };
        Self { binding: Mutex::new(binding) }
    }
    pub(crate) fn is_bound(&self) -> Result<bool> {
        let binding = self.binding.lock().map_err(|_| anyhow!("publisher scope lock poisoned"))?;
        binding.as_ref().map(|scope| scope.is_some()).map_err(|error| anyhow!(error.clone()))
    }
    pub(crate) fn send(&self, session_id: &str, mut request: reqwest::blocking::RequestBuilder) -> Result<()> {
        let mut binding = self.binding.lock().map_err(|_| anyhow!("publisher scope lock poisoned"))?;
        let previous = binding.as_ref().map_err(|error| anyhow!(error.clone()))?.clone();
        if let Some(scope) = previous.as_ref() {
            scope.validate(session_id)?;
            request = request.header(HEADER_NAME, scope.header());
        }
        let response = request.send().context("failed to publish current live frame")?
            .error_for_status().context("current live frame rejected its publisher scope")?;
        let accepted = response.json::<PublicationAcknowledgement>()
            .context("API does not acknowledge publisher session scope")
            .and_then(|ack| {
                ack.session_scope.validate(session_id)?;
                if ack.revision == 0 || previous.as_ref().is_some_and(|scope|
                    scope.request_scope_epoch != ack.session_scope.request_scope_epoch)
                { bail!("publisher acknowledgement changed API/session incarnation"); }
                Ok(ack.session_scope)
            });
        match accepted {
            Ok(scope) => { *binding = Ok(Some(scope)); Ok(()) }
            Err(error) => { *binding = Err(error.to_string()); Err(error) }
        }
    }
}

pub(crate) fn parse_expected_session_scope(
    value: &str,
) -> Result<ExpectedSessionScope, &'static str> {
    let mut parts = value.split('&');
    let session_part = parts.next().ok_or("missing session component")?;
    let epoch_part = parts.next().ok_or("missing epoch component")?;
    let request_scope_epoch_part = parts
        .next()
        .ok_or("missing request scope epoch component")?;
    if parts.next().is_some() {
        return Err("unexpected session scope component");
    }

    let session_value = session_part
        .strip_prefix("session=")
        .ok_or("session component must start with session=")?;
    let epoch_value = epoch_part
        .strip_prefix("epoch=")
        .ok_or("epoch component must start with epoch=")?;
    let request_scope_epoch_value = request_scope_epoch_part
        .strip_prefix("request_scope_epoch=")
        .ok_or("request scope epoch component must start with request_scope_epoch=")?;
    let session_id = decode_canonical_component(session_value).ok_or("invalid session value")?;
    let session_epoch = decode_canonical_component(epoch_value).ok_or("invalid epoch value")?;
    let request_scope_epoch = decode_canonical_component(request_scope_epoch_value)
        .ok_or("invalid request scope epoch value")?;

    Ok(ExpectedSessionScope {
        session_id,
        session_epoch,
        request_scope_epoch,
    })
}

fn decode_canonical_component(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            if !(0x21..=0x7e).contains(&byte) {
                return None;
            }
            decoded.push(byte);
            index += 1;
        }
    }

    let decoded = String::from_utf8(decoded).ok()?;
    (encode_uri_component(&decoded) == value).then_some(decoded)
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if is_uri_component_unescaped(*byte) {
            encoded.push(*byte as char);
        } else {
            encoded.push('%');
            encoded.push(hex_digit(byte >> 4));
            encoded.push(hex_digit(byte & 0x0f));
        }
    }
    encoded
}

fn is_uri_component_unescaped(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        )
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        10..=15 => (b'A' + value - 10) as char,
        _ => unreachable!("hex digit is limited to four bits"),
    }
}
