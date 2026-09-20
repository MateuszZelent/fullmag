"""Persistent provenance contracts for frozen-spin bimeron artifacts.

The sweep writes one immutable request contract beside every case.  The
contract is deliberately small and JSON-safe: it contains the physical
parameters that determine energy comparability, the numerical relaxation
policy, and source fingerprints.  A result may only be reused when its
contract is present and equivalent to the current request.

Older ``analysis.json`` files do not contain this evidence and are therefore
diagnostic history only.  They are never silently reused as current data.
"""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable


CONTRACT_SCHEMA_VERSION = "bimeron_frozen_size.case_contract.v1"
CONTRACT_FILENAME = "request_contract.json"

# Values which identify the material/geometry/execution problem.  Target
# radius and ring details are intentionally kept in ``request`` but omitted
# from ``physical`` so a free p0 or +x background can be checked against the
# same Hamiltonian without pretending that it has the same texture.  The full
# ``numerical`` section remains part of exact case reuse and catches changes
# to tolerance, time limits, cadence, and policy files.
PHYSICAL_SECTIONS = ("material", "geometry", "texture", "execution", "source")


def _finite(value: Any) -> Any:
    """Return JSON-friendly finite numbers while preserving other values."""

    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError(f"contract value must be finite, got {value!r}")
        # Keep integers readable in persisted request files.
        return int(value) if isinstance(value, int) else number
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(item) for item in value]
    return value


