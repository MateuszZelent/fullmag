"""Common Fullmag case for the FDM/FEM/MuMax3 sinc-layer comparison."""

from __future__ import annotations

import os

import fullmag as fm


FILM_SIZE_M = (500e-9, 500e-9, 10e-9)
FDM_CELL_M = (2.5e-9, 2.5e-9, 10e-9)
AIRBOX_SIZE_M = (1e-6, 1e-6, 1e-6)
MS_A_PER_M = 800e3
AEX_J_PER_M = 13e-12
ALPHA = 0.01
BIAS_B_T = (100e-3, 0.0, 0.0)
DRIVE_AMPLITUDE_B_T = 1e-3
DRIVE_DIRECTION = (0.0, 1.0, 0.0)
FCUT_HZ = 10e9
T0_S = 20.0 / FCUT_HZ
TOTAL_TIME_S = 40.0 / FCUT_HZ
RELAX_ALGORITHM = "llg_overdamped"
RELAX_SOLVER = "heun"
RELAX_DT_S = 5e-14
RELAX_TOLERANCE_T = 1e-5
RELAX_MAX_STEPS = 50_000
DYNAMIC_STEPS = 80_000
DYNAMIC_DT_S = TOTAL_TIME_S / DYNAMIC_STEPS
TABLE_QUANTITIES = (
    "step",
    "t",
    "mx",
    "my",
    "mz",
    "e_ex",
    "e_demag",
    "e_ext",
    "e_drive",
    "e_ani",
    "e_dmi",
    "e_total",
)

FEM_DEMAG_REALIZATIONS = {"poisson_robin", "fredkin_koehler"}


def _requested_backend() -> str:
    backend = os.environ.get("FULLMAG_SINC_LAYER_BACKEND", "").strip().lower()
    fem_launcher_device = os.environ.get("FULLMAG_FEM_EXECUTION", "").strip().lower()
    fdm_launcher_device = os.environ.get("FULLMAG_FDM_EXECUTION", "").strip().lower()
    if not backend:
        if fem_launcher_device in {"cpu", "gpu"}:
            backend = "fem"
        elif fdm_launcher_device in {"cpu", "cuda"}:
            backend = "fdm"
    if backend not in {"fdm", "fem"}:
        raise ValueError(
            "FULLMAG_SINC_LAYER_BACKEND must be set to 'fdm' or 'fem'; "
            "the managed launcher may select the corresponding backend through "
            "FULLMAG_FEM_EXECUTION or FULLMAG_FDM_EXECUTION"
        )
    return backend


def _requested_fem_demag() -> str:
    demag = os.environ.get("FULLMAG_SINC_LAYER_DEMAG", "poisson_robin").strip().lower()
    if demag not in FEM_DEMAG_REALIZATIONS:
        choices = ", ".join(sorted(FEM_DEMAG_REALIZATIONS))
        raise ValueError(
            "FULLMAG_SINC_LAYER_DEMAG must be one of: "
            f"{choices}"
        )
    return demag


