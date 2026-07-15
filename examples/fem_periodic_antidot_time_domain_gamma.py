"""Periodic antidot: relax, excite with a spatially uniform sinc pulse, then sample Γ.

This is the time-domain counterpart of
``fem_periodic_antidot_relax_exchange_coupled.py``.  The stable stage ids make
the relaxed-to-dynamic state handoff explicit in ProblemIR; ``excite`` starts
from the final magnetization of ``relax`` on the same native FEM backend.
"""

import os
import fullmag as fm

CELL = float(os.environ.get("FULLMAG_GAMMA_CELL_M", "2e-7"))
THICKNESS = float(os.environ.get("FULLMAG_GAMMA_THICKNESS_M", "1e-8"))
HOLE_RADIUS = float(os.environ.get("FULLMAG_GAMMA_HOLE_RADIUS_M", "2.5e-8"))
DT = float(os.environ.get("FULLMAG_GAMMA_DT_S", "1e-13"))
SAMPLE_DT = float(os.environ.get("FULLMAG_GAMMA_SAMPLE_DT_S", "5e-13"))
UNTIL = float(os.environ.get("FULLMAG_GAMMA_UNTIL_S", "2e-9"))
AMPLITUDE = float(os.environ.get("FULLMAG_GAMMA_AMPLITUDE_B_T", "1e-3"))
CUTOFF = float(os.environ.get("FULLMAG_GAMMA_CUTOFF_HZ", "4e10"))
T0 = float(os.environ.get("FULLMAG_GAMMA_T0_S", "5e-11"))
RELAX_STEPS = int(os.environ.get("FULLMAG_GAMMA_RELAX_STEPS", "500"))
DEVICE = os.environ.get("FULLMAG_FEM_EXECUTION", "gpu")
MESH_SCALE = float(os.environ.get("FULLMAG_GAMMA_MESH_SCALE", "1"))


study = fm.study("fem_periodic_antidot_time_domain_gamma")
study.engine("fem")
study.device(DEVICE, precision="double")
study.universe(
    mode="manual",
    size=(CELL, CELL, max(9 * THICKNESS, 3 * THICKNESS)),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=5e-9 * MESH_SCALE,
    maximum_element_size=100e-9 * MESH_SCALE,
    growth_rate=1.5,
)
study.pbc(x=True, y=True, demag="periodic_airbox_k0")

film = fm.Box(size=(CELL, CELL, THICKNESS), name="periodic_antidot_base")
hole = fm.Cylinder(radius=HOLE_RADIUS, height=THICKNESS, name="central_hole")
body = study.geometry(film - hole, name="periodic_antidot_film")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=3e-9 * MESH_SCALE,
    maximum_element_size=8e-9 * MESH_SCALE,
    curvature_factor=0.25,
    narrow_region_resolution=1.5,
    layers=1,
    order=1,
)

hole_transition = body.add_region(
    "hole_transition_refinement",
    fm.Cylinder(radius=min(0.22 * CELL, 1.72 * HOLE_RADIUS), height=THICKNESS, name="hole_transition_refinement"),
    priority=10,
    realization_policy="conformal",
)
hole_transition.mesh(
    minimum_element_size=0.5e-9 * MESH_SCALE,
    maximum_element_size=3e-9 * MESH_SCALE,
    transition_distance=10e-9,
    order=1,
)

study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-12, max_iterations=500)
study.objects.mesh.defaults(
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=8,
    narrow_regions=1,
)
study.build_domain_mesh()
study.solver(dt=DT, g=2.115)

study.field_drives.add(
    fm.RegionalFieldDrive(
        id="gamma-sinc",
        name="Uniform transverse sinc pulse",
        target=fm.FieldTarget.global_domain(),
        amplitude_B_T=AMPLITUDE,
        direction=(0.0, 1.0, 0.0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.SincPulse(cutoff_hz=CUTOFF, t0=T0),
        time_origin="stage_local",
        activation=fm.DriveActivation.stage_ids(["excite"]),
    )
)

study.tableautosave(
    SAMPLE_DT,
    quantities=["time", "step", "mx", "my", "mz", "E_drive", "E_total", "max_torque"],
)
study.save("m", every=max(SAMPLE_DT, 2e-12))
study.save("H_drive", every=SAMPLE_DT)
study.save("H_eff", every=max(SAMPLE_DT, 2e-12))

study.runtime_metadata(
    "spin_wave_response",
    {
        "schema_version": "spin_wave_response.request.v1",
        "analysis": "gamma",
        "response_component": "my",
        "weighting": "Ms_times_lumped_volume",
        "detrend": "linear",
        "window": "hann",
        "susceptibility_floor_fraction": 1e-6,
    },
)
study.stages.add_minimize(stage_id="relax", method="bb", max_steps=RELAX_STEPS, tol=5e2)
study.stages.add_run(stage_id="excite", until=UNTIL, output_every=SAMPLE_DT)
