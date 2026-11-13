//! Recursive-descent parser of `field_expr.v1`.

use std::collections::BTreeMap;

use crate::lexer::{tokenize, Token, TokenKind};
use crate::{ExprError, FunctionKind};

/// Limits of one equation (`docs/specs/mask-function-v1.md`, section 3).
pub(crate) const MAX_EQUATION_CHARACTERS: usize = 4096;
pub(crate) const MAX_EQUATION_NODES: usize = 512;
const MAX_NESTING_DEPTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Variable {
    X,
    Y,
    Z,
    T,
}

impl Variable {
    pub(crate) fn index(self) -> usize {
        match self {
            Self::X => 0,
            Self::Y => 1,
            Self::Z => 2,
            Self::T => 3,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::X => "x",
            Self::Y => "y",
            Self::Z => "z",
            Self::T => "t",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BinaryOp {
    Add,
    Sub,
    Mul,
    Div,
    Pow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Func1 {
    Sin,
    Cos,
    Tan,
    Asin,
    Acos,
    Atan,
    Sinh,
    Cosh,
    Tanh,
    Exp,
    Log,
    Sqrt,
    Abs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Func2 {
    Atan2,
    Min,
    Max,
}

impl Func1 {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Sin => "sin",
            Self::Cos => "cos",
            Self::Tan => "tan",
            Self::Asin => "asin",
            Self::Acos => "acos",
            Self::Atan => "atan",
            Self::Sinh => "sinh",
            Self::Cosh => "cosh",
            Self::Tanh => "tanh",
            Self::Exp => "exp",
            Self::Log => "log",
            Self::Sqrt => "sqrt",
            Self::Abs => "abs",
        }
    }

    pub(crate) fn apply(self, value: f64) -> f64 {
        match self {
            Self::Sin => value.sin(),
            Self::Cos => value.cos(),
            Self::Tan => value.tan(),
            Self::Asin => value.asin(),
            Self::Acos => value.acos(),
            Self::Atan => value.atan(),
            Self::Sinh => value.sinh(),
            Self::Cosh => value.cosh(),
            Self::Tanh => value.tanh(),
            Self::Exp => value.exp(),
            Self::Log => value.ln(),
            Self::Sqrt => value.sqrt(),
            Self::Abs => value.abs(),
        }
    }
}

impl Func2 {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Atan2 => "atan2",
            Self::Min => "min",
            Self::Max => "max",
        }
    }

    pub(crate) fn apply(self, left: f64, right: f64) -> f64 {
        match self {
            Self::Atan2 => left.atan2(right),
            Self::Min => left.min(right),
            Self::Max => left.max(right),
        }
    }
}

impl BinaryOp {
    pub(crate) fn apply(self, left: f64, right: f64) -> f64 {
        match self {
            Self::Add => left + right,
            Self::Sub => left - right,
            Self::Mul => left * right,
            Self::Div => left / right,
            Self::Pow => left.powf(right),
        }
    }

    pub(crate) fn symbol(self) -> &'static str {
        match self {
            Self::Add => "+",
            Self::Sub => "-",
            Self::Mul => "*",
            Self::Div => "/",
            Self::Pow => "^",
        }
    }
}

/// Syntax tree of one equation. Parameters and `pi` are stored as numbers;
/// a local is a reference to an earlier equation of the same function.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Node {
    Number(f64),
    Variable(Variable),
    Local(usize),
    Negate(Box<Node>),
    Binary(BinaryOp, Box<Node>, Box<Node>),
    Call1(Func1, Box<Node>),
    Call2(Func2, Box<Node>, Box<Node>),
}

pub(crate) fn function1(name: &str) -> Option<Func1> {
    Some(match name {
        "sin" => Func1::Sin,
        "cos" => Func1::Cos,
        "tan" => Func1::Tan,
        "asin" => Func1::Asin,
        "acos" => Func1::Acos,
        "atan" => Func1::Atan,
        "sinh" => Func1::Sinh,
        "cosh" => Func1::Cosh,
        "tanh" => Func1::Tanh,
        "exp" => Func1::Exp,
        "log" => Func1::Log,
        "sqrt" => Func1::Sqrt,
        "abs" => Func1::Abs,
        _ => return None,
    })
}

pub(crate) fn function2(name: &str) -> Option<Func2> {
    Some(match name {
        "atan2" => Func2::Atan2,
        "min" => Func2::Min,
        "max" => Func2::Max,
        _ => return None,
    })
}

