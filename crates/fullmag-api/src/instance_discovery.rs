//! Loopback discovery of the Fullmag instances on this host (ADR 0069).
//!
//! Every Control Room origin (one port) fronts exactly one API process and its
//! live session. Discovery asks each port of a bounded window for its session
//! list with one HTTP/1.0 request and keeps only answers that carry a Fullmag
//! API instance identity, so a frontend whose backend is down, or a foreign
//! service, is not reported as an instance.

use std::ops::RangeInclusive;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinSet;
use tokio::time::timeout;

use crate::schemas::instances::{DiscoveredInstance, InstanceSessionSummary};

/// The launcher's preferred frontend port and its 64-port rotation (ADR 0067).
pub(crate) const DEFAULT_FIRST_PORT: u16 = 3197;
pub(crate) const DEFAULT_LAST_PORT: u16 = 3260;
const MAX_WINDOW_PORTS: usize = 256;
const MAX_SESSIONS_PER_INSTANCE: usize = 64;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
const PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const PORTS_ENV: &str = "FULLMAG_INSTANCE_DISCOVERY_PORTS";
const HOST_ENV: &str = "FULLMAG_INSTANCE_DISCOVERY_HOST";
/// Docker Desktop routes this name to the host, where groups publish their ports.
const DOCKER_HOST_GATEWAY: &str = "host.docker.internal";
const LOOPBACK_HOST: &str = "127.0.0.1";
const INSTANCE_HEADER: &str = "x-fullmag-api-instance";
/// Viewers poll discovery; one probe pass serves every request in this window.
const DISCOVERY_CACHE_TTL: Duration = Duration::from_secs(2);

struct CachedDiscovery {
    at: Instant,
    window: RangeInclusive<u16>,
    instances: Vec<DiscoveredInstance>,
}

fn discovery_cache() -> &'static tokio::sync::Mutex<Option<CachedDiscovery>> {
    static CACHE: OnceLock<tokio::sync::Mutex<Option<CachedDiscovery>>> = OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// One instance's answer to the session-list probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeAnswer {
    pub api_instance_id: String,
    pub sessions: Vec<InstanceSessionSummary>,
}

#[derive(Deserialize)]
struct ProbedSessionList {
    sessions: Vec<InstanceSessionSummary>,
}

/// Parse `<first>-<last>`, an inclusive window of at most 256 ports.
pub(crate) fn parse_port_window(value: &str) -> Result<RangeInclusive<u16>, String> {
    let (first, last) = value
        .trim()
        .split_once('-')
        .ok_or_else(|| format!("{PORTS_ENV} must be <first>-<last>"))?;
    let first: u16 = first
        .trim()
        .parse()
        .map_err(|_| format!("{PORTS_ENV} has an invalid first port"))?;
    let last: u16 = last
        .trim()
        .parse()
        .map_err(|_| format!("{PORTS_ENV} has an invalid last port"))?;
    if first == 0 || last < first {
        return Err(format!(
            "{PORTS_ENV} must name an ascending window of nonzero ports"
        ));
    }
    if usize::from(last - first) + 1 > MAX_WINDOW_PORTS {
        return Err(format!(
            "{PORTS_ENV} may span at most {MAX_WINDOW_PORTS} ports"
        ));
    }
    Ok(first..=last)
}

pub(crate) fn configured_port_window() -> Result<RangeInclusive<u16>, String> {
    match std::env::var(PORTS_ENV) {
        Ok(value) => parse_port_window(&value),
        Err(std::env::VarError::NotPresent) => Ok(DEFAULT_FIRST_PORT..=DEFAULT_LAST_PORT),
        Err(error) => Err(format!("reading {PORTS_ENV} failed: {error}")),
    }
}

