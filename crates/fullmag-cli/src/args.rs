use clap::{Parser, Subcommand, ValueEnum};
use fullmag_ir::{BackendTarget, ExecutionMode, ExecutionPrecision};
use serde::Serialize;
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "fullmag")]
#[command(
    about = "Rust-hosted Fullmag CLI for Python-authored ProblemIR validation, planning, and execution"
)]
#[command(
    override_usage = "fullmag <COMMAND>\n       fullmag [-i|--interactive] [--dev] <script.py> [--backend <auto|fdm|fem|hybrid>] [--mode <strict|extended|hybrid>] [--precision <single|double>] [--headless]"
)]
#[command(
    after_help = "Script mode examples:\n  fullmag examples/exchange_relax.py\n  fullmag --dev examples/exchange_relax.py\n  fullmag -i examples/exchange_relax.py\n\nBy default script.py writes one sibling script.zarr result bundle; --output-dir overrides that location.\nThe launcher gets the run horizon from the script itself.\nFor time evolution scripts define DEFAULT_UNTIL in the script.\nFor relaxation studies Fullmag derives the execution horizon from the study settings.\nDefault behavior serves the built control room from the embedded API unless --headless is passed.\nUse --dev to run the Next.js control room in dev mode.\nUse -i / --interactive to keep the session alive after the scripted stages finish so that more run/relax commands can be queued from the control room or API."
)]
pub(crate) struct Cli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Parser, Debug)]
pub(crate) struct ScriptCli {
    pub script: PathBuf,
    #[arg(short = 'i', long, default_value_t = false)]
    pub interactive: bool,
    #[arg(long, value_enum)]
    pub backend: Option<BackendArg>,
    #[arg(long, value_enum)]
    pub mode: Option<ModeArg>,
    #[arg(long, value_enum)]
    pub precision: Option<PrecisionArg>,
    #[arg(long)]
    pub output_dir: Option<PathBuf>,
    #[arg(long)]
    pub initial_magnetization_state: Option<PathBuf>,
    #[arg(long)]
    pub initial_magnetization_state_format: Option<String>,
    #[arg(long)]
    pub initial_magnetization_state_dataset: Option<String>,
    #[arg(long)]
    pub initial_magnetization_state_sample_index: Option<i64>,
    #[arg(long = "workspace-root", default_value = ".fullmag/local-live/history")]
    pub session_root: PathBuf,
    #[arg(long, default_value_t = false)]
    pub headless: bool,
    #[arg(long, default_value_t = false)]
    pub dev: bool,
    #[arg(long)]
    pub json: bool,
    #[arg(
        long,
        help = "Port for the dev control room frontend (auto-selects 3000-3010 if omitted)"
    )]
    pub web_port: Option<u16>,
}

#[derive(Subcommand)]
pub(crate) enum Command {
    Doctor,
    /// Launch desktop UI shell
    Ui(UiCli),
    #[command(subcommand)]
    Runtime(RuntimeCommand),
    ExampleIr,
    ReferenceExchangeDemo {
        #[arg(long, default_value_t = 10)]
        steps: usize,
        #[arg(long, default_value_t = 1e-13)]
        dt: f64,
    },
    ValidateJson {
        path: PathBuf,
    },
    PlanJson {
        path: PathBuf,
        #[arg(long)]
        backend: Option<BackendArg>,
    },
    RunJson {
        path: PathBuf,
        #[arg(long)]
        until: f64,
        #[arg(long, default_value = "run_output")]
        output_dir: PathBuf,
    },
    #[command(hide = true)]
    ResolveRuntimeInvocation {
        #[arg(long, default_value_t = false)]
        shell: bool,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        raw_args: Vec<OsString>,
    },
    /// Session persistence commands (save, open, inspect, recover, gc)
    #[command(subcommand)]
    Session(SessionSubcommand),
}