pub(crate) fn variable(name: &str) -> Option<Variable> {
    Some(match name {
        "x" => Variable::X,
        "y" => Variable::Y,
        "z" => Variable::Z,
        "t" => Variable::T,
        _ => return None,
    })
}

/// A name that a parameter or a local may not use.
pub(crate) fn is_reserved_name(name: &str) -> bool {
    name == "pi"
        || variable(name).is_some()
        || function1(name).is_some()
        || function2(name).is_some()
}

/// Names visible while one equation is parsed.
pub(crate) struct Scope<'a> {
    pub kind: FunctionKind,
    pub parameters: &'a BTreeMap<&'a str, f64>,
    /// Locals defined before the equation, by name, with their index.
    pub locals: &'a BTreeMap<&'a str, usize>,
}

pub(crate) fn parse_equation(source: &str, scope: &Scope<'_>) -> Result<Node, ExprError> {
    if source.len() > MAX_EQUATION_CHARACTERS {
        return Err(ExprError::new(
            "expr_too_large",
            MAX_EQUATION_CHARACTERS,
            format!(
                "equation has {} characters; the limit is {MAX_EQUATION_CHARACTERS}",
                source.len()
            ),
        ));
    }
    let tokens = tokenize(source)?;
    let mut parser = Parser {
        tokens: &tokens,
        cursor: 0,
        scope,
        nodes: 0,
        depth: 0,
    };
    let node = parser.expression()?;
    let trailing = parser.peek();
    if trailing.kind != TokenKind::End {
        return Err(ExprError::new(
            "expr_syntax",
            trailing.position,
            "unexpected input after the end of the expression",
        ));
    }
    Ok(node)
}

struct Parser<'a> {
    tokens: &'a [Token],
    cursor: usize,
    scope: &'a Scope<'a>,
    nodes: usize,
    depth: usize,
}

