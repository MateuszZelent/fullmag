use anyhow::{Context, Result};
use std::fs;
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::process::Child;
use std::sync::{Arc, Mutex, OnceLock};

static TERMINAL_LOGGER: OnceLock<TerminalLogger> = OnceLock::new();

pub(crate) fn terminal_logger() -> &'static TerminalLogger {
    TERMINAL_LOGGER.get_or_init(TerminalLogger::new)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TerminalLogSource {
    Cli,
    Api,
    Web,
}

impl TerminalLogSource {
    fn label(self) -> &'static str {
        match self {
            Self::Cli => "CLI",
            Self::Api => "API",
            Self::Web => "WEB",
        }
    }

    fn ansi_color(self) -> &'static str {
        match self {
            Self::Cli => "\x1b[1;36m",
            Self::Api => "\x1b[1;34m",
            Self::Web => "\x1b[1;35m",
        }
    }

    fn strip_embedded_prefix<'a>(self, line: &'a str) -> &'a str {
        match self {
            Self::Cli => line.strip_prefix("[fullmag-cli] ").unwrap_or(line),
            Self::Api => line.strip_prefix("[fullmag-api] ").unwrap_or(line),
            Self::Web => line,
        }
    }
}

pub(crate) struct TerminalLogger {
    colors_enabled: bool,
}

impl TerminalLogger {
    fn new() -> Self {
        Self {
            colors_enabled: std::io::stderr().is_terminal(),
        }
    }

    pub(crate) fn emit(&self, source: TerminalLogSource, line: impl AsRef<str>) {
        print_terminal_line(self.colors_enabled, source, line.as_ref());
    }

    pub(crate) fn attach_child(
        &self,
        child: &mut Child,
        source: TerminalLogSource,
        log_file: fs::File,
    ) -> Result<()> {
        let stdout = child
            .stdout
            .take()
            .with_context(|| format!("{} stdout was not piped", source.label()))?;
        let stderr = child
            .stderr
            .take()
            .with_context(|| format!("{} stderr was not piped", source.label()))?;
        let log_file = Arc::new(Mutex::new(log_file));
        self.spawn_child_reader(stdout, source, Arc::clone(&log_file));
        self.spawn_child_reader(stderr, source, log_file);
        Ok(())
    }

    fn spawn_child_reader<R: Read + Send + 'static>(
        &self,
        reader: R,
        source: TerminalLogSource,
        log_file: Arc<Mutex<fs::File>>,
    ) {
        let colors_enabled = self.colors_enabled;
        std::thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf);
                        let line = line.trim_end_matches(['\r', '\n']);
                        if line.is_empty() {
                            continue;
                        }
                        write_child_log_file_line(&log_file, line);
                        if should_emit_child_terminal_line(source, line) {
                            print_terminal_line(colors_enabled, source, line);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
}

fn verbose_api_sync_terminal_logs() -> bool {
    std::env::var("FULLMAG_VERBOSE_API_SYNC_LOGS")
        .ok()
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn should_emit_child_terminal_line(source: TerminalLogSource, line: &str) -> bool {
    match source {
        TerminalLogSource::Api if !verbose_api_sync_terminal_logs() => {
            !(line.starts_with("[fullmag-api] sync -> live ")
                || line.starts_with("[fullmag-api] PERF: internal live "))
        }
        _ => true,
    }
}

fn write_child_log_file_line(file: &Arc<Mutex<fs::File>>, line: &str) {
    if let Ok(mut guard) = file.lock() {
        let _ = writeln!(guard, "{line}");
        let _ = guard.flush();
    }
}

fn print_terminal_line(colors_enabled: bool, source: TerminalLogSource, line: &str) {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return;
    }
    let content = source.strip_embedded_prefix(line);
    if colors_enabled {
        eprintln!(
            "{}{}{}\x1b[0m │ {}",
            source.ansi_color(),
            source.label(),
            "\x1b[0m",
            content
        );
    } else {
        eprintln!("{} │ {}", source.label(), content);
    }
}
