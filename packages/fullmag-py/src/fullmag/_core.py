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
