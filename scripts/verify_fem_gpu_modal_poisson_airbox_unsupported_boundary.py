#!/usr/bin/env python3
"""Validate the GPU modal Poisson-airbox unsupported-boundary artifact."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import NoReturn


EXPECTED_FIELDS: dict[str, object] = {
    "schema_version": "gpu_modal_poisson_airbox_unsupported_boundary.v1",
    "lane": "gpu_modal_poisson_airbox_k0",
    "case_id": "K0-3",
    "demag_kind": "periodic_airbox_k0",
    "requested_device": "gpu",
    "gpu_device_resident_modal_eigensolver": False,
    "cpu_fallback": "disabled",
    "status": "unsupported_until_pa_g_parity_runtime",
}
REQUIRED_DIAGNOSTIC_FRAGMENTS = (
    "GPU modal K0/Kittel with demag",
    "CPU fallback",
    "disabled",
)


def fail(message: str) -> NoReturn:
    raise SystemExit(f"invalid GPU modal Poisson-airbox unsupported boundary:\n{message}")


def load_boundary(path: Path) -> dict[str, object]:
    if not path.is_file():
        fail(f"{path} does not exist")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail(f"{path} is not valid JSON: {error}")
    if not isinstance(payload, dict):
        fail(f"{path} must contain a JSON object")
    return payload


def validate_boundary(path: Path) -> None:
    payload = load_boundary(path)
    for key, expected in EXPECTED_FIELDS.items():
        actual = payload.get(key)
        if actual != expected:
            fail(f"{key} must be {expected!r}, got {actual!r}")

    fragments = payload.get("required_diagnostic_fragments")
    if not isinstance(fragments, list) or not all(
        isinstance(fragment, str) for fragment in fragments
    ):
        fail("required_diagnostic_fragments must be a string array")
    for fragment in REQUIRED_DIAGNOSTIC_FRAGMENTS:
        if fragment not in fragments:
            fail(f"required_diagnostic_fragments must include {fragment!r}")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(
            "usage: verify_fem_gpu_modal_poisson_airbox_unsupported_boundary.py "
            "<unsupported_boundary.v1.json>",
            file=sys.stderr,
        )
        return 2
    validate_boundary(Path(argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

