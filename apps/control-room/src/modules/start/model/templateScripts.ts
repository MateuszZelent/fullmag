/**
 * Canonical Fullmag Python for the shipped study templates (stage-first study API).
 *
 * Each script was loaded with `fullmag.runtime.helper export-run-config
 * --skip-geometry-assets` (executes the script and lowers it to ProblemIR; no solver
 * runs). That proves the script is valid Python against the public DSL, not that a
 * given backend can execute it. SI units throughout; `study.device("auto")` keeps the
 * requested intent so the resolved device is recorded at run time.
 */

export const TEMPLATE_SCRIPTS: Readonly<Record<string, string>> = {
  "umag-sp1": `"""uMAG Standard Problem #1: hysteresis of a 2 x 1 um Permalloy rectangle.

Field sweep along the long (x) axis. Re-run with direction=(0.0, 1.0, 0.0)
for the hard-axis loop. All quantities are SI.
"""

import fullmag as fm

nm = 1.0e-9

study = fm.study("umag_standard_problem_1")
study.engine("fdm")
study.device("auto", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(2000 * nm, 1000 * nm, 20 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(10 * nm, 10 * nm, 20 * nm)

film = study.geometry(fm.Box(size=(2000 * nm, 1000 * nm, 20 * nm), name="rectangle"), name="rectangle")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 1.0
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
study.solver(integrator="rk45", max_err=1e-5, dt_initial=1e-15, dt_max=1e-11)

study.stages.add_hysteresis_sweep(
    field_min_mT=-100.0,
    field_max_mT=100.0,
    field_step_mT=2.0,
    direction=(1.0, 0.0, 0.0),
    initial_protocol="positive_saturation",
    branch_mode="major_loop",
)
`,
  "umag-sp4": `"""uMAG Standard Problem #4: field-driven switching of a 500 x 125 x 3 nm strip.

The S-state is relaxed without a field, then field 1 of the problem
(mu0 H = -24.6, 4.3, 0.0 mT) is applied for one nanosecond with alpha = 0.02.
Compare <m> against the reference. All quantities are SI.
"""

import fullmag as fm

nm = 1.0e-9

study = fm.study("umag_standard_problem_4")
study.engine("fdm")
study.device("auto", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(500 * nm, 125 * nm, 3 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(2.5 * nm, 2.5 * nm, 3 * nm)

strip = study.geometry(fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="strip"), name="strip")
strip.Ms = 800.0e3
strip.Aex = 13.0e-12
strip.alpha = 0.02
strip.m = fm.texture.uniform(1.0, 0.1, 0.0)

study.exchange()
study.demag()
study.solver(integrator="rk45", max_err=1e-5, dt_initial=1e-15, dt_max=1e-12)

study.stages.add_relax(
    stage_id="s_state",
    algorithm="llg_overdamped",
    tolT=1e-6,
    max_steps=100000,
    relax_alpha=1.0,
    solver="rk45",
    dt="auto",
    max_error=1e-5,
    dt_min=1e-16,
    dt_max=1e-11,
)

study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.tableautosave(10e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])
study.stages.add_run(1e-9, stage_id="switching")
`,
  "spin-wave-dispersion": `"""Spin-wave dispersion of a YIG waveguide excited by a local sinc pulse.

A localized transverse field pulse excites a broad band of wave vectors; the
absorbing ends keep reflections out of the analysis interval, and the
space-time FFT of m_y gives omega(k). All quantities are SI.
"""

import fullmag as fm

nm = 1.0e-9

LENGTH = 4000 * nm
WIDTH = 100 * nm
THICKNESS = 20 * nm
ABSORBER = 400 * nm
SAMPLE_DT = 10e-12
CUTOFF_HZ = 20.0e9

study = fm.study("yig_spin_wave_dispersion")
study.engine("fdm")
study.device("auto", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(LENGTH, WIDTH, THICKNESS),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(5 * nm, 5 * nm, 10 * nm)

waveguide = study.geometry(fm.Box(size=(LENGTH, WIDTH, THICKNESS), name="waveguide"), name="waveguide")
waveguide.Ms = 140.0e3
waveguide.Aex = 3.65e-12
waveguide.alpha = 1.0e-3
waveguide.m = fm.texture.uniform(1.0, 0.0, 0.0)
waveguide.alpha.absorbing_boundary(
    total_width=ABSORBER,
    ramp_width=ABSORBER,
    max_damping=0.5,
    faces=("x-", "x+"),
)

source = waveguide.add_region(
    "source_strip",
    fm.Box(size=(40 * nm, WIDTH, THICKNESS), name="source_strip_geometry").translate((-0.25 * LENGTH, 0.0, 0.0)),
    priority=10,
)

study.exchange()
study.demag()
study.b_ext(50e-3, 0.0, 0.0)
study.solver(integrator="rk45", max_err=1e-5, dt_initial=1e-15, dt_max=5e-13)

study.field_drives.add(
    fm.RegionalFieldDrive(
        id="sinc_source",
        name="Localized sinc pulse",
        target=fm.FieldTarget.region(source.owner_object, source.region_id),
        amplitude_B_T=1.0e-3,
        direction=(0.0, 1.0, 0.0),
        spatial_profile=fm.UniformFieldProfile(),
        waveform=fm.SincPulse(cutoff_hz=CUTOFF_HZ, t0=5e-11),
        time_origin="stage_local",
        activation=fm.DriveActivation.stage_ids(["propagate"]),
    )
)

study.tableautosave(SAMPLE_DT, quantities=["time", "step", "mx", "my", "mz", "E_total"])
study.save("m", every=SAMPLE_DT)
study.runtime_metadata(
    "spin_wave_response",
    {
        "schema_version": "spin_wave_response.request.v1",
        "analysis": "finite_k",
        "response_component": "my",
        "probe_count": 128,
        "analysis_x_min_m": -LENGTH / 2 + ABSORBER,
        "analysis_x_max_m": LENGTH / 2 - ABSORBER,
        "excluded_absorber_ranges_m": [
            [-LENGTH / 2, -LENGTH / 2 + ABSORBER],
            [LENGTH / 2 - ABSORBER, LENGTH / 2],
        ],
        "window_space": "hann",
        "window_time": "hann",
    },
)

study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", tolT=1e-6, max_steps=20000, relax_alpha=1.0, solver="rk45", dt="auto", max_error=1e-5, dt_min=1e-16, dt_max=5e-13)
study.stages.add_run(stage_id="propagate", until=4e-9)
`,
  "magnonic-crystal-bands": `"""Magnonic crystal bands: Bloch-periodic eigenmodes of a 1D stripe lattice.

One unit cell holds two materials (host and stripe) along x; x is periodic and
the eigenmode study samples a Gamma-X-Gamma path. The demagnetizing field is
not included in this template. All quantities are SI.
"""

import fullmag as fm

nm = 1.0e-9

LATTICE = 200 * nm
STRIPE = 100 * nm
WIDTH = 40 * nm
THICKNESS = 10 * nm
K_MAX = 2.0e7

study = fm.study("magnonic_crystal_bands")
study.engine("fem")
study.device("auto", precision="double")
study.universe(
    mode="auto",
    size=(LATTICE, 4 * WIDTH, 4 * THICKNESS),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=40 * nm)

cell = study.geometry(fm.Box(size=(LATTICE, WIDTH, THICKNESS), name="unit_cell"), name="unit_cell")
cell.Ms = 800.0e3
cell.Aex = 13.0e-12
cell.alpha = 0.01
cell.m = fm.texture.uniform(1.0, 0.0, 0.0)
cell.mesh(maximum_element_size=10 * nm, order=1)

stripe = cell.add_region(
    "stripe",
    fm.Box(size=(STRIPE, WIDTH, THICKNESS), name="stripe_geometry").translate((LATTICE / 4, 0.0, 0.0)),
    priority=10,
    realization_policy="conformal",
)
stripe.material_transition(kind="sharp")
stripe.material.Ms = 1100.0e3
stripe.material.Aex = 20.0e-12

study.pbc(x=True)
study.build_domain_mesh()
study.b_ext(0.05, 0.0, 0.0)

study.save("spectrum")
study.save("dispersion")
study.save("mode", indices=(0,))

study.stages.add_eigenmodes(
    count=6,
    target="lowest",
    operator="full_2x2",
    include_demag=False,
    equilibrium_source="provided",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("G", (0.0, 0.0, 0.0)),
            fm.KPoint("X", (K_MAX, 0.0, 0.0)),
            fm.KPoint("G2", (0.0, 0.0, 0.0)),
        ],
        samples_per_segment=[16, 16],
    ),
    bc=fm.FloquetBC(["x_faces"]),
)
`,
  "skyrmion-phase-diagram": `"""Skyrmion stability: relaxation series over the out-of-plane field.

Interfacial DMI is fixed at D (change it and re-run to add a row of the phase
diagram). A Neel skyrmion is relaxed at each B_z; the topological charge is
tracked in the results viewer. All quantities are SI.
"""

import fullmag as fm

nm = 1.0e-9

D_INTERFACIAL = 3.0e-3
B_Z_SERIES_T = (0.0, 0.02, 0.04, 0.06, 0.08, 0.10)

study = fm.study("skyrmion_bz_series")
study.engine("fdm")
study.device("auto", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(160 * nm, 160 * nm, 1 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(2 * nm, 2 * nm, 1 * nm)

film = study.geometry(fm.Box(size=(160 * nm, 160 * nm, 1 * nm), name="film"), name="film")
film.Ms = 580.0e3
film.Aex = 15.0e-12
film.alpha = 0.3
film.Dind = D_INTERFACIAL
film.Ku1 = 0.8e6
film.anisU = (0.0, 0.0, 1.0)
film.m = fm.texture.neel_skyrmion(radius=20 * nm, wall_width=6 * nm, chirality=1, core_polarity=-1)

study.exchange()
study.demag()
study.solver(integrator="rk45", max_err=1e-5, dt_initial=1e-15, dt_max=1e-12)
study.tableautosave(1e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])

for index, bz in enumerate(B_Z_SERIES_T):
    study.b_ext(0.0, 0.0, bz)
    study.stages.add_relax(
        stage_id=f"relax_bz_{index}",
        algorithm="llg_overdamped",
        tolT=1e-6,
        max_steps=20000,
        relax_alpha=1.0,
        solver="rk45",
        dt="auto",
        max_error=1e-5,
        dt_min=1e-16,
        dt_max=1e-12,
    )
`,
  "broadband-fmr": `"""Broadband FMR: field-stepped linear-response absorption of a thin film.

At each bias field the film is relaxed and its susceptibility tensor is solved
over a frequency list; the resonance moves with the field. All quantities
are SI.
"""

import fullmag as fm

nm = 1.0e-9

BIAS_FIELDS_T = (0.05, 0.10, 0.15, 0.20)
FREQUENCIES_HZ = [2.0e9 + 0.5e9 * n for n in range(25)]

study = fm.study("broadband_fmr")
study.engine("fdm")
study.device("auto", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(5 * nm, 5 * nm, 5 * nm))
film = study.geometry(fm.Box(size=(200 * nm, 200 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
study.save_response("susceptibility_tensor")

for index, bias in enumerate(BIAS_FIELDS_T):
    study.b_ext(bias, 0.0, 0.0)
    study.stages.add_relax(
        stage_id=f"relax_{index}",
        algorithm="projected_gradient_bb",
        max_steps=2000,
        tolT=1e-8,
    )
    study.stages.add_frequency_response(
        frequencies_hz=FREQUENCIES_HZ,
        excitation_field_au_per_m=(0.0, 1.0, 0.0),
        observable="susceptibility_tensor",
        equilibrium_source="relax",
        magnetostatic_bc="open",
    )
`,
  "domain-wall-motion": `"""Current-driven domain-wall motion in a nanostrip (Zhang-Li spin-transfer torque).

A Bloch-type wall is relaxed in the strip centre and then driven by an in-plane
current along x. The strip ends carry absorbing damping layers. All
quantities are SI.
"""

import fullmag as fm

nm = 1.0e-9

LENGTH = 1000 * nm
WIDTH = 50 * nm
THICKNESS = 2 * nm

study = fm.study("domain_wall_motion")
study.engine("fdm")
study.device("auto", precision="double")
study.mode("strict")

study.universe(
    mode="manual",
    size=(LENGTH, WIDTH, THICKNESS),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(2 * nm, 2 * nm, 2 * nm)

strip = study.geometry(fm.Box(size=(LENGTH, WIDTH, THICKNESS), name="strip"), name="strip")
strip.Ms = 800.0e3
strip.Aex = 13.0e-12
strip.alpha = 0.02
strip.Ku1 = 0.5e6
strip.anisU = (1.0, 0.0, 0.0)
strip.m = fm.texture.domain_wall(
    width=20 * nm,
    kind="bloch",
    normal_axis="x",
    left=(1.0, 0.0, 0.0),
    right=(-1.0, 0.0, 0.0),
)
strip.alpha.absorbing_boundary(
    total_width=100 * nm,
    ramp_width=100 * nm,
    max_damping=0.5,
    faces=("x-", "x+"),
)

study.exchange()
study.demag()
study.solver(integrator="rk45", max_err=1e-5, dt_initial=1e-15, dt_max=1e-12)

study.stages.add_relax(
    stage_id="relax_wall",
    algorithm="llg_overdamped",
    tolT=1e-6,
    max_steps=50000,
    relax_alpha=1.0,
    solver="rk45",
    dt="auto",
    max_error=1e-5,
    dt_min=1e-16,
    dt_max=1e-11,
)

study.spin_torque(
    fm.ZhangLiSTT(
        current_density=(1.0e12, 0.0, 0.0),
        degree=0.5,
        beta=0.04,
        id="zhang_li_drive",
        lande_g=2.0,
        target=fm.RegionRef("strip"),
    )
)
study.tableautosave(10e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])
study.stages.add_run(2e-9, stage_id="drive")
`,
  "vortex-gyration": `"""Vortex gyration: field-pulse excitation of a Permalloy disc.

The vortex is relaxed, kicked by a short in-plane field pulse and then left to
gyrate; <m> over time gives the gyrotropic frequency. All quantities are SI.
"""

import fullmag as fm

nm = 1.0e-9

DIAMETER = 200 * nm
THICKNESS = 20 * nm

study = fm.study("vortex_gyration")
study.engine("fem")
study.device("auto", precision="double")
study.universe(
    mode="auto",
    size=(2 * DIAMETER, 2 * DIAMETER, 6 * THICKNESS),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=5 * nm, maximum_element_size=60 * nm)

disc = study.geometry(fm.Cylinder(radius=DIAMETER / 2, height=THICKNESS, name="disc"), name="disc")
disc.Ms = 800.0e3
disc.Aex = 13.0e-12
disc.alpha = 0.01
disc.m = fm.texture.vortex(circulation=1, core_polarity=1)
disc.mesh(minimum_element_size=3 * nm, maximum_element_size=8 * nm, order=1)

study.demag(realization="poisson_robin")
study.build_domain_mesh()
study.solver(dt=1e-13)

study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", tolT=1e-6, max_steps=5000, dt=1e-13)

study.b_ext(2.0e-3, 0.0, 0.0)
study.stages.add_run(50e-12, stage_id="pulse")
study.b_ext(0.0, 0.0, 0.0)
study.tableautosave(5e-12, quantities=["time", "step", "mx", "my", "mz", "E_total"])
study.stages.add_run(10e-9, stage_id="gyration")
`,
};
