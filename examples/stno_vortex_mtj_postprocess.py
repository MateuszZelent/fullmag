"""Artifact-backed STNO post-processing example.

Usage:
    python examples/stno_vortex_mtj_postprocess.py [artifact_dir]

Default artifact directory:
    run_output/stno_vortex_ref_minimal
"""

from __future__ import annotations

import sys
from pathlib import Path

from fullmag.analysis import analyze_stno_artifacts, write_stno_report


def main(argv: list[str]) -> int:
    artifact_dir = Path(argv[1]) if len(argv) > 1 else Path("run_output/stno_vortex_ref_minimal")
    report = analyze_stno_artifacts(artifact_dir)
    json_path, markdown_path = write_stno_report(artifact_dir, report=report)

    print(f"Artifact dir: {artifact_dir}")
    print(f"Signal: {report.spectrum.signal}")
    print(f"Peak frequency: {report.spectrum.peak_frequency_hz / 1e6:.2f} MHz")
    print(f"Linewidth: {report.spectrum.linewidth_fwhm_hz / 1e6:.2f} MHz")
    print(f"Q factor: {report.spectrum.q_factor:.2f}")
    print(f"Steady-state score: {report.steady_state.score:.3f}")
    if report.orbit is not None:
        print(f"Mean orbit radius: {report.orbit.mean_radius_m / 1e-9:.2f} nm")
        print(f"Orbit ellipticity: {report.orbit.ellipticity:.3f}")
    for note in report.notes:
        print(f"Note: {note}")
    print(f"JSON summary: {json_path}")
    print(f"Markdown summary: {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
