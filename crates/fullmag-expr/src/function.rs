//! Compilation and evaluation of one mask or time function.

use std::collections::BTreeMap;

use crate::bytecode::{compile_time_program, TimeProgram};
use crate::parser::{is_reserved_name, parse_equation, BinaryOp, Node, Scope};
use crate::{ExprError, FunctionError, FunctionKind, FunctionSource};

/// Limits of one function (`docs/specs/mask-function-v1.md`, section 3).
pub const MAX_FUNCTION_PARAMETERS: usize = 64;
pub const MAX_FUNCTION_LOCALS: usize = 64;

/// A validated function: parameters folded into numbers, locals and outputs parsed.
#[derive(Debug, Clone)]
pub struct CompiledFunction {
    kind: FunctionKind,
    locals: Vec<Node>,
    outputs: Vec<Node>,
    /// `true` at index `i` when local `i` depends on a variable.
    local_is_variable: Vec<bool>,
    time_program: Option<TimeProgram>,
}

fn function_error(path: String, error: ExprError) -> FunctionError {
    FunctionError {
        code: error.code,
        path,
        position: error.position,
        message: error.message,
    }
}

fn is_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    matches!(characters.next(), Some(first) if first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

/// Check a parameter or local name in isolation (syntax and reserved names).
pub fn validate_name(name: &str) -> Result<(), ExprError> {
    if !is_identifier(name) {
        return Err(ExprError::new(
            "expr_name_invalid",
            0,
            format!("'{name}' is not a valid name"),
        ));
    }
    if is_reserved_name(name) {
        return Err(ExprError::new(
            "expr_name_invalid",
            0,
            format!("'{name}' is reserved"),
        ));
    }
    Ok(())
}

pub fn compile_function(
    source: &FunctionSource<'_>,
    kind: FunctionKind,
) -> Result<CompiledFunction, FunctionError> {
    if source.parameters.len() > MAX_FUNCTION_PARAMETERS {
        return Err(FunctionError {
            code: "expr_too_large",
            path: "parameters".to_string(),
            position: 0,
            message: format!("more than {MAX_FUNCTION_PARAMETERS} parameters"),
        });
    }
    if source.locals.len() > MAX_FUNCTION_LOCALS {
        return Err(FunctionError {
            code: "expr_too_large",
            path: "locals".to_string(),
            position: 0,
            message: format!("more than {MAX_FUNCTION_LOCALS} locals"),
        });
    }
    let expected_outputs = match kind {
        FunctionKind::Mask => 3,
        FunctionKind::Time => 1,
    };
    if source.outputs.len() != expected_outputs {
        return Err(FunctionError {
            code: "expr_arity",
            path: "outputs".to_string(),
            position: 0,
            message: format!(
                "expected {expected_outputs} output(s), got {}",
                source.outputs.len()
            ),
        });
    }

    let mut parameters: BTreeMap<&str, f64> = BTreeMap::new();
    for (index, (name, value)) in source.parameters.iter().enumerate() {
        let path = format!("parameters[{index}]");
        validate_name(name).map_err(|error| function_error(path.clone(), error))?;
        if parameters.insert(name.as_str(), *value).is_some() {
            return Err(FunctionError {
                code: "expr_name_invalid",
                path,
                position: 0,
                message: format!("parameter '{name}' is defined twice"),
            });
        }
    }

    let mut local_indices: BTreeMap<&str, usize> = BTreeMap::new();
    let mut locals = Vec::with_capacity(source.locals.len());
    for (index, (name, expression)) in source.locals.iter().enumerate() {
        let path = format!("locals[{index}]");
        validate_name(name).map_err(|error| function_error(path.clone(), error))?;
        if parameters.contains_key(name.as_str()) || local_indices.contains_key(name.as_str()) {
            return Err(FunctionError {
                code: "expr_name_invalid",
                path,
                position: 0,
                message: format!("name '{name}' is defined twice"),
            });
        }
        let scope = Scope {
            kind,
            parameters: &parameters,
            locals: &local_indices,
        };
        let node =
            parse_equation(expression, &scope).map_err(|error| function_error(path, error))?;
        locals.push(node);
        local_indices.insert(name.as_str(), index);
    }

    let mut outputs = Vec::with_capacity(source.outputs.len());
    for (index, expression) in source.outputs.iter().enumerate() {
        let scope = Scope {
            kind,
            parameters: &parameters,
            locals: &local_indices,
        };
        let node = parse_equation(expression, &scope)
            .map_err(|error| function_error(format!("outputs[{index}]"), error))?;
        outputs.push(node);
    }

    let mut local_is_variable = Vec::with_capacity(locals.len());
    for node in &locals {
        let variable = depends_on_variable(node, &local_is_variable);
        local_is_variable.push(variable);
    }

    let mut function = CompiledFunction {
        kind,
        locals,
        outputs,
        local_is_variable,
        time_program: None,
    };
    if kind == FunctionKind::Time {
        let program = compile_time_program(&function)
            .map_err(|error| function_error("outputs[0]".to_string(), error))?;
        function.time_program = Some(program);
    }
    Ok(function)
}

/// `true` when the tree reads `x`, `y`, `z` or `t`, directly or through a local.
pub(crate) fn depends_on_variable(node: &Node, local_is_variable: &[bool]) -> bool {
    match node {
        Node::Number(_) => false,
        Node::Variable(_) => true,
        Node::Local(index) => local_is_variable[*index],
        Node::Negate(operand) | Node::Call1(_, operand) => {
            depends_on_variable(operand, local_is_variable)
        }
        Node::Binary(_, left, right) | Node::Call2(_, left, right) => {
            depends_on_variable(left, local_is_variable)
                || depends_on_variable(right, local_is_variable)
        }
    }
}

pub(crate) fn evaluate(node: &Node, variables: &[f64; 4], locals: &[f64]) -> f64 {
    match node {
        Node::Number(value) => *value,
        Node::Variable(variable) => variables[variable.index()],
        Node::Local(index) => locals[*index],
        Node::Negate(operand) => -evaluate(operand, variables, locals),
        Node::Binary(op, left, right) => op.apply(
            evaluate(left, variables, locals),
            evaluate(right, variables, locals),
        ),
        Node::Call1(function, operand) => function.apply(evaluate(operand, variables, locals)),
        Node::Call2(function, left, right) => function.apply(
            evaluate(left, variables, locals),
            evaluate(right, variables, locals),
        ),
    }
}

fn format_number(value: f64) -> String {
    format!("{value:?}")
}

impl CompiledFunction {
    pub fn kind(&self) -> FunctionKind {
        self.kind
    }

    pub(crate) fn locals(&self) -> &[Node] {
        &self.locals
    }

    pub(crate) fn outputs(&self) -> &[Node] {
        &self.outputs
    }

    pub(crate) fn local_is_variable(&self) -> &[bool] {
        &self.local_is_variable
    }

    fn evaluate_locals(&self, variables: &[f64; 4]) -> Vec<f64> {
        let mut values = Vec::with_capacity(self.locals.len());
        for node in &self.locals {
            let value = evaluate(node, variables, &values);
            values.push(value);
        }
        values
    }

    /// Value of a mask function at a point (metres). Panics for a time function.
    pub fn eval_mask(&self, point_m: [f64; 3]) -> [f64; 3] {
        assert!(
            self.kind == FunctionKind::Mask,
            "eval_mask called on a time function"
        );
        let variables = [point_m[0], point_m[1], point_m[2], 0.0];
        let locals = self.evaluate_locals(&variables);
        [
            evaluate(&self.outputs[0], &variables, &locals),
            evaluate(&self.outputs[1], &variables, &locals),
            evaluate(&self.outputs[2], &variables, &locals),
        ]
    }

    /// Value of a time function at a time (seconds). Panics for a mask function.
    pub fn eval_time(&self, t_s: f64) -> f64 {
        assert!(
            self.kind == FunctionKind::Time,
            "eval_time called on a mask function"
        );
        let variables = [0.0, 0.0, 0.0, t_s];
        let locals = self.evaluate_locals(&variables);
        evaluate(&self.outputs[0], &variables, &locals)
    }

    /// `false` when every output is a constant (for example the static term `1`).
    pub fn depends_on_variables(&self) -> bool {
        self.outputs
            .iter()
            .any(|output| depends_on_variable(output, &self.local_is_variable))
    }

    /// Outputs with locals substituted, fully parenthesized. Two functions with
    /// equal canonical outputs compute the same values.
    pub fn canonical_outputs(&self) -> Vec<String> {
        self.outputs
            .iter()
            .map(|output| self.canonical(output))
            .collect()
    }

    fn canonical(&self, node: &Node) -> String {
        match node {
            Node::Number(value) => format_number(*value),
            Node::Variable(variable) => variable.name().to_string(),
            Node::Local(index) => self.canonical(&self.locals[*index]),
            Node::Negate(operand) => format!("(-{})", self.canonical(operand)),
            Node::Binary(op, left, right) => {
                let symbol = match op {
                    BinaryOp::Pow => "^".to_string(),
                    other => format!(" {} ", other.symbol()),
                };
                format!(
                    "({}{symbol}{})",
                    self.canonical(left),
                    self.canonical(right)
                )
            }
            Node::Call1(function, operand) => {
                format!("{}({})", function.name(), self.canonical(operand))
            }
            Node::Call2(function, left, right) => format!(
                "{}({}, {})",
                function.name(),
                self.canonical(left),
                self.canonical(right)
            ),
        }
    }

    /// Bytecode of a time function. Panics for a mask function.
    pub fn time_program(&self) -> &TimeProgram {
        self.time_program
            .as_ref()
            .expect("time_program called on a mask function")
    }
}
