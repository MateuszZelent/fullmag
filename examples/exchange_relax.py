"""Canonical executable example: exchange-only relaxation on a Box geometry.

This is the simplest public-executable problem in Phase 1:
- Box geometry (direct grid derivation, no voxelizer needed)
- Exchange energy only
- LLG with Heun integrator
- Random initial magnetization (non-trivial exchange field)
- FDM backend in strict mode

Usage:
    python examples/exchange_relax.py

When fullmag-py-core is installed (maturin develop), this runs
end-to-end through the Rust reference engine and writes artifacts.
"""

import fullmag as fm


def build() -> fm.Problem:
    strip = fm.Box(size=(200e-9, 20e-9, 5e-9), name="strip")
    mat = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="strip",
        geometry=strip,
        material=mat,
        m0=fm.init.random(seed=42),
    )

    return fm.Problem(
        name="exchange_relax",
        magnets=[magnet],
        energy=[fm.Exchange()],
        dynamics=fm.LLG(),
        outputs=[
            fm.SaveField("m", every=100e-12),
            fm.SaveField("H_ex", every=100e-12),
            fm.SaveScalar("E_ex", every=10e-12),
        ],
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(2e-9, 2e-9, 5e-9)),
        ),
    )


if __name__ == "__main__":
    problem = build()
    result = fm.Simulation(problem, backend="fdm").run(until=2e-9)

    print(f"Status: {result.status}")
    if result.steps:
        print(f"Total steps: {len(result.steps)}")
        print(f"Final E_ex: {result.steps[-1].e_ex:.6e} J")
        print(f"Final time: {result.steps[-1].time:.6e} s")
    if result.output_dir:
        print(f"Artifacts written to: {result.output_dir}")
    for note in result.notes:
        print(f"  Note: {note}")
else:
    # When loaded as a module (e.g. by the script loader), just expose the problem
    problem = build()
