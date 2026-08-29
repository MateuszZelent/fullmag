from __future__ import annotations

import copy
import json
import math
import re
import tempfile
from pathlib import Path
from typing import Mapping, Sequence

from fullmag._validation import (
    AUTO_SINC_NYQUIST_GUARD_FACTOR,
    SamplingPeriod,
    normalize_sampling_period,
)
from fullmag.init.magnetization import (
    RandomMagnetization,
    SampledMagnetization,
    UniformMagnetization,
)
from fullmag.init.textures import PresetTexture
from fullmag.init.state_io import infer_magnetization_state_format
from fullmag.model.antenna import (
    AntennaFieldSource,
    CPWAntenna,
    DriveActivation,
    FieldTarget,
    GaussianPlaneWaveFieldProfile,
    GeometryMaskFieldProfile,
    MicrostripAntenna,
    RegionalFieldDrive,
    RfDrive,
    SincFieldProfile,
    SpinWaveExcitationAnalysis,
    UniformFieldProfile,
)
from fullmag.model.current_transport import CurrentTransport
from fullmag.model.discretization import FDM, FDMGrid, FEM, FDMDemag, FemLinearSolverPolicy
from fullmag.model.spin_torque import (
    DriftDiffusionSpinTorque as LegacyDriftDiffusionSpinTorque,
    InterfaceCppSTT,
    PrescribedSpinOrbitTorque,
    SlonczewskiSTT,
    SpinOrbitTorque,
    ZhangLiSTT,
)
from fullmag.model.spin_transport import (
    DriftDiffusionSpinTorque as CanonicalDriftDiffusionSpinTorque,
    SpinDriftDiffusion,
)
from fullmag.model.domain_frame import build_domain_frame, geometry_bounds as shared_geometry_bounds
from fullmag.model.dynamics import (
    ADAPTIVE_INTEGRATORS,
    AdaptiveTimestep,
    DEFAULT_GAMMA,
    LLG,
)
from fullmag.model.energy import BulkDMI, Constant, CubicAnisotropy, Demag, Exchange, InterfacialDMI, Magnetoelastic, OerstedField, OerstedCylinder, PiecewiseLinear, Pulse, SincPulse, Sinusoidal, ThermalNoise, UniaxialAnisotropy, Zeeman
from fullmag.model.eigen import serialize_k_sampling
from fullmag.model.geometry import (
    ArchWaveguide,
    Box,
    Cylinder,
    Difference,
    Ellipse,
    Ellipsoid,
    ImportedGeometry,
    Intersection,
    SinWaveguide,
    Translate,
    Union,
)
from fullmag.model.outputs import (
    SaveDispersion,
    SaveField,
    SaveMode,
    SaveResponse,
    SaveScalar,
    SaveSpectrum,
    Snapshot,
)
from fullmag.model.problem import Problem
from fullmag.model.study import (
    DEFAULT_RELAXATION_MAX_STEPS,
    DEFAULT_RELAXATION_TORQUE_TOLERANCE_APM,
    DEFAULT_TABLE_AUTOSAVE_QUANTITIES,
    Eigenmodes,
    FrequencyResponse,
    Hysteresis,
    RelaxStop,
    Relaxation,
    StageAutosave,
    TableAutosave,
    TimeEvolution,
)
from fullmag.runtime.loader import LoadedProblem, LoadedStage, load_problem_from_script


DEFAULT_ADAPTIVE_DT_MIN = 1e-15
DEFAULT_ADAPTIVE_ATOL = 1e-6


def _is_exact_max_err_policy(policy: AdaptiveTimestep) -> bool:
    return (
        policy._tolerance_mode == "max_error"
        and policy.rtol == 0.0
        and policy.safety == 0.9
        and policy.growth_limit == 2.0
        and policy.shrink_limit == 0.2
        and policy.max_spin_rotation is None
        and policy.norm_tolerance is None
    )


def _adaptive_timestep_draft(policy: AdaptiveTimestep | None) -> dict[str, object] | None:
    if policy is None or _is_exact_max_err_policy(policy):
        return None
    return {
        "atol": _text_number(policy.atol),
        "rtol": _text_number(policy.rtol),
        "dt_initial": _text_number(policy.dt_initial),
        "dt_min": _text_number(policy.dt_min),
        "dt_max": _text_number(policy.dt_max),
        "safety": _text_number(policy.safety),
        "growth_limit": _text_number(policy.growth_limit),
        "shrink_limit": _text_number(policy.shrink_limit),
        "max_spin_rotation": _text_number(policy.max_spin_rotation),
        "norm_tolerance": _text_number(policy.norm_tolerance),
    }


def _stage_adaptive_timestep_draft(
    policy: AdaptiveTimestep | None,
) -> dict[str, object] | None:
    if policy is None:
        return None
    return {
        "tolerance_mode": policy._tolerance_mode,
        "atol": _text_number(policy.atol),
        "rtol": _text_number(policy.rtol),
        "dt_initial": _text_number(policy.dt_initial),
        "dt_min": _text_number(policy.dt_min),
        "dt_max": _text_number(policy.dt_max),
        "safety": _text_number(policy.safety),
        "growth_limit": _text_number(policy.growth_limit),
        "shrink_limit": _text_number(policy.shrink_limit),
        "max_spin_rotation": _text_number(policy.max_spin_rotation),
        "norm_tolerance": _text_number(policy.norm_tolerance),
    }


def _advanced_policy_with_overrides(
    fallback: AdaptiveTimestep | None,
    overrides: dict[str, object],
) -> AdaptiveTimestep:
    nullable = {"dt_initial", "dt_max", "max_spin_rotation", "norm_tolerance"}
    defaults: dict[str, float | None] = {
        "atol": fallback.atol if fallback is not None else None,
        "rtol": fallback.rtol if fallback is not None else None,
        "dt_initial": fallback.dt_initial if fallback is not None else None,
        "dt_min": fallback.dt_min if fallback is not None else None,
        "dt_max": fallback.dt_max if fallback is not None else None,
        "safety": fallback.safety if fallback is not None else None,
        "growth_limit": fallback.growth_limit if fallback is not None else None,
        "shrink_limit": fallback.shrink_limit if fallback is not None else None,
        "max_spin_rotation": fallback.max_spin_rotation if fallback is not None else None,
        "norm_tolerance": fallback.norm_tolerance if fallback is not None else None,
    }
    merged = dict(defaults)
    for key in defaults:
        if key not in overrides:
            continue
        value = _number_or_none(overrides[key])
        if value is None and key not in nullable:
            raise ValueError(f"advanced adaptive override {key} cannot be cleared")
        merged[key] = value
    missing = [key for key in defaults if key not in nullable and merged[key] is None]
    if missing:
        raise ValueError(
            "advanced adaptive override requires " + ", ".join(sorted(missing))
        )
    return AdaptiveTimestep(
        atol=float(merged["atol"]),
        rtol=float(merged["rtol"]),
        dt_initial=merged["dt_initial"],
        dt_min=float(merged["dt_min"]),
        dt_max=merged["dt_max"],
        safety=float(merged["safety"]),
        growth_limit=float(merged["growth_limit"]),
        shrink_limit=float(merged["shrink_limit"]),
        max_spin_rotation=merged["max_spin_rotation"],
        norm_tolerance=merged["norm_tolerance"],
    )


def _max_error_policy_with_overrides(
    fallback: AdaptiveTimestep | None,
    overrides: dict[str, object],
) -> AdaptiveTimestep:
    def value(key: str, default: float | None, *, nullable: bool) -> float | None:
        if key not in overrides:
            return default
        resolved = _number_or_none(overrides[key])
        if resolved is None and not nullable:
            raise ValueError(f"convenience adaptive override {key} cannot be cleared")
        return resolved

    max_err_fallback = (
        fallback.atol
        if fallback is not None and fallback._tolerance_mode == "max_error"
        else None
    )
    max_err = value("max_err", max_err_fallback, nullable=False)
    if max_err is None:
        raise ValueError("convenience adaptive override requires max_err")
    return AdaptiveTimestep._from_max_error(
        max_err=max_err,
        dt_initial=value(
            "dt_initial", fallback.dt_initial if fallback is not None else None, nullable=True
        ),
        dt_min=value(
            "dt_min", fallback.dt_min if fallback is not None else 1e-15, nullable=False
        ),
        dt_max=value(
            "dt_max", fallback.dt_max if fallback is not None else None, nullable=True
        ),
    )


def _builder_base_problem(loaded: LoadedProblem) -> Problem:
    return loaded.pipeline_base_problem(loaded.workspace_problem or loaded.problem)


def export_builder_draft(loaded: LoadedProblem) -> dict[str, object]:
    base_problem = _builder_base_problem(loaded)
    relax_stage = _first_relax_stage(loaded)
    source_root = loaded.source_path.parent
    base_dynamics = getattr(base_problem.study, "dynamics", None)
    adaptive_policy = (
        base_dynamics.adaptive_timestep if base_dynamics is not None else None
    )
    exact_max_err = (
        adaptive_policy is not None and _is_exact_max_err_policy(adaptive_policy)
    )

    draft = {
        "revision": 1,
        "backend": base_problem.runtime.backend_target.value,
        "requested_backend": base_problem.runtime.backend_target.value,
        "requested_device": base_problem.runtime.device_target.value,
        "requested_precision": base_problem.runtime.execution_precision.value,
        "requested_mode": base_problem.runtime.execution_mode.value,
        "cpu_threads": base_problem.runtime.cpu_threads,
        "fem_demag_solver_policy": _export_fem_demag_solver_policy(base_problem),
        "exchange_enabled": _problem_has_exchange(base_problem),
        "demag_enabled": _problem_has_demag(base_problem),
        "demag_realization": _export_demag_realization(base_problem),
        "external_field": _problem_external_field(base_problem),
        "solver": {
            "integrator": base_dynamics.integrator if base_dynamics is not None else None,
            "fixed_timestep": _text_number(base_dynamics.fixed_timestep) if base_dynamics is not None else None,
            "dt_initial": _text_number(
                adaptive_policy.dt_initial
                if exact_max_err
                else None
            ),
            "dt_min": _text_number(
                adaptive_policy.dt_min
                if exact_max_err
                else None
            ),
            "dt_max": _text_number(
                adaptive_policy.dt_max
                if exact_max_err
                else None
            ),
            "max_err": _text_number(
                adaptive_policy.atol
                if exact_max_err
                else None
            ),
            "adaptive_timestep": _adaptive_timestep_draft(adaptive_policy),
            "demag_interval_s": _text_number(
                base_dynamics.field_refresh.demag_interval_s
                if base_dynamics is not None and base_dynamics.field_refresh is not None
                else None
            ),
            "relax_algorithm": relax_stage.algorithm if relax_stage is not None else "llg_overdamped",
            "torque_tolerance": _text_number(
                relax_stage.torque_tolerance
                if relax_stage is not None
                else DEFAULT_RELAXATION_TORQUE_TOLERANCE_APM
            ),
            "energy_tolerance": _text_number(
                relax_stage.energy_tolerance if relax_stage is not None else None
            ),
            "max_relax_steps": str(
                relax_stage.max_steps
                if relax_stage is not None
                else DEFAULT_RELAXATION_MAX_STEPS
            ),
            "max_relaxation_time_s": _text_number(
                relax_stage.stop.max_relaxation_time_s
                if relax_stage is not None
                else None
            ),
        },
        "mesh": _export_global_mesh_state(base_problem),
        "universe": _export_universe(base_problem),
        "domain_frame": _export_domain_frame(base_problem, source_root=source_root),
        "stages": [
            _export_stage_draft_with_identity(stage)
            for stage in _builder_stage_sequence(loaded)
        ],
        "study_pipeline": export_study_pipeline_document(loaded),
        "table_autosave": _export_table_autosave(base_problem),
        "initial_state": _export_initial_state(base_problem),
        "geometries": [
            *[
                _export_geometry_entry(magnet, base_problem, source_root=source_root)
                for magnet in base_problem.magnets
            ],
            *[
                _export_auxiliary_geometry_entry(
                    geometry,
                    base_problem,
                    source_root=source_root,
                )
                for geometry in base_problem.auxiliary_geometries
            ],
        ],
        "couplings": [coupling.to_ir() for coupling in base_problem.couplings],
        "current_modules": [
            _export_current_module_entry(module) for module in base_problem.current_modules
        ],
        "spin_transports": [
            _export_spin_transport_entry(base_problem, module)
            for module in base_problem.spin_transports
        ],
        "field_drives": [drive.to_ir() for drive in base_problem.field_drives],
        "planar_monitors": [monitor.to_ir() for monitor in base_problem.monitors],
        "spin_torques": [
            _export_spin_torque_entry(module) for module in base_problem.spin_torques
        ],
        "oersted_terms": [
            term.to_ir()
            for term in base_problem.energy
            if isinstance(term, (OerstedCylinder, OerstedField))
        ],
        "excitation_analysis": _export_excitation_analysis(base_problem),
    }
    fdm_draft = _export_fdm(base_problem)
    if fdm_draft is not None:
        draft["fdm"] = fdm_draft
    solver_draft = draft["solver"]
    if base_dynamics is None or base_dynamics.fixed_timestep is None:
        solver_draft.pop("fixed_timestep", None)
    if not exact_max_err:
        for key in ("dt_initial", "dt_min", "dt_max", "max_err"):
            solver_draft.pop(key, None)
    if adaptive_policy is None or exact_max_err:
        solver_draft.pop("adaptive_timestep", None)
    return draft


def rewrite_loaded_problem_script(
    loaded: LoadedProblem,
    *,
    overrides: dict[str, object] | None = None,
    write: bool = False,
) -> dict[str, object]:
    rendered = render_loaded_problem_as_script(loaded, overrides=overrides)
    script_path = loaded.source_path

    if write:
        temp_path = script_path.with_name(f"{script_path.name}.fullmag.tmp")
        temp_path.write_text(rendered, encoding="utf-8")
        temp_path.replace(script_path)

    return {
        "script_path": str(script_path),
        "source_kind": _builder_source_kind(loaded.entrypoint_kind),
        "entrypoint_kind": loaded.entrypoint_kind,
        "written": write,
        "bytes_written": len(rendered.encode("utf-8")) if write else 0,
        **({"rendered_source": rendered} if not write else {}),
    }


def render_loaded_problem_as_script(
    loaded: LoadedProblem,
    *,
    overrides: dict[str, object] | None = None,
) -> str:
    overrides = _normalize_mapping(overrides)
    actual_stages = loaded.stages
    _validate_stage_compatibility(actual_stages)
    stages = actual_stages or (
        ()
        if loaded.entrypoint_kind == "flat_workspace"
        else (
            LoadedStage(
                problem=loaded.problem,
                entrypoint_kind=loaded.entrypoint_kind,
                default_until_seconds=loaded.default_until_seconds,
            ),
        )
    )

    base_problem = _builder_base_problem(loaded)
    surface = _script_api_surface(base_problem, overrides=overrides)
    magnet_vars = _magnet_variable_names(base_problem, overrides=overrides)
    lines: list[str] = []
    source_root = loaded.source_path.parent

    lines.extend(_render_header(loaded.source_path, loaded.entrypoint_kind))
    lines.append("")
    lines.append("import fullmag as fm")
    lines.append("")
    if surface == "study":
        lines.extend(_render_study_binding(base_problem))
        lines.append("")

    lines.extend(_render_runtime(base_problem, overrides=overrides, surface=surface))
    lines.append("")
    _validate_energy_terms(base_problem)
    lines.extend(
        _render_geometry_and_materials(
            base_problem,
            magnet_vars,
            source_root=source_root,
            overrides=overrides,
            surface=surface,
        )
    )
    region_owned_lines, region_vars = _render_region_owned_authoring(
        base_problem,
        magnet_vars,
        source_root=source_root,
        overrides=overrides,
    )
    if region_owned_lines:
        lines.append("")
        lines.extend(region_owned_lines)
    geom_viz_lines = _render_geometry_visualization_hints(
        base_problem, magnet_vars, base_problem.runtime_metadata
    )
    if geom_viz_lines:
        lines.extend(geom_viz_lines)

    external_field_lines = _render_external_field(
        base_problem,
        overrides=overrides,
        surface=surface,
    )
    if external_field_lines:
        lines.append("")
        lines.extend(external_field_lines)

    current_module_lines = _render_current_modules(
        base_problem,
        overrides=overrides,
        surface=surface,
    )
    if current_module_lines:
        lines.append("")
        lines.extend(current_module_lines)

    spin_transport_lines = _render_spin_transports(
        base_problem, surface=surface, overrides=overrides
    )
    if spin_transport_lines:
        lines.append("")
        lines.extend(spin_transport_lines)

    field_drive_lines = _render_field_drives(base_problem, surface=surface)
    if field_drive_lines:
        lines.append("")
        lines.extend(field_drive_lines)

    oersted_lines = _render_oersted_terms(
        base_problem, overrides=overrides, surface=surface
    )
    if oersted_lines:
        lines.append("")
        lines.extend(oersted_lines)

    spin_torque_lines = _render_spin_torques(
        base_problem, surface=surface, overrides=overrides
    )
    if spin_torque_lines:
        lines.append("")
        lines.extend(spin_torque_lines)

    exchange_lines = _render_exchange(base_problem, overrides=overrides, surface=surface)
    if exchange_lines:
        lines.append("")
        lines.extend(exchange_lines)

    coupling_lines = _render_couplings(
        base_problem,
        magnet_vars,
        region_vars=region_vars,
        overrides=overrides,
        surface=surface,
    )
    if coupling_lines:
        lines.append("")
        lines.extend(coupling_lines)

    monitor_lines = _render_planar_monitors(
        base_problem,
        overrides=overrides,
        surface=surface,
    )
    if monitor_lines:
        lines.append("")
        lines.extend(monitor_lines)

    demag_lines = _render_demag(base_problem, overrides=overrides, surface=surface)
    if demag_lines:
        lines.append("")
        lines.extend(demag_lines)

    thermal_lines = _render_thermal_noise(base_problem, surface=surface)
    if thermal_lines:
        lines.append("")
        lines.extend(thermal_lines)

    mesh_lines = _render_mesh_workflow(
        base_problem,
        magnet_vars,
        source_root=source_root,
        overrides=overrides,
        surface=surface,
    )
    if mesh_lines:
        lines.append("")
        lines.extend(mesh_lines)

    lines.append("")
    lines.extend(_render_solver(base_problem, overrides=overrides, surface=surface))

    output_lines = _render_outputs(base_problem, magnet_vars, surface=surface)
    if output_lines:
        lines.append("")
        lines.extend(output_lines)

    table_autosave_lines = _render_table_autosave(
        base_problem,
        overrides=overrides,
        surface=surface,
    )
    if table_autosave_lines:
        lines.append("")
        lines.extend(table_autosave_lines)

    excitation_lines = _render_excitation_analysis(
        base_problem,
        overrides=overrides,
        surface=surface,
    )
    if excitation_lines:
        lines.append("")
        lines.extend(excitation_lines)

    stage_lines = _render_stages(stages, overrides=overrides, surface=surface)
    if stage_lines:
        lines.append("")
        lines.extend(stage_lines)

    normalized = "\n".join(lines).rstrip() + "\n"
    return normalized


def render_loaded_problem_as_flat_script(
    loaded: LoadedProblem,
    *,
    overrides: dict[str, object] | None = None,
) -> str:
    return render_loaded_problem_as_script(loaded, overrides=overrides)


def render_scene_document_as_script(scene_document: Mapping[str, object]) -> str:
    """Render a canonical Python script directly from a SceneDocument.

    The scene is first validated through the existing SceneDocument → builder
    adapter.  A small, deterministic capture script supplies the typed
    ``Problem`` required by the established renderer; all authored values are
    then applied through the same builder overrides used by script-backed UI
    export.  No user script or placeholder magnet is required.
    """
    from fullmag.runtime.scene_document import (
        build_builder_from_scene_document,
        builder_overrides_from_scene_document,
    )

    scene = dict(scene_document)
    builder = build_builder_from_scene_document(scene)
    bootstrap = _render_scene_document_bootstrap(builder)
    scene_for_render = copy.deepcopy(scene)
    _inherit_scene_stage_timestep(scene_for_render, builder)
    with tempfile.TemporaryDirectory(prefix="fullmag-scene-export-") as temporary:
        script_path = Path(temporary) / "scene_document.py"
        script_path.write_text(bootstrap, encoding="utf-8")
        loaded = load_problem_from_script(script_path, lightweight_assets=True)
        return render_loaded_problem_as_script(
            loaded,
            overrides=builder_overrides_from_scene_document(scene_for_render),
        )


def _inherit_scene_stage_timestep(
    scene: dict[str, object], builder: Mapping[str, object]
) -> None:
    """Keep a valid global fixed step when 0.3 stages omit a duplicate field."""
    solver = builder.get("solver")
    if not isinstance(solver, Mapping):
        return
    fixed_timestep = solver.get("fixed_timestep")
    if _finite_number(fixed_timestep) is None:
        return
    study = scene.get("study")
    if not isinstance(study, dict) or not isinstance(study.get("stages"), list):
        return
    for stage in study["stages"]:
        if isinstance(stage, dict) and str(stage.get("kind") or "relax") == "relax":
            stage.setdefault("fixed_timestep", fixed_timestep)


def _render_scene_document_bootstrap(builder: Mapping[str, object]) -> str:
    """Build a minimal capture script that realizes the scene's typed objects."""
    backend = str(builder.get("backend") or builder.get("requested_backend") or "auto")
    mode = str(builder.get("requested_mode") or "strict")
    device = str(builder.get("requested_device") or "auto")
    precision = str(
        builder.get("requested_precision")
        or builder.get("execution_precision")
        or "double"
    )
    lines = [
        "import fullmag as fm",
        "",
        'study = fm.study("scene_document")',
        f"study.engine({_python_literal(backend)})",
        f"study.mode({_python_literal(mode)})",
    ]
    if device != "auto" or precision != "double":
        lines.append(
            f"study.device({_python_literal(device)}, precision={_python_literal(precision)})"
        )
    cpu_threads = _positive_int(builder.get("cpu_threads"))
    if cpu_threads is not None:
        lines.append(f"study.threads({cpu_threads})")

    solver = builder.get("solver")
    if isinstance(solver, Mapping):
        solver_kwargs: dict[str, object] = {}
        integrator = solver.get("integrator")
        if isinstance(integrator, str) and integrator.strip():
            solver_kwargs["integrator"] = integrator
        for key, value in (
            ("fixed_timestep", "fix_dt"),
            ("dt_initial", "dt_initial"),
            ("dt_max", "dt_max"),
            ("max_err", "max_err"),
        ):
            numeric = _finite_number(solver.get(key))
            if numeric is not None:
                solver_kwargs[value] = numeric
        if solver_kwargs:
            lines.append(f"study.solver({_python_keyword_args(solver_kwargs)})")

    objects = builder.get("geometries")
    if not isinstance(objects, list) or not objects:
        raise ValueError("SceneDocument export requires at least one geometry object.")
    object_names_by_id: dict[str, str] = {}
    for raw_object in objects:
        if not isinstance(raw_object, Mapping):
            continue
        object_id = raw_object.get("object_id") or raw_object.get("id")
        name = raw_object.get("name") or object_id
        if name is not None:
            for alias in (
                object_id,
                raw_object.get("id"),
                raw_object.get("region_name"),
            ):
                if alias is not None:
                    object_names_by_id[str(alias)] = str(name)

    fdm = builder.get("fdm")
    if isinstance(fdm, Mapping):
        fdm_line = _render_fdm_bootstrap(fdm, object_names_by_id=object_names_by_id)
        if fdm_line:
            lines.append(fdm_line)
    fdm_per_magnet = (
        fdm.get("per_magnet") or fdm.get("per_object_grid")
        if isinstance(fdm, Mapping)
        else None
    )

    handles: list[str] = []
    for index, raw_object in enumerate(objects):
        if not isinstance(raw_object, Mapping):
            raise ValueError(f"SceneDocument geometry {index} must be an object.")
        role = str(raw_object.get("role") or "magnet").lower()
        if role != "magnet":
            continue
        name = str(raw_object.get("name") or raw_object.get("id") or f"object_{index}")
        object_id = str(raw_object.get("object_id") or raw_object.get("id") or name)
        handle = f"object_{index}"
        shape = _render_shape_expression(raw_object)
        lines.append(
            f"{handle} = study.geometry({shape}, name={_python_literal(name)}, "
            f"object_id={_python_literal(object_id)})"
        )
        handles.append(handle)
        material = raw_object.get("material")
        if isinstance(material, Mapping):
            for key in ("Ms", "Aex", "alpha", "Dind", "Dbulk", "Ku1", "Kc1"):
                value = _finite_number(material.get(key))
                if value is not None:
                    lines.append(f"{handle}.{key} = {_python_literal(value)}")
            anis_u = material.get("anisU") or material.get("anis_u")
            if isinstance(anis_u, (list, tuple)) and len(anis_u) == 3:
                lines.append(f"{handle}.anisU = {_python_literal(tuple(anis_u))}")
        magnetization = raw_object.get("magnetization")
        if isinstance(magnetization, Mapping):
            texture_expression = _render_texture_expression(magnetization)
            if texture_expression is not None:
                lines.append(f"{handle}.m = {texture_expression}")
        mesh = raw_object.get("mesh")
        if isinstance(mesh, Mapping):
            mesh_kwargs = _render_scene_mesh_kwargs(mesh)
            if mesh_kwargs:
                lines.append(f"{handle}.mesh({_python_keyword_args(mesh_kwargs)})")
        elif isinstance(fdm_per_magnet, Mapping):
            raw_grid = fdm_per_magnet.get(name) or fdm_per_magnet.get(object_id)
            if isinstance(raw_grid, Mapping) and _is_vector3(raw_grid.get("cell")):
                lines.append(
                    f"{handle}.mesh(cell_size={_python_literal(tuple(raw_grid['cell']))})"
                )

    if not handles:
        raise ValueError("SceneDocument export requires at least one magnetic object.")

    if builder.get("exchange_enabled") is False:
        lines.append("study.disable_exchange()")
    demag_enabled = builder.get("demag_enabled")
    realization = builder.get("demag_realization")
    explicit_demag_realization = (
        isinstance(realization, str) and bool(realization.strip())
    )
    if explicit_demag_realization:
        lines.append(f"study.demag(realization={_python_literal(realization)})")
    if demag_enabled is False:
        lines.append("study.disable_demag()")

    external_field = builder.get("external_field")
    if isinstance(external_field, (list, tuple)) and len(external_field) == 3:
        values = tuple(_finite_number(value) for value in external_field)
        if all(value is not None for value in values):
            lines.append(
                "fm.b_ext(" + ", ".join(_python_literal(value) for value in values) + ")"
            )

    universe = builder.get("universe")
    if isinstance(universe, Mapping):
        universe_kwargs = _render_universe_kwargs(universe)
        if universe_kwargs:
            lines.append(f"study.universe({_python_keyword_args(universe_kwargs)})")
    mesh = builder.get("mesh")
    if isinstance(mesh, Mapping) and backend.lower() == "fem":
        object_mesh_kwargs = _render_scene_mesh_kwargs(mesh)
        if object_mesh_kwargs:
            lines.append(
                "study.objects.mesh.defaults("
                f"{_python_keyword_args(object_mesh_kwargs)})"
            )
    universe_mesh = universe if isinstance(universe, Mapping) else None
    if universe_mesh is not None:
        universe_mesh_kwargs = _render_universe_mesh_kwargs(universe_mesh, backend=backend)
        if universe_mesh_kwargs:
            lines.append(f"study.universe.mesh({_python_keyword_args(universe_mesh_kwargs)})")

    for stage in builder.get("stages") or []:
        if not isinstance(stage, Mapping) or str(stage.get("kind") or "relax") != "relax":
            continue
        kwargs: dict[str, object] = {"stage_id": str(stage.get("stage_id") or "relax")}
        algorithm = stage.get("algorithm")
        if isinstance(algorithm, str) and algorithm.strip():
            kwargs["algorithm"] = algorithm
        max_steps = _positive_int(stage.get("max_steps"))
        if max_steps is not None:
            kwargs["max_steps"] = max_steps
        tolerance = _finite_number(stage.get("torque_tolerance"))
        if tolerance is not None:
            kwargs["tolA"] = tolerance
        fixed_timestep = _finite_number(stage.get("fixed_timestep"))
        if fixed_timestep is None and isinstance(solver, Mapping):
            fixed_timestep = _finite_number(solver.get("fixed_timestep"))
        if fixed_timestep is not None:
            kwargs["dt"] = fixed_timestep
        lines.append(f"study.stages.add_relax({_python_keyword_args(kwargs)})")

    lines.append("")
    return "\n".join(lines) + "\n"


def _render_shape_expression(entry: Mapping[str, object]) -> str:
    kind = str(entry.get("geometry_kind") or "").strip().lower()
    params = entry.get("geometry_params")
    params = params if isinstance(params, Mapping) else {}
    if kind == "box":
        size = params.get("size") or params.get("dimensions")
        if not _is_vector3(size):
            raise ValueError("Box geometry requires three positive size values.")
        expression = f"fm.Box(size={_python_literal(tuple(size))})"
    elif kind == "cylinder":
        radius = _finite_number(params.get("radius"))
        height = _finite_number(params.get("height"))
        if radius is None or height is None:
            raise ValueError("Cylinder geometry requires finite radius and height.")
        expression = f"fm.Cylinder(radius={radius!r}, height={height!r})"
    elif kind in {"sphere", "ellipsoid"}:
        radii = params.get("radii")
        if kind == "sphere" and radii is None:
            radius = _finite_number(params.get("radius"))
            radii = (radius, radius, radius) if radius is not None else None
        if not _is_vector3(radii):
            raise ValueError("Ellipsoid geometry requires three finite radii.")
        constructor = "fm.Sphere" if kind == "sphere" and len(set(radii)) == 1 else "fm.Ellipsoid"
        if constructor == "fm.Sphere":
            expression = f"fm.Sphere({_python_literal(float(radii[0]))})"
        else:
            expression = f"fm.Ellipsoid{_python_literal(tuple(radii))}"
    elif kind in {"archwaveguide", "arch_waveguide"}:
        values = [
            _finite_number(params.get(key))
            for key in ("length", "width", "height", "arch_height")
        ]
        if any(value is None for value in values):
            raise ValueError("ArchWaveguide geometry requires finite dimensions.")
        expression = f"fm.ArchWaveguide{_python_literal(tuple(values))}"
    else:
        raise ValueError(f"SceneDocument export does not support geometry kind '{kind}'.")
    translation = params.get("translation")
    if _is_vector3(translation) and any(float(value) != 0.0 for value in translation):
        expression += f".translate({_python_literal(tuple(translation))})"
    return expression


def _render_texture_expression(magnetization: Mapping[str, object]) -> str | None:
    kind = str(magnetization.get("kind") or "").lower()
    preset_kind = str(magnetization.get("preset_kind") or "").lower()
    params = magnetization.get("preset_params")
    params = dict(params) if isinstance(params, Mapping) else {}
    if kind in {"sampled_field", "sampled"}:
        return None
    if preset_kind == "uniform":
        direction = params.get("direction")
        if not _is_vector3(direction):
            raise ValueError("Uniform magnetization requires a three-component direction.")
        return f"fm.texture.uniform({_python_literal(tuple(direction))})"
    if preset_kind in {"random", "random_seeded"}:
        seed = _non_negative_int(params.get("seed"))
        if seed is None:
            raise ValueError("Random magnetization requires a non-negative integer seed.")
        return f"fm.texture.random({seed})"
    if preset_kind:
        kwargs = {str(key): value for key, value in params.items()}
        return f"fm.texture.{preset_kind}({_python_keyword_args(kwargs)})"
    value = magnetization.get("value")
    if _is_vector3(value):
        return f"fm.texture.uniform({_python_literal(tuple(value))})"
    return None


def _render_fdm_bootstrap(
    fdm: Mapping[str, object],
    *,
    object_names_by_id: Mapping[str, str] | None = None,
) -> str:
    kwargs: dict[str, object] = {}
    default_cell = fdm.get("default_cell")
    if _is_vector3(default_cell):
        kwargs["default_cell"] = tuple(default_cell)
    per_magnet = fdm.get("per_magnet") or fdm.get("per_object_grid")
    if isinstance(per_magnet, Mapping):
        entries: list[str] = []
        for name, raw_grid in per_magnet.items():
            if isinstance(raw_grid, Mapping) and _is_vector3(raw_grid.get("cell")):
                rendered_name = (object_names_by_id or {}).get(str(name), str(name))
                entries.append(
                    f"{_python_literal(rendered_name)}: fm.FDMGrid(cell={_python_literal(tuple(raw_grid['cell']))})"
                )
        if entries:
            kwargs["per_magnet"] = "{" + ", ".join(entries) + "}"
    supported_keys = {"default_cell", "per_magnet", "per_object_grid"}
    if any(
        key not in supported_keys and fdm.get(key) not in (None, "", [], {})
        for key in fdm
    ):
        if not kwargs:
            return ""
        rendered = ", ".join(
            f"{key}={value}"
            if isinstance(value, str) and value.startswith("{")
            else f"{key}={_python_literal(value)}"
            for key, value in kwargs.items()
        )
        return f"study.fdm({rendered})"
    if _is_vector3(default_cell):
        return f"study.objects.mesh.defaults(cell_size={_python_literal(tuple(default_cell))})"
    return ""


def _render_scene_mesh_kwargs(mesh: Mapping[str, object]) -> dict[str, object]:
    allowed = {
        "cell_size",
        "maximum_element_size",
        "minimum_element_size",
        "order",
        "compute_quality",
        "per_element_quality",
        "growth_rate",
        "maximum_element_growth_rate",
    }
    result: dict[str, object] = {}
    for key in allowed:
        value = mesh.get(key)
        if key == "cell_size" and _is_vector3(value):
            result[key] = tuple(value)
        elif key in {"maximum_element_size", "minimum_element_size"}:
            numeric = _finite_number(value)
            if numeric is not None:
                result[key] = numeric
        elif key == "order":
            integer = _positive_int(value)
            if integer is not None:
                result[key] = integer
        elif key in {"compute_quality", "per_element_quality"} and isinstance(value, bool):
            result[key] = value
    return result


def _render_universe_kwargs(universe: Mapping[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key in ("mode", "center"):
        value = universe.get(key)
        if isinstance(value, str) and value.strip():
            result[key] = value
        elif key == "center" and _is_vector3(value):
            result[key] = tuple(value)
    padding = universe.get("padding")
    if _is_vector3(padding):
        result["padding"] = tuple(padding)
    size = universe.get("size")
    if _is_vector3(size):
        result["size"] = tuple(size)
    return result


def _render_universe_mesh_kwargs(mesh: Mapping[str, object], *, backend: str) -> dict[str, object]:
    if backend.lower() == "fdm":
        cell_size = mesh.get("cell_size") or mesh.get("common_cell_size")
        return {"cell_size": tuple(cell_size)} if _is_vector3(cell_size) else {}
    result: dict[str, object] = {}
    for key in ("maximum_element_size", "minimum_element_size", "growth_rate"):
        numeric = _finite_number(mesh.get(key))
        if numeric is not None:
            result[key] = numeric
    return result


def _python_keyword_args(values: Mapping[str, object]) -> str:
    return ", ".join(f"{key}={_python_literal(value)}" for key, value in values.items())


def _python_literal(value: object) -> str:
    if isinstance(value, tuple):
        return "(" + ", ".join(_python_literal(item) for item in value) + ("," if len(value) == 1 else "") + ")"
    if isinstance(value, list):
        return "[" + ", ".join(_python_literal(item) for item in value) + "]"
    return repr(value)


def _is_vector3(value: object) -> bool:
    return isinstance(value, (list, tuple)) and len(value) == 3 and all(_finite_number(item) is not None for item in value)


def _finite_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        numeric = float(value) if value is not None and value != "" else None
    except (TypeError, ValueError):
        return None
    return numeric if numeric is not None and math.isfinite(numeric) else None


def _positive_int(value: object) -> int | None:
    numeric = _finite_number(value)
    if numeric is None or numeric < 1 or int(numeric) != numeric:
        return None
    return int(numeric)


def _non_negative_int(value: object) -> int | None:
    numeric = _finite_number(value)
    if numeric is None or numeric < 0 or int(numeric) != numeric:
        return None
    return int(numeric)


def _first_relax_stage(loaded: LoadedProblem) -> Relaxation | None:
    for stage in loaded.stages:
        if isinstance(stage.problem.study, Relaxation):
            return stage.problem.study
    if isinstance(loaded.problem.study, Relaxation):
        return loaded.problem.study
    return None


def _builder_stage_sequence(loaded: LoadedProblem) -> tuple[LoadedStage, ...]:
    if loaded.stages:
        return loaded.stages
    if loaded.entrypoint_kind == "flat_workspace":
        return ()
    return (
        LoadedStage(
            problem=loaded.problem,
            entrypoint_kind=loaded.entrypoint_kind,
            default_until_seconds=loaded.default_until_seconds,
        ),
    )


def export_study_pipeline_document(loaded: LoadedProblem) -> dict[str, object] | None:
    stages = _builder_stage_sequence(loaded)
    if not stages:
        return None
    return {
        "version": "study_pipeline.v1",
        "nodes": [
            _export_study_pipeline_node(stage, index=index)
            for index, stage in enumerate(stages)
        ],
    }


def _export_stage_draft_with_identity(stage: LoadedStage) -> dict[str, object]:
    payload = _export_stage_draft(stage)
    if stage.stage_id is not None:
        payload["stage_id"] = stage.stage_id
    if stage.output_every_seconds is not None:
        payload["output_every_seconds"] = stage.output_every_seconds
    if stage.table_autosave is not None:
        payload["table_autosave"] = stage.table_autosave.to_ir()
    return payload


def _export_study_pipeline_node(stage: LoadedStage, *, index: int) -> dict[str, object]:
    draft = _export_stage_draft_with_identity(stage)
    stage_kind = _infer_pipeline_stage_kind(draft)
    if stage_kind == "run":
        draft = {
            key: draft[key]
            for key in (
                "kind",
                "entrypoint_kind",
                "stage_id",
                "until_seconds",
                "output_every_seconds",
                "autosave",
            )
            if key in draft
        }
    return {
        "id": stage.stage_id or f"stage_{index + 1}_{stage_kind}",
        "label": _study_pipeline_stage_label(draft, stage_kind=stage_kind, index=index),
        "enabled": True,
        "source": "script_imported",
        "node_kind": "primitive",
        "stage_kind": stage_kind,
        "payload": draft,
    }


def _infer_pipeline_stage_kind(stage_draft: dict[str, object]) -> str:
    kind = str(stage_draft.get("kind") or "").strip().lower()
    if kind in {
        "save_state",
        "load_state",
        "set_transport_current",
        "set_spin_torque_enabled",
        "export",
        "change_device",
        "add_field_drive",
        "remove_field_drive",
        "table_autosave",
        "autosave",
        "fft_response",
    }:
        return kind
    entrypoint = str(stage_draft.get("entrypoint_kind") or "").strip().lower()
    if entrypoint == "relax" or "relax" in kind:
        return "relax"
    if entrypoint == "frequency_response" or "frequency_response" in kind:
        return "frequency_response"
    if entrypoint == "eigenmodes" or "eigen" in kind:
        return "eigenmodes"
    if entrypoint == "flat_hysteresis" or "hysteresis" in kind:
        return "hysteresis"
    if entrypoint == "run" or "run" in kind:
        return "run"
    return "run"


def _study_pipeline_stage_label(
    stage_draft: dict[str, object],
    *,
    stage_kind: str,
    index: int,
) -> str:
    original_kind = str(stage_draft.get("kind") or "").strip()
    if original_kind and original_kind.lower() != stage_kind:
        return f"Imported {index + 1} · {original_kind}"
    return ""


def _export_stage_draft(stage: LoadedStage) -> dict[str, object]:
    action = stage.action if isinstance(stage.action, dict) else None
    if action is not None:
        action_kind = str(action.get("kind") or "").strip().lower()
        if action_kind == "save_state":
            return {
                "kind": "save_state",
                "entrypoint_kind": stage.entrypoint_kind,
                "artifact_name": str(action.get("artifact_name") or "state_snapshot"),
                "format": _text_value(action.get("format")),
                "dataset": _text_value(action.get("dataset")),
            }
        if action_kind == "load_state":
            return {
                "kind": "load_state",
                "entrypoint_kind": stage.entrypoint_kind,
                "artifact_name": _text_value(action.get("artifact_name")),
                "state_path": _text_value(action.get("state_path")),
                "format": _text_value(action.get("format")),
                "dataset": _text_value(action.get("dataset")),
                "sample_index": _text_value(action.get("sample_index")),
            }
        if action_kind == "set_transport_current":
            module_id = _text_value(action.get("module_id"))
            values = action.get("terminal_outward_current_density_Apm2")
            if not module_id or not isinstance(values, dict):
                raise TypeError(
                    "set_transport_current action requires module_id and terminal current mapping"
                )
            return {
                "kind": "set_transport_current",
                "entrypoint_kind": stage.entrypoint_kind,
                "module_id": module_id,
                "terminal_outward_current_density_Apm2": copy.deepcopy(values),
            }
        if action_kind == "set_spin_torque_enabled":
            module_id = _text_value(action.get("module_id"))
            enabled = action.get("enabled")
            if not module_id or not isinstance(enabled, bool):
                raise TypeError(
                    "set_spin_torque_enabled action requires module_id and bool enabled"
                )
            return {
                "kind": "set_spin_torque_enabled",
                "entrypoint_kind": stage.entrypoint_kind,
                "module_id": module_id,
                "enabled": enabled,
            }
        if action_kind == "export":
            return {
                "kind": "export",
                "entrypoint_kind": stage.entrypoint_kind,
                "artifact_name": _text_value(action.get("artifact_name")),
                "quantity": _text_value(action.get("quantity")) or "magnetization",
                "format": _text_value(action.get("format")) or "json",
                "dataset": _text_value(action.get("dataset")),
            }
        if action_kind == "change_device":
            return {
                "kind": "change_device",
                "entrypoint_kind": stage.entrypoint_kind,
                "device": _text_value(action.get("device")) or "auto",
            }
        if action_kind == "add_field_drive":
            drive = action.get("drive")
            if isinstance(drive, RegionalFieldDrive):
                drive_payload: object = drive.to_ir()
            elif isinstance(drive, dict):
                drive_payload = drive
            else:
                raise TypeError("add_field_drive action requires a RegionalFieldDrive")
            return {
                "kind": "add_field_drive",
                "entrypoint_kind": stage.entrypoint_kind,
                "drive": drive_payload,
            }
        if action_kind == "remove_field_drive":
            drive_id = _text_value(action.get("drive_id"))
            if not drive_id:
                raise TypeError("remove_field_drive action requires drive_id")
            return {
                "kind": "remove_field_drive",
                "entrypoint_kind": stage.entrypoint_kind,
                "drive_id": drive_id,
            }
        if action_kind == "table_autosave":
            return {
                "kind": "table_autosave",
                "entrypoint_kind": stage.entrypoint_kind,
                "enabled": bool(action.get("enabled", True)),
                "table_autosave": copy.deepcopy(action.get("table_autosave")),
            }
        if action_kind == "autosave":
            return {
                "kind": "autosave",
                "entrypoint_kind": stage.entrypoint_kind,
                "enabled": bool(action.get("enabled", True)),
                "quantity": _text_value(action.get("quantity")),
                "output": copy.deepcopy(action.get("output")),
            }
        if action_kind == "fft_response":
            return {
                "kind": "fft_response",
                "entrypoint_kind": stage.entrypoint_kind,
                "enabled": bool(action.get("enabled", True)),
                "request": copy.deepcopy(action.get("request")),
            }

    study = stage.problem.study
    if study is None:
        return {"kind": "unknown", "entrypoint_kind": stage.entrypoint_kind}
    if isinstance(study, Hysteresis):
        return {
            **study.to_ir(),
            "entrypoint_kind": stage.entrypoint_kind,
        }
    if isinstance(study, Relaxation):
        payload = {
            "kind": "relax",
            "entrypoint_kind": stage.entrypoint_kind,
            "until_seconds": "",
            "relax_algorithm": study.algorithm,
            "torque_tolerance": _text_number(study.torque_tolerance),
            "energy_tolerance": _text_number(study.energy_tolerance),
            "max_steps": str(study.max_steps),
        }
        if stage.table_autosave is not None:
            payload["table_autosave"] = stage.table_autosave.to_ir()
        if stage.autosave is not None:
            payload["autosave"] = stage.autosave.to_ir()
        if study.dynamics is not None:
            payload.update(
                {
                    "integrator": study.dynamics.integrator,
                    "fixed_timestep": _text_number(study.dynamics.fixed_timestep),
                    "adaptive_timestep": _stage_adaptive_timestep_draft(
                        study.dynamics.adaptive_timestep
                    ),
                    "demag_interval_s": _text_number(
                        study.dynamics.field_refresh.demag_interval_s
                        if study.dynamics.field_refresh is not None
                        else None
                    ),
                    "max_relaxation_time_s": _text_number(
                        study.stop.max_relaxation_time_s
                    ),
                }
            )
        return payload
    dynamics = study.dynamics
    if isinstance(study, Eigenmodes):
        return {
            "kind": "eigenmodes",
            "entrypoint_kind": stage.entrypoint_kind,
            "integrator": dynamics.integrator,
            "fixed_timestep": _text_number(dynamics.fixed_timestep),
            "until_seconds": "",
            "relax_algorithm": "",
            "torque_tolerance": "",
            "energy_tolerance": "",
            "max_steps": "",
            "eigen_count": str(study.count),
            "eigen_target": study.target,
            "eigen_target_frequency": _text_number(study.target_frequency),
            "eigen_frequency_min": _text_number(study.frequency_min),
            "eigen_frequency_max": _text_number(study.frequency_max),
            "eigen_operator": study.operator,
            "eigen_include_demag": study.include_demag,
            "eigen_equilibrium_source": study.equilibrium_source,
            "eigen_normalization": study.normalization,
            "eigen_damping_policy": study.damping_policy,
            "eigen_k_vector": ",".join(str(component) for component in study.k_vector) if study.k_vector is not None else "",
            "eigen_k_path": _text_k_path(study.k_sampling),
            "eigen_spin_wave_bc": _spin_wave_bc_kind(study.spin_wave_bc),
            "eigen_spin_wave_bc_config": _spin_wave_bc_config(study.spin_wave_bc),
            "eigen_magnetostatic_bc": study.magnetostatic_bc,
        }
    if isinstance(study, FrequencyResponse):
        return {
            "kind": "frequency_response",
            "entrypoint_kind": stage.entrypoint_kind,
            "integrator": dynamics.integrator,
            "fixed_timestep": _text_number(dynamics.fixed_timestep),
            "until_seconds": "",
            "relax_algorithm": "",
            "torque_tolerance": "",
            "energy_tolerance": "",
            "max_steps": "",
            "frequency_values_hz": ",".join(str(freq) for freq in study.frequencies_hz),
            "frequency_excitation_field_au_per_m": ",".join(str(component) for component in study.excitation_field_au_per_m),
            "frequency_excitation_phase_rad": _text_number(study.excitation_phase_rad),
            "frequency_include_demag": study.include_demag,
            "frequency_equilibrium_source": study.equilibrium_source,
            "frequency_equilibrium_artifact": _text_value(study.equilibrium_artifact),
            "frequency_normalization": study.normalization,
            "frequency_damping_policy": study.damping_policy,
            "frequency_k_vector": ",".join(str(component) for component in study.k_vector) if study.k_vector is not None else "",
            "frequency_spin_wave_bc": _spin_wave_bc_kind(study.spin_wave_bc),
            "frequency_spin_wave_bc_config": _spin_wave_bc_config(study.spin_wave_bc),
            "frequency_magnetostatic_bc": study.magnetostatic_bc,
            "frequency_solver_method": (
                study.solver_policy.method
                if study.solver_policy is not None
                and study.solver_policy.method is not None
                else ""
            ),
            "frequency_solver_preconditioner": (
                study.solver_policy.preconditioner
                if study.solver_policy is not None
                and study.solver_policy.preconditioner is not None
                else ""
            ),
            "frequency_solver_rtol": _text_number(
                study.solver_policy.rtol if study.solver_policy is not None else None
            ),
            "frequency_solver_max_iterations": (
                str(study.solver_policy.max_iterations)
                if study.solver_policy is not None
                and study.solver_policy.max_iterations is not None
                else ""
            ),
            "frequency_solver_restart_iterations": (
                str(study.solver_policy.restart_iterations)
                if study.solver_policy is not None
                and study.solver_policy.restart_iterations is not None
                else ""
            ),
        }
    payload = {
        "kind": "run",
        "entrypoint_kind": stage.entrypoint_kind,
        "integrator": dynamics.integrator,
        "fixed_timestep": _text_number(dynamics.fixed_timestep),
        "demag_interval_s": _text_number(
            dynamics.field_refresh.demag_interval_s
            if dynamics.field_refresh is not None
            else None
        ),
        "until_seconds": _text_number(stage.default_until_seconds),
        "relax_algorithm": "",
        "torque_tolerance": "",
        "energy_tolerance": "",
        "max_steps": "",
        "sampling": study.to_ir()["sampling"],
        "spin_wave_response": _normalize_mapping(
            stage.problem.runtime_metadata.get("spin_wave_response")
        )
        or None,
    }
    if stage.autosave is not None:
        payload["autosave"] = stage.autosave.to_ir()
    return payload


def _render_header(script_path: Path, entrypoint_kind: str) -> list[str]:
    return [
        '"""Canonical Fullmag script generated from the model builder.',
        "",
        f"Source: {script_path.name}",
        f"Entrypoint: {entrypoint_kind}",
        '"""',
    ]


def _fdm_from_overrides(
    problem: Problem,
    overrides: dict[str, object],
) -> FDM | None:
    """Apply canonical SceneDocument FDM authoring to the exported script.

    The scene owns requested FDM policy while the loaded Problem remains the
    source of values that were not edited.  Keeping this merge here ensures a
    UI transaction reaches the public ``fm.fdm`` authoring call and therefore
    lowers through the same Python → ProblemIR path as a hand-written script.
    """
    base = problem.discretization.fdm if problem.discretization is not None else None
    raw = overrides.get("fdm")
    if not isinstance(raw, Mapping):
        return base if isinstance(base, FDM) else None

    if "default_cell" in raw:
        default_cell = _fdm_vector(raw.get("default_cell"), "fdm.default_cell", 3)
    else:
        default_cell = base.default_cell if isinstance(base, FDM) else None

    # ``per_object_grid`` is the scene-facing alias.  Keep accepting the
    # public ``per_magnet`` spelling and prefer it when both are present so a
    # legacy export remains deterministic.
    per_magnet_key = "per_magnet" if "per_magnet" in raw else "per_object_grid"
    if per_magnet_key in raw:
        raw_per_magnet = raw.get(per_magnet_key)
        per_magnet_label = f"fdm.{per_magnet_key}"
        if raw_per_magnet is None:
            per_magnet = None
        elif isinstance(raw_per_magnet, Mapping):
            per_magnet = {}
            for name, raw_grid in raw_per_magnet.items():
                if not isinstance(raw_grid, Mapping):
                    raise ValueError(f"{per_magnet_label}[{name!r}] must be an object")
                per_magnet[str(name)] = FDMGrid(
                    cell=_fdm_vector(
                        raw_grid.get("cell"),
                        f"{per_magnet_label}[{name!r}].cell",
                        3,
                    )
                )
        else:
            raise ValueError(f"{per_magnet_label} must be an object or null")
    else:
        per_magnet = base.per_magnet if isinstance(base, FDM) else None

    if "demag" in raw:
        raw_demag = raw.get("demag")
        if raw_demag is None:
            demag = None
        elif isinstance(raw_demag, Mapping):
            common_cells = _fdm_integer_vector(
                raw_demag.get("common_cells"), "fdm.demag.common_cells", 3
            )
            common_cells_xy = _fdm_integer_vector(
                raw_demag.get("common_cells_xy"), "fdm.demag.common_cells_xy", 2
            )
            common_cell_size = _fdm_vector(
                raw_demag.get("common_cell_size"),
                "fdm.demag.common_cell_size",
                3,
            )
            explain = raw_demag.get("explain", True)
            if not isinstance(explain, bool):
                raise ValueError("fdm.demag.explain must be boolean")
            demag = FDMDemag(
                strategy=str(raw_demag.get("strategy", "auto")),
                mode=str(raw_demag.get("mode", "auto")),
                fft_backend=str(raw_demag.get("fft_backend", "auto")),
                common_cells=common_cells,
                common_cells_xy=common_cells_xy,
                common_cell_size=common_cell_size,
                explain=explain,
            )
        else:
            raise ValueError("fdm.demag must be an object or null")
    else:
        demag = base.demag if isinstance(base, FDM) else None

    projection_policy = (
        raw.get("projection_policy")
        if "projection_policy" in raw
        else base.projection_policy if isinstance(base, FDM) else None
    )
    if projection_policy is not None and not isinstance(projection_policy, str):
        raise ValueError("fdm.projection_policy must be a string or null")

    boundary_correction = (
        raw.get("boundary_correction")
        if "boundary_correction" in raw
        else base.boundary_correction if isinstance(base, FDM) else None
    )
    if boundary_correction is not None and not isinstance(boundary_correction, str):
        raise ValueError("fdm.boundary_correction must be a string or null")
    boundary_phi_floor = (
        _fdm_number(raw.get("boundary_phi_floor"), "fdm.boundary_phi_floor")
        if "boundary_phi_floor" in raw
        else base.boundary_phi_floor if isinstance(base, FDM) else None
    )
    boundary_delta_min = (
        _fdm_number(raw.get("boundary_delta_min"), "fdm.boundary_delta_min")
        if "boundary_delta_min" in raw
        else base.boundary_delta_min if isinstance(base, FDM) else None
    )
    if default_cell is None and not per_magnet:
        raise ValueError("fdm requires default_cell or per_magnet grid specifications")
    return FDM(
        default_cell=default_cell,
        per_magnet=per_magnet,
        demag=demag,
        projection_policy=projection_policy,
        boundary_correction=boundary_correction,
        boundary_phi_floor=boundary_phi_floor,
        boundary_delta_min=boundary_delta_min,
    )


def _fdm_vector(value: object, label: str, length: int) -> tuple[float, ...] | None:
    if value is None:
        return None
    if not isinstance(value, (list, tuple)) or len(value) != length:
        raise ValueError(f"{label} must contain exactly {length} numbers or null")
    result = tuple(float(component) for component in value)
    if not all(math.isfinite(component) for component in result):
        raise ValueError(f"{label} must contain finite numbers")
    return result


def _uses_canonical_fdm_mesh_authoring(fdm: FDM) -> bool:
    demag = fdm.demag
    return (
        (fdm.default_cell is not None or bool(fdm.per_magnet))
        and fdm.boundary_correction in (None, "none")
        and fdm.boundary_phi_floor is None
        and fdm.boundary_delta_min is None
        and fdm.projection_policy is None
        and (
            demag is None
            or (
                demag.strategy == "auto"
                and demag.mode == "auto"
                and demag.common_cells is None
                and demag.common_cells_xy is None
            )
        )
    )


def _fdm_integer_vector(value: object, label: str, length: int) -> tuple[int, ...] | None:
    if value is None:
        return None
    if not isinstance(value, (list, tuple)) or len(value) != length:
        raise ValueError(f"{label} must contain exactly {length} integers or null")
    if any(
        isinstance(component, bool)
        or not isinstance(component, int)
        or component <= 0
        for component in value
    ):
        raise ValueError(f"{label} values must be positive integers")
    result = tuple(value)
    return result


def _fdm_number(value: object, label: str) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be a finite number or null") from error
    if not math.isfinite(number):
        raise ValueError(f"{label} must be a finite number or null")
    return number


def _render_runtime(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    runtime = problem.runtime
    runtime_override = _normalize_mapping(overrides.get("runtime_selection"))
    requested_mode = overrides.get("requested_mode")
    override_mode = (
        requested_mode
        if isinstance(requested_mode, str)
        else runtime_override.get("mode") if runtime_override else None
    )
    execution_mode = (
        override_mode
        if isinstance(override_mode, str)
        and override_mode in {"strict", "extended", "hybrid"}
        else runtime.execution_mode.value
    )
    override_cpu_threads = runtime_override.get("cpu_threads") if runtime_override else None
    cpu_threads = (
        int(override_cpu_threads)
        if isinstance(override_cpu_threads, (int, float)) and not isinstance(override_cpu_threads, bool)
        else runtime.cpu_threads
    )
    lines = ["# Engine"]
    if surface == "flat" and problem.name != "fullmag_sim":
        lines.append(f"fm.name({_py_repr(problem.name)})")
    lines.append(f"{_surface_call(surface, 'engine')}({_py_repr(runtime.backend_target.value)})")
    if execution_mode != "strict":
        lines.append(f"{_surface_call(surface, 'mode')}({_py_repr(execution_mode)})")

    device_spec = _runtime_device_spec(runtime)
    if device_spec == "auto" and runtime.execution_precision.value == "double":
        pass
    elif runtime.execution_precision.value == "double":
        if device_spec == "cpu":
            lines.append(f'{_surface_call(surface, "device")}("cpu", precision="double")')
        else:
            lines.append(
                f'{_surface_call(surface, "device")}({_py_repr(device_spec)}, precision="double")'
            )
    elif runtime.execution_precision.value == "single":
        lines.append(
            f'{_surface_call(surface, "device")}({_py_repr(device_spec)}, precision="single")'
        )
    else:
        lines.append(f"{_surface_call(surface, 'device')}({_py_repr(device_spec)})")
    if cpu_threads is not None:
        lines.append(f"{_surface_call(surface, 'threads')}({cpu_threads})")

    # PBC is part of the canonical physical problem, not an implicit backend
    # mesh option. Keep the authored axes and demag realization explicit in the
    # exported script so UI/Python round-trips cannot silently drop it.
    pbc = problem.pbc
    if pbc is not None:
        raw_axes = getattr(pbc, "axes", pbc)
        axes = tuple(bool(value) for value in raw_axes)
        if len(axes) != 3:
            raise ValueError("canonical rewrite requires exactly three PBC axes")
        pbc_kwargs = [
            f"{axis}=True"
            for axis, enabled in zip(("x", "y", "z"), axes)
            if enabled
        ]
        demag = str(getattr(pbc, "demag", "open") or "open")
        if demag != "open":
            pbc_kwargs.append(f"demag={_py_repr(demag)}")
        image_counts = getattr(pbc, "image_counts", None)
        if image_counts is not None:
            pbc_kwargs.append(f"images={_py_tuple3(tuple(image_counts))}")
        lines.append(f"{_surface_call(surface, 'pbc')}({', '.join(pbc_kwargs)})")

    fem = problem.discretization.fem if problem.discretization is not None else None
    if isinstance(fem, FEM) and fem.demag_solver_policy is not None:
        lines.append(
            f"{_surface_call(surface, 'fem_demag_solver')}("
            f"solver={_py_repr(fem.demag_solver_policy.solver)}, "
            f"preconditioner={_py_repr(fem.demag_solver_policy.preconditioner)}, "
            f"rtol={_py_number(fem.demag_solver_policy.rtol)}, "
            f"atol={_py_literal(fem.demag_solver_policy.atol)}, "
            f"max_iterations={fem.demag_solver_policy.max_iterations}, "
            f"print_level={fem.demag_solver_policy.print_level})"
        )

    fdm = _fdm_from_overrides(problem, overrides)
    if isinstance(fdm, FDM):
        canonical_mesh_authoring = (
            surface == "study" and _uses_canonical_fdm_mesh_authoring(fdm)
        )
        if canonical_mesh_authoring:
            if fdm.default_cell is not None:
                lines.append(
                    "study.objects.mesh.defaults("
                    f"cell_size={_py_tuple3(fdm.default_cell)})"
                )
            if fdm.demag is not None and fdm.demag.common_cell_size is not None:
                lines.append(
                    "study.universe.mesh("
                    f"cell_size={_py_tuple3(fdm.demag.common_cell_size)})"
                )
        has_extended_policy = (
            fdm.demag is not None
            or fdm.boundary_phi_floor is not None
            or fdm.boundary_delta_min is not None
            or fdm.projection_policy is not None
        )
        if canonical_mesh_authoring:
            pass
        elif fdm.per_magnet or has_extended_policy:
            fdm_kwargs: list[str] = []
            if fdm.default_cell is not None:
                fdm_kwargs.append(f"default_cell={_py_tuple3(fdm.default_cell)}")
            if fdm.per_magnet:
                per_magnet = ", ".join(
                    f"{_py_repr(name)}: fm.FDMGrid(cell={_py_tuple3(grid.cell)})"
                    for name, grid in sorted(fdm.per_magnet.items())
                )
                fdm_kwargs.append(f"per_magnet={{{per_magnet}}}")
            if isinstance(fdm.demag, FDMDemag):
                demag_kwargs = [
                    f"strategy={_py_repr(fdm.demag.strategy)}",
                    f"mode={_py_repr(fdm.demag.mode)}",
                    f"fft_backend={_py_repr(fdm.demag.fft_backend)}",
                    f"explain={fdm.demag.explain!r}",
                ]
                if fdm.demag.common_cells is not None:
                    demag_kwargs.append(f"common_cells={fdm.demag.common_cells!r}")
                if fdm.demag.common_cells_xy is not None:
                    demag_kwargs.append(
                        f"common_cells_xy={fdm.demag.common_cells_xy!r}"
                    )
                if fdm.demag.common_cell_size is not None:
                    demag_kwargs.append(
                        f"common_cell_size={fdm.demag.common_cell_size!r}"
                    )
                fdm_kwargs.append(f"demag=fm.FDMDemag({', '.join(demag_kwargs)})")
            if fdm.projection_policy is not None:
                fdm_kwargs.append(
                    f"projection_policy={_py_repr(fdm.projection_policy)}"
                )
            if fdm.boundary_correction is not None:
                fdm_kwargs.append(
                    f"boundary_correction={_py_repr(fdm.boundary_correction)}"
                )
            if fdm.boundary_phi_floor is not None:
                fdm_kwargs.append(
                    f"boundary_phi_floor={_py_number(fdm.boundary_phi_floor)}"
                )
            if fdm.boundary_delta_min is not None:
                fdm_kwargs.append(
                    f"boundary_delta_min={_py_number(fdm.boundary_delta_min)}"
                )
            lines.append(f"{_surface_call(surface, 'fdm')}({', '.join(fdm_kwargs)})")
        elif fdm.default_cell is not None:
            lines.append(
                f"{_surface_call(surface, 'cell')}({_py_number(fdm.default_cell[0])}, {_py_number(fdm.default_cell[1])}, {_py_number(fdm.default_cell[2])})"
            )
            if fdm.boundary_correction is not None:
                lines.append(
                    f"{_surface_call(surface, 'boundary_correction')}({_py_repr(fdm.boundary_correction)})"
                )

    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    if surface == "study":
        universe = _resolve_universe(problem, overrides=overrides)
        if universe is not None:
            universe_kwargs: list[str] = []
            mode = universe.get("mode")
            if isinstance(mode, str) and mode:
                universe_kwargs.append(f"mode={_py_repr(mode)}")
            size = _optional_vec3(universe.get("size"))
            if size is not None:
                universe_kwargs.append(f"size={_py_tuple3(size)}")
            center = _optional_vec3(universe.get("center"))
            if center is not None:
                universe_kwargs.append(f"center={_py_tuple3(center)}")
            padding = _optional_vec3(universe.get("padding"))
            if padding is not None:
                universe_kwargs.append(f"padding={_py_tuple3(padding)}")
            airbox_hmax = universe.get("airbox_hmax")
            airbox_hmin = universe.get("airbox_hmin")
            airbox_growth_rate = universe.get("airbox_growth_rate")
            airbox_grading = universe.get("airbox_grading")
            lines.append(f"{_surface_call(surface, 'universe')}({', '.join(universe_kwargs)})")
            universe_mesh_kwargs: list[str] = []
            if airbox_hmax is not None:
                universe_mesh_kwargs.append(
                    f"maximum_element_size={_py_number(float(airbox_hmax))}"
                )  # type: ignore[arg-type]
            if airbox_hmin is not None:
                universe_mesh_kwargs.append(
                    f"minimum_element_size={_py_number(float(airbox_hmin))}"
                )  # type: ignore[arg-type]
            if airbox_growth_rate is not None:
                universe_mesh_kwargs.append(
                    f"growth_rate={_py_number(float(airbox_growth_rate))}"
                )  # type: ignore[arg-type]
            if isinstance(airbox_grading, str) and airbox_grading:
                universe_mesh_kwargs.append(f"grading={_py_repr(airbox_grading)}")
            if universe_mesh_kwargs:
                lines.append(
                    f"{_surface_call(surface, 'universe')}.mesh({', '.join(universe_mesh_kwargs)})"
                )
    if runtime_metadata.get("interactive_session_requested") is True:
        lines.append(f"{_surface_call(surface, 'interactive')}(True)")
    if runtime_metadata.get("wait_for_solve") is True:
        lines.append(f"{_surface_call(surface, 'wait_for_solve')}(True)")
    visualization_hint = _normalize_mapping(runtime_metadata.get("visualization_hint"))
    if visualization_hint:
        active_qty = visualization_hint.get("active_quantity_id")
        if isinstance(active_qty, str) and active_qty.strip():
            lines.append(
                f"{_surface_call(surface, 'visualization')}(active_quantity_id={_py_repr(active_qty)})"
            )
        airbox_hint = _normalize_mapping(visualization_hint.get("airbox"))
        if airbox_hint:
            airbox_kwargs = _render_visualization_hint_kwargs(airbox_hint)
            if airbox_kwargs and surface == "study":
                lines.append(f"study.airbox.visualization({airbox_kwargs})")
    adaptive_mesh = _normalize_mapping(runtime_metadata.get("adaptive_mesh"))
    if adaptive_mesh:
        kwargs: list[str] = []
        if adaptive_mesh.get("policy") is not None:
            kwargs.append(f"policy={_py_repr(str(adaptive_mesh.get('policy')))}")
        if adaptive_mesh.get("indicator") is not None:
            kwargs.append(f"indicator={_py_repr(str(adaptive_mesh.get('indicator')))}")
        if adaptive_mesh.get("target_quantity") is not None:
            kwargs.append(
                f"target_quantity={_py_repr(str(adaptive_mesh.get('target_quantity')))}"
            )
        if adaptive_mesh.get("convergence_metric") is not None:
            kwargs.append(
                f"convergence_metric={_py_repr(str(adaptive_mesh.get('convergence_metric')))}"
            )
        if adaptive_mesh.get("theta") is not None:
            kwargs.append(f"theta={_py_number(float(adaptive_mesh.get('theta')))}")  # type: ignore[arg-type]
        if adaptive_mesh.get("h_min") is not None:
            kwargs.append(f"h_min={_py_number(float(adaptive_mesh.get('h_min')))}")  # type: ignore[arg-type]
        if adaptive_mesh.get("h_max") is not None:
            kwargs.append(f"h_max={_py_number(float(adaptive_mesh.get('h_max')))}")  # type: ignore[arg-type]
        if adaptive_mesh.get("max_passes") is not None:
            kwargs.append(f"max_passes={int(adaptive_mesh.get('max_passes'))}")  # type: ignore[arg-type]
        if adaptive_mesh.get("error_tolerance") is not None:
            kwargs.append(
                f"error_tolerance={_py_number(float(adaptive_mesh.get('error_tolerance')))}"  # type: ignore[arg-type]
            )
        if adaptive_mesh.get("chunk_until_seconds") is not None:
            kwargs.append(
                f"chunk_until_seconds={_py_number(float(adaptive_mesh.get('chunk_until_seconds')))}"  # type: ignore[arg-type]
            )
        if adaptive_mesh.get("steps_per_pass") is not None:
            kwargs.append(f"steps_per_pass={int(adaptive_mesh.get('steps_per_pass'))}")  # type: ignore[arg-type]
        enabled = bool(adaptive_mesh.get("enabled", True))
        if kwargs:
            lines.append(f"{_surface_call(surface, 'adaptive_mesh')}({str(enabled)}, {', '.join(kwargs)})")
        elif enabled is not True:
            lines.append(f"{_surface_call(surface, 'adaptive_mesh')}({str(enabled)})")
    return lines


def _export_fem_demag_solver_policy(problem: Problem) -> dict[str, object] | None:
    fem = problem.discretization.fem if problem.discretization is not None else None
    if not isinstance(fem, FEM) or fem.demag_solver_policy is None:
        return None
    policy: FemLinearSolverPolicy = fem.demag_solver_policy
    payload: dict[str, object] = {
        "solver": policy.solver,
        "preconditioner": policy.preconditioner,
        "rtol": policy.rtol,
        "max_iterations": policy.max_iterations,
        "print_level": policy.print_level,
    }
    if policy.atol is not None:
        payload["atol"] = policy.atol
    return payload


def _render_visualization_hint_kwargs(hint: dict[str, object]) -> str:
    """Render kwargs string for a visualization hint dict."""
    parts: list[str] = []
    if "show" in hint:
        parts.append(f"show={_py_literal(hint['show'])}")
    if "mode" in hint and isinstance(hint["mode"], str) and hint["mode"].strip():
        parts.append(f"mode={_py_repr(hint['mode'])}")
    if (
        "active_quantity_id" in hint
        and isinstance(hint["active_quantity_id"], str)
        and hint["active_quantity_id"].strip()
    ):
        parts.append(
            f"active_quantity_id={_py_repr(hint['active_quantity_id'])}"
        )
    return ", ".join(parts)


def _render_geometry_visualization_hints(
    problem: "Problem",
    magnet_vars: dict[str, str],
    runtime_metadata: dict[str, object],
) -> list[str]:
    """Render per-geometry and airbox visualization hints after geometry block."""
    lines: list[str] = []
    visualization_hint = _normalize_mapping(runtime_metadata.get("visualization_hint"))
    if not visualization_hint:
        return lines
    geometry_hints = _normalize_mapping(visualization_hint.get("geometry_hints"))
    if not geometry_hints:
        return lines
    for geom_name, raw_hint in geometry_hints.items():
        hint = _normalize_mapping(raw_hint)
        if not hint:
            continue
        var_name = magnet_vars.get(geom_name)
        if not var_name:
            continue
        kwargs_str = _render_visualization_hint_kwargs(hint)
        if kwargs_str:
            lines.append(f"{var_name}.visualization({kwargs_str})")
    return lines


def _render_geometry_and_materials(
    problem: Problem,
    magnet_vars: dict[str, str],
    *,
    source_root: Path,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    geometries_override = overrides.get("geometries")
    if isinstance(geometries_override, list):
        fdm = _fdm_from_overrides(problem, overrides)
        return _render_geometries_from_override(
            geometries_override,
            magnet_vars=magnet_vars,
            source_root=source_root,
            overrides=overrides,
            surface=surface,
            fdm=fdm,
        )

    initial_state_override = _normalize_mapping(overrides.get("initial_state"))
    fdm = _fdm_from_overrides(problem, overrides)
    canonical_fdm = (
        surface == "study"
        and isinstance(fdm, FDM)
        and _uses_canonical_fdm_mesh_authoring(fdm)
    )
    lines = ["# Geometry & Material"]
    for magnet in problem.magnets:
        var_name = magnet_vars[magnet.name]
        object_id_arg = (
            f", object_id={_py_repr(magnet.object_id)}"
            if magnet.object_id is not None
            else ""
        )
        lines.append(
            f"{var_name} = {_surface_call(surface, 'geometry')}({_render_geometry_expr(magnet.geometry, magnet_name=magnet.name, source_root=source_root)}, name={_py_repr(magnet.name)}{object_id_arg})"
        )
        if canonical_fdm and fdm is not None and fdm.per_magnet:
            grid = fdm.per_magnet.get(magnet.name)
            if grid is not None:
                lines.append(f"{var_name}.mesh(cell_size={_py_tuple3(grid.cell)})")
        if magnet.region is not None and magnet.region.name != magnet.name:
            lines.append(f"{var_name}.region_name = {_py_repr(magnet.region.name)}")
        lines.append(f"{var_name}.Ms = {_py_number(magnet.material.Ms)}")
        lines.append(f"{var_name}.Aex = {_py_number(magnet.material.A)}")
        lines.append(f"{var_name}.alpha = {_py_number(magnet.material.alpha)}")
        lines.extend(
            _render_absorbing_boundary(
                var_name,
                magnet.absorbing_boundary.to_ir()
                if magnet.absorbing_boundary is not None
                else None,
            )
        )
        if magnet.material.Ku1 is not None:
            lines.append(f"{var_name}.Ku1 = {_py_number(magnet.material.Ku1)}")
        if magnet.material.anisU is not None:
            lines.append(
                f"{var_name}.anisU = ({_py_number(magnet.material.anisU[0])}, "
                f"{_py_number(magnet.material.anisU[1])}, {_py_number(magnet.material.anisU[2])})"
            )
        rendered_initial_override = _render_initial_state_override(
            initial_state_override,
            magnet_name=magnet.name,
            magnet_var=var_name,
            source_root=source_root,
        )
        if rendered_initial_override is not None:
            lines.extend(rendered_initial_override)
        elif magnet.m0 is not None:
            rendered_initial = _render_initial_magnetization(
                magnet.m0,
                magnet_var=var_name,
                source_root=source_root,
            )
            if isinstance(rendered_initial, list):
                lines.extend(rendered_initial)
            else:
                lines.append(rendered_initial)
        dmi = _magnet_dmi(problem, magnet.name)
        if dmi is not None:
            lines.append(f"{var_name}.Dind = {_py_number(dmi)}")
        bulk_dmi = _magnet_bulk_dmi(problem, magnet.name)
        if bulk_dmi is not None:
            lines.append(f"{var_name}.Dbulk = {_py_number(bulk_dmi)}")
        lines.append("")
    for geometry in problem.auxiliary_geometries:
        role = problem.auxiliary_geometry_roles.get(geometry.geometry_name, "antenna")
        if role == "antenna":
            constructor = "antenna_object"
            type_suffix = ""
        else:
            constructor = "geometry_object"
            type_suffix = f", type={_py_repr(role)}"
        lines.append(
            f"{_safe_identifier(geometry.geometry_name)} = {_surface_call(surface, constructor)}({_render_geometry_expr(geometry, magnet_name=geometry.geometry_name, source_root=source_root)}, name={_py_repr(geometry.geometry_name)}{type_suffix})"
        )
        lines.append("")
    if lines[-1] == "":
        lines.pop()
    return lines


def _render_region_owned_authoring(
    problem: Problem,
    magnet_vars: dict[str, str],
    *,
    source_root: Path,
    overrides: dict[str, object],
) -> tuple[list[str], dict[str, str]]:
    geometries_override = overrides.get("geometries")
    if isinstance(geometries_override, list):
        return _render_region_owned_authoring_from_override(
            geometries_override,
            magnet_vars=magnet_vars,
            source_root=source_root,
        )

    lines: list[str] = []
    region_vars: dict[str, str] = {}
    for magnet in problem.magnets:
        magnet_var = magnet_vars[magnet.name]
        live_region_ids = {
            region.region_id for region in magnet.object_regions if region.region_id
        }
        for region_id in magnet.allocated_region_ids:
            if region_id not in live_region_ids:
                lines.append(f"{magnet_var}.regions.reserve_id({_py_repr(region_id)})")
        for index, region in enumerate(magnet.object_regions):
            region_var = _safe_identifier(f"{magnet.name}_{region.name}_region")
            if region_var in region_vars.values():
                region_var = f"{region_var}_{index}"
            region_vars[region.region_id] = region_var
            kwargs = [
                _py_repr(region.name),
                _render_geometry_expr(region.shape, magnet_name=region.name, source_root=source_root),
            ]
            optional_kwargs: list[str] = []
            optional_kwargs.append(f"region_id={_py_repr(region.region_id)}")
            if region.frame != "object":
                optional_kwargs.append(f"frame={_py_repr(region.frame)}")
            if not region.enabled:
                optional_kwargs.append("enabled=False")
            if region.priority:
                optional_kwargs.append(f"priority={int(region.priority)}")
            if region.realization_policy != "inherit":
                optional_kwargs.append(
                    f"realization_policy={_py_repr(region.realization_policy)}"
                )
            call_args = ", ".join([*kwargs, *optional_kwargs])
            lines.append(f"{region_var} = {magnet_var}.add_region({call_args})")
            transition = getattr(region, "material_transition_spec", None)
            if transition is not None:
                transition_kwargs = _render_material_transition_kwargs(transition.to_ir())
                if transition_kwargs:
                    lines.append(
                        f"{region_var}.material_transition({', '.join(transition_kwargs)})"
                    )
            for override in region.material_overrides or []:
                field_expr = _render_material_parameter_field_expr(override.value)
                lines.append(
                    f"{region_var}.set_material({_py_repr(override.parameter)}, {field_expr}, "
                    f"priority={int(override.priority)}, "
                    f"conflict_policy={_py_repr(override.conflict_policy)})"
                )
            if region.mesh_policy:
                mesh_kwargs = _render_region_mesh_policy_kwargs(region.mesh_policy)
                if mesh_kwargs:
                    lines.append(f"{region_var}.mesh({', '.join(mesh_kwargs)})")
            if region.texture_override is not None:
                texture_expr = _render_initial_magnetization_expr(
                    region.texture_override.initial_magnetization,
                    source_root=source_root,
                )
                lines.append(f"{region_var}.texture = {texture_expr}")
    for magnet in problem.magnets:
        magnet_var = magnet_vars[magnet.name]
        for assignment in magnet.material_parameter_fields:
            field_expr = _render_material_parameter_field_expr(assignment.value)
            kwargs = [
                _py_repr(assignment.parameter),
                field_expr,
                f"assignment_id={_py_repr(assignment.assignment_id)}",
            ]
            if assignment.region_id is not None:
                region_ref = region_vars.get(assignment.region_id)
                if region_ref is not None:
                    kwargs.append(f"region={region_ref}")
                else:
                    kwargs.append(f"region={_py_repr(assignment.region_id)}")
            if assignment.priority:
                kwargs.append(f"priority={int(assignment.priority)}")
            if assignment.conflict_policy != "error":
                kwargs.append(f"conflict_policy={_py_repr(assignment.conflict_policy)}")
            lines.append(f"{magnet_var}.set_material_field({', '.join(kwargs)})")
    if lines:
        return ["# Object-owned regions and material fields", *lines], region_vars
    return [], region_vars


def _render_region_owned_authoring_from_override(
    geometries: list[object],
    *,
    magnet_vars: dict[str, str],
    source_root: Path,
) -> tuple[list[str], dict[str, str]]:
    lines: list[str] = []
    region_vars: dict[str, str] = {}
    for geo_obj in geometries:
        g = _normalize_mapping(geo_obj)
        magnet_name = str(g.get("name", ""))
        magnet_var = magnet_vars.get(magnet_name, "body")
        raw_regions = g.get("object_regions")
        object_regions = raw_regions if isinstance(raw_regions, list) else []
        live_region_ids = {
            str(region.get("region_id"))
            for region in object_regions
            if isinstance(region, dict) and region.get("region_id")
        }
        allocated_region_ids = g.get("allocated_region_ids")
        if isinstance(allocated_region_ids, list):
            for raw_region_id in allocated_region_ids:
                region_id = str(raw_region_id)
                if region_id not in live_region_ids:
                    lines.append(f"{magnet_var}.regions.reserve_id({_py_repr(region_id)})")
        for index, raw_region in enumerate(object_regions):
            region = _normalize_mapping(raw_region)
            region_id = str(region.get("region_id") or region.get("id") or "")
            if not region_id:
                continue
            region_name = str(region.get("name") or region_id.rsplit(":", 1)[-1])
            region_var = _safe_identifier(f"{magnet_name}_{region_name}_region")
            if region_var in region_vars.values():
                region_var = f"{region_var}_{index}"
            region_vars[region_id] = region_var
            kwargs = [
                _py_repr(region_name),
                _render_region_shape_expr_from_payload(
                    region.get("shape"),
                    region_name=region_name,
                    source_root=source_root,
                ),
            ]
            optional_kwargs = [f"region_id={_py_repr(region_id)}"]
            frame = region.get("frame")
            if isinstance(frame, str) and frame != "object":
                optional_kwargs.append(f"frame={_py_repr(frame)}")
            if region.get("enabled") is False:
                optional_kwargs.append("enabled=False")
            priority = region.get("priority")
            if priority:
                optional_kwargs.append(f"priority={int(priority)}")
            realization_policy = region.get("realization_policy")
            if isinstance(realization_policy, str) and realization_policy != "inherit":
                optional_kwargs.append(
                    f"realization_policy={_py_repr(realization_policy)}"
                )
            call_args = ", ".join([*kwargs, *optional_kwargs])
            lines.append(f"{region_var} = {magnet_var}.add_region({call_args})")
            transition = _normalize_mapping(region.get("material_transition"))
            if transition:
                transition_kwargs = _render_material_transition_kwargs(transition)
                if transition_kwargs:
                    lines.append(
                        f"{region_var}.material_transition({', '.join(transition_kwargs)})"
                    )
            material_overrides = region.get("material_overrides")
            if isinstance(material_overrides, list):
                for raw_override in material_overrides:
                    override = _normalize_mapping(raw_override)
                    field_expr = _render_material_parameter_field_expr(override.get("value"))
                    lines.append(
                        f"{region_var}.set_material({_py_repr(str(override.get('parameter')))}, {field_expr}, "
                        f"priority={int(override.get('priority', 0))}, "
                        f"conflict_policy={_py_repr(str(override.get('conflict_policy', 'error')))})"
                    )
            mesh_policy = _normalize_mapping(region.get("mesh_policy"))
            if mesh_policy:
                mesh_kwargs = _render_region_mesh_policy_kwargs(mesh_policy)
                if mesh_kwargs:
                    lines.append(f"{region_var}.mesh({', '.join(mesh_kwargs)})")
            texture_override = _normalize_mapping(region.get("texture_override"))
            texture = texture_override.get("initial_magnetization")
            if isinstance(texture, dict):
                texture_expr = _render_initial_magnetization_expr_from_payload(
                    texture,
                    source_root=source_root,
                )
                if texture_expr is not None:
                    lines.append(f"{region_var}.texture = {texture_expr}")
    for geo_obj in geometries:
        g = _normalize_mapping(geo_obj)
        magnet_name = str(g.get("name", ""))
        magnet_var = magnet_vars.get(magnet_name, "body")
        raw_assignments = g.get("material_parameter_fields")
        assignments = raw_assignments if isinstance(raw_assignments, list) else []
        for raw_assignment in assignments:
            assignment = _normalize_mapping(raw_assignment)
            field_expr = _render_material_parameter_field_expr(assignment.get("value"))
            kwargs = [
                _py_repr(str(assignment.get("parameter"))),
                field_expr,
                f"assignment_id={_py_repr(str(assignment.get('assignment_id')))}",
            ]
            region_id = assignment.get("region_id")
            if isinstance(region_id, str) and region_id:
                region_ref = region_vars.get(region_id)
                if region_ref is not None:
                    kwargs.append(f"region={region_ref}")
                else:
                    kwargs.append(f"region={_py_repr(region_id)}")
            priority = assignment.get("priority")
            if priority:
                kwargs.append(f"priority={int(priority)}")
            conflict_policy = assignment.get("conflict_policy")
            if isinstance(conflict_policy, str) and conflict_policy != "error":
                kwargs.append(f"conflict_policy={_py_repr(conflict_policy)}")
            lines.append(f"{magnet_var}.set_material_field({', '.join(kwargs)})")
    if lines:
        return ["# Object-owned regions and material fields", *lines], region_vars
    return [], region_vars


def _render_region_shape_expr_from_payload(
    raw_shape: object,
    *,
    region_name: str,
    source_root: Path,
) -> str:
    shape = _normalize_mapping(raw_shape)
    kind = str(shape.get("kind") or "box")
    if kind == "box":
        params = {"size": shape.get("size")}
        return _render_geometry_expr_from_override(
            "Box",
            params,
            name=region_name,
            source_root=source_root,
        )
    if kind == "cylinder":
        params = {
            "radius": shape.get("radius"),
            "height": shape.get("height"),
        }
        return _render_geometry_expr_from_override(
            "Cylinder",
            params,
            name=region_name,
            source_root=source_root,
        )
    if kind == "sphere":
        radius = shape.get("radius")
        params = {"rx": radius, "ry": radius, "rz": radius}
        return _render_geometry_expr_from_override(
            "Ellipsoid",
            params,
            name=region_name,
            source_root=source_root,
        )
    return _render_geometry_expr_from_override(
        "Box",
        {},
        name=region_name,
        source_root=source_root,
    )


def _render_initial_magnetization_expr_from_payload(
    payload: dict[str, object],
    *,
    source_root: Path,
) -> str | None:
    kind = str(payload.get("kind") or "")
    if kind == "uniform":
        value = payload.get("value")
        if isinstance(value, list) and len(value) == 3:
            return (
                "fm.texture.uniform("
                f"{_py_number(float(value[0]))}, "
                f"{_py_number(float(value[1]))}, "
                f"{_py_number(float(value[2]))})"
            )
    if kind == "random":
        seed = payload.get("seed")
        return f"fm.texture.random(seed={int(seed) if seed is not None else 1})"
    if kind in {"file", "sampled"}:
        source_path = payload.get("source_path")
        if isinstance(source_path, str) and source_path:
            return f"fm.texture.loadfile({_py_repr(_relativize_path(source_path, source_root))})"
    return None


def _render_region_mesh_policy_kwargs(mesh_policy: dict[str, object]) -> list[str]:
    keys = [
        "maximum_element_size",
        "minimum_element_size",
        "transition_distance",
        "order",
    ]
    kwargs: list[str] = []
    for key in keys:
        value = mesh_policy.get(key)
        if value is not None:
            kwargs.append(f"{key}={_py_literal(value)}")
    return kwargs


def _render_material_transition_kwargs(transition: dict[str, object]) -> list[str]:
    kind = str(transition.get("kind") or "")
    kwargs: list[str] = []
    if kind and kind != "mesh_relative":
        kwargs.append(f"kind={_py_repr(kind)}")
    if transition.get("cells") is not None:
        kwargs.append(f"cells={int(transition['cells'])}")
    if transition.get("width") is not None:
        kwargs.append(f"width={_py_literal(transition['width'])}")
    scope = transition.get("scope")
    if isinstance(scope, str) and scope != "boundary" and kind != "sharp":
        kwargs.append(f"scope={_py_repr(scope)}")
    return kwargs


def _render_material_parameter_field_expr(value: object) -> str:
    payload = value.to_ir() if hasattr(value, "to_ir") else value
    if not isinstance(payload, dict):
        raise ValueError("material parameter field must render from a dict payload")
    kind = payload.get("kind")
    if kind == "constant":
        args = [_py_literal(payload.get("value"))]
        unit = payload.get("unit")
        if unit is not None:
            args.append(f"unit={_py_repr(str(unit))}")
        return f"fm.fields.constant({', '.join(args)})"
    if kind == "linear":
        kwargs = [
            f"base={_py_literal(payload.get('base'))}",
            f"gradient={_py_literal(payload.get('gradient'))}",
        ]
        frame = payload.get("frame")
        if frame not in (None, "object"):
            kwargs.append(f"frame={_py_repr(str(frame))}")
        unit = payload.get("unit")
        if unit is not None:
            kwargs.append(f"unit={_py_repr(str(unit))}")
        return f"fm.fields.linear({', '.join(kwargs)})"
    if kind == "radial":
        kwargs = [
            f"center={_py_literal(payload.get('center'))}",
            f"radius={_py_literal(payload.get('radius'))}",
            f"inside={_py_literal(payload.get('inside'))}",
            f"outside={_py_literal(payload.get('outside'))}",
        ]
        frame = payload.get("frame")
        if frame not in (None, "object"):
            kwargs.append(f"frame={_py_repr(str(frame))}")
        unit = payload.get("unit")
        if unit is not None:
            kwargs.append(f"unit={_py_repr(str(unit))}")
        return f"fm.fields.radial({', '.join(kwargs)})"
    if kind == "sampled":
        return (
            "fm.fields.sampled("
            f"asset_id={_py_repr(str(payload.get('asset_id')))}, "
            f"component_count={int(payload.get('component_count', 1))}, "
            f"location={_py_repr(str(payload.get('location')))}, "
            f"unit={_py_repr(str(payload.get('unit')))}"
            ")"
        )
    raise ValueError(f"unsupported material parameter field kind {kind!r}")


def _render_couplings(
    problem: Problem,
    magnet_vars: dict[str, str],
    *,
    region_vars: dict[str, str] | None = None,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    couplings_override = overrides.get("couplings")
    if isinstance(couplings_override, list):
        coupling_payloads = [
            _normalize_mapping(coupling)
            for coupling in couplings_override
            if isinstance(coupling, dict)
        ]
    else:
        coupling_payloads = [coupling.to_ir() for coupling in problem.couplings]
    if not coupling_payloads:
        return []
    root = "study.couplings" if surface == "study" else "fm.couplings.registry()"
    lines = ["# Couplings"]
    if surface != "study":
        lines.append("couplings = fm.couplings.registry()")
        root = "couplings"
    for coupling in coupling_payloads:
        source_expr = _render_coupling_endpoint_expr(
            coupling.get("source"),
            magnet_vars,
            region_vars=region_vars,
        )
        target_expr = _render_coupling_endpoint_expr(
            coupling.get("target"),
            magnet_vars,
            region_vars=region_vars,
        )
        params = _normalize_mapping(coupling.get("parameters"))
        kind = str(coupling.get("kind") or params.get("kind") or "")
        if kind == "exchange":
            kwargs = [
                source_expr,
                target_expr,
                f"mode={_py_repr(str(params.get('mode', 'harmonic_mean')))}",
            ]
            if params.get("scale") is not None:
                kwargs.append(f"scale={_py_literal(params.get('scale'))}")
            if params.get("inter_exchange") is not None:
                kwargs.append(f"inter_exchange={_py_literal(params.get('inter_exchange'))}")
            kwargs.extend(_render_common_coupling_kwargs(coupling))
            lines.append(f"{root}.exchange({', '.join(kwargs)})")
        elif kind == "rkky":
            kwargs = [
                source_expr,
                target_expr,
                f"J1={_py_literal(params.get('j1'))}",
                *_render_common_coupling_kwargs(coupling),
            ]
            lines.append(f"{root}.rkky({', '.join(kwargs)})")
        elif kind == "interlayer_exchange":
            kwargs = [
                source_expr,
                target_expr,
                f"J1={_py_literal(params.get('j1'))}",
            ]
            if params.get("j2") is not None:
                kwargs.append(f"J2={_py_literal(params.get('j2'))}")
            kwargs.extend(_render_common_coupling_kwargs(coupling))
            lines.append(f"{root}.interlayer_exchange({', '.join(kwargs)})")
        else:
            raise ValueError(f"unsupported coupling kind {kind!r}")
    return lines


def _render_common_coupling_kwargs(coupling: object) -> list[str]:
    payload = _normalize_mapping(coupling)
    kwargs = [f"coupling_id={_py_repr(str(payload.get('coupling_id') or ''))}"]
    if payload.get("enabled") is False:
        kwargs.append("enabled=False")
    capability_policy = payload.get("capability_policy")
    if isinstance(capability_policy, str) and capability_policy != "require_runtime":
        kwargs.append(f"capability_policy={_py_repr(capability_policy)}")
    return kwargs


def _render_coupling_endpoint_expr(
    endpoint: object,
    magnet_vars: dict[str, str],
    *,
    region_vars: dict[str, str] | None = None,
) -> str:
    payload = endpoint.to_ir() if hasattr(endpoint, "to_ir") else endpoint
    if not isinstance(payload, dict):
        raise ValueError("coupling endpoint must render from a dict payload")
    kind = payload.get("kind")
    object_name = str(payload.get("object"))
    object_expr = magnet_vars.get(object_name, f"fm.couplings.object({_py_repr(object_name)})")
    if kind == "object":
        return object_expr
    if kind == "surface":
        selector = str(payload.get("selector"))
        if object_name in magnet_vars:
            return f"{object_expr}.surface({_py_repr(selector)})"
        return f"fm.couplings.surface({_py_repr(object_name)}, {_py_repr(selector)})"
    if kind == "region":
        region_id = str(payload.get("region_id"))
        region_expr = (region_vars or {}).get(region_id)
        if region_expr is not None:
            return region_expr
        return f"fm.couplings.region({_py_repr(object_name)}, {_py_repr(region_id)})"
    raise ValueError(f"unsupported coupling endpoint kind {kind!r}")


def _render_geometries_from_override(
    geometries: list[object],
    *,
    magnet_vars: dict[str, str],
    source_root: Path,
    overrides: dict[str, object],
    surface: str,
    fdm: FDM | None,
) -> list[str]:
    initial_state_override = _normalize_mapping(overrides.get("initial_state"))
    lines = ["# Geometry & Material"]
    for geo_obj in geometries:
        g = _normalize_mapping(geo_obj)
        name = str(g.get("name", ""))
        var_name = magnet_vars.get(name, "body")
        role = str(g.get("role") or "magnet")

        kind = str(g.get("geometry_kind", "Box"))
        params = _normalize_mapping(g.get("geometry_params"))
        expr = _render_geometry_expr_from_override(
            kind,
            params,
            name=name,
            source_root=source_root,
        )

        if role != "magnet":
            lines.append(
                f"{var_name} = {_surface_call(surface, 'antenna_object')}({expr}, name={_py_repr(name)})"
            )
            lines.append("")
            continue

        object_id = g.get("object_id")
        object_id_arg = (
            f", object_id={_py_repr(object_id)}"
            if isinstance(object_id, str) and object_id
            else ""
        )
        lines.append(
            f"{var_name} = {_surface_call(surface, 'geometry')}({expr}, name={_py_repr(name)}{object_id_arg})"
        )
        if (
            surface == "study"
            and isinstance(fdm, FDM)
            and _uses_canonical_fdm_mesh_authoring(fdm)
            and isinstance(fdm.per_magnet, Mapping)
        ):
            grid = fdm.per_magnet.get(name)
            if isinstance(grid, FDMGrid):
                lines.append(f"{var_name}.mesh(cell_size={_py_tuple3(grid.cell)})")
        region_name = g.get("region_name")
        if isinstance(region_name, str) and region_name and region_name != name:
            lines.append(f"{var_name}.region_name = {_py_repr(region_name)}")

        mat = _normalize_mapping(g.get("material"))
        lines.append(f"{var_name}.Ms = {_py_number(float(str(mat.get('Ms', 800000))))}")
        lines.append(f"{var_name}.Aex = {_py_number(float(str(mat.get('Aex', 1.3e-11))))}")
        lines.append(f"{var_name}.alpha = {_py_number(float(str(mat.get('alpha', 0.02))))}")
        lines.extend(_render_absorbing_boundary(var_name, g.get("absorbing_boundary")))
        physics_stack = _ensure_geometry_physics_stack(
            g.get("physics_stack"),
            material_dind=mat.get("Dind"),
            material_dbulk=mat.get("Dbulk"),
        )
        dmi = _physics_stack_dmi_value(physics_stack)
        if dmi is not None:
            lines.append(f"{var_name}.Dind = {_py_number(dmi)}")
        bulk_dmi = _physics_stack_bulk_dmi_value(physics_stack)
        if bulk_dmi is not None:
            lines.append(f"{var_name}.Dbulk = {_py_number(bulk_dmi)}")
        uniaxial = _physics_stack_uniaxial_params(physics_stack)
        if uniaxial is not None:
            ku1_val = uniaxial["ku1"]  # type: ignore[index]
            lines.append(f"{var_name}.Ku1 = {_py_number(ku1_val)}")  # type: ignore[arg-type]
            axis = uniaxial["axis"]  # type: ignore[index]
            axis0 = axis[0]  # type: ignore[index]
            axis1 = axis[1]  # type: ignore[index]
            axis2 = axis[2]  # type: ignore[index]
            lines.append(
                f"{var_name}.anisU = ({_py_number(axis0)}, {_py_number(axis1)}, {_py_number(axis2)})"
            )

        rendered_initial_override = _render_initial_state_override(
            initial_state_override,
            magnet_name=name,
            magnet_var=var_name,
            source_root=source_root,
        )
        if rendered_initial_override is not None:
            lines.extend(rendered_initial_override)
        else:
            mag = _normalize_mapping(g.get("magnetization"))
            mag_kind = str(mag.get("kind", "uniform"))
            if mag_kind == "uniform":
                val = mag.get("value")
                if isinstance(val, list) and len(val) == 3:
                    lines.append(f"{var_name}.m = fm.texture.uniform({_py_number(float(val[0]))}, {_py_number(float(val[1]))}, {_py_number(float(val[2]))})")
            elif mag_kind == "random":
                seed = mag.get("seed")
                lines.append(f"{var_name}.m = fm.texture.random(seed={int(str(seed)) if seed is not None else 1})")
            elif mag_kind in {"file", "sampled"}:
                src = str(mag.get("source_path", ""))
                if src:
                    kwargs = []
                    if mag.get("source_format") and mag.get("source_format") != "json":
                        kwargs.append(f"format={_py_repr(mag.get('source_format'))}")  # type: ignore[arg-type]
                    if mag.get("dataset"): kwargs.append(f"dataset={_py_repr(mag.get('dataset'))}")  # type: ignore[arg-type]
                    if mag.get("sample_index") not in {None, -1, ""}:
                        kwargs.append(f"sample={int(str(mag.get('sample_index')))}")
                    suffix = f", {', '.join(kwargs)}" if kwargs else ""
                    lines.append(f"{var_name}.m.loadfile({_py_repr(_relativize_path(src, source_root))}{suffix})")
            elif mag_kind == "preset_texture":
                preset_kind = mag.get("preset_kind")
                preset_params = mag.get("preset_params")
                if isinstance(preset_kind, str) and isinstance(preset_params, dict):
                    preset_expr = _render_preset_texture_expr(
                        preset_kind,
                        preset_params,
                        mapping=mag.get("mapping") if isinstance(mag.get("mapping"), dict) else None,
                        transform=mag.get("texture_transform") if isinstance(mag.get("texture_transform"), dict) else None,
                        preset_version=_positive_int(mag.get("preset_version")) or 2,
                        ui_label=mag.get("ui_label") if isinstance(mag.get("ui_label"), str) else None,
                    )
                    lines.append(f"{var_name}.m = {preset_expr}")
        
        lines.append("")

    if lines and lines[-1] == "":
        lines.pop()
    return lines


def _render_absorbing_boundary(var_name: str, raw: object) -> list[str]:
    config = _normalize_mapping(raw)
    if not config:
        return []
    faces = config.get("faces")
    if not isinstance(faces, list) or not faces:
        return []
    face_expr = "(" + ", ".join(_py_repr(str(face)) for face in faces)
    if len(faces) == 1:
        face_expr += ","
    face_expr += ")"
    return [
        f"{var_name}.alpha.absorbing_boundary("
        f"total_width={_py_number(float(config['total_width_m']))}, "
        f"ramp_width={_py_number(float(config['ramp_width_m']))}, "
        f"max_damping={_py_number(float(config['max_damping']))}, "
        f"faces={face_expr}, "
        f"profile={_py_repr(str(config.get('profile', 'smootherstep')))}, "
        f"frame={_py_repr(str(config.get('frame', 'object')))})"
    ]


_GEOMETRY_INTERACTION_ORDER = (
    "exchange",
    "demag",
    "interfacial_dmi",
    "bulk_dmi",
    "uniaxial_anisotropy",
)


def _normalize_geometry_interaction_entry(
    raw: object,
    *,
    material_dind: object,
    material_dbulk: object,
) -> dict[str, object] | None:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip()
    if kind not in _GEOMETRY_INTERACTION_ORDER:
        return None
    if kind in {"exchange", "demag"}:
        return {"kind": kind, "enabled": bool(raw.get("enabled", True)), "params": None}
    params = raw.get("params") if isinstance(raw.get("params"), dict) else {}  # type: ignore[assignment]
    if kind == "interfacial_dmi":
        dind = _number_or_none(params.get("dind"))
        if dind is None:
            dind = _number_or_none(material_dind)
        params["dind"] = dind if dind is not None else 1e-3
    elif kind == "bulk_dmi":
        dbulk = _number_or_none(params.get("dbulk"))
        if dbulk is None:
            dbulk = _number_or_none(material_dbulk)
        params["dbulk"] = dbulk if dbulk is not None else 1e-3
    elif kind == "uniaxial_anisotropy":
        ku1 = _number_or_none(params.get("ku1"))
        params["ku1"] = ku1 if ku1 is not None else 0.0
        params["axis"] = _normalize_vec3(params.get("axis"), fallback=(0.0, 0.0, 1.0))
    return {
        "kind": kind,
        "enabled": bool(raw.get("enabled", True)),
        "params": params,
    }


def _ensure_geometry_physics_stack(
    raw: object,
    *,
    material_dind: object,
    material_dbulk: object,
) -> list[dict[str, object]]:
    by_kind: dict[str, dict[str, object]] = {}
    if isinstance(raw, list):
        for entry in raw:
            normalized = _normalize_geometry_interaction_entry(
                entry,
                material_dind=material_dind,
                material_dbulk=material_dbulk,
            )
            if normalized is not None:
                by_kind[str(normalized["kind"])] = normalized
    for required in ("exchange", "demag"):
        if required not in by_kind:
            by_kind[required] = {"kind": required, "enabled": True, "params": None}
    material_dind_value = _number_or_none(material_dind)
    material_dbulk_value = _number_or_none(material_dbulk)
    if material_dind_value not in (None, 0.0) and "interfacial_dmi" not in by_kind:
        by_kind["interfacial_dmi"] = _normalize_geometry_interaction_entry(
            {"kind": "interfacial_dmi", "enabled": True, "params": None},
            material_dind=material_dind,
            material_dbulk=None,
        ) or {"kind": "interfacial_dmi", "enabled": True, "params": {"dind": 1e-3}}
    if material_dbulk_value not in (None, 0.0) and "bulk_dmi" not in by_kind:
        by_kind["bulk_dmi"] = _normalize_geometry_interaction_entry(
            {"kind": "bulk_dmi", "enabled": True, "params": None},
            material_dind=None,
            material_dbulk=material_dbulk,
        ) or {"kind": "bulk_dmi", "enabled": True, "params": {"dbulk": 1e-3}}
    ordered: list[dict[str, object]] = []
    for kind in _GEOMETRY_INTERACTION_ORDER:
        entry = by_kind.get(kind)
        if entry is not None:
            ordered.append(entry)
    return ordered


def _physics_stack_dmi_value(stack: list[dict[str, object]]) -> float | None:
    for entry in stack:
        if entry.get("kind") != "interfacial_dmi":
            continue
        if not bool(entry.get("enabled", True)):
            return None
        params = entry.get("params") if isinstance(entry.get("params"), dict) else {}  # type: ignore[assignment]
        return _number_or_none(params.get("dind"))
    return None


def _physics_stack_bulk_dmi_value(stack: list[dict[str, object]]) -> float | None:
    for entry in stack:
        if entry.get("kind") != "bulk_dmi":
            continue
        if not bool(entry.get("enabled", True)):
            return None
        params = entry.get("params") if isinstance(entry.get("params"), dict) else {}  # type: ignore[assignment]
        return _number_or_none(params.get("dbulk"))
    return None


def _physics_stack_uniaxial_params(
    stack: list[dict[str, object]],
) -> dict[str, object] | None:
    for entry in stack:
        if entry.get("kind") != "uniaxial_anisotropy":
            continue
        if not bool(entry.get("enabled", True)):
            return None
        params = entry.get("params") if isinstance(entry.get("params"), dict) else {}  # type: ignore[assignment]
        ku1 = _number_or_none(params.get("ku1"))
        axis = _normalize_vec3(params.get("axis"), fallback=(0.0, 0.0, 1.0))
        return {"ku1": ku1 if ku1 is not None else 0.0, "axis": axis}
    return None


def _render_external_field(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    explicit_override = _override_external_field(overrides.get("external_field"))
    if explicit_override is not None:
        return [
            "# External field",
            f"{_surface_call(surface, 'b_ext')}({_py_number(explicit_override[0])}, {_py_number(explicit_override[1])}, {_py_number(explicit_override[2])})",
        ]
    if "external_field" in overrides and overrides.get("external_field") is None:
        return []
    field = _problem_external_field(problem)
    if field is None:
        return []
    return [
        "# External field",
        f"{_surface_call(surface, 'b_ext')}({_py_number(field[0])}, {_py_number(field[1])}, {_py_number(field[2])})",
    ]


def _render_region_ref_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    object_id = str(entry.get("object_id") or "")
    if not object_id:
        raise ValueError("current transport region reference requires object_id")
    args = [_py_repr(object_id)]
    region_id = entry.get("region_id")
    if isinstance(region_id, str) and region_id.strip():
        args.append(f"region_id={_py_repr(region_id.strip())}")
    return f"fm.RegionRef({', '.join(args)})"


def _render_surface_ref_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    object_id = str(entry.get("object_id") or "")
    surface_id = str(entry.get("surface_id") or "")
    orientation = _optional_vec3(entry.get("orientation"))
    if not object_id or not surface_id or orientation is None:
        raise ValueError("current transport surface reference is incomplete")
    return (
        "fm.SurfaceRef("
        f"{_py_repr(object_id)}, {_py_repr(surface_id)}, "
        f"orientation={_py_tuple3(orientation)})"
    )


def _render_charge_material_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    sigma = _number_or_none(entry.get("sigma_Spm"))
    if sigma is None:
        raise ValueError("current transport material requires sigma_Spm")
    kwargs = [f"sigma_Spm={_py_number(sigma)}"]
    for key in ("sigma_parallel_Spm", "sigma_perpendicular_Spm", "sigma_AHE_Spm"):
        value = _number_or_none(entry.get(key))
        if value is not None:
            kwargs.append(f"{key}={_py_number(value)}")
    return f"fm.ChargeTransportMaterial({', '.join(kwargs)})"


def _render_charge_boundary_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    kind = str(entry.get("kind") or "")
    boundary_id = str(entry.get("id") or "")
    surfaces = entry.get("surfaces")
    if not boundary_id or not isinstance(surfaces, list) or not surfaces:
        raise ValueError("current transport boundary is incomplete")
    surfaces_expr = "[" + ", ".join(_render_surface_ref_payload(item) for item in surfaces) + "]"
    if kind == "voltage_electrode":
        potential = _number_or_none(entry.get("potential_V"))
        if potential is None:
            raise ValueError("voltage electrode requires potential_V")
        return (
            f"fm.VoltageElectrode({_py_repr(boundary_id)}, {surfaces_expr}, "
            f"potential_V={_py_number(potential)})"
        )
    if kind == "normal_current_electrode":
        current = _number_or_none(entry.get("outward_current_density_Apm2"))
        if current is None:
            raise ValueError("normal current electrode requires outward_current_density_Apm2")
        return (
            f"fm.NormalCurrentElectrode({_py_repr(boundary_id)}, {surfaces_expr}, "
            f"outward_current_density_Apm2={_py_number(current)})"
        )
    if kind == "insulating":
        return f"fm.ChargeInsulating({_py_repr(boundary_id)}, {surfaces_expr})"
    raise ValueError(f"unsupported current transport boundary kind {kind!r}")


def _render_charge_solver_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    kwargs: list[str] = []
    engine = entry.get("engine")
    if isinstance(engine, str) and engine:
        kwargs.append(f"engine={_py_repr(engine)}")
    linear = _normalize_mapping(entry.get("linear"))
    for key in ("relative_tolerance", "absolute_tolerance"):
        value = _number_or_none(linear.get(key))
        if value is not None:
            kwargs.append(f"{key}={_py_number(value)}")
    max_iterations = linear.get("max_iterations")
    if isinstance(max_iterations, int):
        kwargs.append(f"max_iterations={max_iterations}")
    for key in ("physical_residual_version", "operator_version"):
        value = entry.get(key)
        if isinstance(value, str) and value:
            kwargs.append(f"{key}={_py_repr(value)}")
    return f"fm.ChargeSolverPolicy({', '.join(kwargs)})"


def _render_spin_material_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    required = (
        "sigma_s_Spm",
        "polarization_p",
        "theta_sh",
        "lambda_sf_m",
    )
    kwargs: list[str] = []
    for key in required:
        value = _number_or_none(entry.get(key))
        if value is None:
            raise ValueError(f"spin transport material requires {key}")
        kwargs.append(f"{key}={_py_number(value)}")
    for key in ("lambda_j_m", "lambda_phi_m"):
        value = _number_or_none(entry.get(key))
        if value is not None:
            kwargs.append(f"{key}={_py_number(value)}")
    for key in ("spin_capacitance_As_per_V_m3", "density_of_states_per_spin_Jinv_m3"):
        value = _number_or_none(entry.get(key))
        if value is not None:
            kwargs.append(f"{key}={_py_number(value)}")
    formula = entry.get("capacitance_formula_version")
    if isinstance(formula, str) and formula:
        kwargs.append(f"capacitance_formula_version={_py_repr(formula)}")
    return f"fm.SpinTransportMaterial({', '.join(kwargs)})"


def _render_spin_material_assignment_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    return (
        "fm.SpinTransportMaterialAssignment("
        f"{_render_region_ref_payload(entry.get('region'))}, "
        f"{_render_spin_material_payload(entry.get('material'))})"
    )


def _render_spin_interface_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    kind = str(entry.get("kind") or "")
    interface_id = str(entry.get("id") or "")
    if not interface_id:
        raise ValueError("spin transport interface requires id")
    if kind == "transparent":
        normal = _optional_vec3(entry.get("normal_a_to_b"))
        if normal is None:
            raise ValueError("transparent spin interface requires normal_a_to_b")
        return (
            "fm.TransparentSpinInterface("
            f"id={_py_repr(interface_id)}, "
            f"side_a={_render_region_ref_payload(entry.get('side_a'))}, "
            f"side_b={_render_region_ref_payload(entry.get('side_b'))}, "
            f"normal_a_to_b={_py_tuple3(normal)})"
        )
    if kind != "mixing_conductance":
        raise ValueError(f"unsupported spin transport interface kind {kind!r}")
    normal = _optional_vec3(entry.get("normal_to_ferromagnet"))
    if normal is None:
        raise ValueError("mixing-conductance interface requires normal_to_ferromagnet")
    kwargs = [
        f"id={_py_repr(interface_id)}",
        f"normal_to_ferromagnet={_py_tuple3(normal)}",
        f"normal_side={_render_region_ref_payload(entry.get('normal_side'))}",
        f"ferromagnet_side={_render_region_ref_payload(entry.get('ferromagnet_side'))}",
    ]
    normal_surface = entry.get("normal_surface")
    ferromagnet_surface = entry.get("ferromagnet_surface")
    if (normal_surface is None) != (ferromagnet_surface is None):
        raise ValueError("mixing-conductance interface requires both explicit surfaces or neither")
    if normal_surface is not None:
        kwargs.append(f"normal_surface={_render_surface_ref_payload(normal_surface)}")
        kwargs.append(
            f"ferromagnet_surface={_render_surface_ref_payload(ferromagnet_surface)}"
        )
    for key in ("g_up_Spm2", "g_down_Spm2", "g_r_Spm2", "g_i_Spm2"):
        value = _number_or_none(entry.get(key))
        if value is None:
            raise ValueError(f"mixing-conductance interface requires {key}")
        kwargs.append(f"{key}={_py_number(value)}")
    sml = entry.get("spin_memory_loss")
    if isinstance(sml, Mapping):
        sml_entry = _normalize_mapping(sml)
        sml_kwargs: list[str] = []
        for key in ("g_n_Spm2", "g_f_Spm2", "g_lattice_Spm2"):
            value = _number_or_none(sml_entry.get(key))
            if value is None:
                raise ValueError(f"spin-memory-loss reservoir requires {key}")
            sml_kwargs.append(f"{key}={_py_number(value)}")
        formula = sml_entry.get("formula_version")
        if isinstance(formula, str) and formula:
            sml_kwargs.append(f"formula_version={_py_repr(formula)}")
        kwargs.append(
            "spin_memory_loss=fm.SpinMemoryLossReservoir("
            + ", ".join(sml_kwargs)
            + ")"
        )
    return f"fm.MixingConductanceSpinInterface({', '.join(kwargs)})"


def _render_spin_boundary_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    kind = str(entry.get("kind") or "")
    boundary_id = str(entry.get("id") or "")
    surfaces = entry.get("surfaces")
    if not boundary_id or not isinstance(surfaces, list) or not surfaces:
        raise ValueError("spin transport boundary is incomplete")
    surfaces_expr = "[" + ", ".join(_render_surface_ref_payload(item) for item in surfaces) + "]"
    if kind == "spin_insulating":
        return f"fm.SpinInsulating({_py_repr(boundary_id)}, {surfaces_expr})"
    if kind == "spin_sink":
        return f"fm.SpinSink({_py_repr(boundary_id)}, {surfaces_expr})"
    if kind == "specified_spin_potential":
        value = _optional_vec3(entry.get("spin_potential_V"))
        if value is None:
            raise ValueError("specified spin potential requires spin_potential_V")
        return (
            f"fm.SpecifiedSpinPotential({_py_repr(boundary_id)}, {surfaces_expr}, "
            f"{_py_tuple3(value)})"
        )
    if kind == "specified_spin_flux":
        value = _optional_vec3(entry.get("normal_spin_flux_Apm2"))
        if value is None:
            raise ValueError("specified spin flux requires normal_spin_flux_Apm2")
        return (
            f"fm.SpecifiedSpinFlux({_py_repr(boundary_id)}, {surfaces_expr}, "
            f"{_py_tuple3(value)})"
        )
    raise ValueError(f"unsupported spin transport boundary kind {kind!r}")


def _render_periodic_spin_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    boundary_id = str(entry.get("id") or "")
    translation = _optional_vec3(entry.get("translation_m"))
    if not boundary_id or translation is None:
        raise ValueError("periodic spin boundary is incomplete")
    return (
        "fm.PeriodicSpin("
        f"{_py_repr(boundary_id)}, "
        f"minus_surface={_render_surface_ref_payload(entry.get('minus_surface'))}, "
        f"plus_surface={_render_surface_ref_payload(entry.get('plus_surface'))}, "
        f"translation_m={_py_tuple3(translation)})"
    )


def _render_spin_solver_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    linear = _normalize_mapping(entry.get("linear"))
    kwargs: list[str] = []
    for key in ("engine", "operator_version", "default_external_boundary"):
        value = entry.get(key)
        if isinstance(value, str) and value:
            kwargs.append(f"{key}={_py_repr(value)}")
    for key in ("relative_tolerance", "absolute_tolerance"):
        value = _number_or_none(linear.get(key))
        if value is not None:
            kwargs.append(f"{key}={_py_number(value)}")
    max_iterations = linear.get("max_iterations")
    if isinstance(max_iterations, int):
        kwargs.append(f"max_iterations={max_iterations}")
    nonlinear = entry.get("reciprocal_nonlinear")
    if isinstance(nonlinear, Mapping):
        nonlinear_entry = _normalize_mapping(nonlinear)
        nonlinear_kwargs: list[str] = []
        for key in ("gmres_restart", "max_picard_iterations"):
            value = nonlinear_entry.get(key)
            if isinstance(value, int):
                nonlinear_kwargs.append(f"{key}={value}")
        for key in ("relative_update_tolerance", "eta_transport"):
            value = _number_or_none(nonlinear_entry.get(key))
            if value is not None:
                nonlinear_kwargs.append(f"{key}={_py_number(value)}")
        kwargs.append(
            "reciprocal_nonlinear=fm.ReciprocalNonlinearSolverPolicy("
            + ", ".join(nonlinear_kwargs)
            + ")"
        )
    return f"fm.SpinSolverPolicy({', '.join(kwargs)})"


def _render_transport_execution_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    kwargs: list[str] = []
    for key in ("discretization", "device", "precision", "execution_mode"):
        value = entry.get(key)
        if isinstance(value, str) and value:
            kwargs.append(f"{key}={_py_repr(value)}")
    return f"fm.TransportExecution({', '.join(kwargs)})"


def _render_spin_transport_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    module_id = str(entry.get("id") or "")
    source_id = str(entry.get("current_source_id") or "")
    domain = entry.get("domain")
    materials = entry.get("materials")
    if not module_id or not source_id or not isinstance(domain, list) or not domain:
        raise ValueError("spin transport requires id, current_source_id, and domain")
    if not isinstance(materials, list) or not materials:
        raise ValueError("spin transport requires materials")
    kwargs = [
        f"id={_py_repr(module_id)}",
        f"current_source_id={_py_repr(source_id)}",
        "domain=[" + ", ".join(_render_region_ref_payload(item) for item in domain) + "]",
        "materials=["
        + ", ".join(_render_spin_material_assignment_payload(item) for item in materials)
        + "]",
    ]
    interfaces = entry.get("interfaces")
    if isinstance(interfaces, list) and interfaces:
        kwargs.append(
            "interfaces=[" + ", ".join(_render_spin_interface_payload(item) for item in interfaces) + "]"
        )
    boundaries = entry.get("boundaries")
    if isinstance(boundaries, list) and boundaries:
        rendered_boundaries = []
        for item in boundaries:
            item_map = _normalize_mapping(item)
            if item_map.get("kind") == "periodic_spin":
                rendered_boundaries.append(_render_periodic_spin_payload(item))
            else:
                rendered_boundaries.append(_render_spin_boundary_payload(item))
        kwargs.append("boundaries=[" + ", ".join(rendered_boundaries) + "]")
    solver = entry.get("solver")
    if isinstance(solver, Mapping):
        kwargs.append(f"solver={_render_spin_solver_payload(solver)}")
    requested_execution = entry.get("requested_execution")
    if isinstance(requested_execution, Mapping):
        kwargs.append(
            f"requested_execution={_render_transport_execution_payload(requested_execution)}"
        )
    mode = entry.get("mode")
    if isinstance(mode, str) and mode != "steady":
        kwargs.append(f"mode={_py_repr(mode)}")
    return f"fm.SpinDriftDiffusion({', '.join(kwargs)})"


def _render_spin_transports(
    problem: Problem,
    *,
    surface: str,
    overrides: dict[str, object] | None = None,
) -> list[str]:
    resolved_overrides = overrides or {}
    if "spin_transports" in resolved_overrides:
        override_modules = resolved_overrides["spin_transports"]
        if not isinstance(override_modules, list):
            raise ValueError("spin_transports override must be a list")
        modules: Sequence[object] = override_modules
    else:
        modules = problem.spin_transports
    if not modules:
        return []
    lines = ["# Spin transport"]
    for module in modules:
        if isinstance(module, SpinDriftDiffusion):
            payload = _export_spin_transport_entry(problem, module)
        elif isinstance(module, Mapping):
            payload = dict(module)
        else:
            raise ValueError(
                "canonical flat-script rewrite does not yet support spin transport "
                f"{type(module).__name__}"
            )
        lines.append(_render_spin_transport_payload(payload))
    register = _surface_call(surface, "spin_transport")
    return [lines[0], *(f"{register}({expression})" for expression in lines[1:])]


def _render_int_triplet(value: object, context: str) -> str:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or len(value) != 3:
        raise ValueError(f"{context} must contain three integer values")
    values = tuple(value)
    if any(isinstance(item, bool) or not isinstance(item, int) for item in values):
        raise ValueError(f"{context} must contain three integer values")
    return "(" + ", ".join(str(item) for item in values) + ")"


def _render_conservative_current_view_payload(payload: object) -> str:
    entry = _normalize_mapping(payload)
    stable_ids = entry.get("stable_vertex_ids")
    if not isinstance(stable_ids, list) or not stable_ids:
        raise ValueError("conservative current view stable_vertex_ids is incomplete")
    stable_expr = "[" + ", ".join(str(item) for item in stable_ids) + "]"

    boundary_value = entry.get("boundary_faces")
    if not isinstance(boundary_value, list) or not boundary_value:
        raise ValueError("conservative current view boundary_faces is incomplete")
    boundary_exprs = []
    for raw_face in boundary_value:
        face = _normalize_mapping(raw_face)
        face_ids = _render_int_triplet(face.get("face_vertex_ids"), "boundary face_vertex_ids")
        role = face.get("role")
        if not isinstance(role, str) or not role.strip():
            raise ValueError("conservative current view boundary role is incomplete")
        kwargs = [f"role={_py_repr(role)}"]
        circuit = face.get("circuit_id")
        if circuit is not None:
            kwargs.append(f"circuit_id={_py_repr(str(circuit))}")
        boundary_exprs.append(
            "fm.ConservativeCurrentBoundaryFace("
            f"{face_ids}, {', '.join(kwargs)})"
        )

    identity = _normalize_mapping(entry.get("identity"))
    identity_fields = (
        "source_module_id",
        "source_state_revision",
        "source_field_digest",
        "conductivity_digest",
        "mesh_revision",
        "topology_revision",
        "geometry_digest",
        "envelope_revision",
        "envelope_digest",
    )
    identity_kwargs = [
        f"{field}={_py_repr(str(identity.get(field) or ''))}" for field in identity_fields
    ]
    identity_kwargs.extend(
        [
            f"evaluated_envelope_multiplier={_py_number(_number_or_none(identity.get('evaluated_envelope_multiplier')) or 0.0)}",
            f"evaluation_time_s={_py_number(_number_or_none(identity.get('evaluation_time_s')) or 0.0)}",
            f"stage_identity={int(identity.get('stage_identity') or 0)}",
        ]
    )
    identity_expr = f"fm.ConservativeCurrentIdentity({', '.join(identity_kwargs)})"

    pins = _normalize_mapping(entry.get("pins"))
    pin_fields = (
        "required_source_state_revision",
        "required_source_field_digest",
        "required_mesh_revision",
        "required_topology_revision",
    )
    pins_expr = "fm.ConservativeCurrentPins(" + ", ".join(
        f"{field}={_py_repr(str(pins.get(field) or ''))}" for field in pin_fields
    ) + ")"

    closure = _normalize_mapping(entry.get("closure"))
    if closure.get("kind") == "external_lead":
        interface_value = closure.get("interface_pairs")
        minus_faces = closure.get("minus_outer_electrode_face_vertex_ids")
        plus_faces = closure.get("plus_outer_electrode_face_vertex_ids")
        conductivity = closure.get("lead_conductivity_spm_per_element")
        stable_lead_ids = closure.get("lead_stable_vertex_ids")
        lead_mesh = closure.get("lead_mesh")
        if (
            not isinstance(interface_value, list)
            or not interface_value
            or not isinstance(minus_faces, list)
            or not minus_faces
            or not isinstance(plus_faces, list)
            or not plus_faces
            or not isinstance(conductivity, list)
            or not isinstance(stable_lead_ids, list)
            or not isinstance(lead_mesh, Mapping)
        ):
            raise ValueError("conservative current external-lead closure is incomplete")
        pair_exprs = []
        for raw_pair in interface_value:
            if not isinstance(raw_pair, list) or len(raw_pair) != 2:
                raise ValueError("external-lead interface_pairs must contain two faces")
            pair_exprs.append(
                "fm.ConservativeCurrentLeadInterfacePair("
                f"{_py_literal(raw_pair[0])}, {_py_literal(raw_pair[1])})"
            )
        closure_expr = (
            "fm.ConservativeCurrentExternalLead("
            f"operator_version={_py_repr(str(closure.get('operator_version') or ''))}, "
            f"revision={_py_repr(str(closure.get('revision') or ''))}, "
            f"digest={_py_repr(str(closure.get('digest') or ''))}, "
            f"drive_id={_py_repr(str(closure.get('drive_id') or ''))}, "
            "outer_electrode_potential_drop_v="
            f"{_py_number(_number_or_none(closure.get('outer_electrode_potential_drop_v')) or 0.0)}, "
            f"lead_mesh={_py_literal(dict(lead_mesh))}, "
            f"lead_conductivity_spm_per_element={_py_literal(conductivity)}, "
            f"lead_stable_vertex_ids={_py_literal(stable_lead_ids)}, "
            f"interface_pairs=[{', '.join(pair_exprs)}], "
            f"minus_outer_electrode_face_vertex_ids={_py_literal(minus_faces)}, "
            f"plus_outer_electrode_face_vertex_ids={_py_literal(plus_faces)}, "
            f"lead_conductivity_digest={_py_repr(str(closure.get('lead_conductivity_digest') or ''))})"
        )
    elif closure.get("kind") == "closed_geometry":
        cuts = closure.get("source_cuts")
        if not isinstance(cuts, list) or not cuts:
            raise ValueError("conservative current view source_cuts is incomplete")
        cut_exprs = []
        for raw_cut in cuts:
            cut = _normalize_mapping(raw_cut)
            pairs = cut.get("face_pairs")
            if not isinstance(pairs, list) or not pairs:
                raise ValueError("conservative current view source-cut face_pairs is incomplete")
            pair_exprs = []
            for raw_pair in pairs:
                pair = _normalize_mapping(raw_pair)
                pair_exprs.append(
                    "fm.ConservativeCurrentSourceCutFacePair("
                    f"{_render_int_triplet(pair.get('minus_face_vertex_ids'), 'minus face IDs')}, "
                    f"{_render_int_triplet(pair.get('plus_face_vertex_ids'), 'plus face IDs')})"
                )
            cut_exprs.append(
                "fm.ConservativeCurrentSourceCut("
                f"{_py_repr(str(cut.get('id') or ''))}, "
                f"{_py_tuple3(_optional_vec3(cut.get('translation_m')) or (0.0, 0.0, 0.0))}, "
                f"{_py_number(_number_or_none(cut.get('potential_drop_v')) or 0.0)}, "
                f"[{', '.join(pair_exprs)}])"
            )
        closure_expr = (
            "fm.ConservativeCurrentClosedGeometry("
            f"{_py_repr(str(closure.get('operator_version') or ''))}, "
            f"{_py_repr(str(closure.get('revision') or ''))}, "
            f"{_py_repr(str(closure.get('digest') or ''))}, "
            f"[{', '.join(cut_exprs)}])"
        )
    else:
        raise ValueError("canonical script export supports only known current closures")
    view_kwargs = [
        f"stable_vertex_ids={stable_expr}",
        f"boundary_faces=[{', '.join(boundary_exprs)}]",
        f"identity={identity_expr}",
        f"pins={pins_expr}",
        f"closure={closure_expr}",
        f"algebraic_relative_tolerance={_py_number(_number_or_none(entry.get('algebraic_relative_tolerance')) or 0.0)}",
        f"physical_relative_gate={_py_number(_number_or_none(entry.get('physical_relative_gate')) or 0.0)}",
        f"physical_absolute_gate_a={_py_number(_number_or_none(entry.get('physical_absolute_gate_a')) or 0.0)}",
    ]
    if bool(entry.get("reference_mpi_gather_broadcast", False)):
        view_kwargs.append("reference_mpi_gather_broadcast=True")
    return f"fm.ConservativeCurrentView({', '.join(view_kwargs)})"


def _render_current_transport_payload(payload: object, *, surface: str) -> str:
    entry = _normalize_mapping(payload)
    kwargs = [f"name={_py_repr(str(entry.get('name') or 'transport'))}"]
    model = str(entry.get("model") or "prescribed_density")
    if model != "prescribed_density":
        kwargs.append(f"model={_py_repr(model)}")
    coupling = str(entry.get("coupling") or "one_way")
    if coupling != "one_way":
        kwargs.append(f"coupling={_py_repr(coupling)}")
    current_density = _optional_vec3(entry.get("current_density"))
    if current_density is not None:
        kwargs.append(f"current_density={_py_tuple3(current_density)}")
    solve_region = entry.get("solve_region")
    if isinstance(solve_region, str) and solve_region.strip():
        kwargs.append(f"solve_region={_py_repr(solve_region.strip())}")
    conductivity = _number_or_none(entry.get("conductivity_s_per_m"))
    if conductivity is not None:
        kwargs.append(f"conductivity_s_per_m={_py_number(conductivity)}")
    domain = entry.get("domain")
    if isinstance(domain, list) and domain:
        kwargs.append(
            "domain=[" + ", ".join(_render_region_ref_payload(item) for item in domain) + "]"
        )
    materials = entry.get("materials")
    if isinstance(materials, list) and materials:
        assignments: list[str] = []
        for item in materials:
            assignment = _normalize_mapping(item)
            assignments.append(
                "fm.ChargeTransportMaterialAssignment("
                f"{_render_region_ref_payload(assignment.get('region'))}, "
                f"{_render_charge_material_payload(assignment.get('material'))})"
            )
        kwargs.append("materials=[" + ", ".join(assignments) + "]")
    boundaries = entry.get("boundaries")
    if isinstance(boundaries, list) and boundaries:
        kwargs.append(
            "boundaries=["
            + ", ".join(_render_charge_boundary_payload(item) for item in boundaries)
            + "]"
        )
    gauge = entry.get("gauge")
    if isinstance(gauge, str) and gauge:
        kwargs.append(f"gauge=fm.ChargePotentialGauge({_py_repr(gauge)})")
    solver = entry.get("solver")
    if isinstance(solver, Mapping):
        kwargs.append(f"solver={_render_charge_solver_payload(solver)}")
    time_envelope = entry.get("time_envelope")
    if isinstance(time_envelope, Mapping):
        kwargs.append("time_envelope=" + _render_sot_envelope(time_envelope))
    conservative_view = entry.get("conservative_current_view")
    if isinstance(conservative_view, Mapping):
        kwargs.append(
            "conservative_current_view="
            + _render_conservative_current_view_payload(conservative_view)
        )
    structured_closure = entry.get("structured_current_closure")
    if isinstance(structured_closure, Mapping):
        cuts = structured_closure.get("source_cuts")
        if (
            structured_closure.get("kind") != "closed_geometry"
            or not isinstance(cuts, list)
            or not cuts
        ):
            raise ValueError("structured current closure must be closed_geometry with source cuts")
        cut_exprs: list[str] = []
        for raw_cut in cuts:
            cut = _normalize_mapping(raw_cut)
            plane = _normalize_mapping(cut.get("plane"))
            drive = _normalize_mapping(cut.get("drive"))
            cut_exprs.append(
                "fm.StructuredCurrentSourceCut("
                f"source_cut_id={_py_repr(str(cut.get('source_cut_id') or ''))}, "
                f"circuit_id={_py_repr(str(cut.get('circuit_id') or ''))}, "
                f"region={_render_region_ref_payload(cut.get('region'))}, "
                "plane=fm.StructuredCutPlane("
                f"axis={_py_repr(str(plane.get('axis') or ''))}, "
                f"offset_m={_py_number(_number_or_none(plane.get('offset_m')) or 0.0)}, "
                f"normal={_py_repr(str(plane.get('normal') or ''))}), "
                "drive=fm.ImpressedPotentialJump("
                f"drive_id={_py_repr(str(drive.get('drive_id') or ''))}, "
                "potential_jump_V="
                f"{_py_number(_number_or_none(drive.get('potential_jump_V')) or 0.0)}))"
            )
        kwargs.append(
            "structured_current_closure=fm.StructuredCurrentClosure("
            f"closure_id={_py_repr(str(structured_closure.get('closure_id') or ''))}, "
            f"source_cuts=[{', '.join(cut_exprs)}])"
        )
    return f"{_surface_call(surface, 'current_transport')}({', '.join(kwargs)})"


def _render_current_modules(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    override_modules = overrides.get("current_modules")
    if isinstance(override_modules, list):
        modules = override_modules
    else:
        modules = list(problem.current_modules)
    if not modules:
        return []
    lines = ["# Current modules"]
    for module in modules:
        if isinstance(module, AntennaFieldSource):
            if module.model == "prescribed_zeeman_mask":
                kwargs = [
                    f"name={_py_repr(module.name)}",
                    'model="prescribed_zeeman_mask"',
                    f"object={_py_repr(str(module.object))}",
                    f"B={_py_number(float(module.B if module.B is not None else 0.0))}",
                    f"direction={_py_tuple3(module.direction)}",
                ]
                if module.waveform is not None:
                    kwargs.append(
                        f"waveform={_render_time_dependence_expr(module.waveform)}"
                    )
                lines.append(
                    f"{_surface_call(surface, 'antenna_field_source')}({', '.join(kwargs)})"
                )
                continue
            kwargs = [
                f"name={_py_repr(module.name)}",
                f"antenna={_render_antenna_expr(module.antenna)}",
                f"drive={_render_drive_expr(module.drive)}",
            ]
            if module.solver != "mqs_2p5d_az":
                kwargs.append(f"solver={_py_repr(module.solver)}")
            if abs(module.air_box_factor - 12.0) > 1e-12:
                kwargs.append(f"air_box_factor={_py_number(module.air_box_factor)}")
            lines.append(f"{_surface_call(surface, 'antenna_field_source')}({', '.join(kwargs)})")
            continue
        if isinstance(module, CurrentTransport):
            lines.append(_render_current_transport_payload(module.to_ir(), surface=surface))
            continue
        if isinstance(module, dict):
            lines.append(_render_current_module_override(module, surface=surface))
            continue
        raise ValueError(
            f"canonical flat-script rewrite does not yet support current module {type(module).__name__}"
        )
    return lines


def _render_field_target_expr(target: FieldTarget) -> str:
    if target.kind == "global":
        return "fm.FieldTarget.global_domain()"
    if target.kind == "object":
        return f"fm.FieldTarget.object({_py_repr(target.object_id)})"
    return (
        "fm.FieldTarget.region("
        f"{_py_repr(target.object_id)}, {_py_repr(target.region_id)})"
    )


def _render_spatial_profile_expr(profile: object) -> str:
    if isinstance(profile, UniformFieldProfile):
        return "fm.UniformFieldProfile()"
    if isinstance(profile, SincFieldProfile):
        kwargs = [
            f"axis={_py_tuple3(profile.axis)}",
            f"period_m={_py_number(profile.period_m)}",
        ]
        if abs(profile.center_m) > 0.0:
            kwargs.append(f"center_m={_py_number(profile.center_m)}")
        if profile.width_m is not None:
            kwargs.append(f"width_m={_py_number(profile.width_m)}")
        if profile.window != "none":
            kwargs.append(f"window={_py_repr(profile.window)}")
        return f"fm.SincFieldProfile({', '.join(kwargs)})"
    if isinstance(profile, GaussianPlaneWaveFieldProfile):
        kwargs = [
            f"center_x_m={_py_number(profile.center_x_m)}",
            f"center_y_m={_py_number(profile.center_y_m)}",
            f"carrier_origin_x_m={_py_number(profile.carrier_origin_x_m)}",
            f"sigma_x_m={_py_number(profile.sigma_x_m)}",
            f"sigma_y_m={_py_number(profile.sigma_y_m)}",
            f"wavelength_m={_py_number(profile.wavelength_m)}",
        ]
        if abs(profile.carrier_phase_rad) > 0.0:
            kwargs.append(f"carrier_phase_rad={_py_number(profile.carrier_phase_rad)}")
        return f"fm.GaussianPlaneWaveFieldProfile({', '.join(kwargs)})"
    if isinstance(profile, GeometryMaskFieldProfile):
        return (
            "fm.GeometryMaskFieldProfile("
            f"object_id={_py_repr(profile.object_id)}, "
            f"envelope={_render_spatial_profile_expr(profile.envelope)})"
        )
    raise TypeError(f"unsupported field profile {type(profile).__name__}")


def _render_drive_activation_expr(activation: DriveActivation) -> str:
    if activation.kind == "all_time_evolution":
        return "fm.DriveActivation.all_time_evolution()"
    return f"fm.DriveActivation.stage_ids({_py_literal(list(activation.stage_ids_value))})"


def _render_regional_field_drive_expr(drive: RegionalFieldDrive) -> str:
    kwargs = [
        f"id={_py_repr(drive.id)}",
        f"name={_py_repr(drive.name)}",
        f"target={_render_field_target_expr(drive.target)}",
        f"amplitude_B_T={_py_number(drive.amplitude_B_T)}",
        f"direction={_py_tuple3(drive.direction)}",
        f"spatial_profile={_render_spatial_profile_expr(drive.spatial_profile)}",
        f"waveform={_render_time_dependence_expr(drive.waveform)}",
        f"time_origin={_py_repr(drive.time_origin)}",
        f"activation={_render_drive_activation_expr(drive.activation)}",
    ]
    if not drive.enabled:
        kwargs.append("enabled=False")
    if drive.migration is not None:
        kwargs.append(f"migration={_py_literal(drive.migration)}")
    return f"fm.RegionalFieldDrive({', '.join(kwargs)})"


def _render_regional_field_drive_payload_expr(drive: dict[str, object]) -> str:
    target = _normalize_mapping(drive.get("target"))
    target_kind = str(target.get("kind") or "")
    if target_kind == "global":
        target_expr = "fm.FieldTarget.global_domain()"
    elif target_kind == "object":
        target_expr = f"fm.FieldTarget.object({_py_repr(str(target.get('object_id') or ''))})"
    elif target_kind == "region":
        target_expr = (
            "fm.FieldTarget.region("
            f"{_py_repr(str(target.get('object_id') or ''))}, "
            f"{_py_repr(str(target.get('region_id') or ''))})"
        )
    else:
        raise ValueError(f"unsupported field target kind: {target_kind}")

    profile = _normalize_mapping(drive.get("spatial_profile"))
    profile_kind = str(profile.get("kind") or "")
    if profile_kind == "uniform":
        profile_expr = "fm.UniformFieldProfile()"
    elif profile_kind == "sinc":
        profile_args = [
            f"axis={_py_literal(profile.get('axis'))}",
            f"period_m={_py_number(float(profile.get('period_m', 0.0)))}",
        ]
        if abs(float(profile.get("center_m", 0.0))) > 0.0:
            profile_args.append(f"center_m={_py_number(float(profile['center_m']))}")
        if profile.get("width_m") is not None:
            profile_args.append(f"width_m={_py_number(float(profile['width_m']))}")
        if profile.get("window") not in (None, "none"):
            profile_args.append(f"window={_py_repr(str(profile['window']))}")
        profile_expr = f"fm.SincFieldProfile({', '.join(profile_args)})"
    elif profile_kind == "geometry_mask":
        envelope = _normalize_mapping(profile.get("envelope"))
        profile_expr = (
            "fm.GeometryMaskFieldProfile("
            f"object_id={_py_repr(str(profile.get('object_id') or ''))}, "
            f"envelope={_render_field_profile_payload_expr(envelope)})"
        )
    elif profile_kind == "gaussian_plane_wave":
        profile_args = [
            f"center_x_m={_py_number(float(profile.get('center_x_m', 0.0)))}",
            f"center_y_m={_py_number(float(profile.get('center_y_m', 0.0)))}",
            f"carrier_origin_x_m={_py_number(float(profile.get('carrier_origin_x_m', 0.0)))}",
            f"sigma_x_m={_py_number(float(profile.get('sigma_x_m', 0.0)))}",
            f"sigma_y_m={_py_number(float(profile.get('sigma_y_m', 0.0)))}",
            f"wavelength_m={_py_number(float(profile.get('wavelength_m', 0.0)))}",
        ]
        if abs(float(profile.get("carrier_phase_rad", 0.0))) > 0.0:
            profile_args.append(
                f"carrier_phase_rad={_py_number(float(profile['carrier_phase_rad']))}"
            )
        profile_expr = f"fm.GaussianPlaneWaveFieldProfile({', '.join(profile_args)})"
    else:
        raise ValueError(f"unsupported field profile kind: {profile_kind}")

    activation = _normalize_mapping(drive.get("activation"))
    activation_kind = str(activation.get("kind") or "all_time_evolution")
    if activation_kind == "all_time_evolution":
        activation_expr = "fm.DriveActivation.all_time_evolution()"
    elif activation_kind == "stage_ids":
        activation_expr = (
            "fm.DriveActivation.stage_ids("
            f"{_py_literal(activation.get('stage_ids') or [])})"
        )
    else:
        raise ValueError(f"unsupported drive activation kind: {activation_kind}")

    waveform = _normalize_mapping(drive.get("waveform"))
    kwargs = [
        f"id={_py_repr(str(drive.get('id') or ''))}",
        f"name={_py_repr(str(drive.get('name') or ''))}",
        f"target={target_expr}",
        f"amplitude_B_T={_py_number(float(drive.get('amplitude_B_T', 0.0)))}",
        f"direction={_py_literal(drive.get('direction'))}",
        f"spatial_profile={profile_expr}",
        f"waveform={_render_waveform_override(waveform)}",
        f"time_origin={_py_repr(str(drive.get('time_origin') or 'stage_local'))}",
        f"activation={activation_expr}",
    ]
    if drive.get("enabled") is False:
        kwargs.append("enabled=False")
    migration = drive.get("migration")
    if isinstance(migration, dict):
        kwargs.append(f"migration={_py_literal(migration)}")
    return f"fm.RegionalFieldDrive({', '.join(kwargs)})"


def _render_field_profile_payload_expr(profile: dict[str, object]) -> str:
    kind = str(profile.get("kind") or "")
    if kind == "uniform":
        return "fm.UniformFieldProfile()"
    if kind == "sinc":
        args = [
            f"axis={_py_literal(profile.get('axis'))}",
            f"period_m={_py_number(float(profile.get('period_m', 0.0)))}",
        ]
        if abs(float(profile.get("center_m", 0.0))) > 0.0:
            args.append(f"center_m={_py_number(float(profile['center_m']))}")
        if profile.get("width_m") is not None:
            args.append(f"width_m={_py_number(float(profile['width_m']))}")
        if profile.get("window") not in (None, "none"):
            args.append(f"window={_py_repr(str(profile['window']))}")
        return f"fm.SincFieldProfile({', '.join(args)})"
    if kind == "gaussian_plane_wave":
        args = [
            f"center_x_m={_py_number(float(profile.get('center_x_m', 0.0)))}",
            f"center_y_m={_py_number(float(profile.get('center_y_m', 0.0)))}",
            f"carrier_origin_x_m={_py_number(float(profile.get('carrier_origin_x_m', 0.0)))}",
            f"sigma_x_m={_py_number(float(profile.get('sigma_x_m', 0.0)))}",
            f"sigma_y_m={_py_number(float(profile.get('sigma_y_m', 0.0)))}",
            f"wavelength_m={_py_number(float(profile.get('wavelength_m', 0.0)))}",
        ]
        if abs(float(profile.get("carrier_phase_rad", 0.0))) > 0.0:
            args.append(
                f"carrier_phase_rad={_py_number(float(profile['carrier_phase_rad']))}"
            )
        return f"fm.GaussianPlaneWaveFieldProfile({', '.join(args)})"
    raise ValueError(f"unsupported field profile kind: {kind}")


def _render_field_drives(problem: Problem, *, surface: str) -> list[str]:
    if not problem.field_drives:
        return []
    lines = ["# Regional field drives"]
    for drive in problem.field_drives:
        expression = _render_regional_field_drive_expr(drive)
        if surface == "study":
            lines.append(f"study.field_drives.add({expression})")
        else:
            lines.append(f"fm.field_drive({expression})")
    return lines


def _render_planar_monitors(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    override = overrides.get("planar_monitors")
    if isinstance(override, list):
        payloads = [
            _normalize_mapping(item)
            for item in override
            if isinstance(item, dict)
        ]
    else:
        payloads = [monitor.to_ir() for monitor in problem.monitors]
    if not payloads:
        return []
    if surface != "study":
        raise ValueError("canonical planar monitor rewrite requires the study API surface")

    lines = ["# Planar monitors"]
    for payload in payloads:
        lines.append(
            "study.monitors.add_planar("
            f"monitor_id={_py_repr(str(payload.get('id', '')))}, "
            f"name={_py_repr(str(payload.get('name', '')))}, "
            f"target={_render_monitor_target(payload.get('target'))}, "
            f"frame={_render_planar_frame(payload.get('frame'))}, "
            f"operator={_render_planar_operator(payload.get('operator'))}"
            ")"
        )
    return lines


def _render_monitor_target(value: object) -> str:
    payload = _normalize_mapping(value)
    kind = payload.get("kind")
    if kind == "magnetic_domain":
        return "fm.MonitorTarget.magnetic_domain()"
    if kind == "domain":
        return "fm.MonitorTarget.domain()"
    if kind == "object":
        return f"fm.MonitorTarget.object({_py_repr(str(payload.get('object_id', '')))})"
    if kind == "region":
        return (
            "fm.MonitorTarget.region("
            f"{_py_repr(str(payload.get('object_id', '')))}, "
            f"{_py_repr(str(payload.get('region_id', '')))}"
            ")"
        )
    raise ValueError(f"unsupported planar monitor target kind {kind!r}")


def _render_planar_extent(value: object) -> str:
    payload = _normalize_mapping(value)
    kind = payload.get("kind")
    if kind == "explicit":
        return (
            "fm.PlanarExtent.explicit("
            f"u=({_py_repr(payload.get('u_min_m'))}, {_py_repr(payload.get('u_max_m'))}), "
            f"v=({_py_repr(payload.get('v_min_m'))}, {_py_repr(payload.get('v_max_m'))})"
            ")"
        )
    if kind in {"target_bounds", "magnetic_domain", "universe"}:
        return (
            f"fm.PlanarExtent.{kind}("
            f"padding={_py_repr(payload.get('padding_m', 0.0))}"
            ")"
        )
    raise ValueError(f"unsupported planar extent kind {kind!r}")


def _render_planar_frame(value: object) -> str:
    payload = _normalize_mapping(value)
    extent = _render_planar_extent(payload.get("extent"))
    preset = payload.get("preset")
    origin = payload.get("origin_m")
    if preset in {"xy", "xz", "yz"} and isinstance(origin, list) and len(origin) == 3:
        position_index = {"xy": 2, "xz": 1, "yz": 0}[str(preset)]
        return (
            f"fm.PlanarFrame.{preset}("
            f"position={_py_repr(origin[position_index])}, extent={extent}"
            ")"
        )
    return (
        "fm.PlanarFrame("
        f"origin={_py_repr(payload.get('origin_m'))}, "
        f"normal={_py_repr(payload.get('normal'))}, "
        f"u_axis={_py_repr(payload.get('u_axis'))}, "
        f"extent={extent}"
        ")"
    )


def _render_surface_boundary(value: object) -> str:
    payload = _normalize_mapping(value)
    kind = payload.get("kind")
    if kind == "object_boundary":
        return "fm.SurfaceBoundary.object_boundary()"
    if kind == "region_boundary":
        return (
            "fm.SurfaceBoundary.region_boundary("
            f"{_py_repr(str(payload.get('region_id', '')))}"
            ")"
        )
    if kind == "named_surface":
        return (
            "fm.SurfaceBoundary.named("
            f"{_py_repr(str(payload.get('surface_id', '')))}"
            ")"
        )
    raise ValueError(f"unsupported surface boundary kind {kind!r}")


def _render_planar_operator(value: object) -> str:
    payload = _normalize_mapping(value)
    kind = payload.get("kind")
    if kind == "plane_sample":
        return "fm.PlaneSample()"
    if kind == "slab_average":
        return f"fm.SlabAverage(thickness={_py_repr(payload.get('thickness_m'))})"
    if kind == "depth_projection":
        return (
            "fm.DepthProjection("
            f"reduction={_py_repr(payload.get('reduction'))}, "
            f"empty_policy={_py_repr(payload.get('empty_policy'))}"
            ")"
        )
    if kind == "surface_projection":
        return (
            "fm.SurfaceProjection("
            f"boundary={_render_surface_boundary(payload.get('boundary'))}, "
            f"visibility_policy={_py_repr(payload.get('visibility_policy'))}"
            ")"
        )
    raise ValueError(f"unsupported planar operator kind {kind!r}")


def _render_spin_torques(
    problem: Problem,
    *,
    surface: str,
    overrides: dict[str, object] | None = None,
) -> list[str]:
    """Render the spin_torques list as canonical script lines."""
    resolved_overrides = overrides or {}
    if "spin_torques" in resolved_overrides:
        override_modules = resolved_overrides["spin_torques"]
        if not isinstance(override_modules, list):
            raise ValueError("spin_torques override must be a list")
        modules: Sequence[object] = override_modules
    else:
        modules = problem.spin_torques
    if not modules:
        return []
    lines = ["# Spin torques"]
    for module in modules:
        if isinstance(module, dict):
            lines.append(_render_spin_torque_override(module))
            continue
        if isinstance(module, PrescribedSpinOrbitTorque):
            lines.append(_render_prescribed_sot_entry(module.to_ir_module()))
            continue
        if isinstance(module, SlonczewskiSTT):
            kwargs = []
            if module.formula_version == "slonczewski.fullmag.v2":
                assert module.id is not None and module.target is not None
                assert module.stack_normal is not None
                kwargs.append(f"id={_py_repr(module.id)}")
                kwargs.append(
                    "target=fm.RegionRef("
                    f"object_id={_py_repr(module.target.object_id)}, "
                    f"region_id={'None' if module.target.region_id is None else _py_repr(module.target.region_id)})"
                )
                kwargs.append(f"stack_normal={_py_tuple3(module.stack_normal)}")
                if module.interface_id is not None:
                    kwargs.append(f"interface_id={_py_repr(module.interface_id)}")
            if module.current_density is not None:
                kwargs.append(f"current_density={_py_tuple3(module.current_density)}")
            if module.current_source is not None:
                kwargs.append(f"current_source={_py_repr(module.current_source)}")
            kwargs.append(f"spin_polarization={_py_tuple3(module.spin_polarization)}")
            if module.degree != 0.4:
                kwargs.append(f"degree={_py_number(module.degree)}")
            if module.lambda_asymmetry != 1.0:
                kwargs.append(f"lambda_asymmetry={_py_number(module.lambda_asymmetry)}")
            if module.epsilon_prime != 0.0:
                kwargs.append(f"epsilon_prime={_py_number(module.epsilon_prime)}")
            if module.free_layer_thickness_m is not None:
                kwargs.append(f"free_layer_thickness_m={_py_number(module.free_layer_thickness_m)}")
            if module.formula_version == "slonczewski.legacy_fullmag.v0" and module.fixed_layer_position is not None:
                kwargs.append(f"fixed_layer_position={_py_repr(module.fixed_layer_position)}")
            lines.append(f"fm.SlonczewskiSTT({', '.join(kwargs)})")
            continue
        if isinstance(module, ZhangLiSTT):
            kwargs = []
            if module.current_density is not None:
                kwargs.append(f"current_density={_py_tuple3(module.current_density)}")
            if module.current_source is not None:
                kwargs.append(f"current_source={_py_repr(module.current_source)}")
            if module.degree != 0.4:
                kwargs.append(f"degree={_py_number(module.degree)}")
            if module.beta != 0.0:
                kwargs.append(f"beta={_py_number(module.beta)}")
            if module.formula_version in {"zhang_li.fullmag.v1", "zhang_li.mumax3.v1"}:
                assert module.id is not None and module.target is not None
                assert module.lande_g is not None
                kwargs.append(f"id={_py_repr(module.id)}")
                kwargs.append(
                    "target=fm.RegionRef("
                    f"object_id={_py_repr(module.target.object_id)}, "
                    f"region_id={'None' if module.target.region_id is None else _py_repr(module.target.region_id)})"
                )
                kwargs.append(f"lande_g={_py_number(module.lande_g)}")
                if module.formula_version == "zhang_li.mumax3.v1":
                    kwargs.append(
                        f"operator_version={_py_repr(module.operator_version or 'zl_mumax3_central_v1')}"
                    )
            lines.append(f"fm.ZhangLiSTT({', '.join(kwargs)})")
            continue
        if isinstance(module, InterfaceCppSTT):
            kwargs = []
            if module.current_density is not None:
                kwargs.append(f"current_density={_py_tuple3(module.current_density)}")
            if module.current_source is not None:
                kwargs.append(f"current_source={_py_repr(module.current_source)}")
            kwargs.append(f"spin_polarization={_py_tuple3(module.spin_polarization)}")
            kwargs.append(f"interface_normal={_py_tuple3(module.interface_normal)}")
            if module.degree != 0.4:
                kwargs.append(f"degree={_py_number(module.degree)}")
            if module.lambda_asymmetry != 1.0:
                kwargs.append(f"lambda_asymmetry={_py_number(module.lambda_asymmetry)}")
            if module.epsilon_prime != 0.0:
                kwargs.append(f"epsilon_prime={_py_number(module.epsilon_prime)}")
            lines.append(f"fm.InterfaceCppSTT({', '.join(kwargs)})")
            continue
        if isinstance(module, CanonicalDriftDiffusionSpinTorque):
            lines.append(
                "fm.DriftDiffusionSpinTorque("
                f"id={_py_repr(module.id)}, "
                f"solve_id={_py_repr(module.solve_id)}, "
                f"target={_render_region_ref_payload(module.target.to_ir())})"
            )
            continue
        if isinstance(module, LegacyDriftDiffusionSpinTorque):
            kwargs = []
            if module.current_density is not None:
                kwargs.append(f"current_density={_py_tuple3(module.current_density)}")
            if module.current_source is not None:
                kwargs.append(f"current_source={_py_repr(module.current_source)}")
            kwargs.append(f"spin_polarization={_py_tuple3(module.spin_polarization)}")
            if module.degree != 0.4:
                kwargs.append(f"degree={_py_number(module.degree)}")
            if module.beta != 0.0:
                kwargs.append(f"beta={_py_number(module.beta)}")
            kwargs.append(f"spin_diffusion_length_m={_py_number(module.spin_diffusion_length_m)}")
            lines.append(f"fm.DriftDiffusionSpinTorque({', '.join(kwargs)})")
            continue
        if isinstance(module, SpinOrbitTorque):
            lines.append(_render_prescribed_sot_entry(module.to_ir_module()))
            continue
        raise ValueError(
            f"canonical flat-script rewrite does not yet support spin torque {type(module).__name__}"
        )
    register = _surface_call(surface, "spin_torque")
    return [lines[0], *(f"{register}({expression})" for expression in lines[1:])]


def _required_entry(entry: Mapping[str, object], key: str, *, context: str) -> object:
    if key not in entry:
        raise ValueError(f"{context} entry is missing required field {key!r}")
    return entry[key]


def _required_roundtrip_number(
    entry: Mapping[str, object], key: str, *, context: str
) -> str:
    value = _required_entry(entry, key, context=context)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{context}.{key} must be a finite number")
    candidate = float(value)
    if not math.isfinite(candidate):
        raise ValueError(f"{context}.{key} must be a finite number")
    return repr(value)


def _roundtrip_literal(value: object, *, context: str) -> str:
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            raise ValueError(f"{context} must contain only finite numbers")
        return repr(value)
    if isinstance(value, str):
        return _py_repr(value)
    if isinstance(value, (list, tuple)):
        opening, closing = ("[", "]") if isinstance(value, list) else ("(", ")")
        return opening + ", ".join(
            _roundtrip_literal(item, context=context) for item in value
        ) + closing
    if isinstance(value, dict):
        return "{" + ", ".join(
            f"{_py_repr(str(key))}: {_roundtrip_literal(item, context=context)}"
            for key, item in sorted(value.items())
        ) + "}"
    raise ValueError(f"{context} contains unsupported value {type(value).__name__}")


def _required_nonempty_string(
    entry: Mapping[str, object], key: str, *, context: str
) -> str:
    value = _required_entry(entry, key, context=context)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context}.{key} must be a non-empty string")
    return value


def _reject_unexpected_fields(
    entry: Mapping[str, object], allowed: set[str], *, context: str
) -> None:
    unexpected = sorted(set(entry) - allowed)
    if unexpected:
        raise ValueError(f"{context} has unsupported fields {unexpected!r}")


def _required_mapping(entry: Mapping[str, object], key: str, *, context: str) -> Mapping[str, object]:
    value = _required_entry(entry, key, context=context)
    if not isinstance(value, dict):
        raise ValueError(f"{context}.{key} must be an object")
    return value


def _required_vec3(entry: Mapping[str, object], key: str, *, context: str) -> Sequence[object]:
    value = _required_entry(entry, key, context=context)
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"{context}.{key} must be a three-component vector")
    for index, component in enumerate(value):
        if isinstance(component, bool) or not isinstance(component, (int, float)):
            raise ValueError(f"{context}.{key}[{index}] must be a finite number")
        if not math.isfinite(float(component)):
            raise ValueError(f"{context}.{key}[{index}] must be a finite number")
    return value


def _render_region_ref(entry: Mapping[str, object]) -> str:
    object_id = _required_nonempty_string(
        entry, "object_id", context="prescribed_sot.target"
    )
    kwargs = [_py_repr(object_id)]
    if "region_id" in entry:
        region_id = entry["region_id"]
        if not isinstance(region_id, str) or not region_id.strip():
            raise ValueError("prescribed_sot.target.region_id must be a non-empty string")
        kwargs.append(_py_repr(region_id))
    return f"fm.RegionRef({', '.join(kwargs)})"


def _render_sot_envelope(entry: Mapping[str, object]) -> str:
    kind = _required_entry(entry, "kind", context="prescribed_sot.drive.envelope")
    context = f"prescribed_sot.drive.envelope[{kind}]"
    allowed_by_kind = {
        "constant": {"kind", "value"},
        "sinusoidal": {"kind", "amplitude", "frequency_hz", "phase_rad", "offset"},
        "pulse": {"kind", "amplitude", "t_on_s", "t_off_s"},
        "piecewise_linear": {"kind", "points"},
        "sinc": {"kind", "amplitude", "center_s", "bandwidth_hz", "offset"},
        "tabulated": {
            "kind", "artifact_ref", "interpolation", "extrapolation", "bandwidth_hz",
        },
    }
    allowed = allowed_by_kind.get(str(kind))
    if allowed is None:
        raise ValueError(f"unsupported prescribed SOT envelope kind {kind!r}")
    _reject_unexpected_fields(entry, allowed, context=context)
    if kind == "constant":
        return f"fm.ConstantEnvelope({_required_roundtrip_number(entry, 'value', context=context)})"
    if kind == "sinusoidal":
        return (
            "fm.SinusoidalEnvelope("
            f"{_required_roundtrip_number(entry, 'amplitude', context=context)}, "
            f"{_required_roundtrip_number(entry, 'frequency_hz', context=context)}, "
            f"phase_rad={_required_roundtrip_number(entry, 'phase_rad', context=context)}, "
            f"offset={_required_roundtrip_number(entry, 'offset', context=context)})"
        )
    if kind == "pulse":
        return (
            "fm.PulseEnvelope("
            f"{_required_roundtrip_number(entry, 'amplitude', context=context)}, "
            f"{_required_roundtrip_number(entry, 't_on_s', context=context)}, "
            f"{_required_roundtrip_number(entry, 't_off_s', context=context)})"
        )
    if kind == "piecewise_linear":
        points = _required_entry(entry, "points", context=context)
        if not isinstance(points, list):
            raise ValueError(f"{context}.points must be a list")
        rendered_points: list[str] = []
        for index, point in enumerate(points):
            if not isinstance(point, dict):
                raise ValueError(f"{context}.points[{index}] must be an object")
            rendered_points.append(
                "fm.TimeEnvelopePoint("
                f"{_required_roundtrip_number(point, 'time_s', context=f'{context}.points[{index}]')}, "
                f"{_required_roundtrip_number(point, 'value', context=f'{context}.points[{index}]')})"
            )
        return f"fm.PiecewiseLinearEnvelope([{', '.join(rendered_points)}])"
    if kind == "sinc":
        return (
            "fm.SincEnvelope("
            f"{_required_roundtrip_number(entry, 'amplitude', context=context)}, "
            f"center_s={_required_roundtrip_number(entry, 'center_s', context=context)}, "
            f"bandwidth_hz={_required_roundtrip_number(entry, 'bandwidth_hz', context=context)}, "
            f"offset={_required_roundtrip_number(entry, 'offset', context=context)})"
        )
    if kind == "tabulated":
        kwargs = [
            _py_repr(_required_nonempty_string(entry, "artifact_ref", context=context)),
            f"interpolation={_py_repr(_required_nonempty_string(entry, 'interpolation', context=context))}",
            f"extrapolation={_py_repr(_required_nonempty_string(entry, 'extrapolation', context=context))}",
        ]
        if "bandwidth_hz" in entry:
            kwargs.append(
                f"bandwidth_hz={_required_roundtrip_number(entry, 'bandwidth_hz', context=context)}"
            )
        return f"fm.TabulatedEnvelope({', '.join(kwargs)})"
    raise ValueError(f"unsupported prescribed SOT envelope kind {kind!r}")


def _render_prescribed_sot_drive(entry: Mapping[str, object]) -> str:
    kind = _required_entry(entry, "kind", context="prescribed_sot.drive")
    if kind == "signed_scalar":
        _reject_unexpected_fields(
            entry,
            {"kind", "current_density_Apm2", "sigma_hat", "envelope"},
            context="prescribed_sot.drive[signed_scalar]",
        )
        kwargs = [
            _required_roundtrip_number(
                entry, "current_density_Apm2", context="prescribed_sot.drive"
            ),
            _roundtrip_literal(
                list(_required_vec3(entry, "sigma_hat", context="prescribed_sot.drive")),
                context="prescribed_sot.drive.sigma_hat",
            ),
        ]
        if "envelope" in entry:
            envelope = entry["envelope"]
            if not isinstance(envelope, dict):
                raise ValueError("prescribed_sot.drive.envelope must be an object")
            kwargs.append(_render_sot_envelope(envelope))
        return f"fm.SignedScalarDrive({', '.join(kwargs)})"
    if kind == "vector_current_source":
        _reject_unexpected_fields(
            entry,
            {"kind", "current_source_id", "drive_direction", "interface_normal"},
            context="prescribed_sot.drive[vector_current_source]",
        )
        return (
            "fm.VectorCurrentDrive("
            f"{_py_repr(_required_nonempty_string(entry, 'current_source_id', context='prescribed_sot.drive'))}, "
            f"{_roundtrip_literal(list(_required_vec3(entry, 'drive_direction', context='prescribed_sot.drive')), context='prescribed_sot.drive.drive_direction')}, "
            f"{_roundtrip_literal(list(_required_vec3(entry, 'interface_normal', context='prescribed_sot.drive')), context='prescribed_sot.drive.interface_normal')})"
        )
    raise ValueError(f"unsupported prescribed SOT drive kind {kind!r}")


def _render_prescribed_sot_entry(entry: Mapping[str, object]) -> str:
    if _required_entry(entry, "kind", context="prescribed_sot") != "prescribed_sot":
        raise ValueError("unsupported prescribed SOT kind")
    if _required_entry(entry, "schema_version", context="prescribed_sot") != "prescribed_sot.v1":
        raise ValueError("unsupported prescribed SOT schema_version")
    formula = _required_entry(entry, "formula_version", context="prescribed_sot")
    module_id = _required_entry(entry, "id", context="prescribed_sot")
    if not isinstance(module_id, str) or not module_id.strip():
        raise ValueError("prescribed_sot.id must be a non-empty string")
    if formula == "prescribed_sot.fullmag.v1":
        _reject_unexpected_fields(
            entry,
            {
                "kind", "schema_version", "id", "target", "formula_version",
                "drive", "xi_dl", "xi_fl", "free_layer_thickness_m",
            },
            context="prescribed_sot",
        )
        target = _required_mapping(entry, "target", context="prescribed_sot")
        drive = _required_mapping(entry, "drive", context="prescribed_sot")
        return (
            "fm.PrescribedSpinOrbitTorque("
            f"{_py_repr(module_id)}, {_render_region_ref(target)}, {_render_prescribed_sot_drive(drive)}, "
            f"xi_dl={_required_roundtrip_number(entry, 'xi_dl', context='prescribed_sot')}, "
            f"xi_fl={_required_roundtrip_number(entry, 'xi_fl', context='prescribed_sot')}, "
            "free_layer_thickness_m="
            f"{_required_roundtrip_number(entry, 'free_layer_thickness_m', context='prescribed_sot')})"
        )
    if formula != "prescribed_sot.legacy_fullmag.v0":
        raise ValueError(f"unsupported prescribed SOT formula_version {formula!r}")
    _reject_unexpected_fields(
        entry,
        {
            "kind", "schema_version", "id", "target", "formula_version", "drive",
            "raw_spin_polarization", "xi_dl", "xi_fl", "free_layer_thickness_m",
            "compatibility_origin",
        },
        context="legacy prescribed_sot",
    )
    prefix = "legacy_prescribed_sot_"
    if not module_id.startswith(prefix) or not module_id[len(prefix):].isdigit():
        raise ValueError("legacy prescribed SOT id must encode its module_index")
    if _required_entry(entry, "target", context="prescribed_sot") is not None:
        raise ValueError("legacy prescribed SOT target must be explicitly null")
    drive = _required_mapping(entry, "drive", context="prescribed_sot")
    drive_kind = _required_entry(drive, "kind", context="prescribed_sot.drive")
    drive_kwarg: str
    if drive_kind == "legacy_scalar_magnitude":
        _reject_unexpected_fields(
            drive,
            {"kind", "raw_charge_current_density_Apm2"},
            context="legacy prescribed_sot.drive",
        )
        drive_kwarg = (
            "raw_charge_current_density_Apm2="
            f"{_required_roundtrip_number(drive, 'raw_charge_current_density_Apm2', context='prescribed_sot.drive')}"
        )
    elif drive_kind == "legacy_current_source_norm":
        _reject_unexpected_fields(
            drive,
            {"kind", "current_source_id"},
            context="legacy prescribed_sot.drive",
        )
        drive_kwarg = (
            "current_source_id="
            f"{_py_repr(_required_nonempty_string(drive, 'current_source_id', context='prescribed_sot.drive'))}"
        )
    else:
        raise ValueError(f"unsupported legacy prescribed SOT drive kind {drive_kind!r}")
    origin = _required_mapping(entry, "compatibility_origin", context="prescribed_sot")
    return (
        "fm.PrescribedSpinOrbitTorque.from_legacy_v0("
        f"module_index={int(module_id[len(prefix):])}, target=None, {drive_kwarg}, "
        "raw_spin_polarization="
        f"{_roundtrip_literal(list(_required_vec3(entry, 'raw_spin_polarization', context='prescribed_sot')), context='prescribed_sot.raw_spin_polarization')}, "
        f"xi_dl={_required_roundtrip_number(entry, 'xi_dl', context='prescribed_sot')}, "
        f"xi_fl={_required_roundtrip_number(entry, 'xi_fl', context='prescribed_sot')}, "
        "free_layer_thickness_m="
        f"{_required_roundtrip_number(entry, 'free_layer_thickness_m', context='prescribed_sot')}, "
        f"compatibility_origin={_roundtrip_literal(dict(origin), context='prescribed_sot.compatibility_origin')})"
    )


def _render_spin_torque_override(entry: Mapping[str, object]) -> str:
    kind = _required_entry(entry, "kind", context="spin_torque")
    if kind == "prescribed_sot":
        return _render_prescribed_sot_entry(entry)
    if kind == "drift_diffusion_spin_torque":
        _reject_unexpected_fields(
            entry,
            {"kind", "schema_version", "id", "solve_id", "target", "formula_version"},
            context="drift_diffusion_spin_torque",
        )
        if entry.get("schema_version") != "drift_diffusion_spin_torque.v1":
            raise ValueError("unsupported drift-diffusion spin-torque schema_version")
        if entry.get("formula_version") != "transport_torque_angular_momentum.fullmag.v1":
            raise ValueError("unsupported drift-diffusion spin-torque formula_version")
        module_id = _required_nonempty_string(
            entry, "id", context="drift_diffusion_spin_torque"
        )
        solve_id = _required_nonempty_string(
            entry, "solve_id", context="drift_diffusion_spin_torque"
        )
        target = _required_mapping(entry, "target", context="drift_diffusion_spin_torque")
        return (
            "fm.DriftDiffusionSpinTorque("
            f"id={_py_repr(module_id)}, solve_id={_py_repr(solve_id)}, "
            f"target={_render_region_ref_payload(target)})"
        )
    constructors = {
        "slonczewski": "SlonczewskiSTT",
        "zhang_li": "ZhangLiSTT",
        "interface_cpp": "InterfaceCppSTT",
        "drift_diffusion": "DriftDiffusionSpinTorque",
    }
    constructor = constructors.get(str(kind))
    if constructor is None:
        raise ValueError(f"unsupported spin torque kind {kind!r}")
    fields_by_kind = {
        "slonczewski": {
            "kind", "current_density", "current_source", "spin_polarization", "degree",
            "lambda_asymmetry", "epsilon_prime", "free_layer_thickness_m",
            "fixed_layer_position", "formula_version", "schema_version", "id", "target",
            "stack_normal", "realization",
        },
        "zhang_li": {
            "kind", "schema_version", "id", "target", "formula_version",
            "operator_version", "current_density", "current_source", "degree", "beta", "lande_g",
        },
        "interface_cpp": {
            "kind", "current_density", "current_source", "spin_polarization",
            "interface_normal", "degree", "lambda_asymmetry", "epsilon_prime",
        },
        "drift_diffusion": {
            "kind", "current_density", "current_source", "spin_polarization", "degree",
            "beta", "spin_diffusion_length_m",
        },
    }
    _reject_unexpected_fields(entry, fields_by_kind[str(kind)], context=str(kind))
    kwargs: list[str] = []
    has_density = "current_density" in entry
    has_source = "current_source" in entry
    if has_density == has_source:
        raise ValueError(f"{kind} requires exactly one of current_density or current_source")
    if has_density:
        kwargs.append(
            f"current_density={_roundtrip_literal(list(_required_vec3(entry, 'current_density', context=str(kind))), context=f'{kind}.current_density')}"
        )
    elif has_source:
        kwargs.append(
            f"current_source={_py_repr(_required_nonempty_string(entry, 'current_source', context=str(kind)))}"
        )
    else:
        raise ValueError(f"{kind} requires current_density or current_source")
    required_by_kind = {
        "slonczewski": ("spin_polarization", "degree", "lambda_asymmetry", "epsilon_prime"),
        "zhang_li": ("degree", "beta"),
        "interface_cpp": ("spin_polarization", "interface_normal", "degree", "lambda_asymmetry", "epsilon_prime"),
        "drift_diffusion": ("spin_polarization", "degree", "beta", "spin_diffusion_length_m"),
    }
    for field in required_by_kind[str(kind)]:
        value = _required_entry(entry, field, context=str(kind))
        if field in {"spin_polarization", "interface_normal"}:
            value = list(_required_vec3(entry, field, context=str(kind)))
            kwargs.append(
                f"{field}={_roundtrip_literal(value, context=f'{kind}.{field}')}"
            )
        else:
            kwargs.append(
                f"{field}={_required_roundtrip_number(entry, field, context=str(kind))}"
            )
    if kind == "slonczewski":
        formula_version = entry.get("formula_version", "slonczewski.legacy_fullmag.v0")
        if formula_version == "slonczewski.fullmag.v2":
            if _required_entry(entry, "schema_version", context=str(kind)) != "slonczewski_torque.v1":
                raise ValueError("canonical slonczewski schema_version must be slonczewski_torque.v1")
            kwargs.append(f"id={_py_repr(_required_nonempty_string(entry, 'id', context=str(kind)))}")
            target = _required_entry(entry, "target", context=str(kind))
            if not isinstance(target, Mapping):
                raise ValueError("slonczewski target must be an object")
            object_id = _required_nonempty_string(target, "object_id", context="slonczewski.target")
            region_id = target.get("region_id")
            if region_id is not None and not isinstance(region_id, str):
                raise ValueError("slonczewski target region_id must be a string")
            kwargs.append(
                "target=fm.RegionRef("
                f"object_id={_py_repr(object_id)}, region_id={'None' if region_id is None else _py_repr(region_id)})"
            )
            kwargs.append(
                "stack_normal="
                f"{_roundtrip_literal(list(_required_vec3(entry, 'stack_normal', context=str(kind))), context='slonczewski.stack_normal')}"
            )
            realization = _required_entry(entry, "realization", context=str(kind))
            if not isinstance(realization, Mapping):
                raise ValueError("canonical slonczewski realization must be an object")
            realization_kind = realization.get("kind")
            if realization_kind == "thin_layer_homogenized":
                if realization.get("realization_version") != "slonczewski_thin_layer_homogenized.v1":
                    raise ValueError("canonical slonczewski requires thin-layer realization v1")
            elif realization_kind == "interface_flux":
                if realization.get("realization_version") != "slonczewski_interface_flux.v1":
                    raise ValueError("canonical slonczewski requires interface-flux realization v1")
                kwargs.append(
                    "interface_id="
                    f"{_py_repr(_required_nonempty_string(realization, 'interface_id', context='slonczewski.realization'))}"
                )
            else:
                raise ValueError(f"unsupported canonical slonczewski realization {realization_kind!r}")
            if "fixed_layer_position" in entry:
                raise ValueError("canonical slonczewski must not contain fixed_layer_position")
        elif formula_version == "slonczewski.fullmag.v1":
            raise ValueError("slonczewski.fullmag.v1 is read-only provenance; use slonczewski.fullmag.v2")
        elif formula_version != "slonczewski.legacy_fullmag.v0":
            raise ValueError(f"unsupported slonczewski formula_version {formula_version!r}")
        if "free_layer_thickness_m" in entry:
            kwargs.append(
                "free_layer_thickness_m="
                f"{_required_roundtrip_number(entry, 'free_layer_thickness_m', context=str(kind))}"
            )
        if formula_version == "slonczewski.legacy_fullmag.v0" and "fixed_layer_position" in entry:
            kwargs.append(
                f"fixed_layer_position={_py_repr(_required_nonempty_string(entry, 'fixed_layer_position', context=str(kind)))}"
            )
    if kind == "zhang_li":
        formula_version = entry.get("formula_version", "zhang_li.legacy_fullmag.v0")
        if formula_version in {"zhang_li.fullmag.v1", "zhang_li.mumax3.v1"}:
            if _required_entry(entry, "schema_version", context=str(kind)) != "zhang_li_torque.v1":
                raise ValueError("canonical zhang_li schema_version must be zhang_li_torque.v1")
            required_operator = (
                "zl_mumax3_central_v1"
                if formula_version == "zhang_li.mumax3.v1"
                else "zl_central_reference_v1"
            )
            if _required_entry(entry, "operator_version", context=str(kind)) != required_operator:
                raise ValueError(f"canonical zhang_li requires {required_operator}")
            kwargs.append(f"id={_py_repr(_required_nonempty_string(entry, 'id', context=str(kind)))}")
            target = _required_entry(entry, "target", context=str(kind))
            if not isinstance(target, Mapping):
                raise ValueError("zhang_li target must be an object")
            object_id = _required_nonempty_string(target, "object_id", context="zhang_li.target")
            region_id = target.get("region_id")
            if region_id is not None and not isinstance(region_id, str):
                raise ValueError("zhang_li target region_id must be a string")
            kwargs.append(
                "target=fm.RegionRef("
                f"object_id={_py_repr(object_id)}, region_id={'None' if region_id is None else _py_repr(region_id)})"
            )
            kwargs.append(
                f"lande_g={_required_roundtrip_number(entry, 'lande_g', context=str(kind))}"
            )
            if formula_version == "zhang_li.mumax3.v1":
                kwargs.append("operator_version=\"zl_mumax3_central_v1\"")
        elif formula_version != "zhang_li.legacy_fullmag.v0":
            raise ValueError(f"unsupported zhang_li formula_version {formula_version!r}")
    return f"fm.{constructor}({', '.join(kwargs)})"


def _render_oersted_time_dependence(entry: Mapping[str, object]) -> str:
    kind = _required_entry(entry, "kind", context="oersted_cylinder.time_dependence")
    context = f"oersted_cylinder.time_dependence[{kind}]"
    allowed_by_kind = {
        "constant": {"kind"},
        "sinusoidal": {"kind", "frequency_hz", "phase_rad", "offset"},
        "pulse": {"kind", "t_on", "t_off"},
        "piecewise_linear": {"kind", "points"},
        "sinc_pulse": {"kind", "cutoff_hz", "t0", "amplitude"},
    }
    allowed = allowed_by_kind.get(str(kind))
    if allowed is None:
        raise ValueError(f"unsupported Oersted time-dependence kind {kind!r}")
    _reject_unexpected_fields(entry, allowed, context=context)
    if kind == "constant":
        return "fm.model.Constant()"
    if kind == "sinusoidal":
        return (
            "fm.Sinusoidal("
            f"{_required_roundtrip_number(entry, 'frequency_hz', context=context)}, "
            f"phase_rad={_required_roundtrip_number(entry, 'phase_rad', context=context)}, "
            f"offset={_required_roundtrip_number(entry, 'offset', context=context)})"
        )
    if kind == "pulse":
        return (
            "fm.model.Pulse("
            f"{_required_roundtrip_number(entry, 't_on', context=context)}, "
            f"{_required_roundtrip_number(entry, 't_off', context=context)})"
        )
    if kind == "piecewise_linear":
        points = _required_entry(entry, "points", context=context)
        if not isinstance(points, list):
            raise ValueError(f"{context}.points must be a list")
        rendered_points: list[list[object]] = []
        for index, point in enumerate(points):
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise ValueError(f"{context}.points[{index}] must contain time and value")
            for component in point:
                if (
                    isinstance(component, bool)
                    or not isinstance(component, (int, float))
                    or not math.isfinite(float(component))
                ):
                    raise ValueError(
                        f"{context}.points[{index}] must contain finite numbers"
                    )
            rendered_points.append([point[0], point[1]])
        return f"fm.PiecewiseLinear({_roundtrip_literal(rendered_points, context=context)})"
    if kind == "sinc_pulse":
        return (
            "fm.SincPulse("
            f"{_required_roundtrip_number(entry, 'cutoff_hz', context=context)}, "
            f"t0={_required_roundtrip_number(entry, 't0', context=context)}, "
            f"amplitude={_required_roundtrip_number(entry, 'amplitude', context=context)})"
        )
    raise ValueError(f"unsupported Oersted time-dependence kind {kind!r}")


def _render_oersted_entry(entry: Mapping[str, object]) -> str:
    kind = _required_entry(entry, "kind", context="oersted")
    if kind == "oersted_field":
        _reject_unexpected_fields(
            entry,
            {"kind", "id", "model", "source"},
            context="oersted_field",
        )
        model = _required_entry(entry, "model", context="oersted_field")
        if model != "from_current_solution":
            raise ValueError(f"unsupported OerstedField model {model!r}")
        source = _required_nonempty_string(entry, "source", context="oersted_field")
        module_id = _required_nonempty_string(entry, "id", context="oersted_field")
        return f"fm.OerstedField(source={_py_repr(source)}, model={_py_repr(model)}, id={_py_repr(module_id)})"
    if kind != "oersted_cylinder":
        raise ValueError(f"unsupported Oersted term kind {kind!r}")
    _reject_unexpected_fields(
        entry,
        {"kind", "id", "current", "radius", "center", "axis", "time_dependence"},
        context="oersted_cylinder",
    )
    kwargs = [
        f"current={_required_roundtrip_number(entry, 'current', context='oersted_cylinder')}",
        f"radius={_required_roundtrip_number(entry, 'radius', context='oersted_cylinder')}",
        "center="
        f"{_roundtrip_literal(list(_required_vec3(entry, 'center', context='oersted_cylinder')), context='oersted_cylinder.center')}",
        "axis="
        f"{_roundtrip_literal(list(_required_vec3(entry, 'axis', context='oersted_cylinder')), context='oersted_cylinder.axis')}",
        f"id={_py_repr(_required_nonempty_string(entry, 'id', context='oersted_cylinder'))}",
    ]
    if "time_dependence" in entry:
        time_dependence = entry["time_dependence"]
        if not isinstance(time_dependence, dict):
            raise ValueError("oersted_cylinder.time_dependence must be an object")
        kwargs.append(
            f"time_dependence={_render_oersted_time_dependence(time_dependence)}"
        )
    return f"fm.OerstedCylinder({', '.join(kwargs)})"


def _render_oersted_terms(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str = "flat",
) -> list[str]:
    if "oersted_terms" in overrides:
        override_terms = overrides["oersted_terms"]
        if not isinstance(override_terms, list):
            raise ValueError("oersted_terms override must be a list")
        terms: Sequence[object] = override_terms
    else:
        terms = tuple(
            term
            for term in problem.energy
            if isinstance(term, (OerstedCylinder, OerstedField))
        )
    if not terms:
        return []
    lines = ["# Oersted terms"]
    for term in terms:
        if isinstance(term, (OerstedCylinder, OerstedField)):
            lines.append(_render_oersted_entry(term.to_ir()))
            continue
        if isinstance(term, dict):
            lines.append(_render_oersted_entry(term))
            continue
        raise ValueError(f"unsupported Oersted term {type(term).__name__}")
    register = _surface_call(surface, "oersted")
    return [lines[0], *(f"{register}({expression})" for expression in lines[1:])]


def _render_excitation_analysis(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    analysis_override = overrides.get("excitation_analysis")
    analysis = analysis_override if isinstance(analysis_override, dict) else problem.excitation_analysis
    if analysis is None:
        return []
    if not isinstance(analysis, SpinWaveExcitationAnalysis):
        if isinstance(analysis, dict):
            return ["# Excitation analysis", _render_excitation_analysis_override(analysis, surface=surface)]
        raise ValueError(
            "canonical flat-script rewrite does not yet support non-antenna excitation analyses"
        )
    kwargs = [
        f"source={_py_repr(analysis.source)}",
        f"method={_py_repr(analysis.method)}",
        f"propagation_axis={_py_literal(list(analysis.propagation_axis))}",
        f"samples={analysis.samples}",
    ]
    if analysis.k_max_rad_per_m is not None:
        kwargs.append(f"k_max_rad_per_m={_py_number(analysis.k_max_rad_per_m)}")
    return ["# Excitation analysis", f"{_surface_call(surface, 'spin_wave_excitation')}({', '.join(kwargs)})"]


def _mesh_mode(value: object) -> str:
    return str(value) if isinstance(value, str) and value in {"inherit", "custom"} else "inherit"


def _render_mesh_size_literal(value: object) -> str | None:
    if isinstance(value, (int, float)):
        return _py_number(float(value))
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        if stripped == "auto":
            return _py_repr("auto")
        try:
            return _py_number(float(stripped))
        except ValueError:
            return None
    return None


def _render_mesh_kwargs(mesh_config: dict[str, object], *, source_root: Path) -> list[str]:
    kwargs: list[str] = []

    rendered_hmax = _render_mesh_size_literal(
        mesh_config.get("maximum_element_size")
        if mesh_config.get("maximum_element_size") is not None
        else mesh_config.get("hmax")
    )
    if rendered_hmax is not None:
        kwargs.append(f"maximum_element_size={rendered_hmax}")

    hmin_value = _number_or_none(
        mesh_config.get("minimum_element_size")
        if mesh_config.get("minimum_element_size") is not None
        else mesh_config.get("hmin")
    )
    if hmin_value is not None:
        kwargs.append(f"minimum_element_size={_py_number(hmin_value)}")

    order_value = mesh_config.get("order")
    if isinstance(order_value, (int, float)):
        kwargs.append(f"order={int(order_value)}")

    source_value = mesh_config.get("source")
    if isinstance(source_value, str) and source_value.strip():
        kwargs.append(f"source={_py_repr(_relativize_path(source_value, source_root))}")

    calibrate_for_value = mesh_config.get("calibrate_for")
    if isinstance(calibrate_for_value, str) and calibrate_for_value.strip():
        kwargs.append(f"calibrate_for={_py_repr(calibrate_for_value)}")

    size_preset_value = mesh_config.get("size_preset")
    if isinstance(size_preset_value, str) and size_preset_value.strip():
        kwargs.append(f"size_preset={_py_repr(size_preset_value)}")

    for key in (
        "algorithm_2d",
        "algorithm_3d",
        "size_factor",
        "size_from_curvature",
        "smoothing_steps",
        "optimize_iterations",
    ):
        if mesh_config.get(key) is not None:
            kwargs.append(f"{key}={_py_literal(mesh_config[key])}")

    curvature_factor_value = _number_or_none(mesh_config.get("curvature_factor"))
    if curvature_factor_value is not None:
        kwargs.append(f"curvature_factor={_py_number(curvature_factor_value)}")

    growth_rate_value = _number_or_none(
        mesh_config.get("maximum_element_growth_rate")
        if mesh_config.get("maximum_element_growth_rate") is not None
        else mesh_config.get("growth_rate")
    )
    if growth_rate_value is not None:
        kwargs.append(f"maximum_element_growth_rate={_py_number(growth_rate_value)}")

    narrow_regions_value = mesh_config.get("narrow_regions")
    if isinstance(narrow_regions_value, (int, float)):
        kwargs.append(f"narrow_regions={int(narrow_regions_value)}")

    narrow_region_resolution_value = _number_or_none(mesh_config.get("narrow_region_resolution"))
    if narrow_region_resolution_value is not None:
        kwargs.append(
            f"narrow_region_resolution={_py_number(narrow_region_resolution_value)}"
        )

    interface_hmax_value = _number_or_none(mesh_config.get("interface_hmax"))
    if interface_hmax_value is not None:
        kwargs.append(
            f"interface_maximum_element_size={_py_number(interface_hmax_value)}"
        )

    interface_thickness_value = _number_or_none(mesh_config.get("interface_thickness"))
    if interface_thickness_value is not None:
        kwargs.append(f"interface_thickness={_py_number(interface_thickness_value)}")

    transition_distance_value = _py_transition_distance_literal(
        mesh_config.get("transition_distance")
    )
    if transition_distance_value is not None:
        kwargs.append(f"transition_distance={transition_distance_value}")

    transition_growth_value = _number_or_none(mesh_config.get("transition_growth"))
    if transition_growth_value is not None:
        kwargs.append(f"transition_growth={_py_number(transition_growth_value)}")

    edge_hmax_value = _number_or_none(
        mesh_config.get("edge_maximum_element_size")
        if mesh_config.get("edge_maximum_element_size") is not None
        else mesh_config.get("edge_hmax")
    )
    if edge_hmax_value is not None:
        kwargs.append(f"edge_maximum_element_size={_py_number(edge_hmax_value)}")

    edge_thickness_value = _number_or_none(mesh_config.get("edge_thickness"))
    if edge_thickness_value is not None:
        kwargs.append(f"edge_thickness={_py_number(edge_thickness_value)}")

    edge_transition_distance_value = _py_transition_distance_literal(
        mesh_config.get("edge_transition_distance")
    )
    if edge_transition_distance_value is not None:
        kwargs.append(
            f"edge_transition_distance={edge_transition_distance_value}"
        )

    corner_hmax_value = _number_or_none(
        mesh_config.get("corner_maximum_element_size")
        if mesh_config.get("corner_maximum_element_size") is not None
        else mesh_config.get("corner_hmax")
    )
    if corner_hmax_value is not None:
        kwargs.append(f"corner_maximum_element_size={_py_number(corner_hmax_value)}")

    corner_extent_value = _number_or_none(mesh_config.get("corner_extent"))
    if corner_extent_value is not None:
        kwargs.append(f"corner_extent={_py_number(corner_extent_value)}")

    corner_transition_distance_value = _py_transition_distance_literal(
        mesh_config.get("corner_transition_distance")
    )
    if corner_transition_distance_value is not None:
        kwargs.append(
            f"corner_transition_distance={corner_transition_distance_value}"
        )

    boundary_layer_count_value = mesh_config.get("boundary_layer_count")
    if isinstance(boundary_layer_count_value, (int, float)):
        kwargs.append(f"boundary_layer_count={int(boundary_layer_count_value)}")

    boundary_layer_thickness_value = _number_or_none(
        mesh_config.get("boundary_layer_thickness")
    )
    if boundary_layer_thickness_value is not None:
        kwargs.append(
            f"boundary_layer_thickness={_py_number(boundary_layer_thickness_value)}"
        )

    boundary_layer_stretching_value = _number_or_none(
        mesh_config.get("boundary_layer_stretching")
    )
    if boundary_layer_stretching_value is not None:
        kwargs.append(
            f"boundary_layer_stretching={_py_number(boundary_layer_stretching_value)}"
        )

    for key in (
        "boundary_layer_target_surface_tags",
        "boundary_layer_target_curve_tags",
        "boundary_layer_target_surface_selectors",
        "boundary_layer_target_curve_selectors",
    ):
        value = mesh_config.get(key)
        if isinstance(value, list) and value:
            if key.endswith("_tags"):
                kwargs.append(f"{key}={_py_literal([int(tag) for tag in value])}")
            else:
                kwargs.append(f"{key}={_py_literal(value)}")

    if mesh_config.get("optimize") is not None:
        kwargs.append(f"optimize={_py_repr(str(mesh_config['optimize']))}")
    if mesh_config.get("compute_quality") is not None:
        kwargs.append(f"compute_quality={_py_literal(bool(mesh_config['compute_quality']))}")
    if mesh_config.get("per_element_quality") is not None:
        kwargs.append(
            f"per_element_quality={_py_literal(bool(mesh_config['per_element_quality']))}"
        )

    # Swept / through-thickness parameters
    mesh_strategy_value = mesh_config.get("mesh_strategy")
    if isinstance(mesh_strategy_value, str) and mesh_strategy_value.strip():
        kwargs.append(f"mesh_strategy={_py_repr(mesh_strategy_value)}")

    through_thickness_elements_value = mesh_config.get("through_thickness_elements")
    if isinstance(through_thickness_elements_value, (int, float)):
        kwargs.append(f"through_thickness_elements={int(through_thickness_elements_value)}")

    through_thickness_distribution_value = mesh_config.get("through_thickness_distribution")
    if isinstance(through_thickness_distribution_value, str) and through_thickness_distribution_value.strip():
        kwargs.append(f"through_thickness_distribution={_py_repr(through_thickness_distribution_value)}")

    through_thickness_element_ratio_value = _number_or_none(mesh_config.get("through_thickness_element_ratio"))
    if through_thickness_element_ratio_value is not None:
        kwargs.append(f"through_thickness_element_ratio={_py_number(through_thickness_element_ratio_value)}")

    if mesh_config.get("through_thickness_symmetric"):
        kwargs.append("through_thickness_symmetric=True")

    sweep_face_meshing_value = mesh_config.get("sweep_face_meshing")
    if isinstance(sweep_face_meshing_value, str) and sweep_face_meshing_value.strip():
        kwargs.append(f"sweep_face_meshing={_py_repr(sweep_face_meshing_value)}")

    for key in (
        "topology",
        "sweep_direction",
        "element_family",
        "transition_policy",
    ):
        value = mesh_config.get(key)
        if isinstance(value, str) and value.strip():
            kwargs.append(f"{key}={_py_repr(value)}")

    exact_layer_count = mesh_config.get("exact_layer_count")
    if isinstance(exact_layer_count, bool):
        kwargs.append(f"exact_layer_count={_py_literal(exact_layer_count)}")

    periodic_pair_ids = mesh_config.get("periodic_pair_ids")
    if isinstance(periodic_pair_ids, list) and periodic_pair_ids:
        kwargs.append(f"periodic_pair_ids={_py_literal(periodic_pair_ids)}")

    return kwargs


def _render_thin_film_mesh_kwargs(mesh_config: dict[str, object]) -> list[str] | None:
    strategy = mesh_config.get("mesh_strategy")
    topology = mesh_config.get("topology")
    legacy_tetrahedral = isinstance(strategy, str) and strategy.strip() == "thin_film_tetrahedral"
    prismatic = (
        isinstance(strategy, str)
        and strategy.strip() == "swept_prism"
        and topology == "prismatic"
    )
    if not legacy_tetrahedral and not prismatic:
        return None

    distribution = mesh_config.get("through_thickness_distribution")
    if isinstance(distribution, str) and distribution.strip() not in {"", "fixed"}:
        return None
    face_meshing = mesh_config.get("sweep_face_meshing")
    if isinstance(face_meshing, str) and face_meshing.strip() not in {"", "triangular"}:
        return None
    if prismatic and (
        mesh_config.get("sweep_direction") != "auto"
        or mesh_config.get("element_family") != "prism"
        or mesh_config.get("transition_policy") != "pyramid_to_tetrahedra"
        or not isinstance(mesh_config.get("exact_layer_count"), bool)
        or mesh_config.get("through_thickness_element_ratio") is not None
        or mesh_config.get("through_thickness_symmetric") is True
        or mesh_config.get("order") != 1
    ):
        return None

    kwargs: list[str] = []
    rendered_hmax = _render_mesh_size_literal(
        mesh_config.get("maximum_element_size")
        if mesh_config.get("maximum_element_size") is not None
        else mesh_config.get("hmax")
    )
    if rendered_hmax is not None:
        kwargs.append(f"maximum_element_size={rendered_hmax}")

    hmin_value = _number_or_none(
        mesh_config.get("minimum_element_size")
        if mesh_config.get("minimum_element_size") is not None
        else mesh_config.get("hmin")
    )
    if hmin_value is not None:
        kwargs.append(f"minimum_element_size={_py_number(hmin_value)}")

    order_value = mesh_config.get("order")
    if isinstance(order_value, (int, float)):
        kwargs.append(f"order={int(order_value)}")

    curvature_factor_value = _number_or_none(mesh_config.get("curvature_factor"))
    if curvature_factor_value is not None:
        kwargs.append(f"curvature_factor={_py_number(curvature_factor_value)}")

    narrow_region_resolution_value = _number_or_none(
        mesh_config.get("narrow_region_resolution")
    )
    if narrow_region_resolution_value is not None:
        kwargs.append(
            f"narrow_region_resolution={_py_number(narrow_region_resolution_value)}"
        )

    interface_hmax_value = _number_or_none(mesh_config.get("interface_hmax"))
    if interface_hmax_value is not None:
        kwargs.append(
            f"interface_maximum_element_size={_py_number(interface_hmax_value)}"
        )

    interface_thickness_value = _number_or_none(mesh_config.get("interface_thickness"))
    if interface_thickness_value is not None:
        kwargs.append(f"interface_thickness={_py_number(interface_thickness_value)}")

    transition_distance_value = _py_transition_distance_literal(
        mesh_config.get("transition_distance")
    )
    if transition_distance_value is not None:
        kwargs.append(f"transition_distance={transition_distance_value}")

    edge_hmax_value = _number_or_none(
        mesh_config.get("edge_maximum_element_size")
        if mesh_config.get("edge_maximum_element_size") is not None
        else mesh_config.get("edge_hmax")
    )
    if edge_hmax_value is not None:
        kwargs.append(f"edge_maximum_element_size={_py_number(edge_hmax_value)}")

    edge_thickness_value = _number_or_none(mesh_config.get("edge_thickness"))
    if edge_thickness_value is not None:
        kwargs.append(f"edge_thickness={_py_number(edge_thickness_value)}")

    edge_transition_distance_value = _py_transition_distance_literal(
        mesh_config.get("edge_transition_distance")
    )
    if edge_transition_distance_value is not None:
        kwargs.append(
            f"edge_transition_distance={edge_transition_distance_value}"
        )

    corner_hmax_value = _number_or_none(
        mesh_config.get("corner_maximum_element_size")
        if mesh_config.get("corner_maximum_element_size") is not None
        else mesh_config.get("corner_hmax")
    )
    if corner_hmax_value is not None:
        kwargs.append(f"corner_maximum_element_size={_py_number(corner_hmax_value)}")

    corner_extent_value = _number_or_none(mesh_config.get("corner_extent"))
    if corner_extent_value is not None:
        kwargs.append(f"corner_extent={_py_number(corner_extent_value)}")

    corner_transition_distance_value = _py_transition_distance_literal(
        mesh_config.get("corner_transition_distance")
    )
    if corner_transition_distance_value is not None:
        kwargs.append(
            f"corner_transition_distance={corner_transition_distance_value}"
        )

    layers_value = mesh_config.get("through_thickness_elements")
    if layers_value is not None:
        kwargs.append(
            f"layers={_render_element_layer_count(layers_value, context='thin-film layers')}"
        )

    if prismatic:
        kwargs.append('topology="prismatic"')
        transition = mesh_config.get("transition_policy")
        if isinstance(transition, str) and transition.strip():
            kwargs.append(f"transition={_py_repr(transition)}")
        exact_layers = mesh_config.get("exact_layer_count")
        if isinstance(exact_layers, bool):
            kwargs.append(f"exact_layers={_py_literal(exact_layers)}")

    return kwargs


def _render_swept_mesh_kwargs(mesh_config: dict[str, object]) -> list[str] | None:
    strategy = mesh_config.get("mesh_strategy")
    if strategy not in {"swept_prism", "swept_hex"} or mesh_config.get("topology") is not None:
        return None

    kwargs: list[str] = []
    elements = mesh_config.get("through_thickness_elements")
    if elements is not None:
        kwargs.append(
            f"elements={_render_element_layer_count(elements, context='swept elements')}"
        )
    distribution = mesh_config.get("through_thickness_distribution")
    if isinstance(distribution, str) and distribution.strip():
        kwargs.append(f"distribution={_py_repr(distribution)}")
    element_ratio = _number_or_none(mesh_config.get("through_thickness_element_ratio"))
    if element_ratio is not None:
        kwargs.append(f"element_ratio={_py_number(element_ratio)}")
    if mesh_config.get("through_thickness_symmetric") is True:
        kwargs.append("symmetric=True")
    face_meshing = mesh_config.get("sweep_face_meshing")
    if isinstance(face_meshing, str) and face_meshing.strip():
        kwargs.append(f"face_meshing={_py_repr(face_meshing)}")
    sweep_direction = mesh_config.get("sweep_direction")
    if isinstance(sweep_direction, str) and sweep_direction.strip():
        kwargs.append(f"sweep_direction={_py_repr(sweep_direction)}")
    transition = mesh_config.get("transition_policy")
    if isinstance(transition, str) and transition.strip():
        kwargs.append(f"transition={_py_repr(transition)}")
    exact_layers = mesh_config.get("exact_layer_count")
    if isinstance(exact_layers, bool):
        kwargs.append(f"exact_layers={_py_literal(exact_layers)}")
    return kwargs


def _render_element_layer_count(value: object, *, context: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{context} must be an integer element-layer count")
    if value < 1:
        raise ValueError(f"{context} must be >= 1")
    return value


def _render_geometry_mesh_call(
    target_var: str,
    mesh_config: dict[str, object],
    *,
    source_root: Path,
) -> str | None:
    thin_film_kwargs = _render_thin_film_mesh_kwargs(mesh_config)
    if thin_film_kwargs is not None:
        base_config = dict(mesh_config)
        for key in (
            "hmax",
            "maximum_element_size",
            "hmin",
            "minimum_element_size",
            "order",
            "curvature_factor",
            "narrow_region_resolution",
            "interface_hmax",
            "interface_thickness",
            "transition_distance",
            "edge_hmax",
            "edge_maximum_element_size",
            "edge_thickness",
            "edge_transition_distance",
            "corner_hmax",
            "corner_maximum_element_size",
            "corner_extent",
            "corner_transition_distance",
            "mesh_strategy",
            "through_thickness_elements",
            "through_thickness_distribution",
            "through_thickness_element_ratio",
            "through_thickness_symmetric",
            "sweep_face_meshing",
            "topology",
            "sweep_direction",
            "element_family",
            "transition_policy",
            "exact_layer_count",
        ):
            base_config.pop(key, None)
        base_kwargs = _render_mesh_kwargs(base_config, source_root=source_root)
        target = (
            f"{target_var}.mesh({', '.join(base_kwargs)})"
            if base_kwargs
            else f"{target_var}.mesh"
        )
        return f"{target}.thin_film({', '.join(thin_film_kwargs)})"
    swept_kwargs = _render_swept_mesh_kwargs(mesh_config)
    if swept_kwargs is not None:
        base_config = dict(mesh_config)
        for key in (
            "mesh_strategy",
            "through_thickness_elements",
            "through_thickness_distribution",
            "through_thickness_element_ratio",
            "through_thickness_symmetric",
            "sweep_face_meshing",
            "sweep_direction",
            "element_family",
            "transition_policy",
            "exact_layer_count",
        ):
            base_config.pop(key, None)
        base_kwargs = _render_mesh_kwargs(base_config, source_root=source_root)
        target = (
            f"{target_var}.mesh({', '.join(base_kwargs)})"
            if base_kwargs
            else f"{target_var}.mesh"
        )
        return f"{target}.swept({', '.join(swept_kwargs)})"
    kwargs = _render_mesh_kwargs(mesh_config, source_root=source_root)
    if kwargs:
        return f"{target_var}.mesh({', '.join(kwargs)})"
    return None


def _render_mesh_size_fields(target_var: str, mesh_config: dict[str, object]) -> list[str]:
    size_fields = mesh_config.get("size_fields")
    if not isinstance(size_fields, list):
        return []
    lines: list[str] = []
    for field in size_fields:
        field_map = _normalize_mapping(field)
        kind = field_map.get("kind")
        params = _normalize_mapping(field_map.get("params"))
        if not isinstance(kind, str) or not params:
            continue
        rendered_params = ", ".join(
            f"{key}={_py_literal(value)}" for key, value in sorted(params.items())
        )
        lines.append(f"{target_var}.mesh.size_field({_py_repr(kind)}, {rendered_params})")
    return lines


def _render_mesh_operations(target_var: str, mesh_config: dict[str, object]) -> list[str]:
    operations = mesh_config.get("operations")
    if not isinstance(operations, list):
        return []
    lines: list[str] = []
    for raw_operation in operations:
        operation = _normalize_mapping(raw_operation)
        kind = operation.get("kind")
        params = _normalize_mapping(operation.get("params"))
        if kind == "optimize":
            method = params.get("method")
            iterations = int(params.get("iterations", 1)) if isinstance(params.get("iterations"), (int, float)) else 1  # type: ignore[arg-type]
            kwargs: list[str] = []
            if isinstance(method, str) and method != "default":
                kwargs.append(f"method={_py_repr(method)}")
            if iterations != 1:
                kwargs.append(f"iterations={iterations}")
            suffix = f"({', '.join(kwargs)})" if kwargs else "()"
            lines.append(f"{target_var}.mesh.optimize{suffix}")
        elif kind == "refine":
            steps = int(params.get("steps", 1)) if isinstance(params.get("steps"), (int, float)) else 1  # type: ignore[arg-type]
            if steps == 1:
                lines.append(f"{target_var}.mesh.refine()")
            else:
                lines.append(f"{target_var}.mesh.refine(steps={steps})")
        elif kind == "smooth":
            iterations = int(params.get("iterations", 1)) if isinstance(params.get("iterations"), (int, float)) else 1  # type: ignore[arg-type]
            if iterations == 1:
                lines.append(f"{target_var}.mesh.smooth()")
            else:
                lines.append(f"{target_var}.mesh.smooth(iterations={iterations})")
        elif kind == "swept":
            swept_kwargs: list[str] = []
            elements = params.get("through_thickness_elements")
            if isinstance(elements, (int, float)):
                swept_kwargs.append(f"elements={int(elements)}")
            distribution = params.get("through_thickness_distribution")
            if isinstance(distribution, str) and distribution != "fixed":
                swept_kwargs.append(f"distribution={_py_repr(distribution)}")
            element_ratio = _number_or_none(params.get("through_thickness_element_ratio"))
            if element_ratio is not None and element_ratio != 1.0:
                swept_kwargs.append(f"element_ratio={_py_number(element_ratio)}")
            if params.get("through_thickness_symmetric"):
                swept_kwargs.append("symmetric=True")
            face_meshing = params.get("sweep_face_meshing")
            if isinstance(face_meshing, str) and face_meshing != "triangular":
                swept_kwargs.append(f"face_meshing={_py_repr(face_meshing)}")
            suffix = f"({', '.join(swept_kwargs)})" if swept_kwargs else "()"
            lines.append(f"{target_var}.mesh.swept{suffix}")
    return lines


def _study_global_mesh_config(problem: Problem, overrides: dict[str, object]) -> dict[str, object]:
    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    mesh_workflow = _normalize_mapping(runtime_metadata.get("mesh_workflow"))
    mesh_options = _normalize_mapping(mesh_workflow.get("mesh_options"))
    default_mesh = _normalize_mapping(mesh_workflow.get("default_mesh"))
    mesh_override = _normalize_mapping(overrides.get("mesh"))
    fem = problem.discretization.fem if problem.discretization is not None else None

    config: dict[str, object]
    if "default_mesh" in mesh_workflow:
        config = dict(default_mesh)
        for key, value in mesh_options.items():
            if value is not None:
                config[key] = value
        if mesh_workflow.get("build_target") is not None:
            config["build_target"] = mesh_workflow.get("build_target")
        if mesh_workflow.get("domain_mesh_mode") is not None:
            config["domain_mesh_mode"] = mesh_workflow.get("domain_mesh_mode")
        if mesh_workflow.get("domain_mesh_source") is not None:
            config["domain_mesh_source"] = mesh_workflow.get("domain_mesh_source")
        if mesh_workflow.get("frozen_magnetic_submesh_source") is not None:
            config["frozen_magnetic_submesh_source"] = mesh_workflow.get(
                "frozen_magnetic_submesh_source"
            )
        if mesh_workflow.get("domain_region_markers") is not None:
            config["domain_region_markers"] = mesh_workflow.get("domain_region_markers")
        if mesh_workflow.get("domain_object_region_markers") is not None:
            config["domain_object_region_markers"] = mesh_workflow.get(
                "domain_object_region_markers"
            )
    else:
        config = dict(mesh_options)
        fem_info = _normalize_mapping(mesh_workflow.get("fem"))
        base_hmax = fem_info.get("hmax")
        if base_hmax is None and isinstance(fem, FEM):
            base_hmax = fem.hmax
        if base_hmax is not None:
            config["hmax"] = base_hmax
        base_order = fem_info.get("order")
        if base_order is None and isinstance(fem, FEM):
            base_order = fem.order
        if base_order is not None:
            config["order"] = base_order
        base_source = fem_info.get("mesh")
        if base_source is None and isinstance(fem, FEM):
            base_source = fem.mesh
        if base_source:
            config["source"] = base_source
        if mesh_workflow:
            config["build_requested"] = bool(mesh_workflow.get("build_requested", True))
            if mesh_workflow.get("build_target") is not None:
                config["build_target"] = mesh_workflow.get("build_target")
            if mesh_workflow.get("domain_mesh_mode") is not None:
                config["domain_mesh_mode"] = mesh_workflow.get("domain_mesh_mode")
            if mesh_workflow.get("domain_mesh_source") is not None:
                config["domain_mesh_source"] = mesh_workflow.get("domain_mesh_source")
            if mesh_workflow.get("frozen_magnetic_submesh_source") is not None:
                config["frozen_magnetic_submesh_source"] = mesh_workflow.get(
                    "frozen_magnetic_submesh_source"
                )
            if mesh_workflow.get("domain_region_markers") is not None:
                config["domain_region_markers"] = mesh_workflow.get("domain_region_markers")
            if mesh_workflow.get("domain_object_region_markers") is not None:
                config["domain_object_region_markers"] = mesh_workflow.get(
                    "domain_object_region_markers"
                )

    if mesh_override:
        for key, value in mesh_override.items():
            if key == "adaptive_mesh":
                continue
            config[key] = value

    return config


def _study_geometry_mesh_configs(
    problem: Problem,
    overrides: dict[str, object],
) -> list[tuple[str, dict[str, object]]]:
    geometries_override = overrides.get("geometries")
    if isinstance(geometries_override, list):
        items: list[tuple[str, dict[str, object]]] = []
        for raw_geometry in geometries_override:
            geometry = _normalize_mapping(raw_geometry)
            name = geometry.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            items.append((name, _normalize_mapping(geometry.get("mesh"))))
        return items
    return [
        (magnet.name, _normalize_mapping(_export_geometry_mesh_entry(magnet.name, problem)))
        for magnet in problem.magnets
    ]


def _mesh_entry_requests_build(mesh_config: Mapping[str, object]) -> bool:
    return bool(mesh_config.get("build_requested", False))


def _mesh_entry_requires_explicit_render(mesh_config: Mapping[str, object]) -> bool:
    return _mesh_mode(mesh_config.get("mode")) == "custom" or _mesh_entry_requests_build(mesh_config)


def _render_study_mesh_workflow(
    problem: Problem,
    magnet_vars: dict[str, str],
    *,
    source_root: Path,
    overrides: dict[str, object],
) -> list[str]:
    if _is_pure_fdm_problem(problem):
        return []
    lines: list[str] = []

    global_mesh = _study_global_mesh_config(problem, overrides)
    global_kwargs = _render_mesh_kwargs(global_mesh, source_root=source_root)
    global_build_requested = bool(global_mesh.get("build_requested", False))
    if global_kwargs:
        lines.append(f"study.objects.mesh.defaults({', '.join(global_kwargs)})")

    for magnet_name, mesh_config in _study_geometry_mesh_configs(problem, overrides):
        if not _mesh_entry_requires_explicit_render(mesh_config):
            continue
        target_var = magnet_vars.get(magnet_name)
        if target_var is None:
            continue
        mesh_call = _render_geometry_mesh_call(
            target_var,
            mesh_config,
            source_root=source_root,
        )
        if mesh_call is not None:
            lines.append(mesh_call)
        lines.extend(_render_mesh_size_fields(target_var, mesh_config))
        lines.extend(_render_mesh_operations(target_var, mesh_config))
        if _mesh_entry_requests_build(mesh_config):
            lines.append(f"{target_var}.mesh.build()")

    frozen_submesh_call = _render_frozen_magnetic_submesh_call(
        "study",
        global_mesh,
        source_root=source_root,
    )
    if frozen_submesh_call:
        lines.append(frozen_submesh_call)
    explicit_domain_mesh_call = _render_domain_mesh_call("study", global_mesh, source_root=source_root)
    if explicit_domain_mesh_call:
        lines.append(explicit_domain_mesh_call)
    elif global_build_requested:
        lines.append(_mesh_build_call("study", global_mesh))

    if not lines:
        return []
    return ["# Mesh", *lines]


def _render_mesh_workflow(
    problem: Problem,
    magnet_vars: dict[str, str],
    *,
    source_root: Path,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    if _is_pure_fdm_problem(problem):
        return []
    if surface == "study":
        return _render_study_mesh_workflow(
            problem,
            magnet_vars,
            source_root=source_root,
            overrides=overrides,
        )

    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    mesh_workflow = _normalize_mapping(runtime_metadata.get("mesh_workflow"))
    fem = problem.discretization.fem if problem.discretization is not None else None
    if not isinstance(fem, FEM) and not mesh_workflow:
        return []

    geometry_mesh_configs = _study_geometry_mesh_configs(problem, overrides)
    explicit_geometry_mesh_configs = [
        (magnet_name, mesh_config)
        for magnet_name, mesh_config in geometry_mesh_configs
        if _mesh_entry_requires_explicit_render(mesh_config)
    ]
    lines: list[str] = []

    if explicit_geometry_mesh_configs:
        geometry_build_requested = False
        for magnet_name, mesh_config in explicit_geometry_mesh_configs:
            target_var = magnet_vars.get(magnet_name)
            if target_var is None:
                continue
            mesh_call = _render_geometry_mesh_call(
                target_var,
                mesh_config,
                source_root=source_root,
            )
            if mesh_call is not None:
                lines.append(mesh_call)
            lines.extend(_render_mesh_size_fields(target_var, mesh_config))
            lines.extend(_render_mesh_operations(target_var, mesh_config))
            build_requested = _mesh_entry_requests_build(mesh_config)
            geometry_build_requested = geometry_build_requested or build_requested
            if build_requested:
                lines.append(f"{target_var}.mesh.build()")

        global_mesh = _study_global_mesh_config(problem, overrides)
        frozen_submesh_call = _render_frozen_magnetic_submesh_call(
            surface,
            global_mesh,
            source_root=source_root,
        )
        if frozen_submesh_call:
            lines.append(frozen_submesh_call)
        explicit_domain_mesh_call = _render_domain_mesh_call(surface, global_mesh, source_root=source_root)
        if explicit_domain_mesh_call and not geometry_build_requested:
            lines.append(explicit_domain_mesh_call)
        elif bool(global_mesh.get("build_requested", True)) and not geometry_build_requested:
            lines.append(_mesh_build_call(surface, global_mesh))
    else:
        global_mesh = _study_global_mesh_config(problem, overrides)
        kwargs = _render_mesh_kwargs(global_mesh, source_root=source_root)
        if kwargs:
            lines.append(f"{_surface_call(surface, 'mesh')}({', '.join(kwargs)})")
        elif isinstance(fem, FEM):
            lines.append(
                f"{_surface_call(surface, 'mesh')}(maximum_element_size={_py_number(fem.hmax)}, order={fem.order})"
            )

        frozen_submesh_call = _render_frozen_magnetic_submesh_call(
            surface,
            global_mesh,
            source_root=source_root,
        )
        if frozen_submesh_call:
            lines.append(frozen_submesh_call)
        explicit_domain_mesh_call = _render_domain_mesh_call(surface, global_mesh, source_root=source_root)
        if explicit_domain_mesh_call:
            lines.append(explicit_domain_mesh_call)
        elif bool(global_mesh.get("build_requested", True)):
            lines.append(_mesh_build_call(surface, global_mesh))

    if not lines:
        return []
    return ["# Mesh", *lines]


def _mesh_build_call(surface: str, mesh_config: dict[str, object]) -> str:
    build_target = mesh_config.get("build_target")
    build_fn = "build_domain_mesh" if build_target == "domain" else "build_mesh"
    return f"{_surface_call(surface, build_fn)}()"


def _render_frozen_magnetic_submesh_call(
    surface: str,
    mesh_config: dict[str, object],
    *,
    source_root: Path,
) -> str | None:
    raw_source = _normalize_mapping(mesh_config.get("frozen_magnetic_submesh_source"))
    source_value = raw_source.get("mesh_source")
    if not isinstance(source_value, str) or not source_value.strip():
        return None
    raw_markers = raw_source.get("region_markers")
    if not isinstance(raw_markers, list) or not raw_markers:
        return None
    rendered_markers = {}
    for raw_entry in raw_markers:
        entry = _normalize_mapping(raw_entry)
        geometry_name = entry.get("geometry_name")
        marker = entry.get("marker")
        if not isinstance(geometry_name, str) or not geometry_name.strip():
            continue
        if not isinstance(marker, (int, float)):
            continue
        rendered_markers[geometry_name] = int(marker)
    if not rendered_markers:
        return None
    kwargs = [
        f"source={_py_repr(_relativize_path(source_value, source_root))}",
        f"region_markers={_py_literal(rendered_markers)}",
    ]
    air_mesh_source = raw_source.get("air_mesh_source")
    if isinstance(air_mesh_source, str) and air_mesh_source.strip():
        kwargs.append(
            f"air_mesh_source={_py_repr(_relativize_path(air_mesh_source, source_root))}"
        )
    return f"{_surface_call(surface, 'frozen_magnetic_submesh')}({', '.join(kwargs)})"


def _render_domain_mesh_call(
    surface: str,
    mesh_config: dict[str, object],
    *,
    source_root: Path,
) -> str | None:
    source_value = mesh_config.get("domain_mesh_source")
    if not isinstance(source_value, str) or not source_value.strip():
        return None
    raw_markers = mesh_config.get("domain_region_markers")
    if not isinstance(raw_markers, list) or not raw_markers:
        return None
    rendered_markers = {}
    for raw_entry in raw_markers:
        entry = _normalize_mapping(raw_entry)
        geometry_name = entry.get("geometry_name")
        marker = entry.get("marker")
        if not isinstance(geometry_name, str) or not geometry_name.strip():
            continue
        if not isinstance(marker, (int, float)):
            continue
        rendered_markers[geometry_name] = int(marker)
    if not rendered_markers:
        return None
    kwargs = [
        f"source={_py_repr(_relativize_path(source_value, source_root))}",
        f"region_markers={_py_literal(rendered_markers)}",
    ]
    raw_object_region_markers = mesh_config.get("domain_object_region_markers")
    if isinstance(raw_object_region_markers, list) and raw_object_region_markers:
        rendered_object_region_markers = {}
        for raw_entry in raw_object_region_markers:
            entry = _normalize_mapping(raw_entry)
            geometry_name = entry.get("geometry_name")
            marker = entry.get("marker")
            if not isinstance(geometry_name, str) or not geometry_name.strip():
                continue
            if not isinstance(marker, (int, float)):
                continue
            rendered_object_region_markers[geometry_name] = int(marker)
        if rendered_object_region_markers:
            kwargs.append(
                f"object_region_markers={_py_literal(rendered_object_region_markers)}"
            )
    return f"{_surface_call(surface, 'domain_mesh')}({', '.join(kwargs)})"


def _render_solver(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    solver_override = _normalize_mapping(overrides.get("solver"))
    if problem.study is None:
        return ["# Solver (not configured)"]
    dynamics = problem.study.dynamics
    if dynamics is None:
        return []
    return ["# Solver", _render_solver_call(dynamics, solver_override, surface=surface)]


def _render_outputs(problem: Problem, magnet_vars: dict[str, str], *, surface: str) -> list[str]:
    if problem.study is None:
        return []
    outputs = _study_outputs(problem.study)
    if not outputs:
        return []
    lines = ["# Outputs"]
    for output in outputs:
        if isinstance(output, SaveField):
            lines.append(
                f"{_surface_call(surface, 'save')}({_py_repr(output.field)}, every={_py_sampling_period(output.every)})"
            )
            continue
        if isinstance(output, SaveScalar):
            lines.append(
                f"{_surface_call(surface, 'save')}({_py_repr(output.scalar)}, every={_py_sampling_period(output.every)})"
            )
            continue
        if isinstance(output, Snapshot):
            quantity = _snapshot_quantity_string(output)
            if output.layer is not None and output.layer in magnet_vars:
                lines.append(
                    f"{_surface_call(surface, 'snapshot')}({magnet_vars[output.layer]}, {_py_repr(quantity)}, every={_py_number(output.every)})"
                )
            else:
                lines.append(
                    f"{_surface_call(surface, 'snapshot')}({_py_repr(quantity)}, every={_py_number(output.every)})"
                )
            continue
        if isinstance(output, SaveSpectrum):
            lines.append(f"{_surface_call(surface, 'save')}(\"spectrum\")")
            continue
        if isinstance(output, SaveMode):
            indices_repr = repr(list(output.indices))
            lines.append(f"{_surface_call(surface, 'save')}(\"mode\", indices={indices_repr})")
            continue
        if isinstance(output, SaveDispersion):
            lines.append(f"{_surface_call(surface, 'save')}(\"dispersion\")")
            continue
        if isinstance(output, SaveResponse):
            lines.append(
                f"{_surface_call(surface, 'save_response')}({_py_repr(output.observable)})"
            )
            continue
        raise ValueError(f"unsupported output type: {type(output).__name__}")
    return lines


def _render_table_autosave(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    if problem.study is None:
        return []
    table_autosave = _table_autosave_from_override(
        overrides.get("table_autosave"),
    ) or _study_table_autosave(problem.study)
    if table_autosave is None:
        return []

    kwargs = (
        [f"every_steps={table_autosave.every_steps}"]
        if table_autosave.every_steps is not None
        else [f"{_py_sampling_period(table_autosave.t_sampl)}"]
    )
    quantities = tuple(table_autosave.quantities or DEFAULT_TABLE_AUTOSAVE_QUANTITIES)
    if quantities != DEFAULT_TABLE_AUTOSAVE_QUANTITIES:
        kwargs.append(f"quantities={_py_literal(list(quantities))}")
    lines = [
        "# Table autosave",
        f"{_surface_call(surface, 'tableautosave')}({', '.join(kwargs)})",
    ]
    lines.extend(
        f"{_surface_call(surface, 'tableadd')}({_py_repr(expression)})"
        for expression in table_autosave.expressions
    )
    return lines


def _table_autosave_from_override(value: object) -> TableAutosave | None:
    if not isinstance(value, dict):
        return None
    if value.get("kind") not in {None, "table_autosave"}:
        return None
    every_steps = value.get("every_steps")
    if isinstance(every_steps, bool) or not isinstance(every_steps, int):
        every_steps = None
    sample_period = _requested_sampling_period_from_ir(value, "sample_period_s")
    if sample_period is None and every_steps is None:
        return None
    quantities = value.get("quantities")
    expressions = value.get("expressions")
    return TableAutosave(
        t_sampl=sample_period,
        every_steps=every_steps,
        quantities=quantities if isinstance(quantities, list) else None,
        expressions=expressions if isinstance(expressions, list) else (),
        table_id=str(value.get("table_id") or "default"),
    )


def _render_relax_adaptive_policy_args(policy: AdaptiveTimestep) -> list[str]:
    if policy._tolerance_mode == "max_error":
        args: list[str] = []
        if policy.dt_initial is not None:
            args.append(f"dt_initial={_py_number(policy.dt_initial)}")
        args.extend(
            [
                f"max_err={_py_number(policy.atol)}",
                f"dt_min={_py_number(policy.dt_min)}",
            ]
        )
        if policy.dt_max is not None:
            args.append(f"dt_max={_py_number(policy.dt_max)}")
        return args

    adaptive_parts = [
        f"atol={_py_number(policy.atol)}",
        f"rtol={_py_number(policy.rtol)}",
        "dt_initial="
        + ("None" if policy.dt_initial is None else _py_number(policy.dt_initial)),
        f"dt_min={_py_number(policy.dt_min)}",
        "dt_max=" + ("None" if policy.dt_max is None else _py_number(policy.dt_max)),
        f"safety={_py_number(policy.safety)}",
        f"growth_limit={_py_number(policy.growth_limit)}",
        f"shrink_limit={_py_number(policy.shrink_limit)}",
    ]
    if policy.max_spin_rotation is not None:
        adaptive_parts.append(
            f"max_spin_rotation={_py_number(policy.max_spin_rotation)}"
        )
    if policy.norm_tolerance is not None:
        adaptive_parts.append(f"norm_tolerance={_py_number(policy.norm_tolerance)}")
    return [
        "adaptive_timestep=fm.AdaptiveTimestep("
        + ", ".join(adaptive_parts)
        + ")"
    ]


def _render_stages(
    stages: Sequence[LoadedStage],
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    if not stages:
        return []
    solver_override = _normalize_mapping(overrides.get("solver"))
    stage_overrides = overrides.get("stages")
    is_study_surface = surface == "study"
    lines = ["# Stages" if is_study_surface else "# Run"]
    previous_dynamics_signature: dict[str, object] | None = None
    for index, stage in enumerate(stages):
        if stage.action is not None:
            action_kind = str(stage.action.get("kind") if isinstance(stage.action, dict) else "").strip().lower()
            if action_kind == "save_state":
                artifact_name = str(stage.action.get("artifact_name") or "state_snapshot")
                call_parts = [f"artifact_name={_py_repr(artifact_name)}"]
                action_format = _text_value(stage.action.get("format"))
                action_dataset = _text_value(stage.action.get("dataset"))
                if action_format:
                    call_parts.append(f"format={_py_repr(action_format)}")
                if action_dataset:
                    call_parts.append(f"dataset={_py_repr(action_dataset)}")
                if is_study_surface:
                    lines.append(f"study.stages.add_save_state({', '.join(call_parts)})")
                continue
            if action_kind == "load_state":
                if not is_study_surface:
                    raise ValueError("load_state action requires the study API surface")
                call_parts = []
                artifact_name = _text_value(stage.action.get("artifact_name"))
                state_path = _text_value(stage.action.get("state_path"))
                if artifact_name:
                    call_parts.append(f"artifact_name={_py_repr(artifact_name)}")
                if state_path:
                    call_parts.append(f"state_path={_py_repr(state_path)}")
                for key in ("format", "dataset"):
                    value = _text_value(stage.action.get(key))
                    if value:
                        call_parts.append(f"{key}={_py_repr(value)}")
                sample_index = stage.action.get("sample_index")
                if sample_index is not None:
                    call_parts.append(f"sample_index={int(sample_index)}")
                if stage.stage_id is not None:
                    call_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
                lines.append(f"study.stages.add_load_state({', '.join(call_parts)})")
                continue
            if action_kind == "set_transport_current":
                if not is_study_surface:
                    raise ValueError(
                        "set_transport_current action requires the study API surface"
                    )
                module_id = _text_value(stage.action.get("module_id"))
                values = stage.action.get("terminal_outward_current_density_Apm2")
                if not module_id or not isinstance(values, dict):
                    raise ValueError(
                        "set_transport_current action requires module_id and terminal current mapping"
                    )
                call_parts = [
                    f"module_id={_py_repr(module_id)}",
                    "terminal_outward_current_density_Apm2=" + _py_literal(values),
                ]
                if stage.stage_id is not None:
                    call_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
                lines.append(
                    f"study.stages.set_transport_current({', '.join(call_parts)})"
                )
                continue
            if action_kind == "set_spin_torque_enabled":
                if not is_study_surface:
                    raise ValueError(
                        "set_spin_torque_enabled action requires the study API surface"
                    )
                module_id = _text_value(stage.action.get("module_id"))
                enabled = stage.action.get("enabled")
                if not module_id or not isinstance(enabled, bool):
                    raise ValueError(
                        "set_spin_torque_enabled action requires module_id and bool enabled"
                    )
                call_parts = [
                    f"module_id={_py_repr(module_id)}",
                    f"enabled={enabled!r}",
                ]
                if stage.stage_id is not None:
                    call_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
                lines.append(
                    f"study.stages.set_spin_torque_enabled({', '.join(call_parts)})"
                )
                continue
            if action_kind == "change_device":
                action_device = _text_value(stage.action.get("device")) or "auto"
                if is_study_surface:
                    lines.append(f"study.stages.change_device({_py_repr(action_device)})")
                continue
            if action_kind == "add_field_drive":
                drive = stage.action.get("drive")
                if isinstance(drive, RegionalFieldDrive):
                    drive_expr = _render_regional_field_drive_expr(drive)
                elif isinstance(drive, dict):
                    drive_expr = _render_regional_field_drive_payload_expr(drive)
                else:
                    raise TypeError("add_field_drive action requires a RegionalFieldDrive")
                if not is_study_surface:
                    raise ValueError("add_field_drive action requires the study API surface")
                call_parts = [drive_expr]
                if stage.stage_id is not None:
                    call_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
                lines.append(f"study.stages.add_field_drive({', '.join(call_parts)})")
                continue
            if action_kind == "remove_field_drive":
                if not is_study_surface:
                    raise ValueError("remove_field_drive action requires the study API surface")
                drive_id = _text_value(stage.action.get("drive_id"))
                if not drive_id:
                    raise ValueError("remove_field_drive action requires drive_id")
                call_parts = [_py_repr(drive_id)]
                if stage.stage_id is not None:
                    call_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
                lines.append(f"study.stages.remove_field_drive({', '.join(call_parts)})")
                continue
            if action_kind == "table_autosave":
                if not is_study_surface:
                    raise ValueError("table_autosave action requires the study API surface")
                call_parts: list[str] = []
                if bool(stage.action.get("enabled", True)):
                    table = _normalize_mapping(stage.action.get("table_autosave"))
                    sample_period = _requested_sampling_period_from_ir(table, "sample_period_s")
                    if sample_period is None:
                        raise ValueError("enabled table_autosave action requires a sampling cadence")
                    call_parts.append(_py_sampling_period(sample_period))
                    quantities = table.get("quantities")
                    if isinstance(quantities, list):
                        call_parts.append(f"quantities={_py_literal(quantities)}")
                else:
                    call_parts.append("enabled=False")
                if stage.stage_id is not None:
                    call_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
                lines.append(f"study.stages.tableautosave({', '.join(call_parts)})")
                continue
            if action_kind == "autosave":
                if not is_study_surface:
                    raise ValueError("autosave action requires the study API surface")
                call_parts = []
                enabled = bool(stage.action.get("enabled", True))
                quantity = _text_value(stage.action.get("quantity"))
                if enabled:
                    output = _normalize_mapping(stage.action.get("output"))
                    output_name = _text_value(output.get("name")) or quantity
                    every = _requested_sampling_period_from_ir(output, "every_seconds")
                    if not output_name or every is None:
                        raise ValueError("enabled autosave action requires output name and cadence")
                    call_parts.extend(
                        [
                            _py_repr(output_name),
                            f"every={_py_sampling_period(every)}",
                        ]
                    )
                else:
                    if quantity:
                        call_parts.append(_py_repr(quantity))
                    call_parts.append("enabled=False")
                if stage.stage_id is not None:
                    call_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
                lines.append(f"study.stages.autosave({', '.join(call_parts)})")
                continue
            if action_kind == "fft_response":
                if not is_study_surface:
                    raise ValueError("fft_response action requires the study API surface")
                call_parts = []
                if bool(stage.action.get("enabled", True)):
                    request = _normalize_mapping(stage.action.get("request"))
                    call_parts.append(
                        _py_repr(str(request.get("response_component") or "my"))
                    )
                    detrend = str(request.get("detrend") or "linear")
                    window = str(request.get("window") or "hann")
                    floor = float(request.get("susceptibility_floor_fraction", 1e-6))
                    if detrend != "linear":
                        call_parts.append(f"detrend={_py_repr(detrend)}")
                    if window != "hann":
                        call_parts.append(f"window={_py_repr(window)}")
                    if floor != 1e-6:
                        call_parts.append(
                            f"susceptibility_floor_fraction={_py_number(floor)}"
                        )
                else:
                    call_parts.append("enabled=False")
                if stage.stage_id is not None:
                    call_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
                lines.append(f"study.stages.fft_response({', '.join(call_parts)})")
                continue
            continue
        if stage.problem.study is None:
            continue
        study = stage.problem.study
        stage_override = _stage_override_for(stage_overrides, index=index, stage=stage)
        if isinstance(study, Hysteresis):
            if not is_study_surface:
                raise ValueError("canonical hysteresis rewrite requires the study API surface")
            lines.append(
                f"study.stages.add_hysteresis_sweep({', '.join(_render_hysteresis_stage_args(study))})"
            )
            continue
        stage_dynamics = stage.problem.study.dynamics
        dynamics_signature = (
            stage_dynamics.to_ir() if stage_dynamics is not None else None
        )
        if previous_dynamics_signature is not None and dynamics_signature != previous_dynamics_signature:
            if stage_dynamics is not None:
                lines.append(
                    _render_solver_call(
                        stage_dynamics,
                        solver_override,
                        surface=surface,
                    )
                )
        previous_dynamics_signature = dynamics_signature

        if isinstance(study, Eigenmodes):
            count = _override_int(stage_override, "eigen_count", study.count) or study.count
            target = _override_string(stage_override, "eigen_target", study.target) or study.target
            operator = _override_string(stage_override, "eigen_operator", study.operator) or study.operator
            include_demag_ov = stage_override.get("eigen_include_demag")
            include_demag = bool(include_demag_ov) if isinstance(include_demag_ov, bool) else study.include_demag
            equilibrium_source = _override_string(stage_override, "eigen_equilibrium_source", study.equilibrium_source) or study.equilibrium_source
            normalization = _override_string(stage_override, "eigen_normalization", study.normalization) or study.normalization
            damping_policy = _override_string(stage_override, "eigen_damping_policy", study.damping_policy) or study.damping_policy
            call_parts = [
                f"count={count}",
                f"target={_py_repr(target)}",
            ]
            target_frequency = _override_number(stage_override, "eigen_target_frequency", study.target_frequency)
            if target_frequency is not None:
                call_parts.append(f"target_frequency={_py_number(target_frequency)}")
            frequency_min = _override_number(stage_override, "eigen_frequency_min", study.frequency_min)
            if frequency_min is not None:
                call_parts.append(f"frequency_min={_py_number(frequency_min)}")
            frequency_max = _override_number(stage_override, "eigen_frequency_max", study.frequency_max)
            if frequency_max is not None:
                call_parts.append(f"frequency_max={_py_number(frequency_max)}")
            if operator != "linearized_llg":
                call_parts.append(f"operator={_py_repr(operator)}")
            call_parts.append(f"include_demag={include_demag!r}")
            call_parts.append(f"equilibrium_source={_py_repr(equilibrium_source)}")
            if study.equilibrium_artifact is not None:
                call_parts.append(f"equilibrium_artifact={_py_repr(study.equilibrium_artifact)}")
            call_parts.append(f"normalization={_py_repr(normalization)}")
            call_parts.append(f"damping_policy={_py_repr(damping_policy)}")
            spin_wave_bc_config = stage_override.get("eigen_spin_wave_bc_config")
            if isinstance(spin_wave_bc_config, dict):
                spin_wave_bc = dict(spin_wave_bc_config)
                spin_wave_bc_kind = _override_string(
                    stage_override,
                    "eigen_spin_wave_bc",
                    spin_wave_bc.get("kind"),
                )
                if spin_wave_bc_kind:
                    spin_wave_bc["kind"] = spin_wave_bc_kind
            else:
                spin_wave_bc = (
                    _override_string(stage_override, "eigen_spin_wave_bc", None)
                    or study.spin_wave_bc
                )
            if spin_wave_bc != "free":
                call_parts.append(f"bc={_render_spin_wave_bc_expr(spin_wave_bc)}")
            magnetostatic_bc = _override_string(
                stage_override, "eigen_magnetostatic_bc", study.magnetostatic_bc
            ) or study.magnetostatic_bc
            if magnetostatic_bc != "open":
                call_parts.append(f"magnetostatic_bc={_py_repr(magnetostatic_bc)}")
            k_vector_raw = _override_string(stage_override, "eigen_k_vector", None)
            k_path_expr = _render_stage_k_path_expr(
                _override_string(stage_override, "eigen_k_path", None)
            )
            if k_path_expr is not None:
                call_parts.append(f"k_sampling={k_path_expr}")
            elif k_vector_raw is not None and k_vector_raw.strip():
                try:
                    parsed = tuple(float(component.strip()) for component in k_vector_raw.split(","))
                    if len(parsed) == 3:
                        call_parts.append(f"k_vector={parsed!r}")
                except ValueError:
                    pass
            elif study.k_vector is not None:
                call_parts.append(f"k_vector={study.k_vector!r}")
            elif study.k_sampling is not None:
                k_sampling_expr = _render_k_sampling_expr(study.k_sampling)
                if k_sampling_expr is not None:
                    call_parts.append(f"k_sampling={k_sampling_expr}")
            if study.bias_field_sweep is not None:
                sweep = study.bias_field_sweep
                call_parts.append(
                    "bias_field_sweep=fm.BiasFieldSweep("
                    f"samples_a_per_m={_py_bias_field_sweep_samples_literal(sweep.samples_a_per_m)}, "
                    f"equilibrium_policy={_py_repr(sweep.equilibrium_policy)}, "
                    f"continuation_seed={_py_repr(sweep.continuation_seed)})"
                )
            if is_study_surface:
                lines.append(f"study.stages.add_eigenmodes({', '.join(call_parts)})")
            else:
                lines.append(f"{_surface_call(surface, 'eigenmodes')}({', '.join(call_parts)})")
            continue
        if isinstance(study, FrequencyResponse):
            frequency_values = ", ".join(_py_number(float(freq)) for freq in study.frequencies_hz)
            call_parts = [f"frequencies_hz=[{frequency_values}]"]
            if study.excitation_field_au_per_m != (0.0, 0.0, 1.0):
                call_parts.append(
                    f"excitation_field_au_per_m={_py_tuple3(study.excitation_field_au_per_m)}"
                )
            if abs(study.excitation_phase_rad) > 1e-15:
                call_parts.append(f"excitation_phase_rad={_py_number(study.excitation_phase_rad)}")
            call_parts.append(f"include_demag={study.include_demag!r}")
            if study.equilibrium_source != "provided":
                call_parts.append(f"equilibrium_source={_py_repr(study.equilibrium_source)}")
            if study.equilibrium_artifact is not None:
                call_parts.append(f"equilibrium_artifact={_py_repr(study.equilibrium_artifact)}")
            if study.normalization != "unit_l2":
                call_parts.append(f"normalization={_py_repr(study.normalization)}")
            if study.damping_policy != "ignore":
                call_parts.append(f"damping_policy={_py_repr(study.damping_policy)}")
            if study.spin_wave_bc != "free":
                call_parts.append(f"bc={_render_spin_wave_bc_expr(study.spin_wave_bc)}")
            if study.magnetostatic_bc != "open":
                call_parts.append(f"magnetostatic_bc={_py_repr(study.magnetostatic_bc)}")
            if study.solver_policy is not None:
                if study.solver_policy.method is not None:
                    call_parts.append(
                        f"solver_method={_py_repr(study.solver_policy.method)}"
                    )
                if study.solver_policy.preconditioner is not None:
                    call_parts.append(
                        f"solver_preconditioner={_py_repr(study.solver_policy.preconditioner)}"
                    )
                if study.solver_policy.max_iterations is not None:
                    call_parts.append(
                        f"solver_max_iterations={study.solver_policy.max_iterations}"
                    )
                if study.solver_policy.restart_iterations is not None:
                    call_parts.append(
                        f"solver_restart_iterations={study.solver_policy.restart_iterations}"
                    )
                if study.solver_policy.rtol is not None:
                    call_parts.append(f"solver_rtol={_py_number(study.solver_policy.rtol)}")
            if study.k_vector is not None:
                call_parts.append(f"k_vector={study.k_vector!r}")
            if is_study_surface:
                lines.append(f"study.stages.add_frequency_response({', '.join(call_parts)})")
            else:
                lines.append(f"{_surface_call(surface, 'frequency_response')}({', '.join(call_parts)})")
            continue

        if isinstance(study, Relaxation):
            relax_override = _normalize_mapping(solver_override.get("relax"))
            algorithm = (
                _override_string(stage_override, "relax_algorithm", None)
                or _override_string(relax_override, "algorithm", study.algorithm)
                or study.algorithm
            )
            relax_solver = _override_string(stage_override, "integrator", None)
            if study.dynamics is not None:
                relax_solver = relax_solver or study.dynamics.integrator
            relax_fixed_timestep = _override_number(
                stage_override,
                "fixed_timestep",
                study.dynamics.fixed_timestep if study.dynamics is not None else None,
            )
            has_stage_adaptive_override = "adaptive_timestep" in stage_override
            stage_adaptive_override = _normalize_mapping(
                stage_override.get("adaptive_timestep")
            )
            stage_adaptive_policy: AdaptiveTimestep | None = None
            if stage_adaptive_override:
                if stage_adaptive_override.get("tolerance_mode") == "max_error":
                    stage_adaptive_policy = _max_error_policy_with_overrides(
                        None,
                        {
                            "max_err": stage_adaptive_override.get("atol"),
                            "dt_initial": stage_adaptive_override.get("dt_initial"),
                            "dt_min": stage_adaptive_override.get("dt_min"),
                            "dt_max": stage_adaptive_override.get("dt_max"),
                        },
                    )
                else:
                    stage_adaptive_policy = _advanced_policy_with_overrides(
                        None, stage_adaptive_override
                    )
            if stage_adaptive_policy is not None:
                relax_fixed_timestep = None
            torque_tolerance = _override_number(
                stage_override,
                "torque_tolerance",
                _override_number(
                    relax_override,
                    "torque_tolerance",
                    study.torque_tolerance,
                ),
            )
            energy_tolerance = _override_number(
                stage_override,
                "energy_tolerance",
                _override_number(
                    relax_override,
                    "energy_tolerance",
                    study.energy_tolerance,
                ),
            )
            max_steps = _override_int(
                stage_override,
                "max_steps",
                _override_int(relax_override, "max_steps", study.max_steps),
            )
            max_relaxation_time_s = _override_number(
                stage_override,
                "max_relaxation_time_s",
                _override_number(
                    relax_override,
                    "max_relaxation_time_s",
                    study.stop.max_relaxation_time_s,
                ),
            )
            torque_tolerance_argument = (
                "tolA" if study.torque_tolerance_unit == "A/m" else "tolT"
            )
            torque_tolerance_value = (
                None
                if torque_tolerance is None
                else torque_tolerance
                if study.torque_tolerance_unit == "A/m"
                else torque_tolerance * 4.0e-7 * math.pi
            )
            call_parts = [f"algorithm={_py_repr(algorithm)}"]
            if stage.stage_id is not None:
                call_parts.insert(0, f"stage_id={_py_repr(stage.stage_id)}")
            needs_stop_object = (
                torque_tolerance is None
                or max_steps is None
                or max_relaxation_time_s is not None
            )
            if needs_stop_object:
                if torque_tolerance is not None:
                    call_parts.append(
                        f"{torque_tolerance_argument}="
                        f"{_py_number(torque_tolerance_value)}"
                    )
                stop_parts: list[str] = []
                stop_parts.append(
                    "torque_tolerance_apm=None"
                    if torque_tolerance is None
                    else f"torque_tolerance_apm={_py_number(torque_tolerance)}"
                )
                if energy_tolerance is not None:
                    stop_parts.append(
                        f"energy_tolerance_j={_py_number(energy_tolerance)}"
                    )
                stop_parts.append(
                    "max_steps=None" if max_steps is None else f"max_steps={max_steps}"
                )
                if max_relaxation_time_s is not None:
                    stop_parts.append(
                        "max_relaxation_time_s="
                        f"{_py_number(max_relaxation_time_s)}"
                    )
                call_parts.append(f"stop=fm.RelaxStop({', '.join(stop_parts)})")
            else:
                call_parts.append(
                    f"{torque_tolerance_argument}="
                    f"{_py_number(torque_tolerance_value)}"
                )  # type: ignore[operator]
                call_parts.append(f"max_steps={max_steps}")
                if energy_tolerance is not None:
                    call_parts.append(
                        f"energy_tolerance={_py_number(energy_tolerance)}"
                    )
            if algorithm == "llg_overdamped":
                if relax_solver and relax_solver not in {"auto", "rk23"}:
                    call_parts.append(f"solver={_py_repr(relax_solver)}")
                if relax_fixed_timestep is not None:
                    call_parts.append(f"dt={_py_number(relax_fixed_timestep)}")
                if stage_adaptive_policy is not None:
                    call_parts.extend(
                        _render_relax_adaptive_policy_args(stage_adaptive_policy)
                    )
                elif (
                    not has_stage_adaptive_override
                    and relax_fixed_timestep is None
                    and study.dynamics is not None
                    and study.dynamics.adaptive_timestep is not None
                    and study.dynamics.adaptive_timestep._dt_min_explicit
                    and study.dynamics.adaptive_timestep.dt_max is not None
                ):
                    call_parts.extend(
                        _render_relax_adaptive_policy_args(
                            study.dynamics.adaptive_timestep
                        )
                    )
            if is_study_surface:
                relax_call = f"study.stages.add_relax({', '.join(call_parts)})"
                if stage.table_autosave is not None:
                    table = stage.table_autosave
                    table_parts = [f"every_steps={table.every_steps}"]
                    if table.quantities is not None:
                        table_parts.append(
                            f"quantities={_py_literal(list(table.quantities))}"
                        )
                    if table.table_id != "default":
                        table_parts.append(f"table_id={_py_repr(table.table_id)}")
                    relax_call += f".tableautosave({', '.join(table_parts)})"
                if stage.autosave is not None:
                    relax_call += _render_stage_autosave(stage.autosave)
                lines.append(relax_call)
            else:
                lines.append(f"{_surface_call(surface, 'relax')}({', '.join(call_parts)})")
            continue

        until_seconds = _override_number(
            stage_override,
            "until_seconds",
            stage.default_until_seconds,
        )
        if until_seconds is None:
            raise ValueError(
                "canonical rewrite requires DEFAULT_UNTIL for time-evolution scripts"
            )
        if is_study_surface:
            run_parts: list[str] = []
            if stage.stage_id is not None:
                run_parts.append(f"stage_id={_py_repr(stage.stage_id)}")
            run_parts.append(f"until={_py_number(until_seconds)}")
            run_call = f"study.stages.add_run({', '.join(run_parts)})"
            if stage.autosave is not None:
                run_call += _render_stage_autosave(stage.autosave)
            lines.append(run_call)
        else:
            lines.append(f"{_surface_call(surface, 'run')}({_py_number(until_seconds)})")
    return lines


def _render_stage_autosave(policy: StageAutosave) -> str:
    parts: list[str] = []
    if policy.target != "main":
        parts.append(f"target={_py_repr(policy.target)}")
    if policy.layout != "continuous":
        parts.append(f"layout={_py_repr(policy.layout)}")
    if policy.format != "zarr":
        parts.append(f"format={_py_repr(policy.format)}")
    if policy.table is not None:
        parts.append(f"table={_render_stage_table_autosave(policy.table)}")
    if policy.fields:
        fields = ", ".join(
            _render_field_autosave(field_policy)
            for field_policy in policy.fields
        )
        parts.append(f"fields=[{fields}]")
    return f".autosave(fm.StageAutosave({', '.join(parts)}))"


def _render_stage_table_autosave(table: TableAutosave) -> str:
    parts: list[str] = []
    if table.every_steps is not None:
        parts.append(f"every_steps={table.every_steps}")
    else:
        parts.append(f"t_sampl={_py_sampling_period(table.t_sampl)}")
    if table.quantities is not None:
        parts.append(f"quantities={_py_literal(list(table.quantities))}")
    if table.table_id != "default":
        parts.append(f"table_id={_py_repr(table.table_id)}")
    return f"fm.TableAutosave({', '.join(parts)})"


def _render_field_autosave(field_policy: object) -> str:
    quantity = getattr(field_policy, "quantity")
    every_steps = getattr(field_policy, "every_steps")
    every = getattr(field_policy, "every")
    cadence = (
        f"every_steps={every_steps}"
        if every_steps is not None
        else f"every={_py_sampling_period(every)}"
    )
    return f"fm.FieldAutosave({_py_repr(quantity)}, {cadence})"


def _render_hysteresis_stage_args(study: Hysteresis) -> list[str]:
    payload = study.to_ir()
    args: list[str] = []
    for key in ("field_min_mT", "field_max_mT", "field_step_mT"):
        if key in payload:
            args.append(f"{key}={_py_number(float(payload[key]))}")
    if "field_values_mT" in payload:
        args.append(f"field_values_mT={_py_literal(payload['field_values_mT'])}")
    if "direction" in payload:
        args.append(f"direction={_py_literal(payload['direction'])}")
    if "orientation" in payload:
        args.append(f"orientation={_render_hysteresis_orientation(payload['orientation'])}")
    args.append(f"measurement_axis={_render_hysteresis_measurement_axis(payload['measurement_axis'])}")
    if "angular_family" in payload:
        args.append(f"angular_family={_render_hysteresis_angular_family(payload['angular_family'])}")
    args.append(f"initial_protocol={_py_repr(str(payload['initial_protocol']))}")
    if "initial_state_ref" in payload:
        args.append(f"initial_state_ref={_py_repr(str(payload['initial_state_ref']))}")
    if "saturation" in payload:
        args.append(f"saturation={_render_hysteresis_saturation(payload['saturation'])}")
    args.append(f"branch_mode={_py_repr(str(payload['branch_mode']))}")
    if "settle_pipeline" in payload:
        args.append(f"settle_pipeline={_render_hysteresis_settle_pipeline(payload['settle_pipeline'])}")
    if "storage" in payload:
        args.append(f"storage={_render_hysteresis_storage(payload['storage'])}")
    if "field_schedule" in payload:
        args.append(f"field_schedule={_render_hysteresis_field_schedule(payload['field_schedule'])}")
    if "schedule_refinements" in payload:
        args.append(
            f"schedule_refinements={_render_hysteresis_field_windows(payload['schedule_refinements'])}"
        )
    if "adaptive_refinement" in payload:
        args.append(
            f"adaptive_refinement={_render_hysteresis_adaptive_refinement(payload['adaptive_refinement'])}"
        )
    if "minor_loops" in payload:
        args.append(f"minor_loops={_render_hysteresis_minor_loops(payload['minor_loops'])}")
    return args


def _render_hysteresis_orientation(value: object) -> str:
    payload = _normalize_mapping(value)
    kind = str(payload.get("kind") or "")
    if kind == "preset":
        return f"fm.FieldOrientation.preset({_py_repr(str(payload.get('preset_name') or ''))})"
    if kind == "sample":
        return (
            "fm.FieldOrientation.sample("
            f"theta_deg={_py_number(float(payload.get('theta', 0.0)))}, "
            f"phi_deg={_py_number(float(payload.get('phi', 0.0)))})"
        )
    if kind == "global":
        return f"fm.FieldOrientation.global_vector({_py_literal(payload.get('vector'))})"
    raise ValueError(f"unsupported hysteresis field orientation kind {kind!r}")


def _render_hysteresis_adaptive_refinement(value: object) -> str:
    payload = _normalize_mapping(value)
    kwargs = [
        f"enabled={_py_literal(bool(payload.get('enabled', True)))}",
        f"max_passes={int(payload.get('max_passes', 1))}",
        f"max_insertions_per_pass={int(payload.get('max_insertions_per_pass', 16))}",
        f"dm_dh_threshold_per_mT={_py_number(float(payload.get('dm_dh_threshold_per_mT', 0.02)))}",
        f"max_step_mT={_py_number(float(payload.get('max_step_mT', 5.0)))}",
        f"min_step_mT={_py_number(float(payload.get('min_step_mT', 0.1)))}",
        f"include_zero_crossings={_py_literal(bool(payload.get('include_zero_crossings', True)))}",
        f"include_high_susceptibility={_py_literal(bool(payload.get('include_high_susceptibility', True)))}",
        f"include_in_metrics={_py_literal(bool(payload.get('include_in_metrics', False)))}",
    ]
    return "fm.AdaptiveRefinement(" + ", ".join(kwargs) + ")"


def _render_hysteresis_angular_family(value: object) -> str:
    payload = _normalize_mapping(value)
    variants = payload.get("variants")
    if not isinstance(variants, list):
        raise ValueError("hysteresis angular_family variants must be a list")
    args = [
        "variants=[" + ", ".join(_render_hysteresis_angular_variant(variant) for variant in variants) + "]",
        f"family_id={_py_repr(str(payload.get('family_id') or 'angular_family'))}",
    ]
    if payload.get("label"):
        args.append(f"label={_py_repr(str(payload.get('label')))}")
    return "fm.HysteresisAngularFamily(" + ", ".join(args) + ")"


def _render_hysteresis_angular_variant(value: object) -> str:
    payload = _normalize_mapping(value)
    args = [
        f"variant_id={_py_repr(str(payload.get('variant_id') or ''))}",
        f"orientation={_render_hysteresis_orientation(payload.get('orientation'))}",
    ]
    if payload.get("label"):
        args.append(f"label={_py_repr(str(payload.get('label')))}")
    if "measurement_axis" in payload:
        args.append(
            f"measurement_axis={_render_hysteresis_measurement_axis(payload['measurement_axis'])}"
        )
    return "fm.HysteresisAngularVariant(" + ", ".join(args) + ")"


def _render_hysteresis_measurement_axis(value: object) -> str:
    if isinstance(value, str):
        return _py_repr(value)
    if isinstance(value, Mapping):
        payload = dict(value)
        kind = payload.get("kind")
        if kind == "custom":
            return f"fm.MeasurementAxis.custom({_py_literal(payload.get('vector'))})"
    raise ValueError(f"unsupported hysteresis measurement axis {value!r}")


def _render_hysteresis_saturation(value: object) -> str:
    payload = _normalize_mapping(value)
    args = [
        f"mode={_py_repr(str(payload.get('mode') or 'auto'))}",
        f"max_field_mT={_py_number(float(payload.get('max_field_mT', 300.0)))}",
        f"susceptibility_threshold={_py_number(float(payload.get('susceptibility_threshold', 1e-3)))}",
        f"transverse_threshold={_py_number(float(payload.get('transverse_threshold', 1e-2)))}",
        f"on_failure={_py_repr(str(payload.get('on_failure') or 'continue_with_warning'))}",
    ]
    return f"fm.SaturationProbe({', '.join(args)})"


def _render_hysteresis_storage(value: object) -> str:
    payload = _normalize_mapping(value)
    args = [
        f"scalar_history={_py_literal(bool(payload.get('scalar_history', True)))}",
        f"magnetization={_py_repr(str(payload.get('magnetization') or 'selected'))}",
        f"every_n={int(payload.get('every_n', 5))}",
        f"key_events={_py_literal(bool(payload.get('key_events', True)))}",
        f"key_event_threshold_dm={_py_number(float(payload.get('key_event_threshold_dm', 0.02)))}",
    ]
    return f"fm.HysteresisStorage({', '.join(args)})"


def _render_hysteresis_settle_pipeline(value: object) -> str:
    payload = _normalize_mapping(value)
    kind = str(payload.get("kind") or "")
    if kind == "sequence":
        steps = payload.get("steps")
        if not isinstance(steps, list):
            raise ValueError("hysteresis settle pipeline sequence requires steps")
        rendered = ", ".join(_render_hysteresis_settle_step(step) for step in steps)
        return f"fm.SettlePipeline([{rendered}])"
    if kind == "tree":
        default = _render_hysteresis_settle_step(payload.get("default"))
        branches = payload.get("branches")
        if not isinstance(branches, list):
            raise ValueError("hysteresis settle tree requires branches")
        rendered_branches = ", ".join(_render_hysteresis_settle_branch(branch) for branch in branches)
        return f"fm.SettleTree(default={default}, branches=[{rendered_branches}])"
    raise ValueError(f"unsupported hysteresis settle pipeline kind {kind!r}")


def _render_hysteresis_settle_branch(value: object) -> str:
    payload = _normalize_mapping(value)
    return (
        "fm.SettleBranch("
        f"when={_py_repr(str(payload.get('when') or ''))}, "
        f"run={_render_hysteresis_settle_step(payload.get('run'))})"
    )


def _render_hysteresis_settle_step(value: object) -> str:
    payload = _normalize_mapping(value)
    kind = str(payload.get("kind") or "")
    class_name = {
        "relax": "RelaxStep",
        "minimize": "MinimizeStep",
        "dynamics_settle": "DynamicsSettleStep",
    }.get(kind)
    if class_name is None:
        raise ValueError(f"unsupported hysteresis settle step kind {kind!r}")
    args: list[str] = []
    for key in (
        "method",
        "alpha",
        "torque_tolerance",
        "energy_tolerance",
        "damping",
        "max_steps",
        "applies_to",
        "stop_criteria",
        "timestep_s",
        "max_pseudotime_s",
        "max_physical_time_s",
        "on_non_convergence",
        "retry_timestep_scale",
        "retry_max_attempts",
    ):
        if key not in payload:
            continue
        value = payload[key]
        if isinstance(value, str):
            args.append(f"{key}={_py_repr(value)}")
        elif isinstance(value, bool):
            args.append(f"{key}={_py_literal(value)}")
        elif isinstance(value, int):
            args.append(f"{key}={value}")
        elif isinstance(value, float):
            args.append(f"{key}={_py_number(value)}")
        elif value is not None:
            args.append(f"{key}={_py_literal(value)}")
    return f"fm.{class_name}({', '.join(args)})"


def _render_hysteresis_field_schedule(value: object) -> str:
    payload = _normalize_mapping(value)
    segments = payload.get("segments")
    if not isinstance(segments, list):
        raise ValueError("hysteresis field schedule requires segments")
    rendered = ", ".join(_render_hysteresis_field_segment(segment) for segment in segments)
    return f"fm.PiecewiseFieldSchedule.mT([{rendered}])"


def _render_hysteresis_field_segment(value: object) -> str:
    payload = _normalize_mapping(value)
    args = [
        f"start={_py_number(float(payload.get('start', 0.0)))}",
        f"stop={_py_number(float(payload.get('stop', 0.0)))}",
        f"step={_py_number(float(payload.get('step', 0.0)))}",
        f"segment_id={_py_repr(str(payload.get('segment_id') or ''))}",
        f"label={_py_repr(str(payload.get('label') or ''))}",
        f"endpoint_policy={_py_repr(str(payload.get('endpoint_policy') or 'include_stop'))}",
        f"reason={_py_repr(str(payload.get('reason') or ''))}",
    ]
    return f"fm.FieldSegment({', '.join(args)})"


def _render_hysteresis_field_windows(value: object) -> str:
    if not isinstance(value, list):
        raise ValueError("hysteresis schedule_refinements must be a list")
    return "[" + ", ".join(_render_hysteresis_field_window(window) for window in value) + "]"


def _render_hysteresis_field_window(value: object) -> str:
    payload = _normalize_mapping(value)
    args = [
        f"center_mT={_py_number(float(payload.get('center_mT', 0.0)))}",
        f"half_width_mT={_py_number(float(payload.get('half_width_mT', 0.0)))}",
        f"step_mT={_py_number(float(payload.get('step_mT', 0.0)))}",
        f"reason={_py_repr(str(payload.get('reason') or ''))}",
    ]
    if payload.get("priority") is not None:
        args.append(f"priority={int(payload['priority'])}")
    return f"fm.FieldWindow({', '.join(args)})"


def _render_hysteresis_minor_loops(value: object) -> str:
    if not isinstance(value, list):
        raise ValueError("hysteresis minor_loops must be a list")
    return "[" + ", ".join(_render_hysteresis_minor_loop(loop) for loop in value) + "]"


def _render_hysteresis_minor_loop(value: object) -> str:
    payload = _normalize_mapping(value)
    args = [
        f"reversal_mT={_py_number(float(payload.get('reversal_mT', 0.0)))}",
        f"return_mT={_py_number(float(payload.get('return_mT', 0.0)))}",
    ]
    intermediate_fields = payload.get("intermediate_fields_mT")
    if intermediate_fields:
        if not isinstance(intermediate_fields, list):
            raise ValueError("hysteresis minor loop intermediate_fields_mT must be a list")
        args.append(
            "intermediate_fields_mT=["
            + ", ".join(_py_number(float(field)) for field in intermediate_fields)
            + "]"
        )
    if payload.get("continuation_policy") not in (None, "branch_only"):
        args.append(f"continuation_policy={_py_repr(str(payload['continuation_policy']))}")
    return (
        "fm.MinorLoop("
        + ", ".join(args)
        + ")"
    )


def _stage_override_for(
    raw_stage_overrides: object,
    *,
    index: int,
    stage: LoadedStage,
) -> dict[str, object]:
    if not isinstance(raw_stage_overrides, list):
        return {}
    if index >= len(raw_stage_overrides):
        return {}
    override = _normalize_mapping(raw_stage_overrides[index])
    if not override:
        return {}
    if isinstance(stage.action, dict):
        action_kind = str(stage.action.get("kind") or "").strip().lower()
        if action_kind in {
            "save_state",
            "load_state",
            "set_transport_current",
            "set_spin_torque_enabled",
            "export",
            "change_device",
            "add_field_drive",
            "remove_field_drive",
            "table_autosave",
            "autosave",
            "fft_response",
        }:
            expected_kind = action_kind
        else:
            expected_kind = "run"
    else:
        if isinstance(stage.problem.study, Relaxation):
            expected_kind = "relax"
        elif isinstance(stage.problem.study, Eigenmodes):
            expected_kind = "eigenmodes"
        elif isinstance(stage.problem.study, FrequencyResponse):
            expected_kind = "frequency_response"
        else:
            expected_kind = "run"
    override_kind = override.get("kind")
    if isinstance(override_kind, str) and override_kind and override_kind != expected_kind:
        return {}
    return override


def _render_solver_call(
    dynamics: LLG,
    solver_override: dict[str, object],
    *,
    surface: str,
) -> str:
    kwargs: list[str] = []
    integrator = _override_string(solver_override, "integrator", dynamics.integrator)
    if integrator and integrator != "auto":
        kwargs.append(f"integrator={_py_repr(integrator)}")

    fixed_timestep = _override_number(solver_override, "fixed_timestep", dynamics.fixed_timestep)
    demag_interval_s = _override_number(
        solver_override,
        "demag_interval_s",
        dynamics.field_refresh.demag_interval_s
        if dynamics.field_refresh is not None
        else None,
    )
    convenience_keys = {"dt_initial", "dt_min", "dt_max", "max_err"}
    has_fixed_override = (
        "fixed_timestep" in solver_override
        and _number_or_none(solver_override.get("fixed_timestep")) is not None
    )
    has_advanced_override = isinstance(solver_override.get("adaptive_timestep"), dict)
    has_convenience_override = any(key in solver_override for key in convenience_keys)
    has_active_convenience_override = any(
        key in solver_override and _number_or_none(solver_override.get(key)) is not None
        for key in convenience_keys
    )
    if has_fixed_override and (
        has_advanced_override or has_active_convenience_override
    ):
        raise ValueError("solver override must resolve exactly one timestep policy")
    if has_advanced_override and has_active_convenience_override:
        raise ValueError("solver override must resolve exactly one timestep policy")

    resolved_adaptive = dynamics.adaptive_timestep
    resolved_fixed = fixed_timestep
    if has_fixed_override:
        resolved_adaptive = None
    elif has_advanced_override:
        resolved_adaptive = _advanced_policy_with_overrides(
            dynamics.adaptive_timestep,
            solver_override["adaptive_timestep"],
        )
        resolved_fixed = None
    elif has_convenience_override:
        resolved_adaptive = _max_error_policy_with_overrides(
            dynamics.adaptive_timestep, solver_override
        )
        resolved_fixed = None
    elif "adaptive_timestep" in solver_override:
        resolved_adaptive = None

    if (
        resolved_adaptive is not None
        and integrator not in ADAPTIVE_INTEGRATORS
        and integrator != "auto"
    ):
        raise ValueError("adaptive timestep requires rk23, rk45, or auto")

    if resolved_adaptive is not None:
        if not _is_exact_max_err_policy(resolved_adaptive):
            kwargs.append(
                "adaptive_timestep=fm.AdaptiveTimestep("
                + ", ".join(
                    [
                        f"atol={_py_number(resolved_adaptive.atol)}",
                        f"rtol={_py_number(resolved_adaptive.rtol)}",
                        "dt_initial="
                        + (
                            "None"
                            if resolved_adaptive.dt_initial is None
                            else _py_number(resolved_adaptive.dt_initial)
                        ),
                        f"dt_min={_py_number(resolved_adaptive.dt_min)}",
                        "dt_max="
                        + (
                            "None"
                            if resolved_adaptive.dt_max is None
                            else _py_number(resolved_adaptive.dt_max)
                        ),
                        f"safety={_py_number(resolved_adaptive.safety)}",
                        f"growth_limit={_py_number(resolved_adaptive.growth_limit)}",
                        f"shrink_limit={_py_number(resolved_adaptive.shrink_limit)}",
                        "max_spin_rotation="
                        + (
                            "None"
                            if resolved_adaptive.max_spin_rotation is None
                            else _py_number(resolved_adaptive.max_spin_rotation)
                        ),
                        "norm_tolerance="
                        + (
                            "None"
                            if resolved_adaptive.norm_tolerance is None
                            else _py_number(resolved_adaptive.norm_tolerance)
                        ),
                    ]
                )
                + ")"
            )
        else:
            if resolved_adaptive.dt_initial is not None:
                kwargs.append(f"dt_initial={_py_number(resolved_adaptive.dt_initial)}")
            kwargs.append(f"dt_min={_py_number(resolved_adaptive.dt_min)}")
            if resolved_adaptive.dt_max is not None:
                kwargs.append(f"dt_max={_py_number(resolved_adaptive.dt_max)}")
            kwargs.append(f"max_err={_py_number(resolved_adaptive.atol)}")
    elif resolved_fixed is not None:
        kwargs.append(f"fix_dt={_py_number(resolved_fixed)}")
    if demag_interval_s is not None:
        kwargs.append(f"demag_interval_s={_py_number(demag_interval_s)}")

    if dynamics.gamma is not None and abs(dynamics.gamma - DEFAULT_GAMMA) > 1e-12:
        kwargs.append(f"gamma={_py_number(dynamics.gamma)}")

    if not kwargs:
        return f"{_surface_call(surface, 'solver')}()"
    return f"{_surface_call(surface, 'solver')}({', '.join(kwargs)})"


def _render_drive_expr(drive: RfDrive) -> str:
    kwargs = [f"current_a={_py_number(drive.current_a)}"]
    if drive.waveform is not None:
        kwargs.append(f"waveform={_render_time_dependence_expr(drive.waveform)}")
    elif drive.frequency_hz is not None:
        kwargs.append(f"frequency_hz={_py_number(drive.frequency_hz)}")
        if abs(drive.phase_rad) > 1e-15:
            kwargs.append(f"phase_rad={_py_number(drive.phase_rad)}")
    return f"fm.RfDrive({', '.join(kwargs)})"


def _render_time_dependence_expr(waveform: object) -> str:
    if isinstance(waveform, Constant):
        return "fm.Constant()"
    if isinstance(waveform, Sinusoidal):
        kwargs = [f"frequency_hz={_py_number(waveform.frequency_hz)}"]
        if abs(waveform.phase_rad) > 1e-15:
            kwargs.append(f"phase_rad={_py_number(waveform.phase_rad)}")
        if abs(waveform.offset) > 1e-15:
            kwargs.append(f"offset={_py_number(waveform.offset)}")
        return f"fm.Sinusoidal({', '.join(kwargs)})"
    if isinstance(waveform, Pulse):
        return (
            f"fm.Pulse(t_on={_py_number(waveform.t_on)}, "
            f"t_off={_py_number(waveform.t_off)})"
        )
    if isinstance(waveform, SincPulse):
        kwargs = [f"cutoff_hz={_py_number(waveform.cutoff_hz)}"]
        if abs(waveform.t0) > 1e-15:
            kwargs.append(f"t0={_py_number(waveform.t0)}")
        if abs(waveform.amplitude - 1.0) > 1e-15:
            kwargs.append(f"amplitude={_py_number(waveform.amplitude)}")
        return f"fm.SincPulse({', '.join(kwargs)})"
    if isinstance(waveform, PiecewiseLinear):
        return f"fm.PiecewiseLinear({_py_literal([list(point) for point in waveform.points])})"
    return f"fm.{type(waveform).__name__}()"


def _render_antenna_expr(antenna: object) -> str:
    if isinstance(antenna, MicrostripAntenna):
        return (
            "fm.MicrostripAntenna("
            f"width={_py_number(antenna.width)}, "
            f"thickness={_py_number(antenna.thickness)}, "
            f"height_above_magnet={_py_number(antenna.height_above_magnet)}, "
            f"preview_length={_py_number(antenna.preview_length)}, "
            f"center_x={_py_number(antenna.center_x)}, "
            f"center_y={_py_number(antenna.center_y)})"
        )
    if isinstance(antenna, CPWAntenna):
        return (
            "fm.CPWAntenna("
            f"signal_width={_py_number(antenna.signal_width)}, "
            f"gap={_py_number(antenna.gap)}, "
            f"ground_width={_py_number(antenna.ground_width)}, "
            f"thickness={_py_number(antenna.thickness)}, "
            f"height_above_magnet={_py_number(antenna.height_above_magnet)}, "
            f"preview_length={_py_number(antenna.preview_length)}, "
            f"center_x={_py_number(antenna.center_x)}, "
            f"center_y={_py_number(antenna.center_y)})"
        )
    raise ValueError(
        f"canonical flat-script rewrite does not yet support antenna kind {type(antenna).__name__}"
    )


def _render_current_module_override(module: dict[str, object], *, surface: str) -> str:
    kind = str(module.get("kind") or "antenna_field_source")
    if kind == "current_transport":
        return _render_current_transport_payload(module, surface=surface)

    model = str(module.get("model") or "mqs_2p5d_az")
    if model == "prescribed_zeeman_mask":
        kwargs = [
            f"name={_py_repr(str(module.get('name') or 'antenna'))}",
            'model="prescribed_zeeman_mask"',
            f"object={_py_repr(str(module.get('object') or 'antenna_object'))}",
            f"B={_py_number(float(module.get('B', 0.0)))}",  # type: ignore[arg-type]
        ]
        direction = _optional_vec3(module.get("direction"))
        if direction is not None:
            kwargs.append(f"direction={_py_tuple3(direction)}")
        waveform = module.get("waveform")
        if isinstance(waveform, dict):
            kwargs.append(f"waveform={_render_waveform_override(waveform)}")
        return f"{_surface_call(surface, 'antenna_field_source')}({', '.join(kwargs)})"

    antenna_kind = str(module.get("antenna_kind") or "")
    antenna_params = _normalize_mapping(module.get("antenna_params"))
    drive = _normalize_mapping(module.get("drive"))
    kwargs = [
        f"name={_py_repr(str(module.get('name') or 'antenna'))}",
        f"antenna={_render_antenna_override(antenna_kind, antenna_params)}",
        f"drive={_render_drive_override(drive)}",
    ]
    solver = str(module.get("solver") or "mqs_2p5d_az")
    if solver != "mqs_2p5d_az":
        kwargs.append(f"solver={_py_repr(solver)}")
    air_box_factor = module.get("air_box_factor")
    if air_box_factor is not None and abs(float(air_box_factor)) > 1e-12:  # type: ignore[arg-type]
        kwargs.append(f"air_box_factor={_py_number(float(air_box_factor))}")  # type: ignore[arg-type]
    return f"{_surface_call(surface, 'antenna_field_source')}({', '.join(kwargs)})"


def _render_antenna_override(kind: str, params: dict[str, object]) -> str:
    if kind == "MicrostripAntenna":
        return (
            "fm.MicrostripAntenna("
            f"width={_py_number(float(params.get('width', 1.0)))}, "
            f"thickness={_py_number(float(params.get('thickness', 1.0)))}, "
            f"height_above_magnet={_py_number(float(params.get('height_above_magnet', 0.0)))}, "
            f"preview_length={_py_number(float(params.get('preview_length', 1.0)))}, "
            f"center_x={_py_number(float(params.get('center_x', 0.0)))}, "
            f"center_y={_py_number(float(params.get('center_y', 0.0)))})"  # type: ignore[arg-type]
        )
    if kind == "CPWAntenna":
        return (
            "fm.CPWAntenna("
            f"signal_width={_py_number(float(params.get('signal_width', 1.0)))}, "
            f"gap={_py_number(float(params.get('gap', 1.0)))}, "
            f"ground_width={_py_number(float(params.get('ground_width', 1.0)))}, "
            f"thickness={_py_number(float(params.get('thickness', 1.0)))}, "
            f"height_above_magnet={_py_number(float(params.get('height_above_magnet', 0.0)))}, "
            f"preview_length={_py_number(float(params.get('preview_length', 1.0)))}, "
            f"center_x={_py_number(float(params.get('center_x', 0.0)))}, "
            f"center_y={_py_number(float(params.get('center_y', 0.0)))})"  # type: ignore[arg-type]
        )
    raise ValueError(f"unsupported antenna override kind: {kind}")


def _render_drive_override(drive: dict[str, object]) -> str:
    kwargs = [f"current_a={_py_number(float(drive.get('current_a', 0.0)))}"]  # type: ignore[arg-type]
    frequency_hz = drive.get("frequency_hz")
    if frequency_hz is not None:
        kwargs.append(f"frequency_hz={_py_number(float(frequency_hz))}")  # type: ignore[arg-type]
    phase_rad = drive.get("phase_rad")
    if phase_rad is not None and abs(float(phase_rad)) > 1e-15:  # type: ignore[arg-type]
        kwargs.append(f"phase_rad={_py_number(float(phase_rad))}")  # type: ignore[arg-type]
    waveform = drive.get("waveform")
    if isinstance(waveform, dict):
        kwargs.append(f"waveform={_render_waveform_override(waveform)}")
    return f"fm.RfDrive({', '.join(kwargs)})"


def _render_waveform_override(waveform: dict[str, object]) -> str:
    kind = str(waveform.get("kind") or "")
    if kind == "constant":
        return "fm.Constant()"
    if kind == "sinusoidal":
        kwargs = [f"frequency_hz={_py_number(float(waveform.get('frequency_hz', 0.0)))}"]  # type: ignore[arg-type]
        if abs(float(waveform.get("phase_rad", 0.0))) > 1e-15:
            kwargs.append(f"phase_rad={_py_number(float(waveform.get('phase_rad', 0.0)))}")
        if abs(float(waveform.get("offset", 0.0))) > 1e-15:
            kwargs.append(f"offset={_py_number(float(waveform.get('offset', 0.0)))}")
        return f"fm.Sinusoidal({', '.join(kwargs)})"
    if kind == "pulse":
        return (
            f"fm.Pulse(t_on={_py_number(float(waveform.get('t_on', 0.0)))}, "
            f"t_off={_py_number(float(waveform.get('t_off', 0.0)))})"
        )
    if kind == "sinc_pulse":
        kwargs = [f"cutoff_hz={_py_number(float(waveform.get('cutoff_hz', 0.0)))}"]  # type: ignore[arg-type]
        if abs(float(waveform.get("t0", 0.0))) > 1e-15:
            kwargs.append(f"t0={_py_number(float(waveform.get('t0', 0.0)))}")
        if abs(float(waveform.get("amplitude", 1.0)) - 1.0) > 1e-15:
            kwargs.append(f"amplitude={_py_number(float(waveform.get('amplitude', 1.0)))}")
        return f"fm.SincPulse({', '.join(kwargs)})"
    if kind == "piecewise_linear":
        return f"fm.PiecewiseLinear({_py_literal(waveform.get('points') or [])})"
    raise ValueError(f"unsupported waveform override kind: {kind}")


def _render_excitation_analysis_override(
    analysis: dict[str, object],
    *,
    surface: str,
) -> str:
    axis = analysis.get("propagation_axis")
    propagation_axis = axis if isinstance(axis, list) and len(axis) == 3 else [1.0, 0.0, 0.0]
    kwargs = [
        f"source={_py_repr(str(analysis.get('source') or 'antenna'))}",
        f"method={_py_repr(str(analysis.get('method') or 'source_k_profile'))}",
        f"propagation_axis={_py_literal(propagation_axis)}",
        f"samples={int(analysis.get('samples', 256))}",
    ]
    if analysis.get("k_max_rad_per_m") is not None:
        kwargs.append(f"k_max_rad_per_m={_py_number(float(analysis['k_max_rad_per_m']))}")
    return f"{_surface_call(surface, 'spin_wave_excitation')}({', '.join(kwargs)})"


def _render_geometry_expr_from_override(
    kind: str,
    params: dict[str, object],
    *,
    name: str,
    source_root: Path,
) -> str:
    if kind == "Box":
        size = params.get("size")
        if isinstance(size, list) and len(size) == 3:
            args = [
                _py_number(float(size[0])),
                _py_number(float(size[1])),
                _py_number(float(size[2])),
            ]
        elif isinstance(size, (int, float)):
            args = [_py_number(float(size))] * 3
        else:
            args = ["1e-9", "1e-9", "1e-9"]
        expr = f"fm.Box({', '.join(args)}, name={_py_repr(name)})"
    elif kind == "Cylinder":
        axis = params.get("axis")
        axis_kw = ""
        if isinstance(axis, list) and len(axis) == 3 and tuple(float(value) for value in axis) != (0.0, 0.0, 1.0):
            axis_kw = (
                f", axis=({_py_number(float(axis[0]))}, "
                f"{_py_number(float(axis[1]))}, {_py_number(float(axis[2]))})"
            )
        expr = (
            f"fm.Cylinder(radius={_py_number(float(str(params.get('radius', 1e-9))))}, "
            f"height={_py_number(float(str(params.get('height', 1e-9))))}, "
            f"name={_py_repr(name)}{axis_kw})"
        )
    elif kind == "ArchWaveguide":
        expr = (
            f"fm.ArchWaveguide(length={_py_number(float(str(params.get('length', 1e-9))))}, "
            f"width={_py_number(float(str(params.get('width', 1e-9))))}, "
            f"height={_py_number(float(str(params.get('height', 1e-9))))}, "
            f"arch_height={_py_number(float(str(params.get('arch_height', 0.0))))}, "
            f"z0={_py_number(float(str(params.get('z0', 0.0))))}, "
            f"name={_py_repr(name)})"
        )
    elif kind == "SinWaveguide":
        expr = (
            f"fm.SinWaveguide(length={_py_number(float(str(params.get('length', 1e-9))))}, "
            f"width={_py_number(float(str(params.get('width', 1e-9))))}, "
            f"height={_py_number(float(str(params.get('height', 1e-9))))}, "
            f"period={_py_number(float(str(params.get('period', 1e-9))))}, "
            f"amplitude={_py_number(float(str(params.get('amplitude', 0.0))))}, "
            f"phase={_py_number(float(str(params.get('phase', 0.0))))}, "
            f"z0={_py_number(float(str(params.get('z0', 0.0))))}, "
            f"name={_py_repr(name)})"
        )
    elif kind == "Ellipsoid":
        expr = (
            f"fm.Ellipsoid({_py_number(float(str(params.get('rx', 1e-9))))}, "
            f"{_py_number(float(str(params.get('ry', 1e-9))))}, "
            f"{_py_number(float(str(params.get('rz', 1e-9))))}, "
            f"name={_py_repr(name)})"
        )
    elif kind == "Ellipse":
        expr = (
            f"fm.Ellipse({_py_number(float(str(params.get('rx', 1e-9))))}, "
            f"{_py_number(float(str(params.get('ry', 1e-9))))}, "
            f"{_py_number(float(str(params.get('height', 1e-9))))}, "
            f"name={_py_repr(name)})"
        )
    elif kind == "ImportedGeometry":
        source = str(params.get("source", ""))
        kwargs = [
            f"source={_py_repr(_relativize_path(source, source_root))}",
            f"name={_py_repr(name)}",
        ]
        scale = params.get("scale")
        if isinstance(scale, list) and len(scale) == 3:
            kwargs.append(f"scale={_py_tuple3(tuple(float(value) for value in scale))}")
        elif isinstance(scale, (int, float)) and float(scale) != 1.0:
            kwargs.append(f"scale={_py_number(float(scale))}")
        volume = params.get("volume")
        if isinstance(volume, str) and volume and volume != "full":
            kwargs.append(f"volume={_py_repr(volume)}")
        expr = f"fm.ImportedGeometry({', '.join(kwargs)})"
    elif kind == "Translate":
        base = _normalize_mapping(params.get("base"))
        base_kind = str(base.get("geometry_kind", "Box"))
        base_params = _normalize_mapping(base.get("geometry_params"))
        expr = _render_geometry_expr_from_override(
            base_kind,
            base_params,
            name=name,
            source_root=source_root,
        )
    elif kind in {"Difference", "Union", "Intersection"}:
        if kind == "Difference":
            left_raw = _normalize_mapping(params.get("base"))
            right_raw = _normalize_mapping(params.get("tool"))
            operator = "-"
        else:
            left_raw = _normalize_mapping(params.get("a"))
            right_raw = _normalize_mapping(params.get("b"))
            operator = "+" if kind == "Union" else "&"
        left_expr = _render_geometry_expr_from_override(
            str(left_raw.get("geometry_kind", "Box")),
            _normalize_mapping(left_raw.get("geometry_params")),
            name=f"{name}_{'lhs' if kind != 'Difference' else 'base'}",
            source_root=source_root,
        )
        right_expr = _render_geometry_expr_from_override(
            str(right_raw.get("geometry_kind", "Box")),
            _normalize_mapping(right_raw.get("geometry_params")),
            name=f"{name}_{'rhs' if kind != 'Difference' else 'tool'}",
            source_root=source_root,
        )
        expr = f"({left_expr} {operator} {right_expr})"
    else:
        expr = f"fm.Box(1e-9, 1e-9, 1e-9, name={_py_repr(name)})"

    translation = params.get("translation")
    if not isinstance(translation, list):
        translation = params.get("translate")
    if isinstance(translation, list) and len(translation) == 3 and any(float(value) != 0 for value in translation):
        expr = (
            f"{expr}.translate(({_py_number(float(translation[0]))}, "
            f"{_py_number(float(translation[1]))}, "
            f"{_py_number(float(translation[2]))}))"
        )
    return expr


def _render_geometry_expr(geometry: object, *, magnet_name: str, source_root: Path) -> str:
    if isinstance(geometry, ImportedGeometry):
        kwargs = [f"source={_py_repr(_relativize_path(geometry.source, source_root))}"]
        if geometry.scale != 1.0:
            kwargs.append(f"scale={_py_literal(geometry.scale)}")
        if geometry.volume != "full":
            kwargs.append(f"volume={_py_repr(geometry.volume)}")
        default_name = Path(geometry.source).stem
        if geometry.name is not None and geometry.name not in {default_name, f"{magnet_name}_geom"}:
            kwargs.append(f"name={_py_repr(geometry.name)}")
        return f"fm.ImportedGeometry({', '.join(kwargs)})"
    if isinstance(geometry, Box):
        args = ", ".join(_py_number(value) for value in geometry.size)
        if geometry.name in {"box", f"{magnet_name}_geom"}:
            return f"fm.Box({args})"
        return f"fm.Box({args}, name={_py_repr(geometry.name)})"
    if isinstance(geometry, Cylinder):
        args = f"radius={_py_number(geometry.radius)}, height={_py_number(geometry.height)}"
        if geometry.axis != (0.0, 0.0, 1.0):
            args = f"{args}, axis={_py_tuple3(geometry.axis)}"
        if geometry.name in {"cylinder", f"{magnet_name}_geom"}:
            return f"fm.Cylinder({args})"
        return f"fm.Cylinder({args}, name={_py_repr(geometry.name)})"
    if isinstance(geometry, ArchWaveguide):
        args = (
            f"length={_py_number(geometry.length)}, width={_py_number(geometry.width)}, "
            f"height={_py_number(geometry.height)}, arch_height={_py_number(geometry.arch_height)}, "
            f"z0={_py_number(geometry.z0)}"
        )
        if geometry.name in {"arch_waveguide", f"{magnet_name}_geom"}:
            return f"fm.ArchWaveguide({args})"
        return f"fm.ArchWaveguide({args}, name={_py_repr(geometry.name)})"
    if isinstance(geometry, SinWaveguide):
        args = (
            f"length={_py_number(geometry.length)}, width={_py_number(geometry.width)}, "
            f"height={_py_number(geometry.height)}, period={_py_number(geometry.period)}, "
            f"amplitude={_py_number(geometry.amplitude)}, phase={_py_number(geometry.phase)}, "
            f"z0={_py_number(geometry.z0)}"
        )
        if geometry.name in {"sin_waveguide", f"{magnet_name}_geom"}:
            return f"fm.SinWaveguide({args})"
        return f"fm.SinWaveguide({args}, name={_py_repr(geometry.name)})"
    if isinstance(geometry, Ellipsoid):
        args = f"{_py_number(geometry.rx)}, {_py_number(geometry.ry)}, {_py_number(geometry.rz)}"
        if geometry.name in {"ellipsoid", f"{magnet_name}_geom"}:
            return f"fm.Ellipsoid({args})"
        return f"fm.Ellipsoid({args}, name={_py_repr(geometry.name)})"
    if isinstance(geometry, Ellipse):
        args = f"{_py_number(geometry.rx)}, {_py_number(geometry.ry)}, {_py_number(geometry.height)}"
        if geometry.name in {"ellipse", f"{magnet_name}_geom"}:
            return f"fm.Ellipse({args})"
        return f"fm.Ellipse({args}, name={_py_repr(geometry.name)})"
    if isinstance(geometry, Difference):
        base = _render_geometry_expr(geometry.base, magnet_name=magnet_name, source_root=source_root)
        tool = _render_geometry_expr(geometry.tool, magnet_name=magnet_name, source_root=source_root)
        expr = f"{base} - {tool}"
        if geometry.name not in {"difference", f"{magnet_name}_geom"}:
            expr = f"({expr})"
        return expr
    if isinstance(geometry, Union):
        return (
            f"{_render_geometry_expr(geometry.a, magnet_name=magnet_name, source_root=source_root)}"
            f" + "
            f"{_render_geometry_expr(geometry.b, magnet_name=magnet_name, source_root=source_root)}"
        )
    if isinstance(geometry, Intersection):
        return (
            f"{_render_geometry_expr(geometry.a, magnet_name=magnet_name, source_root=source_root)}"
            f" & "
            f"{_render_geometry_expr(geometry.b, magnet_name=magnet_name, source_root=source_root)}"
        )
    if isinstance(geometry, Translate):
        base = _render_geometry_expr(geometry.geometry, magnet_name=magnet_name, source_root=source_root)
        offset = ", ".join(_py_number(value) for value in geometry.offset)
        return f"{base}.translate(({offset}))"
    raise ValueError(f"unsupported geometry kind for canonical rewrite: {type(geometry).__name__}")


def _render_initial_magnetization(
    initializer: object,
    *,
    magnet_var: str,
    source_root: Path,
) -> str | list[str]:
    if isinstance(initializer, SampledMagnetization):
        if initializer.source_path:
            kwargs = []
            if initializer.source_format and initializer.source_format != "json":
                kwargs.append(f"format={_py_repr(initializer.source_format)}")
            if initializer.dataset and initializer.dataset != "values":
                kwargs.append(f"dataset={_py_repr(initializer.dataset)}")
            if initializer.sample_index not in {None, -1}:
                kwargs.append(f"sample={initializer.sample_index}")
            rendered_path = _py_repr(_relativize_path(initializer.source_path, source_root))
            suffix = f", {', '.join(kwargs)}" if kwargs else ""
            return [f"{magnet_var}.m.loadfile({rendered_path}{suffix})"]
        raise ValueError(
            "canonical flat-script rewrite requires sampled-field initial magnetization to come from loadfile(...)"
        )
    return f"{magnet_var}.m = {_render_initial_magnetization_expr(initializer, source_root=source_root)}"


def _render_initial_magnetization_expr(
    initializer: object,
    *,
    source_root: Path,
) -> str:
    if isinstance(initializer, UniformMagnetization):
        return f"fm.texture.uniform({_py_number(initializer.value[0])}, {_py_number(initializer.value[1])}, {_py_number(initializer.value[2])})"
    if isinstance(initializer, RandomMagnetization):
        return f"fm.texture.random(seed={initializer.seed})"
    if isinstance(initializer, PresetTexture):
        preset_expr = _render_preset_texture_expr(
            initializer.preset_kind,
            initializer.params,
            mapping=initializer.mapping.to_ir(),
            transform=initializer.transform.to_ir(),
            preset_version=initializer.preset_version,
            ui_label=initializer.ui_label,
            preview_proxy=initializer.preview_proxy,
        )
        return preset_expr
    raise ValueError(
        f"unsupported initial magnetization kind for canonical rewrite: {type(initializer).__name__}"
    )


def _render_initial_state_override(
    override: dict[str, object],
    *,
    magnet_name: str,
    magnet_var: str,
    source_root: Path,
) -> list[str] | None:
    if not override:
        return None
    override_path = override.get("source_path")
    if not isinstance(override_path, str) or not override_path.strip():
        return None
    target_magnet = override.get("magnet_name")
    if isinstance(target_magnet, str) and target_magnet.strip() and target_magnet != magnet_name:
        return None

    kwargs = []
    override_format = override.get("format")
    if isinstance(override_format, str) and override_format.strip() and override_format != "json":
        kwargs.append(f"format={_py_repr(override_format)}")
    override_dataset = override.get("dataset")
    if isinstance(override_dataset, str) and override_dataset.strip() and override_dataset != "values":
        kwargs.append(f"dataset={_py_repr(override_dataset)}")
    override_sample = override.get("sample_index")
    if isinstance(override_sample, int) and override_sample >= 0:
        kwargs.append(f"sample={override_sample}")

    rendered_path = _py_repr(_relativize_path(override_path, source_root))
    suffix = f", {', '.join(kwargs)}" if kwargs else ""
    return [f"{magnet_var}.m.loadfile({rendered_path}{suffix})"]


def _export_initial_state(problem: Problem) -> dict[str, object] | None:
    if len(problem.magnets) != 1:
        return None
    magnet = problem.magnets[0]
    if not isinstance(magnet.m0, SampledMagnetization) or not magnet.m0.source_path:
        return None

    return {
        "magnet_name": magnet.name,
        "source_path": str(Path(magnet.m0.source_path).resolve()),
        "format": magnet.m0.source_format
        or infer_magnetization_state_format(magnet.m0.source_path),
        "dataset": magnet.m0.dataset,
        "sample_index": magnet.m0.sample_index,
    }


def _export_global_mesh_state(problem: Problem) -> dict[str, object]:
    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    adaptive_mesh = _normalize_mapping(runtime_metadata.get("adaptive_mesh"))
    mesh_workflow = _normalize_mapping(runtime_metadata.get("mesh_workflow"))
    mesh_options = _normalize_mapping(mesh_workflow.get("mesh_options"))
    default_mesh = _normalize_mapping(mesh_workflow.get("default_mesh"))
    fem = problem.discretization.fem if problem.discretization is not None else None

    use_declared_defaults = _script_api_surface(problem) == "study" and "default_mesh" in mesh_workflow
    declared_hmax = default_mesh.get("hmax") if use_declared_defaults else (
        fem.hmax if isinstance(fem, FEM) else None
    )
    declared_order = default_mesh.get("order") if use_declared_defaults else None
    if declared_order is None and isinstance(fem, FEM):
        declared_order = fem.order

    return {
        "algorithm_2d": int(mesh_options.get("algorithm_2d", 6)),
        "algorithm_3d": int(mesh_options.get("algorithm_3d", 1)),
        "hmax": _text_mesh_size(declared_hmax),
        "hmin": _text_number(_number_or_none(mesh_options.get("hmin"))),
        "order": int(declared_order) if isinstance(declared_order, (int, float)) else None,
        "maximum_element_size": _text_mesh_size(declared_hmax),
        "minimum_element_size": _text_number(_number_or_none(mesh_options.get("hmin"))),
        "calibrate_for": str(mesh_options.get("calibrate_for", "") or ""),
        "size_preset": str(mesh_options.get("size_preset", "") or ""),
        "size_factor": float(mesh_options.get("size_factor", 1.0)),
        "size_from_curvature": int(mesh_options.get("size_from_curvature", 0)),
        "curvature_factor": _text_number(_number_or_none(mesh_options.get("curvature_factor"))),
        "growth_rate": _text_number(_number_or_none(mesh_options.get("growth_rate"))),
        "maximum_element_growth_rate": _text_number(_number_or_none(mesh_options.get("growth_rate"))),
        "narrow_regions": int(mesh_options.get("narrow_regions", 0)),
        "narrow_region_resolution": _text_number(
            _number_or_none(mesh_options.get("narrow_region_resolution"))
        ),
        "interface_hmax": _text_number(_number_or_none(mesh_options.get("interface_hmax"))),
        "interface_maximum_element_size": _text_number(
            _number_or_none(mesh_options.get("interface_hmax"))
        ),
        "interface_thickness": _text_number(
            _number_or_none(mesh_options.get("interface_thickness"))
        ),
        "transition_distance": _text_transition_distance(
            mesh_options.get("transition_distance")
        ),
        "transition_growth": _text_number(
            _number_or_none(mesh_options.get("transition_growth"))
        ),
        "edge_maximum_element_size": _text_number(_number_or_none(mesh_options.get("edge_hmax"))),
        "edge_thickness": _text_number(_number_or_none(mesh_options.get("edge_thickness"))),
        "edge_transition_distance": _text_transition_distance(
            mesh_options.get("edge_transition_distance")
        ),
        "corner_maximum_element_size": _text_number(_number_or_none(mesh_options.get("corner_hmax"))),
        "corner_extent": _text_number(_number_or_none(mesh_options.get("corner_extent"))),
        "corner_transition_distance": _text_transition_distance(
            mesh_options.get("corner_transition_distance")
        ),
        "boundary_layer_count": (
            int(mesh_options.get("boundary_layer_count"))
            if isinstance(mesh_options.get("boundary_layer_count"), (int, float))
            else None
        ),
        "boundary_layer_thickness": _text_number(
            _number_or_none(mesh_options.get("boundary_layer_thickness"))
        ),
        "boundary_layer_stretching": _number_or_none(
            mesh_options.get("boundary_layer_stretching")
        ),
        "boundary_layer_target_surface_tags": (
            list(mesh_options.get("boundary_layer_target_surface_tags"))
            if isinstance(mesh_options.get("boundary_layer_target_surface_tags"), list)
            else []
        ),
        "boundary_layer_target_curve_tags": (
            list(mesh_options.get("boundary_layer_target_curve_tags"))
            if isinstance(mesh_options.get("boundary_layer_target_curve_tags"), list)
            else []
        ),
        "boundary_layer_target_surface_selectors": (
            list(mesh_options.get("boundary_layer_target_surface_selectors"))
            if isinstance(mesh_options.get("boundary_layer_target_surface_selectors"), list)
            else []
        ),
        "boundary_layer_target_curve_selectors": (
            list(mesh_options.get("boundary_layer_target_curve_selectors"))
            if isinstance(mesh_options.get("boundary_layer_target_curve_selectors"), list)
            else []
        ),
        "resolved_size_from_curvature": (
            int(mesh_options.get("resolved_size_from_curvature"))
            if isinstance(mesh_options.get("resolved_size_from_curvature"), (int, float))
            else None
        ),
        "resolved_narrow_regions": (
            int(mesh_options.get("resolved_narrow_regions"))
            if isinstance(mesh_options.get("resolved_narrow_regions"), (int, float))
            else None
        ),
        "resolved_growth_rate": _text_number(_number_or_none(mesh_options.get("resolved_growth_rate"))),
        "smoothing_steps": int(mesh_options.get("smoothing_steps", 1)),
        "optimize": str(mesh_options.get("optimize", "") or ""),
        "optimize_iterations": int(mesh_options.get("optimize_iterations", 1)),
        "compute_quality": bool(mesh_options.get("compute_quality", True)),
        "per_element_quality": bool(mesh_options.get("per_element_quality", True)),
        "adaptive_enabled": bool(adaptive_mesh.get("enabled", False)),
        "adaptive_policy": str(adaptive_mesh.get("policy", "auto") or "auto"),
        "adaptive_indicator": str(adaptive_mesh.get("indicator", "geometric_only") or "geometric_only"),
        "adaptive_target_quantity": str(adaptive_mesh.get("target_quantity", "auto") or "auto"),
        "adaptive_convergence_metric": str(
            adaptive_mesh.get("convergence_metric", "energy_delta") or "energy_delta"
        ),
        "adaptive_theta": (
            float(adaptive_mesh.get("theta"))
            if isinstance(adaptive_mesh.get("theta"), (int, float))
            else 0.3
        ),
        "adaptive_h_min": _text_number(_number_or_none(adaptive_mesh.get("h_min"))),
        "adaptive_h_max": _text_number(_number_or_none(adaptive_mesh.get("h_max"))),
        "adaptive_max_passes": (
            int(adaptive_mesh.get("max_passes"))
            if isinstance(adaptive_mesh.get("max_passes"), (int, float))
            else 2
        ),
        "adaptive_error_tolerance": _text_number(
            _number_or_none(adaptive_mesh.get("error_tolerance"))
        ),
    }


def _is_pure_fdm_problem(problem: Problem) -> bool:
    discretization = problem.discretization
    return (
        discretization is not None
        and isinstance(discretization.fdm, FDM)
        and discretization.fem is None
    )


def _mesh_workflow_per_geometry_entry(problem: Problem, magnet_name: str) -> dict[str, object]:
    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    mesh_workflow = _normalize_mapping(runtime_metadata.get("mesh_workflow"))
    raw_entries = mesh_workflow.get("per_geometry")
    if not isinstance(raw_entries, list):
        return {}
    for raw_entry in raw_entries:
        entry = _normalize_mapping(raw_entry)
        if entry.get("geometry") == magnet_name:
            return entry
    return {}


def _export_geometry_mesh_entry(magnet_name: str, problem: Problem) -> dict[str, object] | None:
    fem = problem.discretization.fem if problem.discretization is not None else None
    mesh_entry = _mesh_workflow_per_geometry_entry(problem, magnet_name)
    if mesh_entry:
        mode = mesh_entry.get("mode")
        resolved_mode = str(mode) if isinstance(mode, str) and mode in {"inherit", "custom"} else "inherit"
        return {
            "mode": resolved_mode,
            "hmax": _text_mesh_size(mesh_entry.get("hmax")),
            "hmin": _text_number(_number_or_none(mesh_entry.get("hmin"))),
            "maximum_element_size": _text_mesh_size(mesh_entry.get("hmax")),
            "minimum_element_size": _text_number(_number_or_none(mesh_entry.get("hmin"))),
            "calibrate_for": str(mesh_entry.get("calibrate_for")) if isinstance(mesh_entry.get("calibrate_for"), str) else None,
            "size_preset": str(mesh_entry.get("size_preset")) if isinstance(mesh_entry.get("size_preset"), str) else None,
            "mesh_strategy": str(mesh_entry["mesh_strategy"]) if isinstance(mesh_entry.get("mesh_strategy"), str) else None,
            "order": int(mesh_entry["order"]) if isinstance(mesh_entry.get("order"), (int, float)) else None,
            "through_thickness_elements": int(mesh_entry["through_thickness_elements"]) if isinstance(mesh_entry.get("through_thickness_elements"), (int, float)) else None,
            "through_thickness_distribution": str(mesh_entry["through_thickness_distribution"]) if isinstance(mesh_entry.get("through_thickness_distribution"), str) else None,
            "through_thickness_element_ratio": _number_or_none(
                mesh_entry.get("through_thickness_element_ratio")
            ),
            "through_thickness_symmetric": bool(mesh_entry["through_thickness_symmetric"]) if isinstance(mesh_entry.get("through_thickness_symmetric"), bool) else None,
            "sweep_face_meshing": str(mesh_entry["sweep_face_meshing"]) if isinstance(mesh_entry.get("sweep_face_meshing"), str) else None,
            "topology": str(mesh_entry["topology"]) if isinstance(mesh_entry.get("topology"), str) else None,
            "sweep_direction": str(mesh_entry["sweep_direction"]) if isinstance(mesh_entry.get("sweep_direction"), str) else None,
            "element_family": str(mesh_entry["element_family"]) if isinstance(mesh_entry.get("element_family"), str) else None,
            "transition_policy": str(mesh_entry["transition_policy"]) if isinstance(mesh_entry.get("transition_policy"), str) else None,
            "exact_layer_count": bool(mesh_entry["exact_layer_count"]) if isinstance(mesh_entry.get("exact_layer_count"), bool) else None,
            "source": str(mesh_entry["source"]) if isinstance(mesh_entry.get("source"), str) else None,
            "algorithm_2d": int(mesh_entry["algorithm_2d"]) if isinstance(mesh_entry.get("algorithm_2d"), (int, float)) else None,
            "algorithm_3d": int(mesh_entry["algorithm_3d"]) if isinstance(mesh_entry.get("algorithm_3d"), (int, float)) else None,
            "size_factor": float(mesh_entry["size_factor"]) if isinstance(mesh_entry.get("size_factor"), (int, float)) else None,
            "size_from_curvature": int(mesh_entry["size_from_curvature"]) if isinstance(mesh_entry.get("size_from_curvature"), (int, float)) else None,
            "curvature_factor": _text_number(_number_or_none(mesh_entry.get("curvature_factor"))),
            "growth_rate": _text_number(_number_or_none(mesh_entry.get("growth_rate"))),
            "maximum_element_growth_rate": _text_number(_number_or_none(mesh_entry.get("growth_rate"))),
            "narrow_regions": int(mesh_entry["narrow_regions"]) if isinstance(mesh_entry.get("narrow_regions"), (int, float)) else None,
            "narrow_region_resolution": _text_number(
                _number_or_none(mesh_entry.get("narrow_region_resolution"))
            ),
            "interface_hmax": _text_number(_number_or_none(mesh_entry.get("interface_hmax"))),
            "interface_maximum_element_size": _text_number(
                _number_or_none(mesh_entry.get("interface_hmax"))
            ),
            "interface_thickness": _text_number(
                _number_or_none(mesh_entry.get("interface_thickness"))
            ),
            "transition_distance": _text_transition_distance(
                mesh_entry.get("transition_distance")
            ),
            "transition_growth": _number_or_none(mesh_entry.get("transition_growth")),
            "edge_maximum_element_size": _text_number(_number_or_none(mesh_entry.get("edge_hmax"))),
            "edge_thickness": _text_number(_number_or_none(mesh_entry.get("edge_thickness"))),
            "edge_transition_distance": _text_transition_distance(
                mesh_entry.get("edge_transition_distance")
            ),
            "corner_maximum_element_size": _text_number(_number_or_none(mesh_entry.get("corner_hmax"))),
            "corner_extent": _text_number(_number_or_none(mesh_entry.get("corner_extent"))),
            "corner_transition_distance": _text_transition_distance(
                mesh_entry.get("corner_transition_distance")
            ),
            "boundary_layer_count": (
                int(mesh_entry["boundary_layer_count"])
                if isinstance(mesh_entry.get("boundary_layer_count"), (int, float))
                else None
            ),
            "boundary_layer_thickness": _text_number(
                _number_or_none(mesh_entry.get("boundary_layer_thickness"))
            ),
            "boundary_layer_stretching": _number_or_none(
                mesh_entry.get("boundary_layer_stretching")
            ),
            "boundary_layer_target_surface_tags": (
                list(mesh_entry.get("boundary_layer_target_surface_tags"))
                if isinstance(mesh_entry.get("boundary_layer_target_surface_tags"), list)
                else []
            ),
            "boundary_layer_target_curve_tags": (
                list(mesh_entry.get("boundary_layer_target_curve_tags"))
                if isinstance(mesh_entry.get("boundary_layer_target_curve_tags"), list)
                else []
            ),
            "boundary_layer_target_surface_selectors": (
                list(mesh_entry.get("boundary_layer_target_surface_selectors"))
                if isinstance(mesh_entry.get("boundary_layer_target_surface_selectors"), list)
                else []
            ),
            "boundary_layer_target_curve_selectors": (
                list(mesh_entry.get("boundary_layer_target_curve_selectors"))
                if isinstance(mesh_entry.get("boundary_layer_target_curve_selectors"), list)
                else []
            ),
            "resolved_size_from_curvature": (
                int(mesh_entry["resolved_size_from_curvature"])
                if isinstance(mesh_entry.get("resolved_size_from_curvature"), (int, float))
                else None
            ),
            "resolved_narrow_regions": (
                int(mesh_entry["resolved_narrow_regions"])
                if isinstance(mesh_entry.get("resolved_narrow_regions"), (int, float))
                else None
            ),
            "resolved_growth_rate": _text_number(_number_or_none(mesh_entry.get("resolved_growth_rate"))),
            "smoothing_steps": int(mesh_entry["smoothing_steps"]) if isinstance(mesh_entry.get("smoothing_steps"), (int, float)) else None,
            "optimize": str(mesh_entry["optimize"]) if isinstance(mesh_entry.get("optimize"), str) else None,
            "optimize_iterations": int(mesh_entry["optimize_iterations"]) if isinstance(mesh_entry.get("optimize_iterations"), (int, float)) else None,
            "compute_quality": bool(mesh_entry["compute_quality"]) if isinstance(mesh_entry.get("compute_quality"), bool) else None,
            "per_element_quality": bool(mesh_entry["per_element_quality"]) if isinstance(mesh_entry.get("per_element_quality"), bool) else None,
            "size_fields": list(mesh_entry.get("size_fields")) if isinstance(mesh_entry.get("size_fields"), list) else [],
            "operations": list(mesh_entry.get("operations")) if isinstance(mesh_entry.get("operations"), list) else [],
            "build_requested": bool(mesh_entry.get("build_requested", False)),
        }
    if isinstance(fem, FEM):
        return {
            "mode": "inherit",
            "hmax": "",
            "hmin": "",
            "maximum_element_size": "",
            "minimum_element_size": "",
            "calibrate_for": None,
            "size_preset": None,
            "mesh_strategy": None,
            "order": None,
            "through_thickness_elements": None,
            "through_thickness_distribution": None,
            "through_thickness_element_ratio": None,
            "through_thickness_symmetric": None,
            "sweep_face_meshing": None,
            "topology": None,
            "sweep_direction": None,
            "element_family": None,
            "transition_policy": None,
            "exact_layer_count": None,
            "source": None,
            "algorithm_2d": None,
            "algorithm_3d": None,
            "size_factor": None,
            "size_from_curvature": None,
            "curvature_factor": "",
            "growth_rate": "",
            "maximum_element_growth_rate": "",
            "narrow_regions": None,
            "narrow_region_resolution": "",
            "interface_hmax": "",
            "interface_maximum_element_size": "",
            "interface_thickness": "",
            "transition_distance": "",
            "transition_growth": None,
            "edge_maximum_element_size": "",
            "edge_thickness": "",
            "edge_transition_distance": "",
            "corner_maximum_element_size": "",
            "corner_extent": "",
            "corner_transition_distance": "",
            "boundary_layer_count": None,
            "boundary_layer_thickness": "",
            "boundary_layer_stretching": None,
            "boundary_layer_target_surface_tags": [],
            "boundary_layer_target_curve_tags": [],
            "boundary_layer_target_surface_selectors": [],
            "boundary_layer_target_curve_selectors": [],
            "resolved_size_from_curvature": None,
            "resolved_narrow_regions": None,
            "resolved_growth_rate": "",
            "smoothing_steps": None,
            "optimize": None,
            "optimize_iterations": None,
            "compute_quality": None,
            "per_element_quality": None,
            "size_fields": [],
            "operations": [],
            "build_requested": False,
        }
    return None


def _export_geometry_entry(
    magnet: object,
    problem: Problem,
    *,
    source_root: Path,
) -> dict[str, object]:
    """Serialize one magnet into a geometry entry for the builder draft."""
    geom = magnet.geometry
    mat = magnet.material

    # --- Geometry kind + params ---
    geometry_kind, geometry_params = _export_geometry_kind_params(geom)
    bounds_min, bounds_max = _geometry_bounds(geom, source_root=source_root)

    # --- Material ---
    material: dict[str, object] = {
        "Ms": mat.Ms if mat.Ms is not None else None,
        "Aex": mat.A if mat.A is not None else None,
        "alpha": mat.alpha,
        "Dind": None,
        "Dbulk": None,
    }
    dmi_val = _magnet_dmi(problem, magnet.name)
    if dmi_val is not None:
        material["Dind"] = dmi_val
    bulk_dmi_val = _magnet_bulk_dmi(problem, magnet.name)
    if bulk_dmi_val is not None:
        material["Dbulk"] = bulk_dmi_val
    physics_stack: list[dict[str, object]] = [
        {"kind": "exchange", "enabled": _problem_has_exchange(problem), "params": None},
        {"kind": "demag", "enabled": _problem_has_demag(problem), "params": None},
    ]
    if dmi_val is not None:
        physics_stack.append(
            {
                "kind": "interfacial_dmi",
                "enabled": True,
                "params": {"dind": dmi_val},
            }
        )
    if bulk_dmi_val is not None:
        physics_stack.append(
            {
                "kind": "bulk_dmi",
                "enabled": True,
                "params": {"dbulk": bulk_dmi_val},
            }
        )
    if mat.Ku1 is not None or mat.anisU is not None:
        physics_stack.append(
            {
                "kind": "uniaxial_anisotropy",
                "enabled": True,
                "params": {
                    "ku1": mat.Ku1 if mat.Ku1 is not None else 0.0,
                    "axis": (
                        [float(mat.anisU[0]), float(mat.anisU[1]), float(mat.anisU[2])]
                        if mat.anisU is not None
                        else [0.0, 0.0, 1.0]
                    ),
                },
            }
        )

    # --- Magnetization ---
    magnetization: dict[str, object] = {
        "kind": "uniform",
        "value": [1, 0, 0],
        "seed": None,
        "source_path": None,
        "mapping": None,
        "texture_transform": None,
        "preset_kind": None,
        "preset_params": None,
        "preset_version": None,
        "ui_label": None,
    }
    if magnet.m0 is not None:
        if isinstance(magnet.m0, UniformMagnetization):
            magnetization = {"kind": "uniform", "value": list(magnet.m0.value), "seed": None, "source_path": None}
        elif isinstance(magnet.m0, RandomMagnetization):
            magnetization = {"kind": "random", "value": None, "seed": magnet.m0.seed, "source_path": None}
        elif isinstance(magnet.m0, SampledMagnetization):
            magnetization = {
                "kind": "sampled",
                "value": None,
                "seed": None,
                "source_path": magnet.m0.source_path,
                "source_format": magnet.m0.source_format,
                "dataset": magnet.m0.dataset,
                "sample_index": magnet.m0.sample_index,
            }
        elif isinstance(magnet.m0, PresetTexture):
            magnetization = {
                "kind": "preset_texture",
                "value": None,
                "seed": None,
                "source_path": None,
                "mapping": magnet.m0.mapping.to_ir(),
                "texture_transform": magnet.m0.transform.to_ir(),
                "preset_kind": magnet.m0.preset_kind,
                "preset_params": dict(magnet.m0.params),
                "preset_version": magnet.m0.preset_version,
                "ui_label": magnet.m0.ui_label,
            }

    # --- Per-geometry mesh ---
    per_mesh = _export_geometry_mesh_entry(magnet.name, problem)

    return {
        "name": magnet.name,
        "object_id": magnet.object_id,
        "region_name": magnet.region_name,
        "geometry_kind": geometry_kind,
        "geometry_params": geometry_params,
        "bounds_min": list(bounds_min) if bounds_min is not None else None,
        "bounds_max": list(bounds_max) if bounds_max is not None else None,
        "material": material,
        "magnetization": magnetization,
        "physics_stack": physics_stack,
        "mesh": per_mesh,
        "object_regions": [region.to_ir() for region in magnet.object_regions],
        "allocated_region_ids": list(magnet.allocated_region_ids),
        "material_parameter_fields": [
            assignment.to_ir() for assignment in magnet.material_parameter_fields
        ],
        "absorbing_boundary": magnet.absorbing_boundary.to_ir()
        if magnet.absorbing_boundary is not None
        else None,
    }


def _export_auxiliary_geometry_entry(
    geometry: object,
    problem: Problem,
    *,
    source_root: Path,
) -> dict[str, object]:
    geometry_kind, geometry_params = _export_geometry_kind_params(geometry)
    bounds_min, bounds_max = _geometry_bounds(geometry, source_root=source_root)
    name = str(getattr(geometry, "geometry_name", getattr(geometry, "name", "object")))
    visualization_hint = _normalize_mapping(
        _normalize_mapping(problem.runtime_metadata).get("visualization_hint")
    )
    geometry_hints = _normalize_mapping(visualization_hint.get("geometry_hints"))
    hint = _normalize_mapping(geometry_hints.get(name))
    return {
        "name": name,
        "role": str(
            problem.auxiliary_geometry_roles.get(name)
            or hint.get("role")
            or "geometry"
        ),
        "geometry_kind": geometry_kind,
        "geometry_params": geometry_params,
        "bounds_min": list(bounds_min) if bounds_min is not None else None,
        "bounds_max": list(bounds_max) if bounds_max is not None else None,
        "visualization_hint": hint,
    }


def _export_current_module_entry(module: object) -> dict[str, object]:
    if isinstance(module, CurrentTransport):
        return copy.deepcopy(module.to_ir())
    if not isinstance(module, AntennaFieldSource):
        raise ValueError(f"unsupported current module kind: {type(module).__name__}")
    if module.model == "prescribed_zeeman_mask":
        entry: dict[str, object] = {
            "kind": "antenna_field_source",
            "name": module.name,
            "model": module.model,
            "object": str(module.object),
            "B": float(module.B if module.B is not None else 0.0),
            "direction": list(module.direction),
            "spatial_profile": module.spatial_profile or {"kind": "uniform"},
        }
        if module.waveform is not None:
            entry["waveform"] = module.waveform.to_ir()
        return entry
    antenna = module.antenna
    antenna_kind = type(antenna).__name__
    if isinstance(antenna, MicrostripAntenna):
        antenna_params = {
            "width": antenna.width,
            "thickness": antenna.thickness,
            "height_above_magnet": antenna.height_above_magnet,
            "preview_length": antenna.preview_length,
            "center_x": antenna.center_x,
            "center_y": antenna.center_y,
        }
    elif isinstance(antenna, CPWAntenna):
        antenna_params = {
            "signal_width": antenna.signal_width,
            "gap": antenna.gap,
            "ground_width": antenna.ground_width,
            "thickness": antenna.thickness,
            "height_above_magnet": antenna.height_above_magnet,
            "preview_length": antenna.preview_length,
            "center_x": antenna.center_x,
            "center_y": antenna.center_y,
        }
    else:
        raise ValueError(f"unsupported antenna kind: {type(antenna).__name__}")

    drive = {
        "current_a": module.drive.current_a,
        "frequency_hz": module.drive.frequency_hz,
        "phase_rad": module.drive.phase_rad,
        "waveform": module.drive.waveform.to_ir() if module.drive.waveform is not None else None,
    }
    return {
        "kind": "antenna_field_source",
        "name": module.name,
        "solver": module.solver,
        "air_box_factor": module.air_box_factor,
        "antenna_kind": antenna_kind,
        "antenna_params": antenna_params,
        "drive": drive,
    }


def _export_excitation_analysis(problem: Problem) -> dict[str, object] | None:
    analysis = problem.excitation_analysis
    if analysis is None:
        return None
    return analysis.to_ir()


def _export_spin_transport_entry(
    problem: Problem,
    module: SpinDriftDiffusion,
) -> dict[str, object]:
    """Export a spin-transport solve with its source-owned coupling."""
    source = next(
        (
            candidate
            for candidate in problem.current_modules
            if isinstance(candidate, CurrentTransport)
            and candidate.name == module.current_source_id
        ),
        None,
    )
    coupling = source.coupling if isinstance(source, CurrentTransport) else None
    return copy.deepcopy(module.to_ir(coupling=coupling))


def _export_spin_torque_entry(module: object) -> dict[str, object]:
    """Export a spin-torque module as a JSON-serialisable builder draft entry."""
    if hasattr(module, "to_ir_module"):
        return module.to_ir_module()
    raise ValueError(f"unsupported spin torque module kind: {type(module).__name__}")


def _export_geometry_kind_params(geom: object) -> tuple[str, dict[str, object]]:
    """Extract kind string and parameter dict from a geometry object."""
    descriptor = _export_geometry_descriptor(geom, flatten_translation=True)
    return str(descriptor["geometry_kind"]), _normalize_mapping(descriptor["geometry_params"])


def _export_geometry_descriptor(
    geom: object,
    *,
    flatten_translation: bool,
) -> dict[str, object]:
    if isinstance(geom, ImportedGeometry):
        return {
            "geometry_kind": "ImportedGeometry",
            "geometry_params": {
                "source": geom.source,
                "scale": geom.scale,
                "volume": geom.volume,
                "name": geom.name,
            },
        }
    if isinstance(geom, Box):
        return {"geometry_kind": "Box", "geometry_params": {"size": list(geom.size)}}
    if isinstance(geom, Cylinder):
        params: dict[str, object] = {"radius": geom.radius, "height": geom.height}
        if geom.axis != (0.0, 0.0, 1.0):
            params["axis"] = list(geom.axis)
        return {
            "geometry_kind": "Cylinder",
            "geometry_params": params,
        }
    if isinstance(geom, Ellipsoid):
        return {
            "geometry_kind": "Ellipsoid",
            "geometry_params": {"rx": geom.rx, "ry": geom.ry, "rz": geom.rz},
        }
    if isinstance(geom, Ellipse):
        return {
            "geometry_kind": "Ellipse",
            "geometry_params": {"rx": geom.rx, "ry": geom.ry, "height": geom.height},
        }
    if isinstance(geom, ArchWaveguide):
        return {
            "geometry_kind": "ArchWaveguide",
            "geometry_params": {
                "length": geom.length,
                "width": geom.width,
                "height": geom.height,
                "arch_height": geom.arch_height,
                "z0": geom.z0,
            },
        }
    if isinstance(geom, SinWaveguide):
        return {
            "geometry_kind": "SinWaveguide",
            "geometry_params": {
                "length": geom.length,
                "width": geom.width,
                "height": geom.height,
                "period": geom.period,
                "amplitude": geom.amplitude,
                "phase": geom.phase,
                "z0": geom.z0,
            },
        }
    if isinstance(geom, Translate):
        if flatten_translation:
            base = _export_geometry_descriptor(geom.geometry, flatten_translation=True)
            return {
                "geometry_kind": str(base["geometry_kind"]),
                "geometry_params": {
                    **_normalize_mapping(base["geometry_params"]),
                    "translation": list(geom.offset),
                },
            }
        return {
            "geometry_kind": "Translate",
            "geometry_params": {
                "base": _export_geometry_descriptor(geom.geometry, flatten_translation=False),
                "translation": list(geom.offset),
            },
        }
    if isinstance(geom, Difference):
        return {
            "geometry_kind": "Difference",
            "geometry_params": {
                "base": _export_geometry_descriptor(geom.base, flatten_translation=False),
                "tool": _export_geometry_descriptor(geom.tool, flatten_translation=False),
            },
        }
    if isinstance(geom, Union):
        return {
            "geometry_kind": "Union",
            "geometry_params": {
                "a": _export_geometry_descriptor(geom.a, flatten_translation=False),
                "b": _export_geometry_descriptor(geom.b, flatten_translation=False),
            },
        }
    if isinstance(geom, Intersection):
        return {
            "geometry_kind": "Intersection",
            "geometry_params": {
                "a": _export_geometry_descriptor(geom.a, flatten_translation=False),
                "b": _export_geometry_descriptor(geom.b, flatten_translation=False),
            },
        }
    return {"geometry_kind": type(geom).__name__, "geometry_params": {}}


def _geometry_bounds(
    geom: object,
    *,
    source_root: Path | None = None,
) -> tuple[tuple[float, float, float] | None, tuple[float, float, float] | None]:
    return shared_geometry_bounds(geom, source_root=source_root)


def _combine_bounds_union(
    left: tuple[tuple[float, float, float] | None, tuple[float, float, float] | None],
    right: tuple[tuple[float, float, float] | None, tuple[float, float, float] | None],
) -> tuple[tuple[float, float, float] | None, tuple[float, float, float] | None]:
    left_min, left_max = left
    right_min, right_max = right
    if left_min is None or left_max is None:
        return right
    if right_min is None or right_max is None:
        return left
    return (
        tuple(min(left_min[i], right_min[i]) for i in range(3)),
        tuple(max(left_max[i], right_max[i]) for i in range(3)),
    )


def _normalize_bounds_pair(
    bounds_min: tuple[float, float, float],
    bounds_max: tuple[float, float, float],
) -> tuple[tuple[float, float, float] | None, tuple[float, float, float] | None]:
    normalized_min = tuple(min(bounds_min[i], bounds_max[i]) for i in range(3))
    normalized_max = tuple(max(bounds_min[i], bounds_max[i]) for i in range(3))
    if any(normalized_max[i] - normalized_min[i] <= 0 for i in range(3)):
        return None, None
    return normalized_min, normalized_max


def _study_outputs(
    study: TimeEvolution | Relaxation | Eigenmodes | FrequencyResponse,
) -> Sequence[object]:
    return tuple(study.outputs)


def _study_table_autosave(
    study: TimeEvolution | Relaxation | Eigenmodes | FrequencyResponse,
) -> TableAutosave | None:
    table_autosave = getattr(study, "_table_autosave", None)
    return table_autosave if isinstance(table_autosave, TableAutosave) else None


def _export_table_autosave(problem: Problem) -> dict[str, object] | None:
    if problem.study is None:
        return None
    table_autosave = _study_table_autosave(problem.study)
    return table_autosave.to_ir() if table_autosave is not None else None


def _magnet_dmi(problem: Problem, magnet_name: str) -> float | None:
    del magnet_name
    for term in problem.energy:
        if isinstance(term, InterfacialDMI):
            return term.D
    return None


def _magnet_bulk_dmi(problem: Problem, magnet_name: str) -> float | None:
    del magnet_name
    for term in problem.energy:
        if isinstance(term, BulkDMI):
            return term.D
    return None


def _snapshot_quantity_string(snapshot: Snapshot) -> str:
    if snapshot.component == "3D":
        return snapshot.field
    if snapshot.field == "m":
        return f"m{snapshot.component}"
    return f"{snapshot.field}_{snapshot.component}"


def _runtime_device_spec(runtime) -> str:
    device = runtime.device_target.value
    if device == "cpu":
        return "cpu"
    if device in {"cuda", "gpu"}:
        index = runtime.device_index if runtime.device_index is not None else 0
        return f"cuda:{index}"
    return device


def _magnet_variable_names(
    problem: Problem,
    overrides: dict[str, object] | None = None,
) -> dict[str, str]:
    geometries_override = (overrides or {}).get("geometries")
    if isinstance(geometries_override, list):
        if len(geometries_override) == 1:
            name = _normalize_mapping(geometries_override[0]).get("name")
            return {str(name): "body"} if name else {}
        return {
            str(_normalize_mapping(g).get("name")): f"body_{i}"
            for i, g in enumerate(geometries_override, 1)
        }

    used: set[str] = set()
    mapping: dict[str, str] = {}
    for magnet in problem.magnets:
        base = re.sub(r"[^a-zA-Z0-9_]+", "_", magnet.name).strip("_").lower() or "body"
        if base[0].isdigit():
            base = f"m_{base}"
        candidate = base
        suffix = 2
        while candidate in used:
            candidate = f"{base}_{suffix}"
            suffix += 1
        used.add(candidate)
        mapping[magnet.name] = candidate
    return mapping


def _safe_identifier(value: str) -> str:
    candidate = re.sub(r"[^a-zA-Z0-9_]+", "_", value).strip("_").lower()
    if not candidate:
        candidate = "region"
    if candidate[0].isdigit():
        candidate = f"r_{candidate}"
    return candidate


def _script_api_surface(
    problem: Problem,
    *,
    overrides: dict[str, object] | None = None,
) -> str:
    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    surface = runtime_metadata.get("script_api_surface")
    couplings_override = (overrides or {}).get("couplings")
    monitors_override = (overrides or {}).get("planar_monitors")
    if problem.couplings or (
        isinstance(couplings_override, list) and len(couplings_override) > 0
    ) or problem.monitors or (
        isinstance(monitors_override, list) and len(monitors_override) > 0
    ):
        return "study"
    return "study" if surface == "study" else "flat"


def _render_study_binding(problem: Problem) -> list[str]:
    if problem.name != "fullmag_sim":
        return [f"study = fm.study({_py_repr(problem.name)})"]
    return ["study = fm.study()"]


def _surface_call(surface: str, name: str) -> str:
    root = "study" if surface == "study" else "fm"
    return f"{root}.{name}"


def _problem_demag_realization(problem: Problem) -> str | None:
    for term in problem.energy:
        if isinstance(term, Demag):
            return term.realization
    authored = _normalize_mapping(problem.runtime_metadata).get(
        "authored_demag_realization"
    )
    return str(authored) if isinstance(authored, str) and authored.strip() else None


def _problem_has_exchange(problem: Problem) -> bool:
    return any(isinstance(term, Exchange) for term in problem.energy)


def _problem_has_demag(problem: Problem) -> bool:
    return any(isinstance(term, Demag) for term in problem.energy)


def _problem_external_field(problem: Problem) -> list[float] | None:
    for term in problem.energy:
        if isinstance(term, Zeeman):
            return [float(term.B[0]), float(term.B[1]), float(term.B[2])]
    return None


def _override_external_field(value: object) -> tuple[float, float, float] | None:
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return (float(value[0]), float(value[1]), float(value[2]))
        except (TypeError, ValueError):
            return None
    return None


def _override_bool(value: object, fallback: bool) -> bool:
    return value if isinstance(value, bool) else fallback


def _export_demag_realization(problem: Problem) -> str | None:
    realization = _problem_demag_realization(problem)
    return str(realization) if isinstance(realization, str) and realization.strip() else None


def _export_fdm(problem: Problem) -> dict[str, object] | None:
    fdm = problem.discretization.fdm if problem.discretization is not None else None
    if not isinstance(fdm, FDM):
        return None
    payload: dict[str, object] = {
        "default_cell": list(fdm.default_cell) if fdm.default_cell is not None else None,
        "per_magnet": (
            {
                name: {"cell": list(grid.cell)}
                for name, grid in sorted((fdm.per_magnet or {}).items())
            }
            if fdm.per_magnet
            else None
        ),
        "boundary_correction": fdm.boundary_correction,
        "boundary_phi_floor": fdm.boundary_phi_floor,
        "boundary_delta_min": fdm.boundary_delta_min,
        "projection_policy": fdm.projection_policy,
    }
    if fdm.demag is not None:
        payload["demag"] = {
            "strategy": fdm.demag.strategy,
            "mode": fdm.demag.mode,
            "fft_backend": fdm.demag.fft_backend,
            "common_cells": list(fdm.demag.common_cells)
            if fdm.demag.common_cells is not None
            else None,
            "common_cells_xy": list(fdm.demag.common_cells_xy)
            if fdm.demag.common_cells_xy is not None
            else None,
            "common_cell_size": list(fdm.demag.common_cell_size)
            if fdm.demag.common_cell_size is not None
            else None,
            "explain": fdm.demag.explain,
        }
    else:
        payload["demag"] = None
    return payload


def _render_exchange(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    enabled = _override_bool(overrides.get("exchange_enabled"), _problem_has_exchange(problem))
    if enabled:
        return []
    return [
        "# Effective-field terms",
        f"{_surface_call(surface, 'disable_exchange')}()",
    ]


def _render_demag(
    problem: Problem,
    *,
    overrides: dict[str, object],
    surface: str,
) -> list[str]:
    enabled = _override_bool(overrides.get("demag_enabled"), _problem_has_demag(problem))
    realization = overrides.get("demag_realization", _problem_demag_realization(problem))
    explicit_realization = isinstance(realization, str) and realization.strip() not in {
        "",
        "auto",
    }
    if enabled and not explicit_realization:
        return []
    lines = ["# Outer boundary / demag"]
    if explicit_realization:
        lines.append(
            f"{_surface_call(surface, 'demag')}(realization={_py_repr(realization)})"
        )
    if not enabled:
        lines.append(f"{_surface_call(surface, 'disable_demag')}()")
    return lines


def _render_thermal_noise(problem: Problem, *, surface: str) -> list[str]:
    thermal_terms = [term for term in problem.energy if isinstance(term, ThermalNoise)]
    if not thermal_terms:
        return []
    if len(thermal_terms) != 1:
        raise ValueError("canonical flat-script rewrite requires at most one ThermalNoise term")
    term = thermal_terms[0]
    args = [f"temperature={_py_number(term.temperature)}"]
    if term.seed is not None:
        args.append(f"seed={term.seed}")
    return ["# Brown thermal noise", f"{_surface_call(surface, 'thermal_noise')}({', '.join(args)})"]


def _resolve_universe(
    problem: Problem,
    *,
    overrides: dict[str, object],
) -> dict[str, object] | None:
    override_universe = _normalize_mapping(overrides.get("universe"))
    if override_universe:
        return override_universe
    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    domain_frame = _normalize_mapping(runtime_metadata.get("domain_frame"))
    universe = _normalize_mapping(domain_frame.get("declared_universe"))
    if not universe:
        universe = _normalize_mapping(runtime_metadata.get("study_universe"))
    return universe or None


def _export_universe(problem: Problem) -> dict[str, object] | None:
    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    domain_frame = _normalize_mapping(runtime_metadata.get("domain_frame"))
    universe = _normalize_mapping(domain_frame.get("declared_universe"))
    if not universe:
        universe = _normalize_mapping(runtime_metadata.get("study_universe"))
    if not universe:
        return None
    mode = universe.get("mode")
    size = _optional_vec3(universe.get("size"))
    center = _optional_vec3(universe.get("center"))
    padding = _optional_vec3(universe.get("padding"))
    airbox_hmax = universe.get("airbox_hmax")
    airbox_hmin = universe.get("airbox_hmin")
    airbox_growth_rate = universe.get("airbox_growth_rate")
    airbox_grading = universe.get("airbox_grading")
    return {
        "mode": str(mode) if isinstance(mode, str) else "auto",
        "size": list(size) if size is not None else None,
        "center": list(center) if center is not None else None,
        "padding": list(padding) if padding is not None else None,
        "airbox_hmax": float(airbox_hmax) if airbox_hmax is not None else None,
        "airbox_hmin": float(airbox_hmin) if airbox_hmin is not None else None,
        "maximum_element_size": float(airbox_hmax) if airbox_hmax is not None else None,
        "minimum_element_size": float(airbox_hmin) if airbox_hmin is not None else None,
        "airbox_growth_rate": (
            float(airbox_growth_rate) if airbox_growth_rate is not None else None
        ),
        "airbox_grading": str(airbox_grading) if isinstance(airbox_grading, str) else None,
    }


def _export_domain_frame(
    problem: Problem,
    *,
    source_root: Path | None,
) -> dict[str, object] | None:
    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    domain_frame = _normalize_mapping(runtime_metadata.get("domain_frame"))
    if domain_frame:
        return domain_frame
    universe = _normalize_mapping(runtime_metadata.get("study_universe"))
    return build_domain_frame(
        geometries=[magnet.geometry for magnet in problem.magnets],
        source_root=source_root,
        study_universe=universe or None,
    )


def _optional_vec3(value: object) -> tuple[float, float, float] | None:
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return (float(value[0]), float(value[1]), float(value[2]))
        except (TypeError, ValueError):
            return None
    return None


def _normalize_vec3(
    value: object,
    *,
    fallback: tuple[float, float, float],
) -> tuple[float, float, float]:
    parsed = _optional_vec3(value)
    return parsed if parsed is not None else fallback


def _py_tuple3(value: tuple[float, float, float]) -> str:
    return f"({_py_number(value[0])}, {_py_number(value[1])}, {_py_number(value[2])})"


def _normalize_mapping(value: object) -> dict[str, object]:
    return dict(value) if isinstance(value, dict) else {}


def _requested_sampling_period_from_ir(
    value: Mapping[str, object],
    numeric_key: str,
) -> SamplingPeriod | None:
    kind = value.get("kind")
    resolved_auto_kind = kind in {"field_resolved_auto", "scalar_resolved_auto"}
    requested_policy = value.get("requested_policy")
    if resolved_auto_kind:
        if requested_policy is None:
            raise ValueError("resolved automatic sampling output requires requested_policy")
        _validate_auto_sinc_sampling_policy_ir(requested_policy)
        if numeric_key not in value:
            raise ValueError("resolved automatic sampling output requires a resolved cadence")
        normalize_sampling_period(value[numeric_key], numeric_key)
        return "auto"
    if requested_policy is not None:
        raise ValueError("requested_policy is only valid for resolved automatic outputs")

    policy_value = value.get("sample_period_policy")
    if policy_value is not None:
        _validate_auto_sinc_sampling_policy_ir(policy_value)
        if value.get(numeric_key) is not None:
            raise ValueError("automatic sampling intent must not contain an explicit cadence")
        return "auto"

    if numeric_key not in value:
        return None
    return normalize_sampling_period(value[numeric_key], numeric_key)


def _validate_auto_sinc_sampling_policy_ir(value: object) -> None:
    policy = _normalize_mapping(value)
    guard = policy.get("nyquist_guard_factor")
    if (
        policy.get("kind") != "auto_sinc_cutoff"
        or isinstance(guard, bool)
        or not isinstance(guard, (int, float))
        or float(guard) != AUTO_SINC_NYQUIST_GUARD_FACTOR
    ):
        raise ValueError("unsupported automatic sampling period policy")


def _override_string(overrides: dict[str, object], key: str, fallback: str | None) -> str | None:
    value = overrides.get(key, fallback)
    if value is None:
        return fallback
    if isinstance(value, str) and value.strip():
        return value.strip()
    return fallback


def _override_number(overrides: dict[str, object], key: str, fallback: float | None) -> float | None:
    if key not in overrides:
        return fallback
    value = overrides.get(key)
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return fallback
    return fallback


def _override_int(overrides: dict[str, object], key: str, fallback: int | None) -> int | None:
    if key not in overrides:
        return fallback
    value = overrides.get(key)
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return int(float(stripped))
        except ValueError:
            return fallback
    return fallback


def _number_or_none(value: object) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return float(stripped)
        except ValueError:
            return None
    return None


def _text_number(value: float | None) -> str:
    return "" if value is None else _py_number(value)


def _text_transition_distance(value: object) -> str:
    numeric = _number_or_none(value)
    if numeric is not None:
        return _py_number(numeric)
    if isinstance(value, str):
        return value.strip()
    return ""


def _text_value(value: object) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text


def _render_stage_k_path_expr(value: str | None) -> str | None:
    if value is None:
        return None
    raw = value.strip()
    if not raw:
        return None
    point_part, _, option_part = raw.partition("|")
    points: list[tuple[str, tuple[float, float, float]]] = []
    for item in point_part.split(";"):
        entry = item.strip()
        if not entry:
            continue
        label, sep, vector_text = entry.partition(":")
        if not sep:
            label = f"k{len(points)}"
            vector_text = entry
        components = [part.strip() for part in vector_text.split(",")]
        if len(components) != 3:
            return None
        try:
            vector = tuple(float(component) for component in components)
        except ValueError:
            return None
        points.append((label.strip() or f"k{len(points)}", vector))  # type: ignore[arg-type]
    if len(points) < 2:
        return None

    samples: list[int] = []
    closed = False
    for option in option_part.split(";"):
        key, sep, option_value = option.strip().partition("=")
        option_key = key.strip().lower()
        if sep and option_key in {"samples", "samples_per_segment"}:
            try:
                samples = [max(1, int(part.strip())) for part in option_value.split(",") if part.strip()]
            except ValueError:
                return None
        elif sep and option_key == "closed":
            closed_value = option_value.strip().lower()
            if closed_value in {"1", "true", "yes"}:
                closed = True
            elif closed_value not in {"0", "false", "no"}:
                return None
    segment_count = len(points) if closed else len(points) - 1
    if not samples:
        samples = [41] * segment_count
    elif len(samples) == 1 and segment_count > 1:
        samples = samples * segment_count
    elif len(samples) != segment_count:
        return None

    rendered_points = ", ".join(
        f"fm.KPoint({_py_repr(label)}, {_py_tuple3(vector)})"
        for label, vector in points
    )
    return (
        f"fm.KPath(points=[{rendered_points}], "
        f"samples_per_segment={samples!r}"
        f"{', closed=True' if closed else ''})"
    )


def _text_k_path(value: object | None) -> str:
    if value is None:
        return ""
    try:
        payload = serialize_k_sampling(value)
    except ValueError:
        return ""
    if payload is None or payload.get("kind") != "path":
        return ""
    points = payload.get("points")
    samples = payload.get("samples_per_segment")
    if not isinstance(points, list) or not isinstance(samples, list):
        return ""
    rendered_points: list[str] = []
    for point in points:
        if not isinstance(point, dict):
            return ""
        k_vector = point.get("k_vector")
        if not isinstance(k_vector, list) or len(k_vector) != 3:
            return ""
        label = str(point.get("label") or "")
        rendered_points.append(
            f"{label}:{','.join(_py_number(float(component)) for component in k_vector)}"
        )
    rendered_samples = ",".join(str(int(sample)) for sample in samples)
    options = [f"samples={rendered_samples}"]
    if payload.get("closed") is True:
        options.append("closed=true")
    return f"{'; '.join(rendered_points)} | {'; '.join(options)}"


def _render_k_sampling_expr(value: object | None) -> str | None:
    if value is None:
        return None
    try:
        payload = serialize_k_sampling(value)
    except ValueError:
        return None
    if payload is None:
        return None
    if payload.get("kind") == "single":
        k_vector = payload.get("k_vector")
        if not isinstance(k_vector, list) or len(k_vector) != 3:
            return None
        return _py_tuple3(k_vector)
    if payload.get("kind") == "path":
        points = payload.get("points")
        samples = payload.get("samples_per_segment")
        if not isinstance(points, list) or not isinstance(samples, list):
            return None
        rendered_points: list[str] = []
        for point in points:
            if not isinstance(point, dict):
                return None
            k_vector = point.get("k_vector")
            if not isinstance(k_vector, list) or len(k_vector) != 3:
                return None
            rendered_points.append(
                f"fm.KPoint({_py_literal(point.get('label'))}, {_py_tuple3(k_vector)})"
            )
        args = [
            f"points=[{', '.join(rendered_points)}]",
            f"samples_per_segment={samples!r}",
        ]
        if payload.get("closed") is True:
            args.append("closed=True")
        return f"fm.KPath({', '.join(args)})"
    return None


def _text_mesh_size(value: object) -> str:
    rendered = _render_mesh_size_literal(value)
    if rendered is None:
        return ""
    if rendered.startswith('"') and rendered.endswith('"'):
        return rendered[1:-1]
    return rendered


def _py_transition_distance_literal(value: object) -> str | None:
    numeric = _number_or_none(value)
    if numeric is not None:
        return _py_number(numeric)
    if isinstance(value, str) and value.strip():
        return _py_repr(value.strip())
    return None


def _py_repr(value: str) -> str:
    return json.dumps(value)


def _py_number(value: float) -> str:
    return format(float(value), ".12g")


def _py_bias_field_sweep_samples_literal(samples: Sequence[Sequence[float]]) -> str:
    return "[" + ", ".join(
        "(" + ", ".join(repr(float(component)) for component in sample) + ")"
        for sample in samples
    ) + "]"


def _py_sampling_period(value: SamplingPeriod) -> str:
    return _py_repr("auto") if value == "auto" else _py_number(value)


def _py_literal(value: object) -> str:
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return _py_number(float(value))
    if isinstance(value, str):
        return _py_repr(value)
    if isinstance(value, tuple):
        return "(" + ", ".join(_py_literal(item) for item in value) + ")"
    if isinstance(value, list):
        return "[" + ", ".join(_py_literal(item) for item in value) + "]"
    if isinstance(value, dict):
        items = ", ".join(f"{_py_repr(str(key))}: {_py_literal(item)}" for key, item in sorted(value.items()))
        return "{" + items + "}"
    if value is None:
        return "None"
    raise ValueError(f"unsupported literal for canonical rewrite: {type(value).__name__}")


def _spin_wave_bc_payload(value: object) -> str | dict[str, object]:
    if hasattr(value, "to_ir"):
        value = value.to_ir()
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return dict(value)
    raise ValueError(f"unsupported spin-wave boundary condition: {type(value).__name__}")


def _spin_wave_bc_kind(value: object) -> str:
    payload = _spin_wave_bc_payload(value)
    if isinstance(payload, str):
        return payload
    return str(payload.get("kind", ""))


def _spin_wave_bc_config(value: object) -> dict[str, object] | None:
    payload = _spin_wave_bc_payload(value)
    if isinstance(payload, dict):
        return payload
    return None


def _render_spin_wave_bc_expr(value: object) -> str:
    payload = _spin_wave_bc_payload(value)
    if isinstance(payload, str):
        return _py_repr(payload)
    pair_ids = payload.get("pair_ids")
    if payload.get("kind") == "periodic" and isinstance(pair_ids, list):
        return f"fm.PeriodicBC({_py_literal(pair_ids)})"
    if payload.get("kind") == "floquet" and isinstance(pair_ids, list):
        args = [_py_literal(pair_ids)]
        phase_convention = payload.get("phase_convention")
        if phase_convention not in {None, "exp_minus_i_k_dot_delta_r"}:
            args.append(f"phase_convention={_py_repr(str(phase_convention))}")
        return f"fm.FloquetBC({', '.join(args)})"
    return _py_literal(payload)


_DEFAULT_TEXTURE_MAPPING = {
    "space": "object",
    "projection": "object_local",
    "clamp_mode": "none",
}

_DEFAULT_TEXTURE_TRANSFORM = {
    "translation": [0.0, 0.0, 0.0],
    "rotation_quat": [0.0, 0.0, 0.0, 1.0],
    "scale": [1.0, 1.0, 1.0],
    "pivot": [0.0, 0.0, 0.0],
}

_DEFAULT_TEXTURE_PREVIEW_PROXY = {
    "uniform": "none",
    "random": "none",
    "random_seeded": "none",
    "vortex": "disc",
    "antivortex": "disc",
    "bloch_skyrmion": "disc",
    "neel_skyrmion": "disc",
    "bimeron": "disc",
    "domain_wall": "box",
    "two_domain": "box",
    "helical": "box",
    "conical": "box",
}


def _render_vector_literal(values: Sequence[object]) -> str:
    return f"({', '.join(_py_number(float(value)) for value in values)})"


def _render_texture_factory_call(
    preset_kind: str,
    params: Mapping[str, object],
) -> str | None:
    if preset_kind == "uniform":
        direction = params.get("direction")
        if isinstance(direction, list) and len(direction) == 3:
            return f"fm.texture.uniform{_render_vector_literal(direction)}"
        return "fm.texture.uniform((1.0, 0.0, 0.0))"
    if preset_kind in {"random", "random_seeded"}:
        seed = params.get("seed")
        return f"fm.texture.random(seed={int(str(seed)) if seed is not None else 1})"
    if preset_kind in {"vortex", "antivortex"}:
        kwargs = [
            f"circulation={int(str(params.get('circulation', 1)))}",
            f"core_polarity={int(str(params.get('core_polarity', 1)))}",
        ]
        if params.get("core_radius") is not None:
            kwargs.append(f"core_radius={_py_number(float(params['core_radius']))}")
        if params.get("plane") not in {None, "xy"}:
            kwargs.append(f"plane={_py_repr(str(params['plane']))}")
        return f"fm.texture.{preset_kind}({', '.join(kwargs)})"
    if preset_kind in {"bloch_skyrmion", "neel_skyrmion"}:
        radius = params.get("radius")
        wall_width = params.get("wall_width")
        if radius is None or wall_width is None:
            return None
        kwargs = [
            f"radius={_py_number(float(radius))}",
            f"wall_width={_py_number(float(wall_width))}",
            f"chirality={int(str(params.get('chirality', 1)))}",
            f"core_polarity={int(str(params.get('core_polarity', -1)))}",
        ]
        if params.get("plane") not in {None, "xy"}:
            kwargs.append(f"plane={_py_repr(str(params['plane']))}")
        return f"fm.texture.{preset_kind}({', '.join(kwargs)})"
    if preset_kind == "bimeron":
        radius = params.get("radius")
        wall_width = params.get("wall_width")
        if radius is None or wall_width is None:
            return None
        kwargs = [
            f"radius={_py_number(float(radius))}",
            f"wall_width={_py_number(float(wall_width))}",
            f"vorticity={int(str(params.get('vorticity', 1)))}",
            f"helicity_rad={_py_number(float(params.get('helicity_rad', 0.0)))}",
            f"background_sign={int(str(params.get('background_sign', 1)))}",
        ]
        if params.get("plane") not in {None, "xy"}:
            kwargs.append(f"plane={_py_repr(str(params['plane']))}")
        return f"fm.texture.bimeron({', '.join(kwargs)})"
    if preset_kind == "domain_wall":
        width = params.get("width")
        if width is None:
            return None
        kwargs = [
            f"width={_py_number(float(width))}",
            f"kind={_py_repr(str(params.get('kind', 'neel')))}",
            f"center_offset={_py_number(float(params.get('center_offset', 0.0)))}",
            f"normal_axis={_py_repr(str(params.get('normal_axis', 'x')))}",
        ]
        left = params.get("left")
        right = params.get("right")
        if isinstance(left, list) and len(left) == 3:
            kwargs.append(f"left={_render_vector_literal(left)}")
        if isinstance(right, list) and len(right) == 3:
            kwargs.append(f"right={_render_vector_literal(right)}")
        wall_direction = params.get("wall_center_direction")
        if isinstance(wall_direction, list) and len(wall_direction) == 3:
            kwargs.append(f"wall_center_direction={_render_vector_literal(wall_direction)}")
        return f"fm.texture.domain_wall({', '.join(kwargs)})"
    if preset_kind == "two_domain":
        left = params.get("left")
        right = params.get("right")
        wall = params.get("wall")
        if not (
            isinstance(left, list) and len(left) == 3
            and isinstance(right, list) and len(right) == 3
            and isinstance(wall, list) and len(wall) == 3
        ):
            return None
        kwargs = [
            f"left={_render_vector_literal(left)}",
            f"right={_render_vector_literal(right)}",
            f"wall={_render_vector_literal(wall)}",
            f"normal_axis={_py_repr(str(params.get('normal_axis', 'x')))}",
        ]
        sharp = params.get("sharp")
        wall_width = params.get("wall_width")
        if sharp is not None:
            kwargs.append(f"sharp={_py_literal(sharp)}")
        elif wall_width is not None:
            kwargs.append("sharp=False")
        if wall_width is not None:
            kwargs.append(f"wall_width={_py_number(float(wall_width))}")
        return f"fm.texture.two_domain({', '.join(kwargs)})"
    if preset_kind == "helical":
        wavevector = params.get("wavevector")
        if not (isinstance(wavevector, list) and len(wavevector) == 3):
            return None
        kwargs = [f"wavevector={_render_vector_literal(wavevector)}"]
        for key, default in (("e1", [1.0, 0.0, 0.0]), ("e2", [0.0, 1.0, 0.0])):
            value = params.get(key)
            if isinstance(value, list) and len(value) == 3 and value != default:
                kwargs.append(f"{key}={_render_vector_literal(value)}")
        if params.get("phase_rad") not in {None, 0.0}:
            kwargs.append(f"phase_rad={_py_number(float(params['phase_rad']))}")
        return f"fm.texture.helical({', '.join(kwargs)})"
    if preset_kind == "conical":
        wavevector = params.get("wavevector")
        if not (isinstance(wavevector, list) and len(wavevector) == 3):
            return None
        kwargs = [f"wavevector={_render_vector_literal(wavevector)}"]
        cone_axis = params.get("cone_axis")
        if isinstance(cone_axis, list) and len(cone_axis) == 3 and cone_axis != [0.0, 0.0, 1.0]:
            kwargs.append(f"cone_axis={_render_vector_literal(cone_axis)}")
        if params.get("cone_angle_rad") not in {None, 0.7853981633974483}:
            kwargs.append(f"cone_angle_rad={_py_number(float(params['cone_angle_rad']))}")
        if params.get("phase_rad") not in {None, 0.0}:
            kwargs.append(f"phase_rad={_py_number(float(params['phase_rad']))}")
        return f"fm.texture.conical({', '.join(kwargs)})"
    return None


def _render_preset_texture_expr(
    preset_kind: str,
    params: Mapping[str, object],
    *,
    mapping: Mapping[str, object] | None = None,
    transform: Mapping[str, object] | None = None,
    preset_version: int = 2,
    ui_label: str | None = None,
    preview_proxy: str | None = None,
) -> str:
    normalized_mapping = dict(mapping or _DEFAULT_TEXTURE_MAPPING)
    normalized_transform = dict(transform or _DEFAULT_TEXTURE_TRANSFORM)
    factory_expr = _render_texture_factory_call(preset_kind, params)
    if (
        factory_expr is not None
        and normalized_mapping == _DEFAULT_TEXTURE_MAPPING
        and preset_version == 2
        and normalized_transform == _DEFAULT_TEXTURE_TRANSFORM
        and ui_label is None
        and preview_proxy in {None, _DEFAULT_TEXTURE_PREVIEW_PROXY.get(preset_kind)}
    ):
        return factory_expr

    mapping_expr = (
        "fm.TextureMapping("
        f"space={_py_repr(str(normalized_mapping.get('space', 'object')))}, "
        f"projection={_py_repr(str(normalized_mapping.get('projection', 'object_local')))}, "
        f"clamp_mode={_py_repr(str(normalized_mapping.get('clamp_mode', 'none')))})"
    )
    transform_expr = (
        "fm.TextureTransform3D("
        f"translation={_py_literal(tuple(normalized_transform.get('translation', (0.0, 0.0, 0.0))))}, "
        f"rotation_quat={_py_literal(tuple(normalized_transform.get('rotation_quat', (0.0, 0.0, 0.0, 1.0))))}, "
        f"scale={_py_literal(tuple(normalized_transform.get('scale', (1.0, 1.0, 1.0))))}, "
        f"pivot={_py_literal(tuple(normalized_transform.get('pivot', (0.0, 0.0, 0.0))))})"
    )
    return (
        "fm.PresetTexture("
        f"preset_version={preset_version}, "
        f"preset_kind={_py_repr(preset_kind)}, "
        f"params={_py_literal(dict(params))}, "
        f"mapping={mapping_expr}, "
        f"transform={transform_expr}, "
        f"ui_label={_py_repr(ui_label) if ui_label is not None else 'None'}, "
        f"preview_proxy={_py_repr(preview_proxy) if preview_proxy is not None else 'None'})"
    )


def _validate_stage_compatibility(stages: Sequence[LoadedStage]) -> None:
    solver_stages = [stage for stage in stages if stage.action is None]
    if len(solver_stages) <= 1:
        return
    baseline = _stage_signature(solver_stages[0].problem)
    for stage in solver_stages[1:]:
        signature = _stage_signature(stage.problem)
        if signature != baseline:
            raise ValueError(
                "canonical rewrite does not yet support stage-local geometry or material mutations"
            )


def _stage_signature(problem: Problem) -> dict[str, object]:
    runtime_metadata = _normalize_mapping(problem.runtime_metadata)
    return {
        "name": problem.name,
        "runtime": problem.runtime.to_runtime_metadata(),
        "geometries": [
            *[_geometry_signature(magnet.geometry) for magnet in problem.magnets],
            *[_geometry_signature(geometry) for geometry in problem.auxiliary_geometries],
        ],
        "auxiliary_geometry_roles": dict(problem.auxiliary_geometry_roles),
        "materials": [_material_signature(magnet) for magnet in problem.magnets],
        "magnets": [
            {
                "name": magnet.name,
                "geometry": magnet.geometry.geometry_name,
                "initial_magnetization": magnet.m0.to_ir() if magnet.m0 is not None else None,
            }
            for magnet in problem.magnets
        ],
        "energy_terms": [term.to_ir() for term in problem.energy],
        "current_modules": _stage_current_module_signatures(problem),
        "spin_torque_modules": [module.to_ir_module() for module in problem.spin_torques],
        "excitation_analysis": problem.excitation_analysis.to_ir()
        if problem.excitation_analysis is not None
        else None,
        "discretization": problem.discretization.to_ir() if problem.discretization else None,
        "mesh_workflow": runtime_metadata.get("mesh_workflow"),
        "interactive": runtime_metadata.get("interactive_session_requested"),
        "wait_for_solve": runtime_metadata.get("wait_for_solve"),
        "domain_frame": runtime_metadata.get("domain_frame"),
        "study_universe": runtime_metadata.get("study_universe"),
    }


def _stage_current_module_signatures(problem: Problem) -> list[dict[str, object]]:
    """Compare transport structure while ignoring declared stage drive values.

    ``study.stages.set_transport_current`` is an explicit workflow action.  Its
    boundary values therefore belong to the stage action stream, not to the
    immutable geometry/material signature used by canonical script rewriting.
    """
    signatures: list[dict[str, object]] = []
    for module in problem.current_modules:
        payload = copy.deepcopy(module.to_ir())
        if payload.get("model") in {"ohmic_poisson", "magnetoresistive_poisson"}:
            boundaries = payload.get("boundaries")
            if isinstance(boundaries, list):
                for boundary in boundaries:
                    if isinstance(boundary, dict) and "outward_current_density_Apm2" in boundary:
                        boundary["outward_current_density_Apm2"] = "<stage-current>"
        signatures.append(payload)
    return signatures


def _geometry_signature(geometry: object) -> dict[str, object]:
    if hasattr(geometry, "to_ir"):
        return geometry.to_ir()
    raise ValueError(f"unsupported geometry signature kind: {type(geometry).__name__}")


def _material_signature(magnet) -> dict[str, object]:
    material = dict(magnet.material.to_ir())
    # Flat relax stages temporarily rewrite damping to the relaxation alpha, but
    # the canonical script still expresses that as fm.relax(...), not as a
    # stage-local material mutation. Ignore alpha here so ordinary relax->run
    # sequences remain rewriteable.
    material.pop("damping", None)
    return material


def _relativize_path(path_value: str, source_root: Path) -> str:
    path = Path(path_value)
    if not path.is_absolute():
        return path_value
    try:
        return str(path.relative_to(source_root))
    except ValueError:
        return path_value


def _validate_energy_terms(problem: Problem) -> None:
    exchange_count = 0
    demag_count = 0
    zeeman_count = 0
    dmi_count = 0
    for term in problem.energy:
        if isinstance(term, Exchange):
            exchange_count += 1
            continue
        if isinstance(term, Zeeman):
            zeeman_count += 1
            continue
        if isinstance(term, InterfacialDMI):
            dmi_count += 1
            continue
        if isinstance(term, Demag):
            demag_count += 1
            if term.realization not in {
                None,
                "auto",
                "poisson_dirichlet",
                "poisson_robin",
                # Legacy aliases still accepted by Demag class:
                "poisson_airbox",
                "airbox_dirichlet",
                "airbox_robin",
            }:
                raise ValueError(
                    "canonical flat-script rewrite does not yet support explicit demag realizations"
                )
            continue
        if isinstance(term, (BulkDMI, OerstedCylinder, OerstedField, Magnetoelastic, UniaxialAnisotropy, CubicAnisotropy, ThermalNoise)):
            continue
        raise ValueError(
            f"canonical flat-script rewrite does not yet support energy term {type(term).__name__}"
        )
    if exchange_count > 1 or demag_count > 1:
        raise ValueError(
            "canonical flat-script rewrite currently supports at most one exchange term and one demag term"
        )
    if zeeman_count > 1 or dmi_count > 1:
        raise ValueError(
            "canonical flat-script rewrite does not yet support multiple Zeeman or DMI terms"
        )


def _builder_source_kind(entrypoint_kind: str) -> str:
    if entrypoint_kind.startswith("flat_"):
        return "flat_script"
    if entrypoint_kind == "build":
        return "build_function"
    if entrypoint_kind == "problem":
        return "problem_object"
    if entrypoint_kind.startswith("interactive_"):
        return "interactive_command"
    return "problem_model"
