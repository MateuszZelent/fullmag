from __future__ import annotations

import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def root_context_dockerfiles() -> tuple[Path, ...]:
    dockerfiles: set[Path] = set()
    pattern = re.compile(
        r"^\s*build:\s*$\n"
        r"^\s*context:\s*\.\s*$\n"
        r"^\s*dockerfile:\s*(?P<path>\S+)\s*$",
        re.MULTILINE,
    )
    for compose_name in ("compose.yaml", "compose.windows.yaml"):
        compose = (REPO_ROOT / compose_name).read_text(encoding="utf-8")
        dockerfiles.update(
            REPO_ROOT / match.group("path") for match in pattern.finditer(compose)
        )
    assert dockerfiles, "expected at least one Dockerfile with build.context: ."
    return tuple(sorted(dockerfiles))


def test_root_docker_context_contains_only_docker_definitions() -> None:
    dockerignore = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8")

    assert dockerignore.splitlines() == ["**", "!docker/", "!docker/**"]


def test_root_context_dockerfiles_do_not_copy_checkout_files() -> None:
    for dockerfile in root_context_dockerfiles():
        instructions = [
            line.strip()
            for line in dockerfile.read_text(encoding="utf-8").splitlines()
            if re.match(r"^\s*(COPY|ADD)\s+", line, re.IGNORECASE)
        ]
        local_instructions = [
            line for line in instructions if not re.search(r"\s--from=\S+", line)
        ]

        assert not local_instructions, (
            f"{dockerfile.relative_to(REPO_ROOT)} copies from the checkout but the "
            f"root Docker context excludes it: {local_instructions}"
        )
