"""Contract tests for the FEM frequency-domain native verification recipe."""

from __future__ import annotations

import re
from pathlib import Path


JUSTFILE = Path(__file__).resolve().parents[1] / "justfile"


def recipe_source(name: str) -> str:
    text = JUSTFILE.read_text(encoding="utf-8")
    match = re.search(rf"^{re.escape(name)}(?:\s+[^:\n]+)?:", text, re.MULTILINE)
    assert match is not None, f"missing just recipe: {name}"
    remainder = text[match.start() :]
    next_recipe = remainder.find("\n\n")
    return remainder if next_recipe < 0 else remainder[:next_recipe]


def test_native_contract_recipe_uses_its_own_kernel_mounted_build_tree() -> None:
    recipe = recipe_source("verify-fem-frequency-domain-native-contract")

    assert "-v /mnt/fullmag-zfn2-native:/mnt/fullmag-zfn2-native" in recipe
    assert (
        "build_dir=/mnt/fullmag-zfn2-native/fem-frequency-domain-native-contract"
        in recipe
    )
    assert 'cmake -S native -B "$build_dir"' in recipe
    assert 'cmake --build "$build_dir"' in recipe
    assert 'LD_LIBRARY_PATH="$build_dir/backends/fem' in recipe
    assert '"$build_dir/backends/fem/fem_frequency_domain_contract"' in recipe
    assert "-DFULLMAG_FEM_WITH_SLEPC=ON" in recipe
    assert "native/build" not in recipe