#[derive(Subcommand)]
pub(crate) enum SessionSubcommand {
    /// Export the current session store as a portable .fms file
    Save {
        /// Output path for the .fms file
        path: PathBuf,
        /// Save profile: compact, solved, resume, archive
        #[arg(long, value_enum, default_value = "resume")]
        profile: SaveProfileArg,
        /// Session name override
        #[arg(long)]
        name: Option<String>,
    },
    /// Import and restore a .fms file into the session store
    Open {
        /// Path to the .fms file
        path: PathBuf,
    },
    /// Inspect a .fms file without importing
    Inspect {
        /// Path to the .fms file
        path: PathBuf,
    },
    /// List and manage crash-recovery snapshots
    Recover {
        /// Clear all recovery snapshots instead of listing them
        #[arg(long, default_value_t = false)]
        clear: bool,
    },
    /// Run garbage collection on the session store
    Gc {
        /// Session store root (defaults to .fullmag/local-live/session-store)
        #[arg(long)]
        store: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum SaveProfileArg {
    Compact,
    Solved,
    Resume,
    Archive,
}

impl From<SaveProfileArg> for fullmag_session::SaveProfile {
    fn from(a: SaveProfileArg) -> Self {
        match a {
            SaveProfileArg::Compact => fullmag_session::SaveProfile::Compact,
            SaveProfileArg::Solved => fullmag_session::SaveProfile::Solved,
            SaveProfileArg::Resume => fullmag_session::SaveProfile::Resume,
            SaveProfileArg::Archive => fullmag_session::SaveProfile::Archive,
        }
    }
}

#[derive(Parser, Debug)]
pub(crate) struct UiCli {
    /// Optional script to open directly in workspace
    pub script: Option<PathBuf>,
    #[arg(long, value_enum)]
    pub backend: Option<BackendArg>,
    #[arg(long, value_enum)]
    pub mode: Option<ModeArg>,
    #[arg(long, value_enum)]
    pub precision: Option<PrecisionArg>,
    /// Use web dev server instead of static assets
    #[arg(long, default_value_t = false)]
    pub dev: bool,
    #[arg(
        long,
        help = "Port for the dev control room frontend (auto-selects 3000-3010 if omitted)"
    )]
    pub web_port: Option<u16>,
}

#[derive(Subcommand)]
pub(crate) enum RuntimeCommand {
    /// Diagnose installed runtime packs and host capabilities
    Doctor,
    /// Print native FEM CPU/GPU availability from the linked runtime
    FemAvailability {
        #[arg(long, default_value_t = false)]
        json: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BackendArg {
    Auto,
    Fdm,
    Fem,
    Hybrid,
}

#[derive(Debug, Clone, Copy, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ModeArg {
    Strict,
    Extended,
    Hybrid,
}

#[derive(Debug, Clone, Copy, Serialize, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PrecisionArg {
    Single,
    Double,
}

impl From<BackendArg> for BackendTarget {
    fn from(value: BackendArg) -> Self {
        match value {
            BackendArg::Auto => BackendTarget::Auto,
            BackendArg::Fdm => BackendTarget::Fdm,
            BackendArg::Fem => BackendTarget::Fem,
            BackendArg::Hybrid => BackendTarget::Hybrid,
        }
    }
}

impl From<ModeArg> for ExecutionMode {
    fn from(value: ModeArg) -> Self {
        match value {
            ModeArg::Strict => ExecutionMode::Strict,
            ModeArg::Extended => ExecutionMode::Extended,
            ModeArg::Hybrid => ExecutionMode::Hybrid,
        }
    }
}

impl From<PrecisionArg> for ExecutionPrecision {
    fn from(value: PrecisionArg) -> Self {
        match value {
            PrecisionArg::Single => ExecutionPrecision::Single,
            PrecisionArg::Double => ExecutionPrecision::Double,
        }
    }
}

pub(crate) fn backend_target_name(value: BackendTarget) -> &'static str {
    match value {
        BackendTarget::Auto => "auto",
        BackendTarget::Fdm => "fdm",
        BackendTarget::Fem => "fem",
        BackendTarget::Hybrid => "hybrid",
    }
}

pub(crate) fn execution_mode_name(value: ExecutionMode) -> &'static str {
    match value {
        ExecutionMode::Strict => "strict",
        ExecutionMode::Extended => "extended",
        ExecutionMode::Hybrid => "hybrid",
    }
}

pub(crate) fn execution_precision_name(value: ExecutionPrecision) -> &'static str {
    match value {
        ExecutionPrecision::Single => "single",
        ExecutionPrecision::Double => "double",
    }
}
