use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_TIME_EXPRESSION_EVENTS: usize = 4096;

/// A dimensionless drive authored as a function of cumulative physical seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeExpressionIR {
    pub source: String,
    #[serde(default)]
    pub constants: BTreeMap<String, f64>,
    #[serde(default)]
    pub event_times_s: Vec<f64>,
}

impl TimeExpressionIR {
    pub fn compile(&self) -> Result<fullmag_expr::TimeProgram, String> {
        if self.event_times_s.len() > MAX_TIME_EXPRESSION_EVENTS {
            return Err(format!(
                "time expression has {} event times; the limit is {MAX_TIME_EXPRESSION_EVENTS}",
                self.event_times_s.len()
            ));
        }
        if self.event_times_s.iter().any(|time| !time.is_finite() || *time < 0.0)
            || self.event_times_s.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err("time expression event times must be nonnegative and strictly increasing".into());
        }
        let parameters: Vec<_> = self.constants.iter().map(|(name, value)| (name.clone(), *value)).collect();
        let function = fullmag_expr::compile_function(&fullmag_expr::FunctionSource {
            parameters: &parameters,
            locals: &[],
            outputs: std::slice::from_ref(&self.source),
        }, fullmag_expr::FunctionKind::Time).map_err(|error| error.to_string())?;
        let program = function.time_program();
        if function.depends_on_variables()
            && program.uses_heaviside()
            && self.event_times_s.is_empty()
        {
            return Err(
                "time expression uses heaviside(t) and must declare its discontinuity event_times_s"
                    .into(),
            );
        }
        if !function.depends_on_variables() && !fullmag_expr::eval_time_program(&program.code, 0.0).is_finite() {
            return Err("time expression has a non-finite constant value".into());
        }
        Ok(program.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evaluate(expression: &fullmag_expr::TimeProgram, t: f64) -> Option<f64> {
        let value = fullmag_expr::eval_time_program(&expression.code, t);
        value.is_finite().then_some(value)
    }

    #[test]
    fn expressions_evaluate_a_signed_sinusoid_and_mumax_heaviside() {
        let expression = TimeExpressionIR {
            source: "heaviside(t - on) * sin(2*pi*f*(t-on)) + heaviside(t-on)".into(),
            constants: BTreeMap::from([("on".into(), 70e-9), ("f".into(), 4e9)]),
            event_times_s: vec![70e-9],
        }.compile().unwrap();
        assert_eq!(evaluate(&expression, 0.0), Some(0.0));
        assert_eq!(evaluate(&expression, 70e-9), Some(0.5));
        assert!((evaluate(&expression, 70e-9 + 0.25 / 4e9).unwrap() - 2.0).abs() < 1e-12);
        assert!(evaluate(&expression, 70e-9 + 0.75 / 4e9).unwrap().abs() < 1e-12);
    }

    #[test]
    fn expression_requires_bound_names_and_finite_intermediates() {
        let compile = |source: &str| TimeExpressionIR {
            source: source.into(), constants: BTreeMap::new(), event_times_s: vec![],
        }.compile();
        assert!(compile("f*sin(t)").is_err());
        assert!(compile("max(t)").is_err());
        assert!(compile("heaviside(t)").is_err());
        assert_eq!(evaluate(&compile("heaviside(1)").unwrap(), 0.0), Some(1.0));
        assert!(compile("exp(999)").is_err());
        assert_eq!(evaluate(&compile("1/(t-t)").unwrap(), 0.0), None);
        assert_eq!(evaluate(&compile("max(-2^2, min(3, t))").unwrap(), 2.0), Some(2.0));
    }

    #[test]
    fn expression_bounds_the_declared_event_schedule() {
        let expression = TimeExpressionIR {
            source: "sin(t)".into(),
            constants: BTreeMap::new(),
            event_times_s: (0..=MAX_TIME_EXPRESSION_EVENTS)
                .map(|index| index as f64)
                .collect(),
        };
        assert!(expression.compile().unwrap_err().contains("limit is 4096"));
    }
}
