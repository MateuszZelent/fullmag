"""Zero-field buckyball relaxation, FEM GPU, double precision.

Open this script in Fullmag and press Compute. Material and size come from
params.txt: Ms=400 kA/m, A=8 pJ/m, outer size=5 um. The largest STL bounding-box
extent defines the outer size; STL coordinates have no intrinsic units.

The initial state is saturated along +x, without a preparatory field stage.
This finds a local energy minimum, not a guaranteed ground state. Repeat with
other initial states and finer meshes before drawing physical conclusions.
The 8 nm magnetic mesh is below the exchange length (~8.9 nm), but mesh and
airbox convergence still require independent checks. This 5 um model can be
expensive; increasing MAGNETIC_MESH_M makes a preview, not a qualified result.

Pattern: tests/standard_problems/mumag/sp4/fem/scenarios/
relax_projected_gradient_bb.py. No eigenmode or subsequent field stage.
"""

# %% Parameters (SI)
from pathlib import Path
import sys

import fullmag as fm

SCRIPT_DIR = Path(__file__).resolve().parent
STL_PATH = SCRIPT_DIR / "buckyball.stl"
OUTER_SIZE_M = 5e-6
# Measured from the supplied binary STL; update if replacing the geometry.
STL_MAX_EXTENT = 5.361742973327637
STL_SCALE = OUTER_SIZE_M / STL_MAX_EXTENT
MS_A_PER_M = 400e3
AEX_J_PER_M = 8e-12
MAGNETIC_MESH_M = 8e-9
AIR_MESH_M = 500e-9
MAX_STEPS = 100_000
TORQUE_TOL_T = 1e-6

if not STL_PATH.is_file():
    raise FileNotFoundError(f"Missing buckyball geometry: {STL_PATH}")

# %% FEM GPU configuration; Compute starts the registered stages
study = fm.study("buckyball_zero_field_relax")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.interactive(True)
study.wait_for_solve(True)

# Explicit absolute storage keeps results and scratch on the admitted E: ext4 volume.
# This path is the private user-data bind of this task's Compose group.
RUN_DIR = Path("/user-data/buckyball-zero-field-20261115")
study.storage(
    output_dir=str(RUN_DIR / "relax.zarr"),
    temp_dir=str(RUN_DIR / "scratch"),
    data_format="zarr",
    cleanup="never",
    existing_output="error",
)

# %% Exterior domain for open-boundary demagnetization
study.universe(
    mode="manual",
    size=(3 * OUTER_SIZE_M,) * 3,
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    minimum_element_size=MAGNETIC_MESH_M,
    maximum_element_size=AIR_MESH_M,
    maximum_element_growth_rate=1.5,
    grading="geometric",
)

# %% Magnetic body: exchange and demag, no crystalline anisotropy
body = study.geometry(
    fm.ImportedGeometry(source=str(STL_PATH), scale=STL_SCALE, name="buckyball"),
    name="buckyball",
)
body.Ms = MS_A_PER_M
body.Aex = AEX_J_PER_M
body.alpha = 0.5
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
body.mesh(maximum_element_size=MAGNETIC_MESH_M, order=1)

study.demag(realization="poisson_robin")
study.b_ext(0.0, 0.0, 0.0)
study.fem_demag_solver(
    solver="CG", preconditioner="AMG", rtol=1e-10, max_iterations=1000,
)
# The supplied STL has nested exterior/cavity shells. Mesh the walls and both
# air domains explicitly instead of treating each shell as a magnetic solid.
sys.path.insert(0, str(SCRIPT_DIR))
from build_hollow_mesh import build_hollow_mesh

mesh_path = build_hollow_mesh(
    STL_PATH, RUN_DIR / "relax.msh", magnetic_size_m=MAGNETIC_MESH_M,
)
study.mesh.import_(
    mesh_path, region_map={"buckyball": 1},
    boundary_map={"outer": 1, "magnetic_air": 2}, coordinate_unit="um",
)
study.mesh.save_or_load(RUN_DIR / "relax.fullmag-mesh")

# %% Relax and retain energy/torque diagnostics plus the final magnetization
# A saved candidate is an equilibrium only after the terminal stop reason and
# max_torque_T have been checked; exhausting MAX_STEPS does not prove convergence.
study.stages.add_relax(
    stage_id="relax_zero_field",
    algorithm="projected_gradient_bb",
    max_steps=MAX_STEPS,
    tolT=TORQUE_TOL_T,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=[
                "step", "mx", "my", "mz", "e_ex", "e_demag",
                "e_total", "max_torque_T",
            ],
        ),
        fields=[],
    )
)
study.stages.add_save_state(
    artifact_name="buckyball_final_candidate_m.zarr",
    format="zarr",
    dataset="m",
)
