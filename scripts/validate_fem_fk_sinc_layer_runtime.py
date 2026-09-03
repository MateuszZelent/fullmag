#!/usr/bin/env python3
"""Waliduj świeży artefakt managed FEM/BEM FK dla benchmarku warstwy sinc.

Walidator jest celowo surowy: obecność kodu, kontraktów źródłowych albo samego
CSV nie wystarcza do zaliczenia. PASS wymaga zgodności manifestu z dokładnym
przypadkiem, zakończonej relaksacji, pełnych próbek dynamiki, metryk operatora
BEM oraz osobnego dowodu wykonania GPU bez operatora hostowego i fallbacku.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.analysis.compare_fdm_fem_mumax3_sinc_layer import (  # noqa: E402
    assert_no_field_snapshots,
    load_fullmag_stage,
)


PROBLEM_NAME = "fdm_fem_mumax3_sinc_layer"
CASE_PATH = REPO_ROOT / "tests" / "fem_fdm_mumax3_sinc_layer" / "fullmag_case.py"
EXPECTED_GEOMETRY_M = (500e-9, 500e-9, 10e-9)
EXPECTED_FDM_CELL_M = (2.5e-9, 2.5e-9, 10e-9)
EXPECTED_MS_A_PER_M = 800e3
EXPECTED_AEX_J_PER_M = 13e-12
EXPECTED_ALPHA = 0.01
EXPECTED_BIAS_B_T = (100e-3, 0.0, 0.0)
EXPECTED_DRIVE_AMPLITUDE_B_T = 1e-3
EXPECTED_DRIVE_DIRECTION = (0.0, 1.0, 0.0)
EXPECTED_FCUT_HZ = 10e9
EXPECTED_T0_S = 20.0 / EXPECTED_FCUT_HZ
EXPECTED_DURATION_S = 40.0 / EXPECTED_FCUT_HZ
EXPECTED_DYNAMIC_STEPS = 80_000
EXPECTED_DYNAMIC_DT_S = 5e-14
EXPECTED_RELAX_MAX_STEPS = 50_000
EXPECTED_RELAX_TOLERANCE_T = 1e-5
EXPECTED_SAMPLE_PERIOD_S = 1.0 / (2.0 * 1.3 * EXPECTED_FCUT_HZ)
EXPECTED_MU0 = 4.0 * math.pi * 1e-7
REQUIRED_COLUMNS = (
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
SHA256_RE = re.compile(r"^(?:sha256:)?[0-9a-fA-F]{64}$")
GIT_COMMIT_RE = re.compile(r"^[0-9a-fA-F]{40}$")


class ValidationError(ValueError):
    """Błąd kwalifikacji, który trafia do raportu zamiast przerywać walidację."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def _object(value: Any, label: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{label} musi być obiektem JSON")
    return value


def _number(value: Any, label: str) -> float:
    _require(
        isinstance(value, (int, float)) and not isinstance(value, bool),
        f"{label} musi być liczbą",
    )
    result = float(value)
    _require(math.isfinite(result), f"{label} musi być skończone")
    return result


def _integer(value: Any, label: str) -> int:
    result = _number(value, label)
    _require(result.is_integer(), f"{label} musi być całkowite")
    return int(result)


def _close(actual: Any, expected: float, label: str, *, rel: float = 1e-9, abs_: float = 1e-30) -> None:
    value = _number(actual, label)
    _require(
        math.isclose(value, expected, rel_tol=rel, abs_tol=abs_),
        f"{label}={value:.16e}, oczekiwano {expected:.16e}",
    )


def _vector(value: Any, label: str, expected: Sequence[float], *, rel: float = 1e-9, abs_: float = 1e-30) -> None:
    _require(isinstance(value, list) and len(value) == len(expected), f"{label} ma zły wymiar")
    for index, target in enumerate(expected):
        _close(value[index], target, f"{label}[{index}]", rel=rel, abs_=abs_)


def _optional_object(parent: Mapping[str, Any], key: str, label: str) -> dict[str, Any] | None:
    value = parent.get(key)
    if value is None:
        return None
    return _object(value, label)


