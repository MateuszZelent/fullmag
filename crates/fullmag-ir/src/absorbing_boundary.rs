use crate::{AbsorbingBoundaryLayerIR, AbsorbingBoundaryProfileIR};

const TOLERANCE: f64 = 1e-12;
const VALIDATION_STEPS: u32 = 256;

/// A scalar ramp ready to be sampled repeatedly by the material planner.
pub struct ResolvedAbsorbingBoundaryProfile {
    kind: AbsorbingBoundaryProfileIR,
    expression: Option<Expression>,
}

impl AbsorbingBoundaryLayerIR {
    pub fn compile_profile(&self) -> Result<ResolvedAbsorbingBoundaryProfile, String> {
        let expression = match (self.profile, self.expression.as_deref()) {
            (AbsorbingBoundaryProfileIR::Custom, Some(source)) => Some(Parser::parse(source)?),
            (AbsorbingBoundaryProfileIR::Custom, None) => {
                return Err(
                    "expression is required for a custom absorbing boundary profile".into(),
                );
            }
            (_, None) => None,
            (_, Some(_)) => {
                return Err("expression requires a custom absorbing boundary profile".into());
            }
        };
        let profile = ResolvedAbsorbingBoundaryProfile {
            kind: self.profile,
            expression,
        };
        if profile.expression.is_some() {
            for step in 0..=VALIDATION_STEPS {
                profile.evaluate(f64::from(step) / f64::from(VALIDATION_STEPS))?;
            }
        }
        Ok(profile)
    }
}

impl ResolvedAbsorbingBoundaryProfile {
    pub fn evaluate(&self, value: f64) -> Result<f64, String> {
        let u = value.clamp(0.0, 1.0);
        if let Some(expression) = &self.expression {
            let weight = expression
                .evaluate(u)
                .ok_or_else(|| format!("expression is undefined at u={u}"))?;
            if !(-TOLERANCE..=1.0 + TOLERANCE).contains(&weight) {
                return Err(format!("expression must return a value in [0, 1] at u={u}"));
            }
            if u == 0.0 || u == 1.0 {
                if (weight - u).abs() > TOLERANCE {
                    return Err("expression must equal 0 at u=0 and 1 at u=1".into());
                }
                return Ok(u);
            }
            return Ok(weight.clamp(0.0, 1.0));
        }
        if u == 0.0 || u == 1.0 {
            return Ok(u);
        }
        Ok(match self.kind {
            AbsorbingBoundaryProfileIR::Linear => u,
            AbsorbingBoundaryProfileIR::Quadratic => u * u,
            AbsorbingBoundaryProfileIR::Smootherstep => u * u * u * (u * (u * 6.0 - 15.0) + 10.0),
            AbsorbingBoundaryProfileIR::Logarithmic => (9.0 * u).ln_1p() / std::f64::consts::LN_10,
            AbsorbingBoundaryProfileIR::Tanh => {
                (1.0 + (4.0 * u - 2.0).tanh() / 2.0_f64.tanh()) / 2.0
            }
            AbsorbingBoundaryProfileIR::Custom => {
                unreachable!("compiled custom profile has an expression")
            }
        })
    }
}

type UnaryOperation = fn(f64) -> f64;
type BinaryOperation = fn(f64, f64) -> f64;

enum Expression {
    Number(f64),
    Position,
    Unary(UnaryOperation, Box<Self>),
    Binary(BinaryOperation, Box<Self>, Box<Self>),
}

impl Expression {
    fn evaluate(&self, u: f64) -> Option<f64> {
        let value = match self {
            Self::Number(value) => *value,
            Self::Position => u,
            Self::Unary(operation, operand) => operation(operand.evaluate(u)?),
            Self::Binary(operation, left, right) => {
                operation(left.evaluate(u)?, right.evaluate(u)?)
            }
        };
        value.is_finite().then_some(value)
    }
}

struct Parser<'a> {
    remaining: &'a str,
}

