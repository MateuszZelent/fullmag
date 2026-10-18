//! Private launch binding for the owner-controlled development handoff.
//!
//! The browser build and restart request transport was removed. The owner
//! coordinator still needs to know whether the launcher supplied the exact
//! restart binding before it can accept a private candidate handoff.

#[derive(Clone, Debug, Default)]
pub(crate) struct DevelopmentRestartTransportConfig {
    ui_origin: Option<String>,
}

impl DevelopmentRestartTransportConfig {
    pub(crate) fn is_configured(&self) -> bool {
        self.ui_origin.is_some()
    }

    pub(crate) fn from_environment() -> Self {
        if std::env::var("FULLMAG_DEVELOPMENT_RESTART_COORDINATOR").as_deref() != Ok("1") {
            return Self::default();
        }
        let token = std::env::var("FULLMAG_DEVELOPMENT_OWNER_TOKEN").unwrap_or_default();
        if !hex(&token, 32) {
            return Self::default();
        }
        let origin = std::env::var("FULLMAG_DEVELOPMENT_RESTART_UI_ORIGIN").unwrap_or_default();
        let Some(port) = origin
            .strip_prefix("http://localhost:")
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port != 0)
        else {
            return Self::default();
        };
        if origin != format!("http://localhost:{port}") {
            return Self::default();
        }
        Self {
            ui_origin: Some(origin),
        }
    }
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