def _json_file(path: Path) -> dict[str, Any]:
    _require(path.is_file(), f"brak artefaktu JSON: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"nie można odczytać JSON {path}: {exc}") from exc
    return _object(value, f"{path}")


def load_last_json_object(text: str) -> dict[str, Any]:
    """Odczytaj ostatnie podsumowanie JSON z mieszanego logu runnera."""

    decoder = json.JSONDecoder()
    last: dict[str, Any] | None = None
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and {"status", "artifact_dir", "total_steps"} <= value.keys():
            last = value
    if last is None:
        raise ValidationError("log runtime nie zawiera podsumowania z artifact_dir")
    return last


def _resolve_input(path: Path) -> tuple[Path, dict[str, Any] | None]:
    if path.is_dir():
        return path.resolve(), None
    _require(path.is_file(), f"wejście runtime nie istnieje: {path}")
    summary = load_last_json_object(path.read_text(encoding="utf-8", errors="replace"))
    raw = summary.get("artifact_dir")
    _require(isinstance(raw, str) and raw, "podsumowanie runtime nie ma artifact_dir")
    artifact = Path(raw)
    if artifact.is_absolute() and not artifact.exists() and artifact.is_relative_to("/workspace"):
        artifact = (Path.cwd() / artifact.relative_to("/workspace")).resolve()
    elif not artifact.is_absolute():
        artifact = (path.parent / artifact).resolve()
        if not artifact.exists():
            artifact = (Path.cwd() / raw).resolve()
    _require(artifact.is_dir(), f"artifact_dir nie istnieje: {artifact}")
    return artifact, summary


def _metadata_paths(root: Path) -> list[Path]:
    direct = root / "metadata.json"
    if direct.is_file():
        return [direct]
    return sorted(root.rglob("metadata.json"))


def _metadata_stage_id(metadata: Mapping[str, Any]) -> str:
    problem_meta = metadata.get("problem_meta")
    if not isinstance(problem_meta, dict):
        return ""
    runtime = problem_meta.get("runtime_metadata")
    if not isinstance(runtime, dict):
        return ""
    active = runtime.get("active_stage_id")
    return active if isinstance(active, str) else ""


def _load_stage_metadata(root: Path) -> tuple[dict[str, Any], dict[str, Any] | None, Path]:
    paths = _metadata_paths(root)
    _require(paths, f"brak metadata.json w artefakcie {root}")
    if len(paths) == 1 or paths[0] == root / "metadata.json":
        return _json_file(paths[0]), None, paths[0]

    values = [(path, _json_file(path)) for path in paths]

    def matches(path: Path, metadata: Mapping[str, Any], tokens: Sequence[str]) -> bool:
        haystack = f"{path.parent.name} {_metadata_stage_id(metadata)}".lower()
        return any(token in haystack for token in tokens)

    dynamic = next(
        ((path, value) for path, value in reversed(values) if matches(path, value, ("dynamic", "excite"))),
        None,
    )
    relaxation = next(
        ((path, value) for path, value in reversed(values) if matches(path, value, ("relax",))),
        None,
    )
    main_path, main = dynamic or values[-1]
    relax_metadata = relaxation[1] if relaxation and relaxation[0] != main_path else None
    return main, relax_metadata, main_path


def _qualification_metadata(
    metadata: Mapping[str, Any],
    relaxation_metadata: Mapping[str, Any] | None,
    key: str,
) -> dict[str, Any]:
    for candidate in (metadata, relaxation_metadata or {}):
        value = candidate.get(key)
        if isinstance(value, dict):
            return value
    raise ValidationError(f"brak {key} w metadanych relaksacji")


def _runtime_case_metadata(metadata: Mapping[str, Any]) -> dict[str, Any]:
    problem_meta = _object(metadata.get("problem_meta"), "problem_meta")
    runtime = _object(problem_meta.get("runtime_metadata"), "problem_meta.runtime_metadata")
    return _object(runtime.get(PROBLEM_NAME), f"runtime_metadata.{PROBLEM_NAME}")


def _find_artifact(root: Path, *names: str) -> Path | None:
    candidates: list[Path] = []
    for name in names:
        candidates.extend((root / name, root / "artifacts" / name, root / "states" / name))
        candidates.extend(sorted(root.rglob(name)))
    seen: set[Path] = set()
    existing = []
    for candidate in candidates:
        candidate = candidate.resolve()
        if candidate in seen or not candidate.is_file():
            continue
        seen.add(candidate)
        existing.append(candidate)
    return existing[0] if existing else None


def _state_vectors(value: Mapping[str, Any], label: str) -> list[tuple[float, float, float]]:
    raw = value.get("values")
    _require(isinstance(raw, list), f"{label}.values musi być tablicą")
    if raw and all(isinstance(item, list) and len(item) == 3 for item in raw):
        vectors = [tuple(_number(component, f"{label}.values[{index}]") for component in item) for index, item in enumerate(raw)]
    else:
        _require(len(raw) % 3 == 0, f"{label}.values ma długość niepodzielną przez 3")
        vectors = [
            tuple(_number(raw[offset + component], f"{label}.values[{offset + component}]") for component in range(3))
            for offset in range(0, len(raw), 3)
        ]
    _require(vectors, f"{label}.values nie może być puste")
    return vectors


def _norm_defect(vectors: Sequence[Sequence[float]]) -> float:
    return max(abs(math.sqrt(sum(component * component for component in vector)) - 1.0) for vector in vectors)


def _check_case_source(case_path: Path) -> None:
    _require(case_path.is_file(), f"brak wspólnego skryptu przypadku: {case_path}")
    source = case_path.read_text(encoding="utf-8")
    required = (
        "FILM_SIZE_M = (500e-9, 500e-9, 10e-9)",
        "FDM_CELL_M = (2.5e-9, 2.5e-9, 10e-9)",
        "MS_A_PER_M = 800e3",
        "AEX_J_PER_M = 13e-12",
        "ALPHA = 0.01",
        "BIAS_B_T = (100e-3, 0.0, 0.0)",
        "DRIVE_AMPLITUDE_B_T = 1e-3",
        "DRIVE_DIRECTION = (0.0, 1.0, 0.0)",
        "FCUT_HZ = 10e9",
        "T0_S = 20.0 / FCUT_HZ",
        "TOTAL_TIME_S = 40.0 / FCUT_HZ",
        "DYNAMIC_STEPS = 80_000",
        "study.build_mesh()",
        'study.demag(realization="fredkin_koehler")',
        '"body_only_free_tetrahedral"',
        '"auto_sinc_cutoff"',
    )
    missing = [snippet for snippet in required if snippet not in source]
    if "DYNAMIC_DT_S = 5e-14" not in source and "DYNAMIC_DT_S = TOTAL_TIME_S / DYNAMIC_STEPS" not in source:
        missing.append("DYNAMIC_DT_S = TOTAL_TIME_S / DYNAMIC_STEPS")
    _require(not missing, "wspólny skrypt nie zawiera kontraktu benchmarku: " + "; ".join(missing))


def _validate_summary(summary: Mapping[str, Any], device: str) -> None:
    _require(summary.get("status") == "completed", f"runtime status={summary.get('status')!r}")
    _require(summary.get("backend") == "fem", f"runtime backend={summary.get('backend')!r}")
    _require(summary.get("mode") == "strict", f"runtime mode={summary.get('mode')!r}, oczekiwano strict")
    _require(summary.get("precision") == "double", f"runtime precision={summary.get('precision')!r}")
    if "device" in summary:
        _require(summary.get("device") == device, f"runtime device={summary.get('device')!r}, oczekiwano {device}")
    _require(_integer(summary.get("total_steps"), "runtime total_steps") >= EXPECTED_DYNAMIC_STEPS, "runtime nie wykonał 80000 kroków dynamiki")
    if "final_time" in summary:
        _close(summary["final_time"], EXPECTED_DURATION_S, "runtime final_time", rel=1e-8, abs_=2 * EXPECTED_DYNAMIC_DT_S)
    if "final_e_total" in summary:
        _number(summary["final_e_total"], "runtime final_e_total")


def _validate_completion(metadata: Mapping[str, Any]) -> None:
    _require(metadata.get("status") == "completed", f"metadata status={metadata.get('status')!r}")
    completion = _object(metadata.get("completion"), "completion")
    _require(completion.get("status") == "completed", f"completion status={completion.get('status')!r}")
    _require(_integer(metadata.get("field_snapshots"), "field_snapshots") == 0, "artefakt zawiera field_snapshots")
    _require(_integer(metadata.get("accepted_solver_steps"), "accepted_solver_steps") >= EXPECTED_DYNAMIC_STEPS, "accepted_solver_steps nie obejmuje pełnej dynamiki")


def _validate_requested_execution(metadata: Mapping[str, Any], device: str) -> None:
    requested = _object(metadata.get("requested_execution"), "requested_execution")
    expected = {
        "backend": "fem",
        "device": device,
        "precision": "double",
        "mode": "strict",
        "fallback_policy": "forbidden",
    }
    for key, value in expected.items():
        _require(requested.get(key) == value, f"requested_execution.{key}={requested.get(key)!r}, oczekiwano {value!r}")


def _validate_problem_metadata(metadata: Mapping[str, Any], device: str) -> dict[str, Any]:
    runtime = _runtime_case_metadata(metadata)
    _require(runtime.get("schema_version") == "fdm_fem_mumax3_sinc_layer.v1", "zły schemat runtime metadata benchmarku")
    _require(runtime.get("backend") == "fem", "runtime metadata nie opisuje FEM")
    _require(runtime.get("fem_demag") == "fredkin_koehler", "runtime metadata nie opisuje Fredkina-Köhlera")
    _require(runtime.get("fem_mesh_mode") == "body_only_free_tetrahedral", "FEM FK musi używać body-only free tetrahedral")
    _vector(runtime.get("geometry_size_m"), "geometry_size_m", EXPECTED_GEOMETRY_M)
    _vector(runtime.get("fdm_cell_m"), "fdm_cell_m", EXPECTED_FDM_CELL_M)
    _require(runtime.get("pbc") == [False, False, False], "benchmark FK nie może mieć PBC")
    material = _object(runtime.get("material"), "runtime material")
    _require(material.get("name") == "Py", "materiał benchmarku musi być Py")
    _close(material.get("Ms_A_per_m"), EXPECTED_MS_A_PER_M, "material.Ms_A_per_m")
    _close(material.get("A_J_per_m"), EXPECTED_AEX_J_PER_M, "material.A_J_per_m")
    _close(material.get("alpha"), EXPECTED_ALPHA, "material.alpha")
    _vector(runtime.get("bias_B_T"), "bias_B_T", EXPECTED_BIAS_B_T)
    drive = _object(runtime.get("drive"), "runtime drive")
    _close(drive.get("amplitude_B_T"), EXPECTED_DRIVE_AMPLITUDE_B_T, "drive.amplitude_B_T")
    _vector(drive.get("direction"), "drive.direction", EXPECTED_DRIVE_DIRECTION)
    _close(drive.get("cutoff_hz"), EXPECTED_FCUT_HZ, "drive.cutoff_hz")
    _close(drive.get("t0_s"), EXPECTED_T0_S, "drive.t0_s", rel=1e-8, abs_=1e-24)
    _close(runtime.get("duration_s"), EXPECTED_DURATION_S, "duration_s", rel=1e-8, abs_=1e-24)
    _require(_integer(runtime.get("dynamic_steps"), "dynamic_steps") == EXPECTED_DYNAMIC_STEPS, "dynamic_steps musi wynosić 80000")
    _close(runtime.get("dynamic_timestep_s"), EXPECTED_DYNAMIC_DT_S, "dynamic_timestep_s", rel=1e-8, abs_=1e-24)
    _require(runtime.get("dynamic_initial_state") == "relaxed_state_after_llg_overdamped", "dynamika musi startować ze stanu po relaksacji LLG")
    _require(runtime.get("relaxation_policy") == "same_script_pre_dynamic_llg_overdamped", "relaksacja musi pochodzić z tego samego skryptu")
    relaxation = _object(runtime.get("relaxation"), "runtime relaxation")
    expected_relaxation = {
        "algorithm": "llg_overdamped",
        "solver": "heun",
        "state_artifact": "relaxed_state",
        "field_drive_active": False,
    }
    for key, expected in expected_relaxation.items():
        _require(relaxation.get(key) == expected, f"relaxation.{key}={relaxation.get(key)!r}, oczekiwano {expected!r}")
    _close(relaxation.get("fixed_timestep_s"), EXPECTED_DYNAMIC_DT_S, "relaxation.fixed_timestep_s", rel=1e-8, abs_=1e-24)
    _close(relaxation.get("torque_tolerance_T"), EXPECTED_RELAX_TOLERANCE_T, "relaxation.torque_tolerance_T")
    _require(_integer(relaxation.get("max_steps"), "relaxation.max_steps") == EXPECTED_RELAX_MAX_STEPS, "relaxation.max_steps musi wynosić 50000")
    sampling = _object(runtime.get("table_sampling_policy"), "table_sampling_policy")
    _require(sampling.get("kind") == "auto_sinc_cutoff", "sampling musi być auto_sinc_cutoff")
    _close(sampling.get("nyquist_guard_factor"), 1.3, "table_sampling_policy.nyquist_guard_factor")
    _require(runtime.get("magnetization_field_outputs") is False, "benchmark ma rejestrować skalarne m, nie snapshoty pól")
    return runtime


def _validate_plan_and_mesh(metadata: Mapping[str, Any]) -> None:
    execution_plan = _object(metadata.get("execution_plan"), "execution_plan")
    common = _object(execution_plan.get("common"), "execution_plan.common")
    _require(common.get("requested_backend") == "fem", "plan requested_backend musi być fem")
    _require(common.get("resolved_backend") == "fem", "plan resolved_backend musi być fem")
    _require(common.get("execution_mode") == "strict", "plan execution_mode musi być strict")
    plan = _object(execution_plan.get("backend_plan"), "execution_plan.backend_plan")
    _require(plan.get("kind") == "fem", "backend_plan.kind musi być fem")
    _require(plan.get("demag_realization") == "fredkin_koehler", "backend_plan demag musi być FK")
    _require(plan.get("fe_order") == 1, "FK benchmark musi używać P1")
    _close(plan.get("hmax"), EXPECTED_FDM_CELL_M[0], "backend_plan.hmax", rel=1e-8, abs_=1e-24)
    _require(plan.get("air_box_config") is None, "FK body-only nie może mieć air_box_config")
    _require(plan.get("enable_exchange") is True, "FK plan musi włączyć exchange")
    _require(plan.get("enable_demag") is True, "FK plan musi włączyć demag")
    _require(
        plan.get("domain_mesh_mode") in {"merged_magnetic_mesh", "body_only_magnetic_mesh", "magnetic_body_only"},
        f"plan domain_mesh_mode nie jest body-only: {plan.get('domain_mesh_mode')!r}",
    )
    for key in ("mesh_parts", "object_segments"):
        entries = plan.get(key)
        if entries is None:
            continue
        _require(isinstance(entries, list), f"backend_plan.{key} musi być tablicą")
        for index, entry in enumerate(entries):
            if isinstance(entry, dict):
                tokens = " ".join(str(entry.get(name, "")) for name in ("role", "part", "object_id", "geometry_id", "name")).lower()
            else:
                tokens = str(entry).lower()
            _require("air" not in tokens and "outer_boundary" not in tokens, f"backend_plan.{key}[{index}] wskazuje airbox: {tokens}")
    material = plan.get("material")
    if isinstance(material, dict):
        ms = material.get("saturation_magnetisation", material.get("Ms_A_per_m"))
        aex = material.get("exchange_stiffness", material.get("A_J_per_m"))
        alpha = material.get("damping", material.get("alpha"))
        _close(ms, EXPECTED_MS_A_PER_M, "backend_plan.material.Ms")
        _close(aex, EXPECTED_AEX_J_PER_M, "backend_plan.material.Aex")
        _close(alpha, EXPECTED_ALPHA, "backend_plan.material.alpha")
    external = plan.get("external_field")
    if external is not None:
        try:
            _vector(external, "backend_plan.external_field", EXPECTED_BIAS_B_T)
        except ValidationError:
            _vector(external, "backend_plan.external_field", tuple(value / EXPECTED_MU0 for value in EXPECTED_BIAS_B_T), rel=1e-8, abs_=1e-12)
    mesh = _object(metadata.get("mesh"), "mesh")
    node_count = _integer(mesh.get("node_count", mesh.get("nodes_count")), "mesh.node_count")
    element_count = _integer(mesh.get("element_count", mesh.get("elements_count")), "mesh.element_count")
    _require(node_count > 0 and element_count > 0, "body-only mesh musi mieć węzły i elementy")
    for key in ("periodic_node_pair_count", "periodic_boundary_pair_count"):
        _require(_integer(mesh.get(key, 0), f"mesh.{key}") == 0, f"mesh.{key} musi wynosić zero")
    nested_mesh = plan.get("mesh")
    if isinstance(nested_mesh, dict):
        for key in ("periodic_node_pair_count", "periodic_boundary_pair_count"):
            if key in nested_mesh:
                _require(_integer(nested_mesh[key], f"backend_plan.mesh.{key}") == 0, f"backend_plan.mesh.{key} musi wynosić zero")
        for key in ("periodic_node_pairs", "periodic_boundary_pairs"):
            if key in nested_mesh:
                _require(nested_mesh[key] == [], f"backend_plan.mesh.{key} nie może zawierać par PBC")


def _validate_build_identity(metadata: Mapping[str, Any], source_snapshot: Path | None) -> None:
    identity = _object(metadata.get("build_identity"), "build_identity")
    git_commit = identity.get("git_commit")
    snapshot = identity.get("source_snapshot_sha256")
    _require(isinstance(git_commit, str) and GIT_COMMIT_RE.fullmatch(git_commit), "build_identity.git_commit musi mieć 40 znaków hex")
    _require(isinstance(snapshot, str) and SHA256_RE.fullmatch(snapshot), "build_identity.source_snapshot_sha256 musi mieć 64 znaków hex")
    _require(identity.get("worktree_state") in {"clean", "dirty"}, "build_identity.worktree_state jest nieznany")
    if source_snapshot is not None:
        snapshot_value: str
        if source_snapshot.is_file():
            loaded = json.loads(source_snapshot.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                snapshot_value = str(loaded.get("source_snapshot_sha256", ""))
            else:
                snapshot_value = str(loaded)
        else:
            snapshot_value = source_snapshot.read_text(encoding="utf-8").strip()
        _require(snapshot_value == snapshot, "artefakt pochodzi z innego source snapshot niż wskazany walidatorowi")


def _bem_metadata(metadata: Mapping[str, Any], device: str, min_applies: int) -> dict[str, Any]:
    runtime = _object(metadata.get("demag_runtime"), "demag_runtime")
    _require(runtime.get("model") == "fredkin_koehler", "demag_runtime.model musi być fredkin_koehler")
    _require(runtime.get("magnetostatic_boundary_model") == "fredkin_koehler", "demag_runtime boundary model musi być FK")
    _require(runtime.get("poisson_operator") is None, "FK nie może publikować operatora Poissona jako demag operatora")
    _require(runtime.get("boundary_variant") is None, "FK nie może publikować wariantu Robin/Dirichlet")
    _require(runtime.get("airbox_factor") is None and runtime.get("robin_beta_mode") is None and runtime.get("robin_beta_factor") is None, "FK runtime nie może mieć parametrów airbox/Robin")
    bem = _object(runtime.get("bem_operator"), "demag_runtime.bem_operator")
    provenance = _object(_object(metadata.get("execution_provenance"), "execution_provenance").get("fem_bem_demag"), "execution_provenance.fem_bem_demag")
    for key in ("operator_mode", "operator_fingerprint"):
        _require(bem.get(key) == provenance.get(key), f"BEM provenance {key} różni się między runtime i execution_provenance")
    expected_mode = "hierarchical_h2" if device == "cpu" else "device_hypre_fem_bem"
    _require(bem.get("operator_mode") == expected_mode, f"BEM operator_mode={bem.get('operator_mode')!r}, oczekiwano {expected_mode!r}")
    fingerprint = bem.get("operator_fingerprint")
    _require(isinstance(fingerprint, str) and SHA256_RE.fullmatch(fingerprint), "BEM operator_fingerprint musi być sha256/64 hex")
    positive = ("boundary_node_count", "boundary_triangle_count", "near_block_count", "far_block_count", "near_entry_count", "far_row_count", "max_rank", "resident_bytes", "operator_build_count", "apply_count")
    for key in positive:
        _require(_integer(bem.get(key), f"BEM {key}") > 0, f"BEM {key} musi być dodatnie")
    _require(_integer(bem.get("operator_build_count"), "BEM operator_build_count") == 1, "BEM operator musi być zbudowany dokładnie raz")
    _require(_integer(bem.get("apply_count"), "BEM apply_count") >= min_applies, "BEM apply_count nie obejmuje pełnej trajektorii")
    error = _number(bem.get("relative_error_estimate"), "BEM relative_error_estimate")
    _require(0.0 <= error <= 1.0e-4, f"BEM estymowany błąd względny jest za duży: {error:.3e}")
    device_bytes = _integer(bem.get("device_bytes"), "BEM device_bytes")
    upload_count = _integer(bem.get("operator_upload_count"), "BEM operator_upload_count")
    if device == "gpu":
        _require(device_bytes > 0, "GPU BEM musi mieć dodatnią pamięć device_bytes")
        _require(upload_count > 0, "GPU BEM musi mieć upload operatora w setup")
    else:
        _require(device_bytes == 0, "CPU BEM nie może raportować device_bytes")
        _require(upload_count == 0, "CPU BEM nie może raportować uploadu GPU")
    return bem


def _validate_execution_provenance(metadata: Mapping[str, Any], device: str) -> dict[str, Any]:
    provenance = _object(metadata.get("execution_provenance"), "execution_provenance")
    expected_engine = "fem_cpu_native" if device == "cpu" else "fem_native_gpu"
    expected_mode = "hierarchical_h2" if device == "cpu" else "device_hypre_fem_bem"
    _require(provenance.get("execution_engine") == expected_engine, f"execution_engine={provenance.get('execution_engine')!r}")
    _require(provenance.get("precision") == "double", "execution_provenance precision musi być double")
    _require(provenance.get("lossy_fallback_used") is False, "execution_provenance raportuje fallback/lossy fallback")
    _require(provenance.get("requested_demag_realization") == "fredkin_koehler", "requested demag nie jest FK")
    _require(provenance.get("resolved_demag_realization") == "fredkin_koehler", "resolved demag nie jest FK")
    _require(provenance.get("fem_assembly_mode") == "legacy_sparse", "nieznany FEM assembly mode")
    _require(provenance.get("fem_demag_operator_mode") == expected_mode, f"fem_demag_operator_mode={provenance.get('fem_demag_operator_mode')!r}")
    _require(provenance.get("energy_minimizer_realization") == "native_llg_time_integrator", "relaksacja nie ma natywnej realizacji LLG")
    _require(provenance.get("llg_mode") == "pure_damping", "relaksacja benchmarku musi być pure damping")
    if device == "cpu":
        _require(provenance.get("fem_execution_mode") == "cpu_native", "CPU FK nie wykonał się w cpu_native")
        _require(provenance.get("demag_residency") == "host", "CPU FK powinien raportować host demag residency")
        _require("host" in str(provenance.get("hypre_execution_policy", "")).lower(), "CPU FK nie opublikował hostowego solver policy")
    else:
        _require(provenance.get("fem_execution_mode") == "all_in_gpu_legacy_sparse", "GPU FK nie wykonał się w strict all_in_gpu_legacy_sparse")
        _require(provenance.get("fem_data_residency") == "device_source_of_truth", "GPU FK nie ma device_source_of_truth")
        _require(provenance.get("demag_residency") == "device", "GPU FK nie ma device demag residency")
        _require(provenance.get("uses_cuda_kernels") is True, "GPU FK nie raportuje uses_cuda_kernels=true")
        _require(provenance.get("uses_gpu_poisson") is True, "GPU FK nie raportuje device Hypre Poisson solve")
        _require(provenance.get("fem_gpu_qualification_status") == "production_executable", "GPU FK nie ma statusu production_executable")
        for key in ("hot_loop_compute_h2d_bytes", "hot_loop_compute_d2h_bytes", "hot_loop_compute_host_sync_count"):
            _require(_integer(provenance.get(key), f"execution_provenance.{key}") == 0, f"GPU FK ma transfer/sync hot-loop: {key}")
    return provenance


def _validate_relaxation_qualification(
    metadata: Mapping[str, Any],
    relaxation_metadata: Mapping[str, Any] | None,
    device: str,
) -> dict[str, Any]:
    key = "fem_cpu_relaxation_qualification" if device == "cpu" else "fem_gpu_relaxation_qualification"
    qualification = _qualification_metadata(metadata, relaxation_metadata, key)
    _require(qualification.get("schema_version") == f"fem_{device}_relaxation_qualification.v1", f"zły schemat {key}")
    _require(qualification.get("relaxation_algorithm") == "llg_overdamped", f"{key}.relaxation_algorithm musi być llg_overdamped")
    _require(qualification.get("converged") is True, f"{key} nie potwierdza zbieżnej relaksacji")
    _require(qualification.get("stop_reason") == "torque", f"{key}.stop_reason musi być torque")
    _require(qualification.get("stop_metric_unit") == "T", f"{key}.stop_metric_unit musi być T")
    _close(qualification.get("stop_threshold"), EXPECTED_RELAX_TOLERANCE_T, f"{key}.stop_threshold")
    final_torque = _number(qualification.get("final_torque_t"), f"{key}.final_torque_t")
    _require(final_torque <= EXPECTED_RELAX_TOLERANCE_T, f"{key}.final_torque_t przekracza tolerancję")
    defect = _number(qualification.get("norm_defect"), f"{key}.norm_defect")
    _require(defect <= 1e-9, f"{key}.norm_defect przekracza 1e-9")
    steps = _integer(qualification.get("executed_steps"), f"{key}.executed_steps")
    _require(1 <= steps <= EXPECTED_RELAX_MAX_STEPS, f"{key}.executed_steps poza zakresem relaksacji")
    if device == "cpu":
        _require(qualification.get("assembly_mode") == "legacy_sparse", "CPU qualification assembly_mode musi być legacy_sparse")
        policy = _object(qualification.get("algorithm_policy"), f"{key}.algorithm_policy")
        _require(policy.get("realization") == "native_llg_time_integrator", "CPU qualification nie ma natywnego LLG")
        _require(str(policy.get("time_integrator", "")).lower() == "heun", "CPU qualification relaksacji nie używa Heun")
        _require(policy.get("precession_policy") == "disabled_pure_damping", "CPU qualification ma precesję w relaksacji")
        _require(policy.get("rhs_policy") == "llg_overdamped_rhs", "CPU qualification ma zły RHS")
    else:
        policy = _object(qualification.get("device_policy"), f"{key}.device_policy")
        expected_policy = {
            "execution_mode": "all_in_gpu_legacy_sparse",
            "qualification_status": "production_executable",
            "data_residency": "device_source_of_truth",
            "exchange_operator_mode": "legacy_sparse_gpu",
            "demag_operator_mode": "device_hypre_fem_bem",
            "uses_cuda_kernels": True,
            "uses_gpu_poisson": True,
            "hot_loop_exchange_host_sync_count": 0,
            "hot_loop_compute_host_sync_count": 0,
            "hot_loop_control_scalar_host_sync_count": 0,
        }
        for field, expected in expected_policy.items():
            _require(policy.get(field) == expected, f"GPU device_policy.{field}={policy.get(field)!r}, oczekiwano {expected!r}")
        algorithm_policy = _object(qualification.get("algorithm_policy"), f"{key}.algorithm_policy")
        _require(algorithm_policy.get("realization") == "native_llg_time_integrator", "GPU qualification nie ma natywnego LLG")
        _require(str(algorithm_policy.get("time_integrator", "")).lower() == "heun", "GPU qualification relaksacji nie używa Heun")
        _require(algorithm_policy.get("precession_policy") == "disabled_pure_damping", "GPU qualification ma precesję w relaksacji")
        _require(algorithm_policy.get("rhs_policy") == "llg_overdamped_rhs", "GPU qualification ma zły RHS")
    return qualification


def _validate_gpu_receipt(metadata: Mapping[str, Any]) -> dict[str, Any]:
    provenance = _object(metadata.get("execution_provenance"), "execution_provenance")
    receipt = _object(provenance.get("fem_gpu_execution_receipt"), "fem_gpu_execution_receipt")
    expected = {
        "resolved": "device_resident",
        "executed": "cuda_fem",
        "execution_class": "device_resident",
        "precision": "double",
        "accounting_valid": True,
        "resolved_host_operator_mask": 0,
        "resolved_unknown_operator_mask": 0,
        "executed_host_operator_mask": 0,
        "executed_unknown_operator_mask": 0,
        "fallback_count": 0,
        "hot_loop_compute_h2d_bytes": 0,
        "hot_loop_compute_d2h_bytes": 0,
        "hot_loop_compute_host_sync_count": 0,
    }
    for key, value in expected.items():
        if key in {"resolved_host_operator_mask", "resolved_unknown_operator_mask", "executed_host_operator_mask", "executed_unknown_operator_mask"} and receipt.get(key) != value:
            operator_kind = "host operator" if "host" in key else "unknown operator"
            _require(False, f"GPU receipt {operator_kind} violation: {key}={receipt.get(key)!r}, oczekiwano {value!r}")
        _require(receipt.get(key) == value, f"GPU receipt {key}={receipt.get(key)!r}, oczekiwano {value!r}")
    required = _integer(receipt.get("required_operator_mask"), "receipt.required_operator_mask")
    _require(required > 0, "GPU receipt required_operator_mask jest pusty")
    for key in ("resolved_device_operator_mask", "executed_device_operator_mask"):
        _require(_integer(receipt.get(key), f"receipt.{key}") == required, f"GPU receipt {key} nie pokrywa wszystkich operatorów")
    _require(_integer(receipt.get("accepted_step_count"), "receipt.accepted_step_count") >= EXPECTED_DYNAMIC_STEPS, "GPU receipt nie obejmuje 80000 kroków")
    return receipt


def _validate_scalar_tables(root: Path, metadata: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        relaxation = load_fullmag_stage(root, "relaxation")
        dynamic = load_fullmag_stage(root, "dynamic")
    except ValueError as exc:
        raise ValidationError(f"brak pełnych tabel scalar m/energii (energy columns): {exc}") from exc
    for stage_name, table in (("relaxation", relaxation), ("dynamic", dynamic)):
        missing = [column for column in REQUIRED_COLUMNS if column not in table.columns]
        _require(not missing, f"{stage_name} table missing energy/magnetization columns: {', '.join(missing)}")
        _require(len(table.rows) >= 2, f"{stage_name} table musi mieć co najmniej dwa wiersze")
        for index, row in enumerate(table.rows):
            for column in REQUIRED_COLUMNS:
                _number(row.get(column), f"{stage_name}[{index}].{column}")
    for index in range(1, len(relaxation.rows)):
        _require(relaxation.rows[index]["e_total"] <= relaxation.rows[index - 1]["e_total"] + 1e-12 * max(abs(relaxation.rows[index]["e_total"]), abs(relaxation.rows[index - 1]["e_total"]), 1e-30), "relaksacja zwiększa E_total")
    _require(all(abs(row["e_drive"]) <= 1e-30 for row in relaxation.rows), "drive musi być wyłączony podczas relaksacji")
    dynamic_steps = _integer(dynamic.rows[-1].get("step"), "dynamic final step")
    _require(dynamic_steps == EXPECTED_DYNAMIC_STEPS, f"dynamic final step={dynamic_steps}, oczekiwano {EXPECTED_DYNAMIC_STEPS}")
    _close(dynamic.rows[-1]["time_s"], EXPECTED_DURATION_S, "dynamic final time", rel=1e-8, abs_=2 * EXPECTED_DYNAMIC_DT_S)
    previous_time = -math.inf
    for index, row in enumerate(dynamic.rows):
        time_s = row["time_s"]
        _require(time_s >= previous_time, f"dynamic time nie jest monotoniczny w wierszu {index}")
        previous_time = time_s
        if "solver_dt" in dynamic.columns:
            _close(row["solver_dt"], EXPECTED_DYNAMIC_DT_S, f"dynamic solver_dt[{index}]", rel=1e-7, abs_=1e-24)
    unique_times = sorted({row["time_s"] for row in dynamic.rows})
    _require(len(unique_times) >= 2, "dynamic sampling ma mniej niż dwa czasy")
    max_gap = max(right - left for left, right in zip(unique_times, unique_times[1:]))
    _require(max_gap <= EXPECTED_SAMPLE_PERIOD_S + 2 * EXPECTED_DYNAMIC_DT_S + 1e-18, f"dynamic sampling gap={max_gap:.3e} przekracza auto-sinc cadence")
    relaxation_steps = _integer(relaxation.rows[-1].get("step"), "relaxation final step")
    _require(1 <= relaxation_steps <= EXPECTED_RELAX_MAX_STEPS, "relaxation final step poza kontraktem")
    scalar_rows = metadata.get("scalar_rows")
    if scalar_rows is not None:
        _require(_integer(scalar_rows, "scalar_rows") >= len(dynamic.rows), "metadata scalar_rows nie obejmuje dynamiki")
    return (
        {"rows": len(relaxation.rows), "last_step": relaxation_steps, "last_time_s": relaxation.last_time_s},
        {"rows": len(dynamic.rows), "last_step": dynamic_steps, "last_time_s": dynamic.last_time_s, "max_gap_s": max_gap, "columns": list(dynamic.columns)},
    )


def _sampling_resolution(root: Path, metadata: Mapping[str, Any], runtime: Mapping[str, Any]) -> dict[str, Any]:
    value = metadata.get("sampling_resolution")
    if not isinstance(value, dict):
        value = runtime.get("sampling_resolution")
    if not isinstance(value, dict):
        path = root / "sampling" / "sampling_resolution.v1.json"
        if path.is_file():
            value = _json_file(path).get("sampling_resolution")
    resolution = _object(value, "sampling_resolution")
    _require(resolution.get("schema_version") == "sampling_resolution.v1", "zły schemat sampling_resolution")
    policy = _object(resolution.get("requested_policy"), "sampling_resolution.requested_policy")
    _require(policy.get("kind") == "auto_sinc_cutoff", "sampling_resolution policy musi być auto_sinc_cutoff")
    _close(policy.get("nyquist_guard_factor"), 1.3, "sampling requested nyquist guard")
    _close(resolution.get("maximum_cutoff_hz"), EXPECTED_FCUT_HZ, "sampling maximum_cutoff_hz")
    _close(resolution.get("nyquist_guard_factor"), 1.3, "sampling nyquist_guard_factor")
    _close(resolution.get("sampling_frequency_hz"), 26e9, "sampling sampling_frequency_hz")
    _close(resolution.get("sample_period_s"), EXPECTED_SAMPLE_PERIOD_S, "sampling sample_period_s", rel=1e-8, abs_=1e-24)
    _require(resolution.get("target_stage_id") in {"dynamic", "dynamic_table"}, "sampling target_stage_id musi wskazywać dynamikę")
    return resolution


def _validate_state_artifacts(root: Path, node_count: int) -> dict[str, Any]:
    paths = {
        "m_initial": _find_artifact(root, "m_initial.json"),
        "m_final": _find_artifact(root, "m_final.json"),
        "relaxed_state": _find_artifact(root, "relaxed_state.json"),
    }
    vectors_by_name: dict[str, list[tuple[float, float, float]]] = {}
    for name, path in paths.items():
        _require(path is not None, f"brak artefaktu {name}.json")
        vectors = _state_vectors(_json_file(path), name)
        _require(len(vectors) == node_count, f"{name} ma {len(vectors)} wektorów, mesh ma {node_count}")
        vectors_by_name[name] = vectors
        _require(_norm_defect(vectors) <= 1e-9, f"{name} ma zły norm defect")
    _require(len(vectors_by_name["m_initial"]) == len(vectors_by_name["m_final"]), "m_initial/m_final mają różny rozmiar")
    return {"node_count": node_count, "norm_defect": max(_norm_defect(vectors) for vectors in vectors_by_name.values())}


def _record(checks: list[dict[str, str]], check_id: str, action: Callable[[], str | None]) -> None:
    try:
        detail = action() or "OK"
    except (ValidationError, OSError, KeyError, TypeError, ValueError) as exc:
        checks.append({"id": check_id, "status": "FAIL", "detail": str(exc)})
    else:
        checks.append({"id": check_id, "status": "PASS", "detail": detail})


def validate_lane(
    artifact: str | Path,
    device: str,
    *,
    case_path: str | Path = CASE_PATH,
    source_snapshot: str | Path | None = None,
) -> dict[str, Any]:
    """Zwróć raport kwalifikacji; status to PASS albo NOT VERIFIED."""

    _require(device in {"cpu", "gpu"}, f"nieznane urządzenie: {device}")
    input_path = Path(artifact)
    checks: list[dict[str, str]] = []
    metrics: dict[str, Any] = {"lane": device}
    try:
        root, summary = _resolve_input(input_path)
    except (ValidationError, OSError, ValueError) as exc:
        return {"schema": "fem_fk_sinc_layer_qualification.v1", "lane": device, "status": "NOT VERIFIED", "artifact_dir": str(input_path), "checks": [{"id": "input", "status": "FAIL", "detail": str(exc)}], "metrics": metrics}
    if summary is not None:
        _record(checks, "runtime_summary", lambda: (_validate_summary(summary, device), "runtime summary OK")[1])
    _record(checks, "artifact_completion", lambda: (_validate_completion(_load_stage_metadata(root)[0]), "artifact completion OK")[1])
    try:
        metadata, relaxation_metadata, metadata_path = _load_stage_metadata(root)
    except (ValidationError, OSError, ValueError) as exc:
        checks.append({"id": "metadata", "status": "FAIL", "detail": str(exc)})
        return {"schema": "fem_fk_sinc_layer_qualification.v1", "lane": device, "status": "NOT VERIFIED", "artifact_dir": str(root), "checks": checks, "metrics": metrics}
    metrics["metadata_path"] = str(metadata_path)
    runtime: dict[str, Any] | None = None
    bem: dict[str, Any] | None = None
    _record(checks, "requested_execution", lambda: (_validate_requested_execution(metadata, device), "requested execution OK")[1])
    _record(checks, "source_case_contract", lambda: (_check_case_source(Path(case_path)), "wspólny skrypt benchmarku OK")[1])
    _record(checks, "problem_parameters", lambda: (_validate_problem_metadata(metadata, device), "parametry geometryczne/fizyczne/schedule OK")[1])
    try:
        runtime = _runtime_case_metadata(metadata)
    except ValidationError:
        runtime = None
    _record(checks, "body_only_mesh", lambda: (_validate_plan_and_mesh(metadata), "body-only P1 mesh bez PBC/airboxa OK")[1])
    _record(checks, "build_identity", lambda: (_validate_build_identity(metadata, Path(source_snapshot) if source_snapshot is not None else None), "build/source provenance OK")[1])
    _record(checks, "execution_provenance", lambda: (_validate_execution_provenance(metadata, device), "execution provenance OK")[1])
    min_applies = EXPECTED_DYNAMIC_STEPS
    _record(checks, "bem_operator_provenance", lambda: (_bem_metadata(metadata, device, min_applies), "BEM operator metrics/fingerprint/residency OK")[1])
    try:
        bem = _object(_object(metadata.get("demag_runtime"), "demag_runtime").get("bem_operator"), "bem_operator")
        metrics["bem_operator"] = bem
    except ValidationError:
        pass
    _record(checks, "relaxation_qualification", lambda: (_validate_relaxation_qualification(metadata, relaxation_metadata, device), "relaksacja LLG overdamped/Heun zbieżna OK")[1])
    if device == "gpu":
        _record(checks, "gpu_execution_receipt", lambda: (_validate_gpu_receipt(metadata), "GPU receipt potwierdza device-only bez host operatora/fallbacku OK")[1])
    table_metrics: tuple[dict[str, Any], dict[str, Any]] | None = None
    _record(checks, "scalar_tables", lambda: (_validate_scalar_tables(root, metadata), "mx/my/mz i wszystkie energie w relaksacji/dynamice OK")[1])
    if table_metrics is None:
        try:
            relaxation_table = load_fullmag_stage(root, "relaxation")
            dynamic_table = load_fullmag_stage(root, "dynamic")
            table_metrics = (
                {"rows": len(relaxation_table.rows), "last_step": int(round(relaxation_table.rows[-1]["step"]))},
                {"rows": len(dynamic_table.rows), "last_step": int(round(dynamic_table.rows[-1]["step"])), "last_time_s": dynamic_table.last_time_s},
            )
        except (ValueError, OSError, IndexError):
            pass
    if table_metrics is not None:
        metrics["relaxation"] = table_metrics[0]
        metrics["dynamic"] = table_metrics[1]
        metrics["dynamic_steps"] = table_metrics[1]["last_step"]
    if runtime is not None:
        _record(checks, "sampling_resolution", lambda: (_sampling_resolution(root, metadata, runtime), "sampling auto-sinc/26 GHz OK")[1])
    try:
        mesh = _object(metadata.get("mesh"), "mesh")
        node_count = _integer(mesh.get("node_count", mesh.get("nodes_count")), "mesh.node_count")
    except ValidationError:
        node_count = 0
    if node_count > 0:
        _record(checks, "state_artifacts", lambda: (_validate_state_artifacts(root, node_count), "m_initial/m_final/relaxed_state i normy OK")[1])
    _record(checks, "no_field_snapshots", lambda: (assert_no_field_snapshots(root), "brak niejawnych snapshotów pól OK")[1])
    status = "PASS" if checks and all(item["status"] == "PASS" for item in checks) else "NOT VERIFIED"
    return {
        "schema": "fem_fk_sinc_layer_qualification.v1",
        "lane": device,
        "status": status,
        "artifact_dir": str(root),
        "checks": checks,
        "metrics": metrics,
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path, help="bundle .zarr albo log managed runtime")
    parser.add_argument("--device", choices=("cpu", "gpu"), required=True)
    parser.add_argument("--case", type=Path, default=CASE_PATH)
    parser.add_argument("--source-snapshot", type=Path)
    parser.add_argument("--output", type=Path, help="ścieżka raportu JSON; domyślnie artifact/qualification.json")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    report = validate_lane(args.artifact, args.device, case_path=args.case, source_snapshot=args.source_snapshot)
    output = args.output or (Path(report["artifact_dir"]) / "qualification.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
