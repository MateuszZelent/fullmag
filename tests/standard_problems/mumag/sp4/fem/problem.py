"""Public Fullmag study for strict FEM SP4 qualification."""

from __future__ import annotations

import os
from pathlib import Path

import fullmag as fm

from tests.standard_problems.mumag.sp4.common.contract import (
    CONTRACT,
    DEFAULT_RELAXATION_ALGORITHM,
    LEGACY_ALL_TET_RELAXATION_TORQUE_TOLERANCE_APM,
    PRODUCTION_RELAXATION_ALGORITHMS,
    RELAXATION_DT_MAX_S,
    MIXED_P1_RELAXATION_TORQUE_TOLERANCE_APM,
    validate_device,
)
from tests.standard_problems.mumag.sp4.fem.matrix_contract import (
    SP4MeshVariant,
    validate_topology_layers,
)


MUMAX3_COMPATIBILITY_MODE = "mumax3"
NATIVE_COMPATIBILITY_MODE = "native"
MUMAX3_DEMAG_ACCURACY_CONTRACT = {
    "schema_version": "fullmag.fem.demag_accuracy.v1",
    "profile": "mumax3_sp4_v1",
    "required_potential_order": 2,
    "required_topology": "all_tet",
}


def _validate_compatibility_topology(
    compatibility_mode: str,
    topology_variant: str,
    airbox: str,
) -> None:
    if compatibility_mode not in {
        NATIVE_COMPATIBILITY_MODE,
        MUMAX3_COMPATIBILITY_MODE,
    }:
        raise ValueError(
            "unsupported FULLMAG_SP4_COMPATIBILITY: "
            f"{compatibility_mode!r}; expected "
            f"{MUMAX3_COMPATIBILITY_MODE!r} or {NATIVE_COMPATIBILITY_MODE!r}"
        )
    if (
        compatibility_mode == MUMAX3_COMPATIBILITY_MODE
        and topology_variant != "all_tet"
    ):
        raise ValueError(
            "FULLMAG_SP4_COMPATIBILITY=mumax3 requires "
            "FULLMAG_SP4_TOPOLOGY_VARIANT=all_tet: mixed_p1 contains pyramid "
            "cells and resolves Poisson-Robin to a P1 scalar potential, so it "
            "cannot provide a MuMax3-compatible FEM texture or energy"
        )
    if compatibility_mode == MUMAX3_COMPATIBILITY_MODE and airbox != "baseline":
        raise ValueError(
            "FULLMAG_SP4_COMPATIBILITY=mumax3 requires "
            "FULLMAG_SP4_AIRBOX=baseline: the expanded Robin airbox changes "
            "the uniform-state demag oracle and is not qualified by the "
            "MuMax3/FDM compatibility profile"
        )


class SP4RunRequest:
    def __init__(
        self,
        phase,
        case,
        device,
        mesh,
        airbox,
        initial_state,
        duration_s,
        topology_variant,
        layers,
        compatibility_mode=MUMAX3_COMPATIBILITY_MODE,
    ):
        self.phase = phase
        self.case = case
        self.device = device
        self.mesh = mesh
        self.airbox = airbox
        self.initial_state = initial_state
        self.duration_s = duration_s
        self.topology_variant = topology_variant
        self.layers = layers
        self.compatibility_mode = compatibility_mode
        _validate_compatibility_topology(
            compatibility_mode,
            topology_variant,
            airbox,
        )

    @classmethod
    def from_environment(cls) -> "SP4RunRequest":
        phase = os.environ.get("FULLMAG_SP4_PHASE", "relax")
        case = os.environ.get("FULLMAG_SP4_CASE", "case-a")
        device = validate_device(os.environ.get("FULLMAG_SP4_DEVICE", "cpu"))
        mesh = os.environ.get("FULLMAG_SP4_MESH", "medium")
        airbox = os.environ.get("FULLMAG_SP4_AIRBOX", "baseline")
        topology_variant = os.environ.get(
            "FULLMAG_SP4_TOPOLOGY_VARIANT", "all_tet"
        )
        compatibility_mode = os.environ.get(
            "FULLMAG_SP4_COMPATIBILITY", MUMAX3_COMPATIBILITY_MODE
        ).strip().lower()
        layer_value = os.environ.get("FULLMAG_SP4_LAYERS")
        if layer_value is None:
            layers = None
        else:
            try:
                layers = int(layer_value)
            except ValueError as error:
                raise ValueError("FULLMAG_SP4_LAYERS must be an integer") from error
        validate_topology_layers(topology_variant, layers)
        if phase not in {"relax", "dynamic", "replay-before", "replay-after"}:
            raise ValueError(f"unsupported SP4 phase: {phase}")
        if case not in {item.id for item in CONTRACT.cases}:
            raise ValueError(f"unsupported SP4 case: {case}")
        if mesh not in {item.id for item in CONTRACT.meshes}:
            raise ValueError(f"unsupported SP4 mesh: {mesh}")
        if airbox not in {item.id for item in CONTRACT.airboxes}:
            raise ValueError(f"unsupported SP4 airbox: {airbox}")
        state = os.environ.get("FULLMAG_SP4_INITIAL_STATE")
        if phase != "relax" and not state:
            raise ValueError("dynamic SP4 phase requires FULLMAG_SP4_INITIAL_STATE")
        duration = float(os.environ.get("FULLMAG_SP4_DURATION_S", "1e-9"))
        if not 0 < duration <= CONTRACT.maximum_duration_s:
            raise ValueError("SP4 duration is outside (0, 5 ns]")
        return cls(
            phase,
            case,
            device,
            mesh,
            airbox,
            Path(state) if state else None,
            duration,
            topology_variant,
            layers,
            compatibility_mode,
        )


