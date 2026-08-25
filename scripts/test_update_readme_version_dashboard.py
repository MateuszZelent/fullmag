from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts/update_readme_version_dashboard.py"
SPEC = importlib.util.spec_from_file_location("update_readme_version_dashboard", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_cuda_base_version_accepts_configurable_build_argument() -> None:
    dockerfile = 'ARG FULLMAG_CUDA_BASE_IMAGE="nvidia/cuda:12.4.1-devel-ubuntu22.04"\n'

    assert MODULE.cuda_base_version(dockerfile, "Dockerfile") == "12.4.1"


def test_cuda_base_version_keeps_legacy_literal_support() -> None:
    dockerfile = "FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS deps\n"

    assert MODULE.cuda_base_version(dockerfile, "Dockerfile") == "12.4.1"