/// The configured host, else the Docker host gateway when it resolves, else loopback.
async fn discovery_host() -> String {
    if let Ok(host) = std::env::var(HOST_ENV) {
        let host = host.trim();
        if !host.is_empty() {
            return host.to_string();
        }
    }
    let lookup = timeout(
        CONNECT_TIMEOUT,
        tokio::net::lookup_host((DOCKER_HOST_GATEWAY, 0)),
    )
    .await;
    if let Ok(Ok(mut addresses)) = lookup {
        if addresses.next().is_some() {
            return DOCKER_HOST_GATEWAY.to_string();
        }
    }
    LOOPBACK_HOST.to_string()
}

/// Accept only a complete `200` answer with one Fullmag API instance identity
/// and a session list body. Chunked bodies are refused: an HTTP/1.0 request
/// never legitimately receives one.
pub(crate) fn parse_probe_response(response: &[u8]) -> Option<ProbeAnswer> {
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&response[..header_end]).ok()?;
    let body = &response[header_end + 4..];
    let mut lines = head.split("\r\n");
    let mut status_line = lines.next()?.split_whitespace();
    if !status_line.next()?.starts_with("HTTP/1.") || status_line.next()? != "200" {
        return None;
    }
    let mut api_instance_id: Option<&str> = None;
    for line in lines {
        let (name, value) = line.split_once(':')?;
        let (name, value) = (name.trim(), value.trim());
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return None;
        }
        if name.eq_ignore_ascii_case("content-length") && value.parse::<usize>().ok()? != body.len()
        {
            return None;
        }
        if name.eq_ignore_ascii_case(INSTANCE_HEADER) {
            if api_instance_id.is_some() {
                return None;
            }
            api_instance_id = Some(value);
        }
    }
    let api_instance_id = api_instance_id.filter(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })?;
    let list: ProbedSessionList = serde_json::from_slice(body).ok()?;
    if list.sessions.len() > MAX_SESSIONS_PER_INSTANCE {
        return None;
    }
    Some(ProbeAnswer {
        api_instance_id: api_instance_id.to_string(),
        sessions: list.sessions,
    })
}

async fn probe(host: &str, port: u16) -> Option<ProbeAnswer> {
    let attempt = async {
        let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
            .await
            .ok()?
            .ok()?;
        let request = format!(
            "GET /v2/sessions HTTP/1.0\r\nHost: {LOOPBACK_HOST}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut response = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                break;
            }
            if response.len() + read > MAX_RESPONSE_BYTES {
                return None;
            }
            response.extend_from_slice(&chunk[..read]);
        }
        parse_probe_response(&response)
    };
    timeout(PROBE_TIMEOUT, attempt).await.ok().flatten()
}

/// Mark the instance whose API process answered with `self_instance_id`.
pub(crate) fn discovered_instances(
    answers: Vec<(u16, ProbeAnswer)>,
    self_instance_id: &str,
) -> Vec<DiscoveredInstance> {
    let mut instances: Vec<DiscoveredInstance> = answers
        .into_iter()
        .map(|(port, answer)| DiscoveredInstance {
            port,
            is_self: answer.api_instance_id == self_instance_id,
            api_instance_id: answer.api_instance_id,
            sessions: answer.sessions,
        })
        .collect();
    instances.sort_by_key(|instance| instance.port);
    instances
}

/// Probe every port of the window concurrently.
pub(crate) async fn discover_instances(
    window: RangeInclusive<u16>,
    self_instance_id: &str,
) -> Vec<DiscoveredInstance> {
    let host = discovery_host().await;
    let mut probes = JoinSet::new();
    for port in window {
        let host = host.clone();
        probes.spawn(async move { (port, probe(&host, port).await) });
    }
    let mut answers = Vec::new();
    while let Some(joined) = probes.join_next().await {
        if let Ok((port, Some(answer))) = joined {
            answers.push((port, answer));
        }
    }
    discovered_instances(answers, self_instance_id)
}

