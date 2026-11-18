//! Time bytecode `fullmag_time_expr.v1`.
//!
//! A program is a flat array of binary64 words: an opcode, or the literal that
//! follows `PUSH`. The same table is implemented for host C code in
//! `native/include/fullmag_time_expression.h`.

use crate::function::{depends_on_variable, evaluate, CompiledFunction};
use crate::parser::{BinaryOp, Func1, Func2, Node, Variable};
use crate::ExprError;

/// Version of the opcode table; must equal `FULLMAG_TIME_EXPRESSION_VERSION`.
pub const TIME_PROGRAM_VERSION: u32 = 1;
/// Largest value stack a program may need.
pub const MAX_TIME_PROGRAM_STACK: usize = 64;
/// Largest program, in words.
pub const MAX_TIME_PROGRAM_WORDS: usize = 65_536;

pub const OP_RETURN: u32 = 0;
pub const OP_PUSH: u32 = 1;
pub const OP_LOAD_T: u32 = 2;
pub const OP_ADD: u32 = 3;
pub const OP_SUB: u32 = 4;
pub const OP_MUL: u32 = 5;
pub const OP_DIV: u32 = 6;
pub const OP_POW: u32 = 7;
pub const OP_NEG: u32 = 8;
pub const OP_SIN: u32 = 9;
pub const OP_COS: u32 = 10;
pub const OP_TAN: u32 = 11;
pub const OP_ASIN: u32 = 12;
pub const OP_ACOS: u32 = 13;
pub const OP_ATAN: u32 = 14;
pub const OP_ATAN2: u32 = 15;
pub const OP_SINH: u32 = 16;
pub const OP_COSH: u32 = 17;
pub const OP_TANH: u32 = 18;
pub const OP_EXP: u32 = 19;
pub const OP_LOG: u32 = 20;
pub const OP_SQRT: u32 = 21;
pub const OP_ABS: u32 = 22;
pub const OP_MIN: u32 = 23;
pub const OP_MAX: u32 = 24;

#[derive(Debug, Clone, PartialEq)]
pub struct TimeProgram {
    pub code: Vec<f64>,
    pub max_stack: u32,
}

fn binary_opcode(op: BinaryOp) -> u32 {
    match op {
        BinaryOp::Add => OP_ADD,
        BinaryOp::Sub => OP_SUB,
        BinaryOp::Mul => OP_MUL,
        BinaryOp::Div => OP_DIV,
        BinaryOp::Pow => OP_POW,
    }
}

fn func1_opcode(function: Func1) -> u32 {
    match function {
        Func1::Sin => OP_SIN,
        Func1::Cos => OP_COS,
        Func1::Tan => OP_TAN,
        Func1::Asin => OP_ASIN,
        Func1::Acos => OP_ACOS,
        Func1::Atan => OP_ATAN,
        Func1::Sinh => OP_SINH,
        Func1::Cosh => OP_COSH,
        Func1::Tanh => OP_TANH,
        Func1::Exp => OP_EXP,
        Func1::Log => OP_LOG,
        Func1::Sqrt => OP_SQRT,
        Func1::Abs => OP_ABS,
    }
}

fn func2_opcode(function: Func2) -> u32 {
    match function {
        Func2::Atan2 => OP_ATAN2,
        Func2::Min => OP_MIN,
        Func2::Max => OP_MAX,
    }
}

struct Emitter<'a> {
    function: &'a CompiledFunction,
    /// Values of the locals that do not depend on `t`; NaN for the others.
    constant_locals: Vec<f64>,
    code: Vec<f64>,
    depth: usize,
    max_depth: usize,
}

impl Emitter<'_> {
    fn push_depth(&mut self) {
        self.depth += 1;
        self.max_depth = self.max_depth.max(self.depth);
    }

    fn emit(&mut self, node: &Node) -> Result<(), ExprError> {
        if self.code.len() > MAX_TIME_PROGRAM_WORDS {
            return Err(ExprError::new(
                "expr_too_large",
                0,
                format!("time program has more than {MAX_TIME_PROGRAM_WORDS} words"),
            ));
        }
        // A subtree without `t` becomes one literal, evaluated in tree order.
        if !depends_on_variable(node, self.function.local_is_variable()) {
            let value = evaluate(node, &[0.0; 4], &self.constant_locals);
            self.code.push(f64::from(OP_PUSH));
            self.code.push(value);
            self.push_depth();
            return Ok(());
        }
        match node {
            Node::Number(_) => unreachable!("numbers are constant"),
            Node::Variable(variable) => {
                debug_assert!(*variable == Variable::T);
                self.code.push(f64::from(OP_LOAD_T));
                self.push_depth();
            }
            Node::Local(index) => {
                let local = &self.function.locals()[*index];
                self.emit(local)?;
            }
            Node::Negate(operand) => {
                self.emit(operand)?;
                self.code.push(f64::from(OP_NEG));
            }
            Node::Binary(op, left, right) => {
                self.emit(left)?;
                self.emit(right)?;
                self.code.push(f64::from(binary_opcode(*op)));
                self.depth -= 1;
            }
            Node::Call1(function, operand) => {
                self.emit(operand)?;
                self.code.push(f64::from(func1_opcode(*function)));
            }
            Node::Call2(function, left, right) => {
                self.emit(left)?;
                self.emit(right)?;
                self.code.push(f64::from(func2_opcode(*function)));
                self.depth -= 1;
            }
        }
        Ok(())
    }
}

