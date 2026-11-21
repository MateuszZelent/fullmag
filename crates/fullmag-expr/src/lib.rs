//! Equation language `field_expr.v1` of mask and time functions, of the
//! profile and distance formulas of an absorbing boundary layer and of
//! material parameter fields.
//!
//! Contract: `docs/specs/mask-function-v1.md`. The crate parses and evaluates
//! functions (`parameters -> locals -> outputs`) and compiles time functions to
//! the bytecode `fullmag_time_expr.v1`. It depends on `std` only.

mod bytecode;
mod function;
mod lexer;
mod parser;

pub use bytecode::{
    eval_time_program, TimeProgram, MAX_TIME_PROGRAM_STACK, MAX_TIME_PROGRAM_WORDS,
    TIME_PROGRAM_VERSION,
};
pub use function::{
    compile_function, validate_name, CompiledFunction, MAX_FUNCTION_LOCALS, MAX_FUNCTION_PARAMETERS,
};

/// Version string stored next to equations in `ProblemIR`.
pub const FIELD_EXPR_VERSION: &str = "field_expr.v1";
/// Largest number of terms of one mask field drive, and of time-dependent mask
/// terms active in one stage.
pub const MAX_MASK_TERMS: usize = 8;

/// Which leading variables a function may read, and which functions it may call
/// (`docs/specs/mask-function-v1.md`, section 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FunctionKind {
    /// `(x, y, z) -> (Bx, By, Bz)`; three outputs.
    Mask,
    /// `t -> number`; one output.
    Time,
    /// `u -> number`; one dimensionless output. The ramp profile of an
    /// absorbing boundary layer (section 8).
    Profile,
    /// `(x, y, z) -> number`; one output in metres. The distance coordinate of
    /// an absorbing boundary layer (section 8).
    Distance,
    /// `(x, y, z) -> number`; one output in the SI unit of a material
    /// parameter. A material parameter field `fm.fields.function` (section 9);
    /// the functions of a mask.
    Field,
}

impl FunctionKind {
    /// Word used in error messages: "a time function may not use 'x'".
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Mask => "mask",
            Self::Time => "time",
            Self::Profile => "profile",
            Self::Distance => "distance",
            Self::Field => "field",
        }
    }

    /// Number of outputs a function of this kind returns.
    pub(crate) fn output_count(self) -> usize {
        match self {
            Self::Mask => 3,
            Self::Time | Self::Profile | Self::Distance | Self::Field => 1,
        }
    }
}

/// A function as stored in `ProblemIR` (`FunctionIR`).
#[derive(Debug, Clone, Copy)]
pub struct FunctionSource<'a> {
    pub parameters: &'a [(String, f64)],
    /// In definition order; a local may use parameters and earlier locals.
    pub locals: &'a [(String, String)],
    pub outputs: &'a [String],
}

/// An error inside one equation.
#[derive(Debug, Clone, PartialEq)]
pub struct ExprError {
    pub code: &'static str,
    /// Zero-based byte offset inside the equation text.
    pub position: usize,
    pub message: String,
}

impl ExprError {
    pub(crate) fn new(code: &'static str, position: usize, message: impl Into<String>) -> Self {
        Self {
            code,
            position,
            message: message.into(),
        }
    }
}

/// An error of a function, with the path of the offending part:
/// `parameters`, `parameters[i]`, `locals`, `locals[i]`, `outputs` or `outputs[c]`.
#[derive(Debug, Clone, PartialEq)]
pub struct FunctionError {
    pub code: &'static str,
    pub path: String,
    pub position: usize,
    pub message: String,
}

impl std::fmt::Display for FunctionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}: {} @{}: {}",
            self.code, self.path, self.position, self.message
        )
    }
}

impl std::error::Error for FunctionError {}