impl Parser<'_> {
    fn peek(&self) -> &Token {
        &self.tokens[self.cursor]
    }

    fn advance(&mut self) -> Token {
        let token = self.tokens[self.cursor].clone();
        if token.kind != TokenKind::End {
            self.cursor += 1;
        }
        token
    }

    fn count_node(&mut self, position: usize) -> Result<(), ExprError> {
        self.nodes += 1;
        if self.nodes > MAX_EQUATION_NODES {
            return Err(ExprError::new(
                "expr_too_large",
                position,
                format!("equation has more than {MAX_EQUATION_NODES} syntax nodes"),
            ));
        }
        Ok(())
    }

    fn enter(&mut self, position: usize) -> Result<(), ExprError> {
        self.depth += 1;
        if self.depth > MAX_NESTING_DEPTH {
            return Err(ExprError::new(
                "expr_too_large",
                position,
                format!("equation is nested deeper than {MAX_NESTING_DEPTH} levels"),
            ));
        }
        Ok(())
    }

    fn expression(&mut self) -> Result<Node, ExprError> {
        let mut left = self.term()?;
        loop {
            let token = self.peek().clone();
            let op = match token.kind {
                TokenKind::Plus => BinaryOp::Add,
                TokenKind::Minus => BinaryOp::Sub,
                _ => return Ok(left),
            };
            self.advance();
            let right = self.term()?;
            self.count_node(token.position)?;
            left = Node::Binary(op, Box::new(left), Box::new(right));
        }
    }

    fn term(&mut self) -> Result<Node, ExprError> {
        let mut left = self.unary()?;
        loop {
            let token = self.peek().clone();
            let op = match token.kind {
                TokenKind::Star => BinaryOp::Mul,
                TokenKind::Slash => BinaryOp::Div,
                _ => return Ok(left),
            };
            self.advance();
            let right = self.unary()?;
            self.count_node(token.position)?;
            left = Node::Binary(op, Box::new(left), Box::new(right));
        }
    }

    fn unary(&mut self) -> Result<Node, ExprError> {
        let token = self.peek().clone();
        match token.kind {
            TokenKind::Minus => {
                self.advance();
                self.enter(token.position)?;
                let operand = self.unary()?;
                self.depth -= 1;
                self.count_node(token.position)?;
                Ok(Node::Negate(Box::new(operand)))
            }
            TokenKind::Plus => {
                self.advance();
                self.enter(token.position)?;
                let operand = self.unary()?;
                self.depth -= 1;
                Ok(operand)
            }
            _ => self.power(),
        }
    }

    fn power(&mut self) -> Result<Node, ExprError> {
        let base = self.atom()?;
        let token = self.peek().clone();
        if token.kind != TokenKind::Caret {
            return Ok(base);
        }
        self.advance();
        self.enter(token.position)?;
        let exponent = self.unary()?;
        self.depth -= 1;
        self.count_node(token.position)?;
        Ok(Node::Binary(
            BinaryOp::Pow,
            Box::new(base),
            Box::new(exponent),
        ))
    }

    fn atom(&mut self) -> Result<Node, ExprError> {
        let token = self.advance();
        match token.kind {
            TokenKind::Number(value) => {
                self.count_node(token.position)?;
                Ok(Node::Number(value))
            }
            TokenKind::LeftParen => {
                self.enter(token.position)?;
                let inner = self.expression()?;
                self.depth -= 1;
                self.expect_right_paren()?;
                Ok(inner)
            }
            TokenKind::Name(name) => {
                if self.peek().kind == TokenKind::LeftParen {
                    self.call(&name, token.position)
                } else {
                    self.count_node(token.position)?;
                    self.name(&name, token.position)
                }
            }
            TokenKind::End => Err(ExprError::new(
                "expr_syntax",
                token.position,
                "unexpected end of the expression",
            )),
            _ => Err(ExprError::new(
                "expr_syntax",
                token.position,
                "expected a number, a name or '('",
            )),
        }
    }

    fn expect_right_paren(&mut self) -> Result<(), ExprError> {
        let token = self.advance();
        if token.kind == TokenKind::RightParen {
            Ok(())
        } else {
            Err(ExprError::new(
                "expr_syntax",
                token.position,
                "expected ')'",
            ))
        }
    }

    fn name(&mut self, name: &str, position: usize) -> Result<Node, ExprError> {
        if name == "pi" {
            return Ok(Node::Number(std::f64::consts::PI));
        }
        if let Some(variable) = variable(name) {
            let allowed = match self.scope.kind {
                FunctionKind::Mask => variable != Variable::T,
                FunctionKind::Time => variable == Variable::T,
            };
            if !allowed {
                let message = match self.scope.kind {
                    FunctionKind::Mask => "a mask function may not use 't'".to_string(),
                    FunctionKind::Time => {
                        format!("a time function may not use '{name}'")
                    }
                };
                return Err(ExprError::new(
                    "mask_function_wrong_variable",
                    position,
                    message,
                ));
            }
            return Ok(Node::Variable(variable));
        }
        if let Some(value) = self.scope.parameters.get(name) {
            return Ok(Node::Number(*value));
        }
        if let Some(index) = self.scope.locals.get(name) {
            return Ok(Node::Local(*index));
        }
        if function1(name).is_some() || function2(name).is_some() {
            return Err(ExprError::new(
                "expr_syntax",
                position,
                format!("function '{name}' needs arguments in parentheses"),
            ));
        }
        Err(ExprError::new(
            "expr_unknown_name",
            position,
            format!("unknown name '{name}'"),
        ))
    }

    fn call(&mut self, name: &str, position: usize) -> Result<Node, ExprError> {
        let one = function1(name);
        let two = function2(name);
        if one.is_none() && two.is_none() {
            return Err(ExprError::new(
                "expr_unknown_name",
                position,
                format!("unknown function '{name}'"),
            ));
        }
        self.advance(); // "("
        self.enter(position)?;
        let mut arguments = Vec::new();
        if self.peek().kind != TokenKind::RightParen {
            loop {
                arguments.push(self.expression()?);
                if self.peek().kind == TokenKind::Comma {
                    self.advance();
                } else {
                    break;
                }
            }
        }
        self.depth -= 1;
        self.expect_right_paren()?;
        self.count_node(position)?;
        let expected = if one.is_some() { 1 } else { 2 };
        if arguments.len() != expected {
            return Err(ExprError::new(
                "expr_arity",
                position,
                format!(
                    "function '{name}' takes {expected} argument(s), got {}",
                    arguments.len()
                ),
            ));
        }
        let mut arguments = arguments.into_iter();
        let first = Box::new(arguments.next().expect("checked arity"));
        Ok(match (one, two) {
            (Some(function), _) => Node::Call1(function, first),
            (None, Some(function)) => Node::Call2(
                function,
                first,
                Box::new(arguments.next().expect("checked arity")),
            ),
            (None, None) => unreachable!("checked above"),
        })
    }
}