def canonical_json(value: Any) -> str:
    """Serialize a contract deterministically for hashing and comparison."""

    return json.dumps(_finite(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def contract_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def _source_contract(source: dict[str, Any] | None) -> dict[str, Any]:
    source = source if isinstance(source, dict) else {}
    identity = source.get("source_identity")
    if not isinstance(identity, dict):
        identity = {}
    # Keep only stable identity fields.  ``worktree_status`` is useful in the
    # sweep manifest but changes when an unrelated file is edited and must not
    # invalidate a physically identical result.
    stable_identity = {
        key: identity.get(key)
        for key in (
            "head_commit_full",
            "source_snapshot_sha256",
            "source_snapshot_dirty",
        )
        if key in identity
    }
    scripts = source.get("scripts")
    script_hashes: dict[str, Any] = {}
    if isinstance(scripts, dict):
        for name, item in scripts.items():
            if isinstance(item, dict) and item.get("sha256"):
                script_hashes[str(name)] = item["sha256"]
    return {
        "source_identity": stable_identity,
        "script_sha256": script_hashes,
        "profile": source.get("profile"),
    }


def _num_from_environment(environment: dict[str, str], name: str, default: Any = None) -> Any:
    value = environment.get(name, default)
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return value
    return int(number) if number.is_integer() and name.endswith(("_STEPS", "_SIGN", "_VORTICITY")) else number


def build_contract(
    *,
    case: dict[str, Any],
    environment: dict[str, str] | None,
    source: dict[str, Any] | None,
    thresholds_sha256: str | None = None,
    kind: str = "case",
) -> dict[str, Any]:
    """Build the persisted contract for a case, free control, or background."""

    env = environment if isinstance(environment, dict) else {}
    material = {
        "Ms_Apm": _num_from_environment(env, "FULLMAG_BIMERON_MSAT_A_PER_M"),
        "Aex_Jpm": _num_from_environment(env, "FULLMAG_BIMERON_AEX_J_PER_M"),
        "D_Jpm2": _num_from_environment(env, "FULLMAG_BIMERON_D_J_PER_M2"),
        "Ku_Jpm3": _num_from_environment(env, "FULLMAG_BIMERON_KU_J_PER_M3"),
    }
    # Missing material values are an invalid contract rather than a wildcard.
    if any(value is None for value in material.values()):
        raise ValueError("material parameters are required in the provenance environment")

    geometry = {
        "track_x_nm": _num_from_environment(env, "FULLMAG_BIMERON_TRACK_X_NM", case.get("track_x_nm")),
        "track_y_nm": _num_from_environment(env, "FULLMAG_BIMERON_TRACK_Y_NM", case.get("track_y_nm")),
        "cell_nm": _num_from_environment(env, "FULLMAG_BIMERON_CELL_NM", case.get("cell_nm")),
        # This experiment is intentionally a single-cell film with periodic x.
        "thickness_nm": 0.5,
        "pbc_axes": ["x"],
        "demag": "truncated_images",
    }
    texture = {
        "helicity_rad": case.get("helicity_rad"),
        "vorticity": case.get("vorticity"),
        "background_sign": case.get("background_sign"),
    }
    execution = {
        "backend": "fdm",
        "device": env.get("FULLMAG_BIMERON_DEVICE"),
        "precision": "double",
        "mode": "strict",
    }
    solver = {
        "relax_algorithm": env.get("FULLMAG_BIMERON_RELAX_ALGORITHM", "llg_overdamped"),
        "dt_s": _num_from_environment(env, "FULLMAG_BIMERON_DT_S"),
        "alpha": _num_from_environment(env, "FULLMAG_BIMERON_ALPHA"),
        "relax_tol_T": _num_from_environment(env, "FULLMAG_BIMERON_TOL_T"),
        "relax_time_s": _num_from_environment(env, "FULLMAG_BIMERON_RELAX_TIME_S"),
        "hold_time_s": _num_from_environment(env, "FULLMAG_BIMERON_HOLD_TIME_S"),
        "release_time_s": _num_from_environment(env, "FULLMAG_BIMERON_RELEASE_TIME_S"),
        "relax_max_steps": _num_from_environment(env, "FULLMAG_BIMERON_RELAX_MAX_STEPS"),
        "release_max_steps": _num_from_environment(env, "FULLMAG_BIMERON_RELEASE_MAX_STEPS"),
        "field_every_steps": _num_from_environment(env, "FULLMAG_BIMERON_FIELD_EVERY_STEPS"),
        "table_every_steps": _num_from_environment(env, "FULLMAG_BIMERON_TABLE_EVERY_STEPS"),
    }
    cell_size = case.get("cell_size_nm")
    if cell_size is None:
        cell_nm = case.get("cell_nm", _num_from_environment(env, "FULLMAG_BIMERON_CELL_NM"))
        if cell_nm is not None:
            cell_size = [cell_nm, cell_nm, 0.5]
    track_size = case.get("track_size_nm")
    if track_size is None:
        track_x = case.get("track_x_nm", _num_from_environment(env, "FULLMAG_BIMERON_TRACK_X_NM"))
        track_y = case.get("track_y_nm", _num_from_environment(env, "FULLMAG_BIMERON_TRACK_Y_NM"))
        if track_x is not None and track_y is not None:
            track_size = [track_x, track_y, 0.5]
    request = {
        "kind": kind,
        "case_id": case.get("case_id"),
        "protocol": case.get("protocol"),
        "target_radius_nm": case.get("target_radius_nm"),
        "preset_radius_nm": case.get("preset_radius_nm"),
        "wall_width_nm": case.get("wall_width_nm"),
        "cell_size_nm": cell_size,
        "track_size_nm": track_size,
        "pin_radius_nm": case.get("pin_radius_nm"),
        "ring_width_nm": case.get("ring_width_nm"),
        "pin_centres_nm": case.get("pin_centres_nm"),
        "helicity_rad": case.get("helicity_rad"),
        "vorticity": case.get("vorticity"),
        "background_sign": case.get("background_sign"),
        # This offset is a sampled-grid control for the ring selector.  It is
        # environment-owned rather than part of the public case matrix, so it
        # must still participate in the reuse fingerprint.
        "ring_radius_offset_nm": case.get(
            "ring_radius_offset_nm",
            _num_from_environment(env, "FULLMAG_BIMERON_RING_RADIUS_OFFSET_NM", 0.0),
        ),
        "release": bool(case.get("release", False)),
    }
    source_contract = _source_contract(source)
    if thresholds_sha256 is not None:
        source_contract["thresholds_sha256"] = thresholds_sha256
    physical = {
        "material": material,
        "geometry": geometry,
        "texture": texture,
        "execution": execution,
        # Cross-artifact comparisons require the same source snapshot, while
        # the exact case-reuse comparison below additionally checks script
        # hashes and the selected threshold policy.
        "source": {"source_identity": source_contract.get("source_identity")},
    }
    contract: dict[str, Any] = {
        "schema_version": CONTRACT_SCHEMA_VERSION,
        "kind": kind,
        "physical": physical,
        "numerical": {"solver": solver, "source": source_contract},
        "request": request,
    }
    normalized = _finite(contract)
    normalized["contract_sha256"] = contract_sha256(normalized)
    return normalized


def physical_view(contract: dict[str, Any]) -> dict[str, Any]:
    physical = contract.get("physical") if isinstance(contract, dict) else None
    if not isinstance(physical, dict):
        return {}
    return {section: physical.get(section) for section in PHYSICAL_SECTIONS}


def _diff(expected: Any, actual: Any, path: str, differences: list[str]) -> None:
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual)):
            if key not in expected:
                differences.append(f"{path}.{key}: unexpected field")
            elif key not in actual:
                differences.append(f"{path}.{key}: missing field")
            else:
                _diff(expected[key], actual[key], f"{path}.{key}", differences)
        return
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            differences.append(f"{path}: length {len(actual)} != {len(expected)}")
            return
        for index, (left, right) in enumerate(zip(expected, actual)):
            _diff(left, right, f"{path}[{index}]", differences)
        return
    if expected != actual:
        differences.append(f"{path}: {actual!r} != {expected!r}")


def compare_contract(
    expected: dict[str, Any] | None,
    actual: dict[str, Any] | None,
    *,
    physical_only: bool = False,
) -> list[str]:
    """Return explicit mismatches; a missing contract is never compatible."""

    if not isinstance(expected, dict):
        return ["expected_contract_missing"]
    if not isinstance(actual, dict):
        return ["actual_contract_missing"]
    expected_view = physical_view(expected) if physical_only else expected
    actual_view = physical_view(actual) if physical_only else actual
    differences: list[str] = []
    _diff(expected_view, actual_view, "contract", differences)
    return differences