def build_study(request: SP4RunRequest):
    mesh = next(item for item in CONTRACT.meshes if item.id == request.mesh)
    airbox = next(item for item in CONTRACT.airboxes if item.id == request.airbox)
    case = next(item for item in CONTRACT.cases if item.id == request.case)
    mesh_variant = SP4MeshVariant(
        request.topology_variant,
        request.layers,
        mesh,
        airbox,
    )
    compatibility_label = request.compatibility_mode
    study = fm.study(
        f"mumag_sp4_fem_{request.phase}_{request.case}_{request.device}_"
        f"{request.mesh}_{request.airbox}_{request.topology_variant}_"
        f"{mesh_variant.layer_key}_{compatibility_label}"
    )
    study.engine("fem")
    study.device(request.device, precision="double")
    if request.compatibility_mode == MUMAX3_COMPATIBILITY_MODE:
        # This metadata is executable: the FEM planner predicts the scalar
        # potential order from the realized MeshIR and fails closed unless the
        # actual topology can provide this contract.  It prevents another
        # client or a later mesh-policy edit from silently reintroducing P1.
        study.runtime_metadata(
            "fem_demag_accuracy_contract",
            MUMAX3_DEMAG_ACCURACY_CONTRACT,
        )
    study.universe(mode="manual", size=airbox.dimensions_m, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
    study.universe.mesh(
        maximum_element_size=airbox.hmax_m,
        maximum_element_growth_rate=1.7,
        grading="geometric",
    )
    body = study.geometry(fm.Box(size=CONTRACT.dimensions_m, name="film"), name="film")
    body.Ms = CONTRACT.ms_a_per_m
    body.Aex = CONTRACT.aex_j_per_m
    body.alpha = CONTRACT.alpha
    body.m = (fm.init.UniformMagnetization(CONTRACT.initial_m) if request.initial_state is None else fm.load_magnetization(request.initial_state, format="json"))
    if request.topology_variant == "all_tet":
        if request.compatibility_mode == MUMAX3_COMPATIBILITY_MODE:
            # The MuMax3 comparison lane needs the independent P2 scalar
            # potential (mixed meshes with pyramids are intentionally P1).
            # Do not add component-restricted sub-box fields here: Gmsh's
            # component-volume restriction is not a safe global background
            # field for a shared airbox and would refine the overlapping air
            # slab at the 1 nm target. The 3 nm body mesh already matches the
            # MuMax3 cell scale and the P2 potential controls the demag error.
            body.mesh(
                maximum_element_size=mesh.hmax_m,
                algorithm_2d=1,
                algorithm_3d=1,
                # Native OCC Delaunay can leave a sub-threshold sliver in the
                # 3 nm film/airbox fragment.  Netgen relocates the generated
                # first-order tetrahedra before MeshIR extraction while
                # preserving the conformal CAD boundaries and region markers.
                optimize="Netgen",
                optimize_iterations=1,
                order=1,
            )
        else:
            body.mesh(maximum_element_size=mesh.hmax_m, order=1)
    else:
        body.mesh.thin_film(
            minimum_element_size=mesh.hmax_m,
            maximum_element_size=mesh.hmax_m,
            layers=request.layers,
            topology="prismatic",
            exact_layers=True,
            transition="pyramid_to_tetrahedra",
            order=1,
        )
    study.demag(realization="poisson_robin")
    study.fem_demag_solver(solver="CG", preconditioner="AMG", rtol=1e-12, max_iterations=500)
    study.build_domain_mesh()
    table_quantities = [
        "step",
        "t",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "e_total",
        "max_torque_T",
    ]
    if request.phase == "relax":
        algorithm = os.environ.get("FULLMAG_SP4_RELAX_ALGORITHM", DEFAULT_RELAXATION_ALGORITHM)
        maximum_steps = int(os.environ.get("FULLMAG_SP4_RELAX_MAX_STEPS", "50000"))
        default_torque_tolerance_apm = (
            MIXED_P1_RELAXATION_TORQUE_TOLERANCE_APM
            if request.topology_variant == "mixed_p1"
            else LEGACY_ALL_TET_RELAXATION_TORQUE_TOLERANCE_APM
        )
        torque_tolerance_apm = float(
            os.environ.get(
                "FULLMAG_SP4_RELAX_TOL_APM",
                str(default_torque_tolerance_apm),
            )
        )
        if algorithm == "llg_overdamped":
            relax_stage = study.stages.add_relax(
                stage_id="relax",
                algorithm=algorithm,
                solver="rk23",
                dt_initial=1e-15,
                dt_min=1e-17,
                dt_max=RELAXATION_DT_MAX_S,
                max_err=1e-7,
                relax_alpha=1.0,
                max_steps=maximum_steps,
                tolA=torque_tolerance_apm,
            )
        elif algorithm in PRODUCTION_RELAXATION_ALGORITHMS:
            relax_stage = study.stages.add_relax(
                stage_id="relax",
                algorithm=algorithm,
                max_steps=maximum_steps,
                tolA=torque_tolerance_apm,
            )
        else:
            raise ValueError(f"unsupported SP4 relaxation algorithm: {algorithm}")
        relax_stage.tableautosave(every_steps=10, quantities=table_quantities)
    else:
        study.tableautosave(CONTRACT.sample_period_s, quantities=table_quantities)
        study.solver(
            integrator="rk45",
            gamma=CONTRACT.gamma_mu0_m_per_as,
            dt_initial=1e-15,
            dt_min=1e-17,
            dt_max=2e-13,
            max_err=1e-7,
        )
        study.b_ext(*case.field_t)
        study.run(request.duration_s)
    return study, body


REQUEST = SP4RunRequest.from_environment()
study, magnet = build_study(REQUEST)
