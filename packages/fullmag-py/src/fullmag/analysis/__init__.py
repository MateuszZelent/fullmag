"""Post-processing and analysis utilities for Fullmag simulation outputs.

Provides tools for:
- FFT / PSD spectral analysis of magnetization time traces
- Vortex core position tracking
- Linewidth extraction (half-max estimator and Lorentzian fit)
- Oscillation diagnostics
"""

from fullmag.analysis.fitting import (
    LinewidthFitResult,
    fit_lorentzian_linewidth,
    linewidth_halfmax,
)
from fullmag.analysis.spectrum import (
    fft_from_trace,
    linewidth_lorentzian,
    peak_frequency,
    psd_from_trace,
)
from fullmag.analysis.stno_report import (
    StnoArtifactReport,
    StnoOrbitSummary,
    StnoSpectrumMetrics,
    StnoSteadyStateMetrics,
    analyze_stno_artifacts,
    load_scalar_artifacts,
    write_stno_report,
)
from fullmag.analysis.vortex import (
    core_orbit_radius,
    core_phase,
    track_vortex_core,
)
from fullmag.analysis.vortex_fit import (
    CoreTrackResult,
    OrbitMetrics,
    compute_orbit_metrics,
    track_vortex_core_subpixel,
)

__all__ = [
    "CoreTrackResult",
    "LinewidthFitResult",
    "OrbitMetrics",
    "compute_orbit_metrics",
    "core_orbit_radius",
    "core_phase",
    "fft_from_trace",
    "fit_lorentzian_linewidth",
    "linewidth_halfmax",
    "linewidth_lorentzian",
    "peak_frequency",
    "psd_from_trace",
    "StnoArtifactReport",
    "StnoOrbitSummary",
    "StnoSpectrumMetrics",
    "StnoSteadyStateMetrics",
    "analyze_stno_artifacts",
    "load_scalar_artifacts",
    "track_vortex_core",
    "track_vortex_core_subpixel",
    "write_stno_report",
]
