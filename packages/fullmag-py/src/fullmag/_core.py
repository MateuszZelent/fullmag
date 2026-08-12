"""Private bridge to optional native helpers.

The public API remains pure Python. Native helpers stay internal and optional
until packaging for the PyO3 bridge is finalized.
"""

from __future__ import annotations

import json
from typing import Any

try:
    import _fullmag_core as _native_core
except ImportError:  # pragma: no cover - optional bootstrap dependency
    _native_core = None


def validate_ir(ir: dict[str, Any]) -> bool | None:
    if _native_core is None:
        return None
    return bool(_native_core.validate_ir_json(json.dumps(ir)))


def validate_mesh_ir(mesh_ir: dict[str, Any]) -> bool | None:
    if _native_core is None:
        return None
    return bool(_native_core.validate_mesh_ir_json(json.dumps(mesh_ir)))


def run_problem_json(
    ir: dict[str, Any], until_seconds: float, output_dir: str | None = None
) -> dict[str, Any] | None:
    """Run a ProblemIR through the Rust reference runner.

    Returns RunResult dict on success, None if native core is not available.
    Raises ValueError if the problem is not executable in Phase 1.
    """
    if _native_core is None:
        return None
    result_json = _native_core.run_problem_json(
        json.dumps(ir), until_seconds, output_dir
    )
    return json.loads(result_json)


def resample_fem_to_fdm_grid(
    fem_mesh_ir: dict[str, Any],
    magnetization: list[list[float]],
    next_stage_ir: dict[str, Any],
) -> dict[str, Any] | None:
    """Resample FEM node-based magnetization to FDM grid cell centers.

    Returns dict with values, transfer counts, and the canonical target-grid
    identity if the next stage is FDM. Returns None if no resampling is needed
    (next stage is not FDM) or if native core is unavailable.
    """
    if _native_core is None:
        return None
    result_json = _native_core.resample_fem_to_fdm_grid_json(
        json.dumps(fem_mesh_ir),
        magnetization,
        json.dumps(next_stage_ir),
    )
    if result_json is None:
        return None
    return json.loads(result_json)


def extract_fem_mesh_ir(ir: dict[str, Any]) -> dict[str, Any] | None:
    """Extract the FEM mesh IR from a problem's execution plan.

    Returns the mesh IR dict if the backend resolves to FEM,
    or None if the backend is not FEM or native core is unavailable.
    """
    if _native_core is None:
        return None
    mesh_json = _native_core.extract_fem_mesh_ir_json(json.dumps(ir))
    if mesh_json is None:
        return None
    return json.loads(mesh_json)