def load_contract(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) and value.get("schema_version") == CONTRACT_SCHEMA_VERSION else None


def contract_missing_evidence(contract: dict[str, Any] | None) -> list[str]:
    """Return missing provenance fields which make a result unsafe to reuse."""

    if not isinstance(contract, dict):
        return ["contract_missing"]
    missing: list[str] = []
    if contract.get("schema_version") != CONTRACT_SCHEMA_VERSION:
        missing.append("schema_version")
    stored_hash = contract.get("contract_sha256")
    unhashed = dict(contract)
    unhashed.pop("contract_sha256", None)
    if not isinstance(stored_hash, str) or stored_hash != contract_sha256(unhashed):
        missing.append("contract_sha256_mismatch")
    physical = contract.get("physical")
    if not isinstance(physical, dict):
        return missing + ["physical"]
    for section in ("material", "geometry", "texture", "execution", "source"):
        if not isinstance(physical.get(section), dict):
            missing.append(f"physical.{section}")
    source = physical.get("source") if isinstance(physical.get("source"), dict) else {}
    identity = source.get("source_identity") if isinstance(source.get("source_identity"), dict) else {}
    for field in ("head_commit_full", "source_snapshot_sha256"):
        if not identity.get(field):
            missing.append(f"physical.source.source_identity.{field}")
    numerical = contract.get("numerical") if isinstance(contract.get("numerical"), dict) else {}
    numerical_source = numerical.get("source") if isinstance(numerical.get("source"), dict) else {}
    script_hashes = numerical_source.get("script_sha256")
    if not isinstance(script_hashes, dict) or not script_hashes or any(
        not isinstance(value, str) or not value for value in script_hashes.values()
    ):
        missing.append("numerical.source.script_sha256")
    if not numerical_source.get("thresholds_sha256"):
        missing.append("numerical.source.thresholds_sha256")
    solver = numerical.get("solver") if isinstance(numerical.get("solver"), dict) else {}
    for field in (
        "relax_algorithm",
        "dt_s",
        "alpha",
        "relax_tol_T",
        "relax_time_s",
        "hold_time_s",
        "release_time_s",
        "relax_max_steps",
        "release_max_steps",
        "field_every_steps",
        "table_every_steps",
    ):
        if field not in solver or solver.get(field) is None:
            missing.append(f"numerical.solver.{field}")
    material = physical.get("material") if isinstance(physical.get("material"), dict) else {}
    for field in ("Ms_Apm", "Aex_Jpm", "D_Jpm2", "Ku_Jpm3"):
        if field not in material or material.get(field) is None:
            missing.append(f"physical.material.{field}")
    geometry = physical.get("geometry") if isinstance(physical.get("geometry"), dict) else {}
    for field in ("track_x_nm", "track_y_nm", "cell_nm", "thickness_nm", "pbc_axes", "demag"):
        if field not in geometry or geometry.get(field) is None:
            missing.append(f"physical.geometry.{field}")
    texture = physical.get("texture") if isinstance(physical.get("texture"), dict) else {}
    for field in ("helicity_rad", "vorticity", "background_sign"):
        if field not in texture or texture.get(field) is None:
            missing.append(f"physical.texture.{field}")
    execution = physical.get("execution") if isinstance(physical.get("execution"), dict) else {}
    for field in ("backend", "device", "precision", "mode"):
        if field not in execution or execution.get(field) is None:
            missing.append(f"physical.execution.{field}")
    request = contract.get("request") if isinstance(contract.get("request"), dict) else {}
    if not request:
        missing.append("request")
    for field in ("cell_size_nm", "track_size_nm"):
        if field not in request or not isinstance(request.get(field), list) or len(request.get(field, [])) != 3:
            missing.append(f"request.{field}")
    return missing


def load_artifact_contract(artifact_root: Path) -> dict[str, Any] | None:
    """Read the sidecar or embedded contract from an artifact directory."""

    sidecar = load_contract(artifact_root / CONTRACT_FILENAME)
    try:
        analysis = json.loads((artifact_root / "analysis.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return sidecar
    embedded = analysis.get("provenance_contract") if isinstance(analysis, dict) else None
    if not isinstance(embedded, dict) or embedded.get("schema_version") != CONTRACT_SCHEMA_VERSION:
        return sidecar
    if sidecar is not None and compare_contract(sidecar, embedded):
        # The request sidecar and measured output describe different inputs;
        # neither can safely establish provenance for reuse.
        return None
    return sidecar if sidecar is not None else embedded


def contract_status(
    expected: dict[str, Any],
    artifact_root: Path,
    *,
    physical_only: bool = False,
) -> tuple[bool, list[str]]:
    actual = load_artifact_contract(artifact_root)
    differences = compare_contract(expected, actual, physical_only=physical_only)
    return not differences, differences
