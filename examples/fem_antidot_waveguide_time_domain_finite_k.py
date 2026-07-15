"""Finite-k time-domain antidot waveguide with a local sinc source.

The propagation axis x is physically open.  Only the transverse y direction
is periodic.  Three nested high-damping slabs at each x end form a monotone
absorbing ramp outside the central analysis interval.
"""

import os
import fullmag as fm


LENGTH = float(os.environ.get("FULLMAG_FINITE_K_LENGTH_M", "2e-6"))
WIDTH = float(os.environ.get("FULLMAG_FINITE_K_WIDTH_M", "2e-7"))
THICKNESS = float(os.environ.get("FULLMAG_FINITE_K_THICKNESS_M", "1e-8"))
ABSORBER = float(os.environ.get("FULLMAG_FINITE_K_ABSORBER_M", "3e-7"))
DT = float(os.environ.get("FULLMAG_FINITE_K_DT_S", "1e-13"))
SAMPLE_DT = float(os.environ.get("FULLMAG_FINITE_K_SAMPLE_DT_S", "1e-12"))
UNTIL = float(os.environ.get("FULLMAG_FINITE_K_UNTIL_S", "2e-9"))
PROBE_COUNT = int(os.environ.get("FULLMAG_FINITE_K_PROBE_COUNT", "128"))
RELAX_STEPS = int(os.environ.get("FULLMAG_FINITE_K_RELAX_STEPS", "500"))
DEVICE = os.environ.get("FULLMAG_FEM_EXECUTION", "gpu")
CUTOFF = float(os.environ.get("FULLMAG_FINITE_K_CUTOFF_HZ", "3.5e10"))
T0 = float(os.environ.get("FULLMAG_FINITE_K_T0_S", "5e-11"))
MESH_SCALE = float(os.environ.get("FULLMAG_FINITE_K_MESH_SCALE", "1"))

study = fm.study("fem_antidot_waveguide_time_domain_finite_k")
study.engine("fem")
study.device(DEVICE, precision="double")
study.universe(mode="manual", size=(LENGTH, WIDTH, 90e-9), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(minimum_element_size=5e-9 * MESH_SCALE, maximum_element_size=20e-9 * MESH_SCALE, growth_rate=1.4)
study.pbc(y=True, demag="periodic_airbox_k0")

film = fm.Box(size=(LENGTH, WIDTH, THICKNESS), name="antidot_waveguide_base")
hole_spacing = min(200e-9, LENGTH / 5.0)
hole_count = max(1, int((LENGTH - 2 * ABSORBER) / hole_spacing))
hole_centres = [(index - (hole_count - 1) / 2) * hole_spacing for index in range(hole_count)]
hole_radius = min(25e-9, 0.2 * WIDTH, 0.2 * hole_spacing)
holes = fm.Cylinder(radius=hole_radius, height=THICKNESS, name="hole_0").translate((hole_centres[0], 0.0, 0.0))
for index, x_m in enumerate(hole_centres[1:], start=1):
    holes = holes + fm.Cylinder(radius=25e-9, height=THICKNESS, name=f"hole_{index}").translate((x_m, 0.0, 0.0))

body = study.geometry(film - holes, name="antidot_waveguide")
body.Ms = 800e3
body.Aex = 13e-12
body.alpha = 0.01
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh.thin_film(minimum_element_size=3e-9 * MESH_SCALE, maximum_element_size=10e-9 * MESH_SCALE, curvature_factor=0.3, narrow_region_resolution=1.5, layers=1, order=1)

# Local source support.  Its stable region id is used by the field-drive target.
source = body.add_region(
    "source_strip",
    fm.Box(size=(min(50e-9, 0.12 * LENGTH), WIDTH, THICKNESS), name="source_strip_geometry").translate((-0.25 * LENGTH, 0.0, 0.0)),
    priority=30,
    realization_policy="conformal",
)
source.mesh(minimum_element_size=3e-9 * MESH_SCALE, maximum_element_size=6e-9 * MESH_SCALE, transition_distance=20e-9 * MESH_SCALE, order=1)

# Piecewise-quadratic approximation of alpha(x): 0.01 -> 0.08 -> 0.25 -> 0.8.
for side, sign in (("left", -1.0), ("right", 1.0)):
    for band, (width, alpha) in enumerate(((ABSORBER, 0.08), (2*ABSORBER/3, 0.25), (ABSORBER/3, 0.8)), start=1):
        centre = sign * (LENGTH / 2.0 - width / 2.0)
        absorber = body.add_region(
            f"{side}_absorber_{band}",
            fm.Box(size=(width, WIDTH, THICKNESS), name=f"{side}_absorber_geometry_{band}").translate((centre, 0.0, 0.0)),
            priority=band,
            realization_policy="conformal",
        )
        absorber.material_transition(kind="sharp")
        absorber.material.alpha = alpha

study.b_ext(10e-3, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-11, max_iterations=500)
study.build_domain_mesh()
study.solver(dt=DT, g=2.115)

study.field_drives.add(fm.RegionalFieldDrive(
    id="finite-k-local-sinc",
    name="Localized transverse sinc pulse",
    target=fm.FieldTarget.region(source.owner_object, source.region_id),
    amplitude_B_T=0.5e-3,
    direction=(0.0, 1.0, 0.0),
    spatial_profile=fm.UniformFieldProfile(),
    waveform=fm.SincPulse(cutoff_hz=CUTOFF, t0=T0),
    time_origin="stage_local",
    activation=fm.DriveActivation.stage_ids(["propagate"]),
))

study.tableautosave(SAMPLE_DT, quantities=["time", "step", "mx", "my", "mz", "E_drive", "E_total"])
study.save("m", every=SAMPLE_DT)
study.save("H_drive", every=SAMPLE_DT)
study.runtime_metadata("spin_wave_response", {
    "schema_version": "spin_wave_response.request.v1",
    "analysis": "finite_k",
    "response_component": "my",
    "probe_count": PROBE_COUNT,
    "analysis_x_min_m": -LENGTH/2 + ABSORBER,
    "analysis_x_max_m": LENGTH/2 - ABSORBER,
    "excluded_absorber_ranges_m": [[-LENGTH/2, -LENGTH/2 + ABSORBER], [LENGTH/2 - ABSORBER, LENGTH/2]],
    "window_space": "hann",
    "window_time": "hann",
})
study.stages.add_minimize(stage_id="relax", method="bb", max_steps=RELAX_STEPS, tol=5e2)
study.stages.add_run(stage_id="propagate", until=UNTIL, output_every=SAMPLE_DT)
