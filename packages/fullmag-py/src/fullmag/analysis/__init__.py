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
from fullmag.analysis.fem_cartesian_restriction import (
    CartesianRestriction,
    build_prism6_cartesian_restriction,
    build_tet4_cartesian_restriction,
    restrict_fem_magnetization,
    sample_fem_tet4_cartesian_centers,
)
from fullmag.analysis.magnetization_comparison import (
    CartesianGrid,
    FEMMagnetizationState,
    MagnetizationComparison,
    MagnetizationComparisonError,
    StructuredMagnetization,
    compare_magnetization_textures,
    compare_relaxed_states,
    load_fullmag_fem_magnetization,
    load_mumax_magnetization,
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
    "CartesianGrid",
    "CartesianRestriction",
    "CoreTrackResult",
    "FEMMagnetizationState",
    "LinewidthFitResult",
    "MagnetizationComparison",
    "MagnetizationComparisonError",
    "OrbitMetrics",
    "StructuredMagnetization",
    "build_prism6_cartesian_restriction",
    "build_tet4_cartesian_restriction",
    "compare_magnetization_textures",
    "compare_relaxed_states",
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
    "load_fullmag_fem_magnetization",
    "load_mumax_magnetization",
    "restrict_fem_magnetization",
    "sample_fem_tet4_cartesian_centers",
    "track_vortex_core",
    "track_vortex_core_subpixel",
    "write_stno_report",
]