/// Single-flight discovery: concurrent requests wait for one probe pass and
/// share a result younger than `DISCOVERY_CACHE_TTL`.
pub(crate) async fn discover_instances_cached(
    window: RangeInclusive<u16>,
    self_instance_id: &str,
) -> Vec<DiscoveredInstance> {
    let mut cache = discovery_cache().lock().await;
    if let Some(cached) = cache.as_ref() {
        if cached.window == window && cached.at.elapsed() < DISCOVERY_CACHE_TTL {
            return cached.instances.clone();
        }
    }
    let instances = discover_instances(window.clone(), self_instance_id).await;
    *cache = Some(CachedDiscovery {
        at: Instant::now(),
        window,
        instances: instances.clone(),
    });
    instances
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSIONS: &str = r#"{"schema_version":"2.0.0","sessions":[{"session_id":"session-1","name":"live","status":"awaiting_command","current":true}]}"#;

    fn response(status: &str, headers: &[(&str, &str)], body: &str) -> Vec<u8> {
        let mut text = format!("HTTP/1.1 {status}\r\n");
        for (name, value) in headers {
            text.push_str(&format!("{name}: {value}\r\n"));
        }
        text.push_str("\r\n");
        text.push_str(body);
        text.into_bytes()
    }

    #[test]
    fn port_window_accepts_an_ascending_bounded_range() {
        assert_eq!(parse_port_window("3197-3260"), Ok(3197..=3260));
        assert_eq!(parse_port_window(" 3200 - 3200 "), Ok(3200..=3200));
        assert!(parse_port_window("3260-3197").is_err());
        assert!(parse_port_window("0-10").is_err());
        assert!(parse_port_window("3197").is_err());
        assert!(parse_port_window("3000-3256").is_err());
        assert_eq!(parse_port_window("3000-3255"), Ok(3000..=3255));
    }

    #[test]
    fn probe_answer_requires_ok_status_instance_identity_and_session_list() {
        let length = SESSIONS.len().to_string();
        let answer = parse_probe_response(&response(
            "200 OK",
            &[
                ("content-length", length.as_str()),
                ("X-Fullmag-Api-Instance", "6457016d-058e"),
            ],
            SESSIONS,
        ))
        .expect("a Fullmag session list is an instance");
        assert_eq!(answer.api_instance_id, "6457016d-058e");
        assert_eq!(answer.sessions[0].session_id, "session-1");
        assert!(answer.sessions[0].current);

        assert!(parse_probe_response(&response(
            "500 Internal Server Error",
            &[(INSTANCE_HEADER, "a")],
            SESSIONS
        ))
        .is_none());
        assert!(parse_probe_response(&response("200 OK", &[], SESSIONS)).is_none());
        assert!(parse_probe_response(&response(
            "200 OK",
            &[(INSTANCE_HEADER, "a")],
            "<html></html>"
        ))
        .is_none());
    }

    #[test]
    fn probe_answer_rejects_ambiguous_or_truncated_responses() {
        let instance = (INSTANCE_HEADER, "abc");
        assert!(parse_probe_response(&response(
            "200 OK",
            &[instance, ("transfer-encoding", "chunked")],
            SESSIONS
        ))
        .is_none());
        assert!(parse_probe_response(&response(
            "200 OK",
            &[instance, ("content-length", "9999")],
            SESSIONS
        ))
        .is_none());
        assert!(
            parse_probe_response(&response("200 OK", &[instance, instance], SESSIONS)).is_none()
        );
        assert!(parse_probe_response(&response(
            "200 OK",
            &[(INSTANCE_HEADER, "not an id")],
            SESSIONS
        ))
        .is_none());
        assert!(parse_probe_response(b"HTTP/1.1 200 OK\r\nx-fullmag-api-instance: abc").is_none());
    }

    #[test]
    fn discovered_instances_are_ordered_by_port_and_mark_self() {
        let answer = |id: &str| ProbeAnswer {
            api_instance_id: id.to_string(),
            sessions: Vec::new(),
        };
        let instances =
            discovered_instances(vec![(3210, answer("other")), (3206, answer("me"))], "me");
        assert_eq!(
            instances
                .iter()
                .map(|instance| instance.port)
                .collect::<Vec<_>>(),
            vec![3206, 3210]
        );
        assert!(instances[0].is_self);
        assert!(!instances[1].is_self);
    }
}
