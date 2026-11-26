"""Zero-field relaxation of a 300 x 300 x 5 nm permalloy film, for comparison with MuMax3.

The same case is run in MuMax3 (120 x 120 x 2 cells of 2.5 nm), fullmag FDM (same grid) and fullmag FEM.
The FEM film uses the prismatic thin-film layer of the SP4 FEM scenario by default (exact layers through the
thickness, pyramid-to-tetrahedra transition into a graded airbox). The table records the average
magnetization and the energies during the relaxation; its last row is the relaxed state.

Environment knobs (all optional):
FILM_ENGINE           fdm | fem                                   (default fem)
FILM_CELL             FDM cell / FEM layer thickness in metres    (default 2.5e-9)
FILM_FEM_MESH         prism | pure_prism | tet                    (default prism)
FILM_FEM_GPU_STRATEGY auto | cudss | cg_amg                       (default auto)
FILM_FEM_INPLANE      FEM in-plane element size in metres         (default FILM_CELL)
FILM_FEM_LAYERS       FEM prism layers through the thickness      (default round(thickness / FILM_CELL))
FILM_MODE             strict | extended                           (default strict)
FILM_TOLT             relaxation torque tolerance in tesla        (default 5.8349e-9, as in the SP4 scenario)
FILM_MAX_STEPS        relaxation step limit                       (default 100000)
FILM_INIT_M           OVF file with the initial state (FDM grid only; default uniform (1, 0.1, 0))
FEM_CASE_RTOL         FEM demag CG relative tolerance             (default 1e-12, as in the SP4 scenario)
"""

import os

import fullmag as fm

ENGINE = os.environ.get("FILM_ENGINE", "fem").strip().lower()
H = float(os.environ.get("FILM_CELL", "2.5e-9"))
FEM_MESH = os.environ.get("FILM_FEM_MESH", "prism").strip().lower()
GPU_STRATEGY = os.environ.get("FILM_FEM_GPU_STRATEGY", "auto").strip().lower()
H_INPLANE = float(os.environ.get("FILM_FEM_INPLANE", str(H)))
FEM_LAYERS = int(os.environ.get("FILM_FEM_LAYERS", "0")) or max(1, round(5e-9 / H))
MODE = os.environ.get("FILM_MODE", "strict").strip().lower()
TOLT = float(os.environ.get("FILM_TOLT", "5.8349e-9"))
MAX_STEPS = int(os.environ.get("FILM_MAX_STEPS", "100000"))
INIT_M = os.environ.get("FILM_INIT_M", "").strip()
RTOL = float(os.environ.get("FEM_CASE_RTOL", "1e-12"))
LX, LY, LZ = 300e-9, 300e-9, 5e-9

if FEM_MESH not in {"prism", "pure_prism", "tet"}:
    raise ValueError(
        f"Unsupported FILM_FEM_MESH={FEM_MESH!r}; expected 'prism', 'pure_prism', or 'tet'"
    )
if GPU_STRATEGY not in {"auto", "cudss", "cg_amg"}:
    raise ValueError(
        f"Unsupported FILM_FEM_GPU_STRATEGY={GPU_STRATEGY!r}; expected 'auto', 'cudss', or 'cg_amg'"
    )

study = fm.study(f"relax_film_300x300x5_{ENGINE}")
study.engine(ENGINE)
study.device("gpu", precision="double")
study.mode(MODE)
study.interactive(False)

if ENGINE == "fdm":
    study.universe(mode="manual", size=(LX, LY, LZ), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
    study.cell(H, H, H)
else:
    study.universe(mode="manual", size=(900e-9, 900e-9, 600e-9), center=(0.0, 0.0, 0.0),
                   padding=(0.0, 0.0, 0.0))
    study.universe.mesh(minimum_element_size=10e-9, maximum_element_size=110e-9,
                        maximum_element_growth_rate=1.9, grading="geometric")

film = study.geometry(fm.Box(size=(LX, LY, LZ), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
if INIT_M:
    film.m.loadfile(INIT_M, format="ovf")
else:
    film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

if ENGINE == "fdm":
    study.demag()
else:
    if FEM_MESH == "tet":
        film.mesh(maximum_element_size=H, order=1)
    elif FEM_MESH == "pure_prism":
        film.mesh.thin_film(
            minimum_element_size=H_INPLANE,
            maximum_element_size=H_INPLANE,
            layers=FEM_LAYERS,
            topology="prismatic",
            exact_layers=True,
            transition="pure_prism",
            order=1,
        )
    else:
        film.mesh.thin_film(
            minimum_element_size=H_INPLANE,
            maximum_element_size=H_INPLANE,
            layers=FEM_LAYERS,
            topology="prismatic",
            exact_layers=True,
            transition="pyramid_to_tetrahedra",
            order=1,
        )
    study.demag(realization="poisson_robin")
    study.fem_demag_solver(
        solver="CG",
        preconditioner="AMG",
        rtol=RTOL,
        max_iterations=600,
        gpu_strategy=GPU_STRATEGY,
    )
    study.build_domain_mesh()

study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=MAX_STEPS,
    tolT=TOLT,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "mx", "my", "mz", "e_ex", "e_demag", "e_total", "max_torque_T"],
        ),
        fields=[],
    )
)
study.stages.add_save_state(artifact_name="relaxed_m.zarr", format="zarr", dataset="m")
