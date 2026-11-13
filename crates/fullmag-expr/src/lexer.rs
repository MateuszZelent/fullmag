//! Tokens of `field_expr.v1`.

use crate::ExprError;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum TokenKind {
    Number(f64),
    Name(String),
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    LeftParen,
    RightParen,
    Comma,
    End,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Token {
    pub kind: TokenKind,
    /// Zero-based byte offset of the first character of the token.
    pub position: usize,
}

pub(crate) fn tokenize(source: &str) -> Result<Vec<Token>, ExprError> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            index += 1;
            continue;
        }
        let position = index;
        let kind = match byte {
            b'+' => TokenKind::Plus,
            b'-' => TokenKind::Minus,
            b'*' => TokenKind::Star,
            b'/' => TokenKind::Slash,
            b'^' => TokenKind::Caret,
            b'(' => TokenKind::LeftParen,
            b')' => TokenKind::RightParen,
            b',' => TokenKind::Comma,
            b'0'..=b'9' | b'.' => {
                let end = number_end(bytes, index)
                    .ok_or_else(|| ExprError::new("expr_syntax", position, "malformed number"))?;
                let text = &source[index..end];
                let value: f64 = text.parse().map_err(|_| {
                    ExprError::new(
                        "expr_syntax",
                        position,
                        format!("malformed number '{text}'"),
                    )
                })?;
                if !value.is_finite() {
                    return Err(ExprError::new(
                        "expr_syntax",
                        position,
                        format!("number '{text}' is not finite"),
                    ));
                }
                index = end;
                tokens.push(Token {
                    kind: TokenKind::Number(value),
                    position,
                });
                continue;
            }
            b'A'..=b'Z' | b'a'..=b'z' | b'_' => {
                let mut end = index + 1;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
                {
                    end += 1;
                }
                let name = source[index..end].to_string();
                index = end;
                tokens.push(Token {
                    kind: TokenKind::Name(name),
                    position,
                });
                continue;
            }
            _ => {
                let character = source[index..].chars().next().unwrap_or('?');
                return Err(ExprError::new(
                    "expr_syntax",
                    position,
                    format!("unexpected character '{character}'"),
                ));
            }
        };
        index += 1;
        tokens.push(Token { kind, position });
    }
    tokens.push(Token {
        kind: TokenKind::End,
        position: bytes.len(),
    });
    Ok(tokens)
}

/// End offset of the number that starts at `start`:
/// `digits ["." digits] [exponent] | "." digits [exponent]`.
fn number_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut index = start;
    let mut integer_digits = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
        integer_digits += 1;
    }
    let mut fraction_digits = 0;
    if index < bytes.len() && bytes[index] == b'.' {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
            fraction_digits += 1;
        }
        if integer_digits == 0 && fraction_digits == 0 {
            return None;
        }
    } else if integer_digits == 0 {
        return None;
    }
    if index < bytes.len() && (bytes[index] == b'e' || bytes[index] == b'E') {
        let mut exponent = index + 1;
        if exponent < bytes.len() && (bytes[exponent] == b'+' || bytes[exponent] == b'-') {
            exponent += 1;
        }
        let digits_start = exponent;
        while exponent < bytes.len() && bytes[exponent].is_ascii_digit() {
            exponent += 1;
        }
        if exponent == digits_start {
            return None;
        }
        index = exponent;
    }
    Some(index)
}
