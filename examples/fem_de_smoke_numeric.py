"""DE-SMOKE numerical FEM fixture from the 2026-09-16 validation plan.

Default: Gamma and ky=2e6 rad/m. FULLMAG_DE_SMOKE_SAMPLING=five selects
all five prescribed points. References are evaluated after the native solve;
this fixture does not select an analytic solver or claim qualification.
"""
from __future__ import annotations

import os
import fullmag as fm

SAMPLING = os.environ.get("FULLMAG_DE_SMOKE_SAMPLING", "two")
if SAMPLING not in ("two", "five"):
    raise ValueError("FULLMAG_DE_SMOKE_SAMPLING must be 'two' or 'five'")
KY = (0.0, 2e6) if SAMPLING == "two" else (0.0, 1e6, 2e6, 3e6, 5e6)

study = fm.study("de-smoke-10nm-numeric")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)
study.wait_for_solve(True)
study.universe(mode="manual", size=(40e-9, 40e-9, 4010e-9),
               center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=100e-9,
                    maximum_element_growth_rate=1.3, grading="geometric")
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.objects.mesh.defaults(periodic_pair_ids=["x_faces", "y_faces"])
body = study.geometry(fm.Box(size=(40e-9, 40e-9, 10e-9), name="film"), name="film")
body.Ms = 800000.0
body.Aex = 13e-12
body.alpha = 0.5
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=10e-9, maximum_element_size=10e-9,
    interface_maximum_element_size=10e-9, interface_thickness=20e-9,
    transition_distance=20e-9, edge_thickness=10e-9, corner_extent=10e-9,
    layers=3, topology="tetrahedral", order=1,
)
study.b_ext(0.1, 0.0, 0.0)
study.exchange()
study.demag(model="airbox", variant="dirichlet")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-7,
                       max_iterations=1000)
study.solver(gamma=2.211e5, fix_dt=5e-15)
study.build_domain_mesh()
study.save("spectrum")
study.save("dispersion", include_branch_table=True)
study.save("diagnostics")
study.save("mode", field="mode", indices=(0, 1, 2, 3),
           sample_indices=tuple(range(len(KY))))
study.runtime_metadata("de_smoke", {
    "schema": "fullmag.de-smoke.v1",
    "sampling": SAMPLING,
    "film_thickness_m": 10e-9,
    "cell_period_m": 40e-9,
    "air_padding_each_side_m": 2e-6,
    "ky_rad_per_m": list(KY),
    "orientation": "M0=x,k=y,normal=z",
    "analytic_comparison": "postsolve_only",
    "qualification": "NOT VERIFIED",
})
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped",
                       dt=5e-15, relax_alpha=0.5, max_steps=50000, tolA=1.0)
study.stages.add_eigenmodes(
    count=4, target="frequency_window", frequency_min=8.5e9,
    frequency_max=12e9, operator="full_2x2", include_demag=True,
    equilibrium_source="relax", normalization="unit_l2", damping_policy="ignore",
    k_sampling=fm.KPath(
        points=[fm.KPoint("Gamma" if ky == 0 else f"DE-{ky:g}", (0.0, ky, 0.0))
                for ky in KY],
        samples_per_segment=[1] * (len(KY) - 1),
    ),
    bc=fm.FloquetBC(["x_faces", "y_faces"],
                    phase_convention="exp_minus_i_k_dot_delta_r"),
    magnetostatic_bc="floquet_airbox",
)
