"""Relax a periodic antidot, then excite and analyse its k=0 modes in time.

This is the time-domain continuation of
``fem_periodic_antidot_relax_exchange_coupled.py``.  Its workflow is explicit:
``relax -> add antenna -> tableautosave -> autosave(m) -> FFT -> run``.  The
antenna and all sampling actions are therefore absent during relaxation and
become active only for the final time-domain run.

Sampling contract:
    - integration step: 0.1 ps,
    - table and magnetisation sample step: 0.5 ps,
    - simulated response window: 2 ns,
    - half-open response clock: 4000 samples,
    - Nyquist frequency: 1 THz,
    - FFT-bin spacing: 0.5 GHz.

Run with:
    fullmag --dev -i examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py
"""

import fullmag as fm


study = fm.study("fem_periodic_antidot_relax_exchange_coupled_time_domain_k0")

# Engine and universe
study.engine("fem")
study.device("gpu", precision="double")
study.universe(
    mode="manual",
    size=(200e-9, 200e-9, 90e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=5e-9,
    maximum_element_size=100e-9,
    growth_rate=1.5,
)
study.pbc(x=True, y=True, demag="periodic_airbox_k0")
study.interactive(True)

# Geometry
film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="periodic_antidot_base")
hole = fm.Cylinder(radius=25e-9, height=10e-9, name="central_hole")
body = study.geometry(film - hole, name="periodic_antidot_film")

# Material and mesh
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(
    minimum_element_size=3e-9,
    maximum_element_size=8e-9,
    curvature_factor=0.25,
    narrow_region_resolution=1.5,
    layers=1,
    order=1,
)

hole_transition = body.add_region(
    "hole_transition_refinement",
    fm.Cylinder(
        radius=43e-9,
        height=10e-9,
        name="hole_transition_refinement",
    ),
    priority=10,
    realization_policy="conformal",
)
hole_transition.mesh(
    minimum_element_size=0.5e-9,
    maximum_element_size=3e-9,
    transition_distance=10e-9,
    order=1,
)

# Interactions, mesh, and time solver
study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(
    solver="CG",
    preconditioner="AMG",
    rtol=1e-12,
    max_iterations=500,
)
study.objects.mesh.defaults(
    algorithm_2d=6,
    algorithm_3d=1,
    smoothing_steps=1,
    optimize_iterations=1,
    size_from_curvature=8,
    narrow_regions=1,
)
study.build_domain_mesh()


# User-facing time-domain parameters.
t_sampling = "auto"
t_run = 0.5e-9
f_cutoff = 3e9
pulse_t0 = 1e-10

# No antenna, table sampling, field autosave, or FFT is active here.
study.stages.add_minimize(
    stage_id="relax",
    method="bb",
    max_steps=500,
    tol=5.0e2,
)

# study.stages.add_field_drive(
#     stage_id="add-k0-antenna",
#     drive=fm.RegionalFieldDrive(
#         id="k0-sinc-antenna",
#         name="Uniform transverse k0 sinc antenna",
#         target=fm.FieldTarget.global_domain(),
#         amplitude_B_T=1e-9,
#         direction=(0.0, 1.0, 0.0),
#         spatial_profile=fm.UniformFieldProfile(),
#         waveform=fm.SincPulse(cutoff_hz=f_cutoff, t0=pulse_t0),
#         time_origin="stage_local",
#         activation=fm.DriveActivation.stage_ids(["excite"]),
#     ),
# )

# Each command below is a separate visible workflow stage.  The final Run only
# advances the LLG solver; it does not hide any output or analysis settings.
# study.stages.tableautosave(
#     t_sampling,
#     quantities=[
#         "t",
#         "mx",
#         "my",
#         "mz",
#     ],
#     stage_id="table-autosave-on",
# )
# study.stages.autosave("m", t_sampling, stage_id="autosave-m")
# study.stages.fft_response("my", stage_id="analyse-k0-response")
study.solver(
    integrator="rk45",
    # dt=1e-13,
    dt_min=1e-16,
    max_error=1e-6,
    g=2.115,
)
study.stages.add_run(until=t_run)