def _configure_fdm(study: fm.StudyBuilder) -> None:
    device = os.environ.get("FULLMAG_FDM_EXECUTION", "cpu").strip().lower()
    if device == "cpu":
        study_device = "cpu"
    elif device == "cuda":
        study_device = "cuda:0"
    else:
        raise ValueError("FULLMAG_FDM_EXECUTION must be 'cpu' or 'cuda'")
    study.engine("fdm")
    study.device(study_device, precision="double")
    study.universe(
        mode="manual",
        size=FILM_SIZE_M,
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.cell(*FDM_CELL_M)


def _configure_fem(study: fm.StudyBuilder, demag: str) -> None:
    device = os.environ.get("FULLMAG_FEM_EXECUTION", "gpu").strip().lower()
    if device not in {"cpu", "gpu"}:
        raise ValueError("FULLMAG_FEM_EXECUTION must be 'cpu' or 'gpu'")
    study.engine("fem")
    study.device("cuda:0" if device == "gpu" else "cpu", precision="double")
    if demag == "poisson_robin":
        study.universe(
            mode="manual",
            size=AIRBOX_SIZE_M,
            center=(0.0, 0.0, 0.0),
            padding=(0.0, 0.0, 0.0),
        )
        study.universe.mesh(
            minimum_element_size=50e-9,
            maximum_element_size=100e-9,
            growth_rate=1.5,
        )


def _configure_common_physics(
    study: fm.StudyBuilder,
    backend: str,
    fem_demag: str | None = None,
) -> None:
    body = study.geometry(
        fm.Box(size=FILM_SIZE_M, name="py_layer_geometry"),
        name="py_layer",
        object_id="py_layer",
    )
    body.Ms = MS_A_PER_M
    body.Aex = AEX_J_PER_M
    body.alpha = ALPHA
    body.m = fm.texture.uniform(1.0, 0.0, 0.0)

    if backend == "fem":
        if fem_demag == "poisson_robin":
            body.mesh(
                maximum_element_size=2.5e-9,
                minimum_element_size=2.5e-9,
                order=1,
                mesh_strategy="swept_prism",
                topology="prismatic",
                through_thickness_elements=1,
                through_thickness_distribution="fixed",
                sweep_face_meshing="triangular",
                sweep_direction="auto",
                element_family="prism",
                transition_policy="pyramid_to_tetrahedra",
                exact_layer_count=True,
            )
            study.demag(realization="poisson_robin")
        elif fem_demag == "fredkin_koehler":
            body.mesh(
                maximum_element_size=2.5e-9,
                minimum_element_size=2.5e-9,
                order=1,
                mesh_strategy="free_tetrahedral",
                algorithm_2d=1,
                algorithm_3d=1,
                optimize="Netgen",
            )
            study.demag(realization="fredkin_koehler")
        else:
            raise ValueError(f"unsupported FEM demag realization: {fem_demag!r}")
        study.fem_demag_solver(
            solver="CG",
            preconditioner="AMG",
            rtol=1e-12,
            max_iterations=1000,
            print_level=0,
        )
        if fem_demag == "poisson_robin":
            study.build_domain_mesh()
        else:
            study.build_mesh()
    else:
        study.demag(realization="auto")

    study.b_ext(*BIAS_B_T)
    study.solver(
        integrator="rk45",
        fix_dt=DYNAMIC_DT_S,
        gamma=2.211e5,
    )
    study.runtime_metadata(
        "fdm_fem_mumax3_sinc_layer",
        {
            "schema_version": "fdm_fem_mumax3_sinc_layer.v1",
            "backend": backend,
            "fem_demag": fem_demag,
            "fem_mesh_mode": (
                "shared_domain_prism_thin_layer"
                if fem_demag == "poisson_robin"
                else "body_only_free_tetrahedral"
                if fem_demag == "fredkin_koehler"
                else None
            ),
            "geometry_size_m": list(FILM_SIZE_M),
            "fdm_cell_m": list(FDM_CELL_M),
            "pbc": [False, False, False],
            "material": {
                "name": "Py",
                "Ms_A_per_m": MS_A_PER_M,
                "A_J_per_m": AEX_J_PER_M,
                "alpha": ALPHA,
            },
            "bias_B_T": list(BIAS_B_T),
            "drive": {
                "amplitude_B_T": DRIVE_AMPLITUDE_B_T,
                "direction": list(DRIVE_DIRECTION),
                "cutoff_hz": FCUT_HZ,
                "t0_s": T0_S,
            },
            "duration_s": TOTAL_TIME_S,
            "dynamic_steps": DYNAMIC_STEPS,
            "dynamic_timestep_s": DYNAMIC_DT_S,
            "dynamic_initial_state": "relaxed_state_after_llg_overdamped",
            "relaxation_policy": "same_script_pre_dynamic_llg_overdamped",
            "relaxation": {
                "algorithm": RELAX_ALGORITHM,
                "solver": RELAX_SOLVER,
                "fixed_timestep_s": RELAX_DT_S,
                "torque_tolerance_T": RELAX_TOLERANCE_T,
                "max_steps": RELAX_MAX_STEPS,
                "state_artifact": "relaxed_state",
                "field_drive_active": False,
            },
            "table_sampling_policy": {
                "kind": "auto_sinc_cutoff",
                "nyquist_guard_factor": 1.3,
            },
            "magnetization_field_outputs": False,
        },
    )
    study.field_drives.add(
        fm.RegionalFieldDrive(
            id="uniform_sinc_y",
            name="Uniform transverse sinc pulse",
            target=fm.FieldTarget.global_domain(),
            amplitude_B_T=DRIVE_AMPLITUDE_B_T,
            direction=DRIVE_DIRECTION,
            spatial_profile=fm.UniformFieldProfile(),
            waveform=fm.SincPulse(cutoff_hz=FCUT_HZ, t0=T0_S),
            time_origin="stage_local",
            activation=fm.DriveActivation.stage_ids(["dynamic"]),
        )
    )
    relax = study.stages.add_relax(
        stage_id="relax",
        algorithm=RELAX_ALGORITHM,
        solver=RELAX_SOLVER,
        dt=RELAX_DT_S,
        tolT=RELAX_TOLERANCE_T,
        max_steps=RELAX_MAX_STEPS,
    )
    relax.tableautosave(
        every_steps=1,
        quantities=TABLE_QUANTITIES,
        table_id="relaxation",
    )
    study.stages.add_save_state(
        artifact_name="relaxed_state",
        format="json",
    )
    study.stages.tableautosave(
        "auto",
        quantities=TABLE_QUANTITIES,
        stage_id="dynamic_table",
    )
    study.stages.add_run(stage_id="dynamic", until=TOTAL_TIME_S)


BACKEND = _requested_backend()
study = fm.study("fdm_fem_mumax3_sinc_layer")
FEM_DEMAG = _requested_fem_demag() if BACKEND == "fem" else None
if BACKEND == "fdm":
    _configure_fdm(study)
else:
    _configure_fem(study, FEM_DEMAG)
_configure_common_physics(study, BACKEND, FEM_DEMAG)
