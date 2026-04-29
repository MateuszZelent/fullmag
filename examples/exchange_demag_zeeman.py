"""Executable FDM example: Exchange + Demag + Zeeman on a Box geometry.

This extends the narrow exchange-only baseline with:
- dipolar demagnetization field (CPU bootstrap implementation),
- uniform external field via Zeeman(B=...),
- expanded field outputs: H_ex, H_demag, H_ext, H_eff,
- expanded scalar outputs: E_ex, E_demag, E_ext, E_total.

Usage:
    fullmag examples/exchange_demag_zeeman.py
"""

import fullmag as fm


DEFAULT_UNTIL = 5e-10


def build() -> fm.Problem:
    film = fm.Box(size=(128e-9, 64e-9, 4e-9), name="film")
    mat = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.5)
    magnet = fm.Ferromagnet(
        name="film",
        geometry=film,
        material=mat,
        m0=fm.texture.random(seed=7),
    )

    return fm.Problem(
        name="exchange_demag_zeeman",
        magnets=[magnet],
        energy=[
            fm.Exchange(),
            fm.Demag(),
            fm.Zeeman(B=(0.0, 0.0, 0.05)),
        ],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(fixed_timestep=1e-13),
            outputs=[
                fm.SaveField("m", every=50e-12),
                fm.SaveField("H_ex", every=50e-12),
                fm.SaveField("H_demag", every=50e-12),
                fm.SaveField("H_ext", every=50e-12),
                fm.SaveField("H_eff", every=50e-12),
                fm.SaveScalar("E_ex", every=10e-12),
                fm.SaveScalar("E_demag", every=10e-12),
                fm.SaveScalar("E_ext", every=10e-12),
                fm.SaveScalar("E_total", every=10e-12),
                fm.SaveScalar("max_h_eff", every=10e-12),
            ],
        ),
        discretization=fm.DiscretizationHints(
            fdm=fm.FDM(cell=(4e-9, 4e-9, 4e-9)),
        ),
    )


if __name__ == "__main__":
    problem = build()
    result = fm.Simulation(problem, backend="fdm").run(until=DEFAULT_UNTIL)

    print(f"Status: {result.status}")
    if result.steps:
        final = result.steps[-1]
        print(f"Total steps: {len(result.steps)}")
        print(f"Final E_ex: {final.e_ex:.6e} J")
        print(f"Final E_demag: {final.e_demag:.6e} J")
        print(f"Final E_ext: {final.e_ext:.6e} J")
        print(f"Final E_total: {final.e_total:.6e} J")
        print(f"Final time: {final.time:.6e} s")
    if result.output_dir:
        print(f"Artifacts written to: {result.output_dir}")
    for note in result.notes:
        print(f"  Note: {note}")
else:
    problem = build()
