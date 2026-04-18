"""Reference FDM STNO benchmark with artifact-backed post-processing.

This is the canonical minimal public benchmark for the current executable STNO
slice:

- single magnetic free layer,
- vortex initial state,
- Slonczewski STT,
- analytic Oersted cylinder,
- optional thermal noise,
- real solver artifacts plus STNO summary generation.
"""

from __future__ import annotations

import os
from pathlib import Path

import fullmag as fm
from fullmag.analysis import analyze_stno_artifacts, write_stno_report


DEFAULT_UNTIL = float(os.environ.get("FULLMAG_STNO_UNTIL", "2e-8"))
DEFAULT_OUTPUT_DIR = os.environ.get(
    "FULLMAG_STNO_OUTPUT_DIR",
    "run_output/stno_vortex_ref_minimal",
)
DEFAULT_INCLUDE_THERMAL = os.environ.get("FULLMAG_STNO_THERMAL", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


def build(*, include_thermal: bool = DEFAULT_INCLUDE_THERMAL) -> fm.Problem:
    free_layer = fm.Cylinder(radius=60e-9, height=5e-9, name="free_layer")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
    magnet = fm.Ferromagnet(
        name="free_layer",
        geometry=free_layer,
        material=material,
        m0=fm.texture.vortex(circulation=1, core_polarity=1),
    )

    energy: list[object] = [
        fm.Exchange(),
        fm.Demag(),
        fm.OerstedCylinder(current=8e-3, radius=60e-9),
    ]
    if include_thermal:
        energy.append(fm.ThermalNoise(temperature=300.0, seed=7))

    return fm.Problem(
        name="stno_vortex_ref_minimal",
        description=(
            "Canonical minimal FDM STNO benchmark: vortex free layer driven by "
            "Slonczewski STT and analytic Oersted field."
        ),
        magnets=[magnet],
        energy=energy,
        spin_torque=fm.SlonczewskiSTT(
            current_density=(0.0, 0.0, 6.0e10),
            spin_polarization=(0.0, 0.0, 1.0),
            degree=0.4,
            lambda_asymmetry=1.0,
        ),
        temperature=300.0 if include_thermal else None,
        study=fm.TimeEvolution(
            dynamics=fm.LLG(fixed_timestep=5e-13),
            outputs=[
                fm.SaveScalar("time", every=20e-12),
                fm.SaveScalar("mx", every=20e-12),
                fm.SaveScalar("my", every=20e-12),
                fm.SaveScalar("mz", every=20e-12),
                fm.SaveScalar("E_total", every=20e-12),
                fm.SaveScalar("max_dm_dt", every=20e-12),
                fm.SaveField("m", every=1e-9),
            ],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(5e-9, 5e-9, 5e-9)),
        ),
    )


if __name__ == "__main__":
    problem = build()
    output_dir = Path(DEFAULT_OUTPUT_DIR)
    result = fm.Simulation(problem, backend="fdm").run(
        until=DEFAULT_UNTIL,
        output_dir=str(output_dir),
    )

    print(f"Status: {result.status}")
    print(f"Backend: {result.backend.value}")
    print(f"Precision: {result.precision.value}")
    if result.output_dir:
        print(f"Artifacts written to: {result.output_dir}")
    if result.steps:
        final = result.steps[-1]
        print(f"Final time: {final.time:.6e} s")
        print(f"Final mx,my,mz: {final.mx:.4f}, {final.my:.4f}, {final.mz:.4f}")
        print(f"Final E_total: {final.e_total:.6e} J")
    for note in result.notes:
        print(f"  Note: {note}")

    if result.status == "completed" and output_dir.is_dir():
        report = analyze_stno_artifacts(output_dir)
        json_path, markdown_path = write_stno_report(output_dir, report=report)
        print(f"Peak frequency: {report.spectrum.peak_frequency_hz / 1e6:.2f} MHz")
        print(f"Linewidth: {report.spectrum.linewidth_fwhm_hz / 1e6:.2f} MHz")
        print(f"Steady-state score: {report.steady_state.score:.3f}")
        if report.orbit is not None:
            print(f"Mean orbit radius: {report.orbit.mean_radius_m / 1e-9:.2f} nm")
        print(f"STNO JSON summary: {json_path}")
        print(f"STNO Markdown summary: {markdown_path}")
else:
    problem = build()
