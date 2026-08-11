"""Regression guard for explicit interactive runtime provenance constructors."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "crates/fullmag-runner/src/interactive_runtime.rs"


def test_legacy_fem_gpu_provenance_constructor_sets_charge_transport() -> None:
    text = SOURCE.read_text(encoding="utf-8")
    match = re.search(
        r"fn fem_gpu_execution_provenance\([\s\S]*?let mut provenance = ExecutionProvenance \{([\s\S]*?)\n    \};",
        text,
    )
    assert match is not None, "legacy FEM GPU provenance constructor is missing"
    assert "charge_transport: None," in match.group(1)