impl<'a> Parser<'a> {
    fn parse(source: &'a str) -> Result<Expression, String> {
        if source.is_empty()
            || source.len() > 256
            || !source
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b".+*/() \t-".contains(&ch))
        {
            return Err("expression must contain 1 to 256 ASCII math characters".into());
        }
        let mut parser = Self { remaining: source };
        let expression = parser.parse_expression(0)?;
        if !parser.remaining.trim_ascii().is_empty() {
            return Err(parser.expected("end of expression"));
        }
        Ok(expression)
    }

    fn parse_expression(&mut self, minimum_precedence: u8) -> Result<Expression, String> {
        let mut left = self.parse_operand()?;
        loop {
            self.skip_whitespace();
            let Some((token, operation, precedence, right_precedence)) = self.operator() else {
                return Ok(left);
            };
            if precedence < minimum_precedence {
                return Ok(left);
            }
            self.remaining = &self.remaining[token.len()..];
            let right = self.parse_expression(right_precedence)?;
            left = Expression::Binary(operation, Box::new(left), Box::new(right));
        }
    }

    fn parse_operand(&mut self) -> Result<Expression, String> {
        if self.consume("+") {
            return self.parse_expression(3);
        }
        if self.consume("-") {
            let operand = self.parse_expression(3)?;
            return Ok(Expression::Unary(|value| -value, Box::new(operand)));
        }
        if self.consume("(") {
            return self.parenthesized();
        }
        if self
            .remaining
            .starts_with(|ch: char| ch.is_ascii_digit() || ch == '.')
        {
            return self.number();
        }
        let name = self.take_while(|ch| ch.is_ascii_alphanumeric());
        if name == "u" {
            return Ok(Expression::Position);
        }
        let function: UnaryOperation = match name {
            "abs" => f64::abs,
            "sqrt" => f64::sqrt,
            "exp" => f64::exp,
            "log" => f64::ln,
            "log1p" => f64::ln_1p,
            "tanh" => f64::tanh,
            "sin" => f64::sin,
            "cos" => f64::cos,
            _ => return Err(self.expected("u, a number, or a supported math function")),
        };
        if !self.consume("(") {
            return Err(self.expected("'(' after the function name"));
        }
        Ok(Expression::Unary(function, Box::new(self.parenthesized()?)))
    }

    fn parenthesized(&mut self) -> Result<Expression, String> {
        let expression = self.parse_expression(0)?;
        if !self.consume(")") {
            return Err(self.expected("')'"));
        }
        Ok(expression)
    }

    fn number(&mut self) -> Result<Expression, String> {
        let source = self.remaining;
        let integer = self.take_while(|ch| ch.is_ascii_digit());
        let mut integer_only = true;
        if let Some(after_dot) = self.remaining.strip_prefix('.') {
            self.remaining = after_dot;
            self.take_while(|ch| ch.is_ascii_digit());
            integer_only = false;
        }
        if self.remaining.starts_with(['e', 'E']) {
            self.remaining = &self.remaining[1..];
            if self.remaining.starts_with(['+', '-']) {
                self.remaining = &self.remaining[1..];
            }
            self.take_while(|ch| ch.is_ascii_digit());
            integer_only = false;
        }
        if integer_only && integer.starts_with('0') && integer.bytes().any(|ch| ch != b'0') {
            return Err(self.expected("an integer without a leading zero"));
        }
        source[..source.len() - self.remaining.len()]
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(Expression::Number)
            .ok_or_else(|| self.expected("a finite decimal number"))
    }

    fn operator(&self) -> Option<(&'static str, BinaryOperation, u8, u8)> {
        if self.remaining.starts_with("**") {
            return Some(("**", f64::powf, 4, 4));
        }
        match self.remaining.as_bytes().first()? {
            b'+' => Some(("+", |left, right| left + right, 1, 2)),
            b'-' => Some(("-", |left, right| left - right, 1, 2)),
            b'*' => Some(("*", |left, right| left * right, 2, 3)),
            b'/' => Some(("/", |left, right| left / right, 2, 3)),
            _ => None,
        }
    }

    fn skip_whitespace(&mut self) {
        self.remaining = self.remaining.trim_ascii_start();
    }

    fn consume(&mut self, token: &str) -> bool {
        self.skip_whitespace();
        if let Some(rest) = self.remaining.strip_prefix(token) {
            self.remaining = rest;
            return true;
        }
        false
    }

    fn take_while(&mut self, predicate: impl Fn(u8) -> bool) -> &'a str {
        let length = self
            .remaining
            .bytes()
            .take_while(|ch| predicate(*ch))
            .count();
        let (taken, rest) = self.remaining.split_at(length);
        self.remaining = rest;
        taken
    }

    fn expected(&self, expected: &str) -> String {
        format!("invalid expression: expected {expected}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_expression_obeys_precedence_and_rejects_unbounded_operations() {
        for (source, expected) in [
            ("-u**2", -0.25),
            ("u**2**2", 0.0625),
            ("2e-1 + (u - .1) * 2", 1.0),
            ("sqrt(u * u)", 0.5),
            ("2**-u**2", 2.0_f64.powf(-0.25)),
        ] {
            let output = Parser::parse(source).unwrap().evaluate(0.5).unwrap();
            assert!((output - expected).abs() < 1e-12, "{source}");
        }
        for source in [
            "u # comment",
            "u**1_0",
            "01*u",
            "u.real",
            "(sqrt)(u)",
            "((abs))(u)",
            "other(u)",
            "u/ /u",
            "u 2",
            "u**0x2",
            "u**0o2",
            "u**0b10",
        ] {
            assert!(Parser::parse(source).is_err(), "{source}");
        }
        assert_eq!(Parser::parse("1/exp(999)").unwrap().evaluate(0.5), None);
    }
}
