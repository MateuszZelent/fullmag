//! Lightweight solver telemetry (Etap A1).
//!
//! Provides named timers and counters that can be accumulated per step and
//! per simulation.  Zero overhead when the `telemetry` feature is disabled —
//! all calls compile to no-ops.
//!
//! Usage:
//! ```ignore
//! let mut t = StepTelemetry::new();
//! t.begin("field.exchange");
//! // ... compute exchange ...
//! t.end("field.exchange");
//! t.begin("field.demag");
//! // ... compute demag ...
//! t.end("field.demag");
//! let snapshot = t.finish(); // consumes, returns StepSnapshot
//! ```

/// Per-step timing snapshot with named sections.
#[derive(Debug, Clone, Default)]
pub struct StepSnapshot {
    /// (name, duration_ns) pairs in order of first `begin` call.
    pub sections: Vec<(&'static str, u64)>,
    /// Total step wall time (ns).
    pub total_ns: u64,
}

impl StepSnapshot {
    pub fn section_ns(&self, name: &str) -> u64 {
        self.sections
            .iter()
            .filter(|(n, _)| *n == name)
            .map(|(_, ns)| *ns)
            .sum()
    }

    pub fn fraction(&self, name: &str) -> f64 {
        if self.total_ns == 0 {
            return 0.0;
        }
        self.section_ns(name) as f64 / self.total_ns as f64
    }
}

/// Per-step telemetry accumulator.
#[cfg(feature = "telemetry")]
use std::time::Instant;

///
/// When the `telemetry` feature is **not** enabled, all methods are `#[inline]`
/// no-ops and the struct is zero-sized.
#[cfg(feature = "telemetry")]
#[derive(Debug)]
pub struct StepTelemetry {
    sections: Vec<(&'static str, u64)>,
    open: Option<(&'static str, Instant)>,
    step_start: Instant,
}

#[cfg(feature = "telemetry")]
impl StepTelemetry {
    pub fn new() -> Self {
        Self {
            sections: Vec::with_capacity(16),
            open: None,
            step_start: Instant::now(),
        }
    }

    #[inline]
    pub fn begin(&mut self, name: &'static str) {
        debug_assert!(self.open.is_none(), "nested telemetry begin");
        self.open = Some((name, Instant::now()));
    }

    #[inline]
    pub fn end(&mut self, name: &'static str) {
        if let Some((open_name, start)) = self.open.take() {
            debug_assert_eq!(open_name, name, "mismatched telemetry end");
            self.sections
                .push((name, start.elapsed().as_nanos() as u64));
        }
    }

    pub fn finish(self) -> StepSnapshot {
        let total_ns = self.step_start.elapsed().as_nanos() as u64;
        StepSnapshot {
            sections: self.sections,
            total_ns,
        }
    }
}

/// No-op telemetry when feature is disabled.
#[cfg(not(feature = "telemetry"))]
#[derive(Debug)]
pub struct StepTelemetry;

#[cfg(not(feature = "telemetry"))]
impl StepTelemetry {
    #[inline(always)]
    pub fn new() -> Self {
        Self
    }

    #[inline(always)]
    pub fn begin(&mut self, _name: &'static str) {}

    #[inline(always)]
    pub fn end(&mut self, _name: &'static str) {}

    #[inline(always)]
    pub fn finish(self) -> StepSnapshot {
        StepSnapshot::default()
    }
}

impl Default for StepTelemetry {
    fn default() -> Self {
        Self::new()
    }
}

// ── Cumulative telemetry across many steps ──────────────────────────────

/// Accumulates telemetry across multiple steps.
#[derive(Debug, Clone, Default)]
pub struct SimulationTelemetry {
    pub step_count: u64,
    pub rhs_count: u64,
    pub total_ns: u64,
    /// Cumulative (name, total_ns) pairs.
    cumulative: Vec<(&'static str, u64)>,
}

impl SimulationTelemetry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Merge a single step's snapshot into the cumulative counters.
    pub fn accumulate(&mut self, snap: &StepSnapshot) {
        self.step_count += 1;
        self.total_ns += snap.total_ns;
        for &(name, ns) in &snap.sections {
            if let Some(entry) = self.cumulative.iter_mut().find(|(n, _)| *n == name) {
                entry.1 += ns;
            } else {
                self.cumulative.push((name, ns));
            }
        }
    }

    pub fn increment_rhs(&mut self) {
        self.rhs_count += 1;
    }

    /// Return a summary table suitable for logging.
    pub fn summary(&self) -> String {
        let mut lines = Vec::new();
        lines.push(format!(
            "steps={} rhs={} total={:.3}s",
            self.step_count,
            self.rhs_count,
            self.total_ns as f64 / 1e9,
        ));
        for &(name, ns) in &self.cumulative {
            let frac = if self.total_ns > 0 {
                ns as f64 / self.total_ns as f64 * 100.0
            } else {
                0.0
            };
            lines.push(format!(
                "  {:<30} {:>10.3} ms ({:>5.1}%)",
                name,
                ns as f64 / 1e6,
                frac
            ));
        }
        lines.join("\n")
    }
}

// ── Standard section names ─────────────────────────────────────────────

pub mod sections {
    pub const FIELD_EXCHANGE: &str = "field.exchange";
    pub const FIELD_DEMAG: &str = "field.demag";
    pub const FIELD_ANISOTROPY: &str = "field.anisotropy";
    pub const FIELD_DMI: &str = "field.dmi";
    pub const FIELD_EXTERNAL: &str = "field.external";
    pub const FIELD_THERMAL: &str = "field.thermal";
    pub const FIELD_MEL: &str = "field.magnetoelastic";
    pub const FIELD_STT: &str = "field.stt";
    pub const FIELD_SOT: &str = "field.sot";
    pub const RHS_TOTAL: &str = "rhs.total";
    pub const FFT_PACK: &str = "fft.pack";
    pub const FFT_FORWARD: &str = "fft.forward";
    pub const FFT_MULTIPLY: &str = "fft.multiply";
    pub const FFT_INVERSE: &str = "fft.inverse";
    pub const FFT_UNPACK: &str = "fft.unpack";
    pub const INTEGRATOR_STAGE: &str = "integrator.stage";
    pub const INTEGRATOR_OBSERVABLES: &str = "integrator.observables";
    pub const ARTIFACT_EXPORT: &str = "artifact.export";
    pub const PREVIEW_RENDER: &str = "preview.render";
    pub const FEM_ASSEMBLY: &str = "fem.assembly";
    pub const FEM_SPMV: &str = "fem.spmv";
    pub const FEM_CG: &str = "fem.cg";
}