/// Compile the single output of a time function. Locals are inlined.
pub(crate) fn compile_time_program(function: &CompiledFunction) -> Result<TimeProgram, ExprError> {
    let mut constant_locals = Vec::with_capacity(function.locals().len());
    for (index, node) in function.locals().iter().enumerate() {
        let value = if function.local_is_variable()[index] {
            f64::NAN
        } else {
            evaluate(node, &[0.0; 4], &constant_locals)
        };
        constant_locals.push(value);
    }
    let mut emitter = Emitter {
        function,
        constant_locals,
        code: Vec::new(),
        depth: 0,
        max_depth: 0,
    };
    emitter.emit(&function.outputs()[0])?;
    emitter.code.push(f64::from(OP_RETURN));
    if emitter.code.len() > MAX_TIME_PROGRAM_WORDS {
        return Err(ExprError::new(
            "expr_too_large",
            0,
            format!("time program has more than {MAX_TIME_PROGRAM_WORDS} words"),
        ));
    }
    if emitter.max_depth > MAX_TIME_PROGRAM_STACK {
        return Err(ExprError::new(
            "expr_too_large",
            0,
            format!("time program needs a stack deeper than {MAX_TIME_PROGRAM_STACK}"),
        ));
    }
    Ok(TimeProgram {
        code: emitter.code,
        max_stack: emitter.max_depth as u32,
    })
}

/// Run a program at time `t_s`. A malformed program evaluates to NaN.
pub fn eval_time_program(code: &[f64], t_s: f64) -> f64 {
    let mut stack = [0.0_f64; MAX_TIME_PROGRAM_STACK];
    let mut depth = 0_usize;
    let mut cursor = 0_usize;
    while cursor < code.len() {
        let word = code[cursor];
        cursor += 1;
        if !(0.0..=f64::from(OP_MAX)).contains(&word) || word.fract() != 0.0 {
            return f64::NAN;
        }
        let opcode = word as u32;
        match opcode {
            OP_RETURN => {
                return if depth == 1 && cursor == code.len() {
                    stack[0]
                } else {
                    f64::NAN
                };
            }
            OP_PUSH | OP_LOAD_T => {
                if depth == MAX_TIME_PROGRAM_STACK {
                    return f64::NAN;
                }
                stack[depth] = if opcode == OP_PUSH {
                    if cursor == code.len() {
                        return f64::NAN;
                    }
                    cursor += 1;
                    code[cursor - 1]
                } else {
                    t_s
                };
                depth += 1;
            }
            OP_ADD | OP_SUB | OP_MUL | OP_DIV | OP_POW | OP_ATAN2 | OP_MIN | OP_MAX => {
                if depth < 2 {
                    return f64::NAN;
                }
                let right = stack[depth - 1];
                let left = stack[depth - 2];
                depth -= 1;
                stack[depth - 1] = match opcode {
                    OP_ADD => left + right,
                    OP_SUB => left - right,
                    OP_MUL => left * right,
                    OP_DIV => left / right,
                    OP_POW => left.powf(right),
                    OP_ATAN2 => left.atan2(right),
                    OP_MIN => left.min(right),
                    _ => left.max(right),
                };
            }
            _ => {
                if depth < 1 {
                    return f64::NAN;
                }
                let value = stack[depth - 1];
                stack[depth - 1] = match opcode {
                    OP_NEG => -value,
                    OP_SIN => value.sin(),
                    OP_COS => value.cos(),
                    OP_TAN => value.tan(),
                    OP_ASIN => value.asin(),
                    OP_ACOS => value.acos(),
                    OP_ATAN => value.atan(),
                    OP_SINH => value.sinh(),
                    OP_COSH => value.cosh(),
                    OP_TANH => value.tanh(),
                    OP_EXP => value.exp(),
                    OP_LOG => value.ln(),
                    OP_SQRT => value.sqrt(),
                    _ => value.abs(),
                };
            }
        }
    }
    f64::NAN
}
