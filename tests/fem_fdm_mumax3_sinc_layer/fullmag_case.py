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


def _configure_fdm(study: fm.StudyBuilder) -> None:
    study.engine("fdm")
    study.device("cpu", precision="double")
    study.universe(
        mode="manual",
        size=FILM_SIZE_M,
        center=(0.0, 0.0, 0.0),
        padding=(0.0, 0.0, 0.0),
    )
    study.cell(*FDM_CELL_M)


def _configure_fem(study: fm.StudyBuilder) -> None:
    device = os.environ.get("FULLMAG_FEM_EXECUTION", "gpu").strip().lower()
    if device not in {"cpu", "gpu"}:
        raise ValueError("FULLMAG_FEM_EXECUTION must be 'cpu' or 'gpu'")
    study.engine("fem")
    study.device("cuda:0" if device == "gpu" else "cpu", precision="double")
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


def _configure_common_physics(study: fm.StudyBuilder, backend: str) -> None:
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
            interface_hmax=2.5e-9,
            interface_thickness=2.5e-9,
            transition_distance=3e-9,
            edge_hmax=2.5e-9,
            edge_thickness=10e-9,
            edge_transition_distance=20e-9,
            corner_hmax=2.5e-9,
            corner_extent=5e-9,
            corner_transition_distance=10e-9,
        )
        study.demag(realization="poisson_robin")
        study.fem_demag_solver(
            solver="CG",
            preconditioner="AMG",
            rtol=1e-10,
            max_iterations=1000,
            print_level=0,
        )
        study.build_domain_mesh()
    else:
        study.demag(realization="auto")

    study.b_ext(*BIAS_B_T)
    study.solver(
        integrator="rk45",
        dt_initial=1e-12,
        dt_min=1e-15,
        dt_max=2e-12,
        max_err=1e-7,
        gamma=2.211e5,
    )
    study.runtime_metadata(
        "fdm_fem_mumax3_sinc_layer",
        {
            "schema_version": "fdm_fem_mumax3_sinc_layer.v1",
            "backend": backend,
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
            "dynamic_initial_state": (
                "uniform_declared_m0" if backend == "fdm" else "relaxed_state_after_bb"
            ),
            "relaxation_policy": (
                "excluded_from_dynamic_benchmark"
                if backend == "fdm"
                else "included_in_deferred_fem_probe"
            ),
            "table_sampling_policy": {
                "kind": "auto_sinc_cutoff",
                "nyquist_guard_factor": 1.3,
            },
            "magnetization_field_outputs": False,
        },
    )

    if backend == "fem":
        study.stages.add_minimize(
            stage_id="relax",
            method="bb",
            tolT=1e-6,
            max_steps=5000,
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
    study.stages.tableautosave(
        "auto",
        quantities=TABLE_QUANTITIES,
        stage_id="dynamic_table",
    )
    study.stages.add_run(stage_id="dynamic", until=TOTAL_TIME_S)


BACKEND = _requested_backend()
study = fm.study("fdm_fem_mumax3_sinc_layer")
if BACKEND == "fdm":
    _configure_fdm(study)
else:
    _configure_fem(study)
_configure_common_physics(study, BACKEND)
