from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import tempfile
import unittest
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
    for compose_name in ("compose.yaml", "compose.windows.yaml", "compose.toolchain.yaml"):
        compose = (REPO_ROOT / compose_name).read_text(encoding="utf-8")
        dockerfiles.update(
            REPO_ROOT / match.group("path") for match in pattern.finditer(compose)
        )
    assert dockerfiles, "expected at least one Dockerfile with build.context: ."
    return tuple(sorted(dockerfiles))


def test_root_docker_context_contains_only_docker_definitions() -> None:
    dockerignore = (REPO_ROOT / ".dockerignore").read_text(encoding="utf-8")

    assert dockerignore.splitlines() == ["**", "!docker/", "!docker/**"]


def test_root_context_dockerfiles_copy_only_docker_owned_helpers() -> None:
    for dockerfile in root_context_dockerfiles():
        instructions = [
            line.strip()
            for line in dockerfile.read_text(encoding="utf-8").splitlines()
            if re.match(r"^\s*(COPY|ADD)\s+", line, re.IGNORECASE)
        ]
        local_instructions = [
            line for line in instructions if not re.search(r"\s--from=\S+", line)
        ]

        for instruction in local_instructions:
            operands = shlex.split(instruction)[1:]
            while operands and operands[0].startswith("--"):
                operands.pop(0)
            assert len(operands) >= 2, instruction
            for source in operands[:-1]:
                source_path = Path(source)
                assert (
                    not source_path.is_absolute()
                    and source_path.parts[0] == "docker"
                    and ".." not in source_path.parts
                ), f"Application source or secret outside docker/: {instruction}"
                assert (REPO_ROOT / source_path).exists(), instruction


@unittest.skipUnless(
    os.environ.get("FULLMAG_TEST_COMPOSE_CONFIG") == "1",
    "opt in to the installed Docker Compose read-only renderer",
)
def test_managed_fem_bake_preserves_defaults_and_accepts_toolchain_pins() -> None:
    environment = dict(os.environ)
    for key in ("FULLMAG_BUILD_ROOT", "FULLMAG_CARGO_TARGET_DIR", "FULLMAG_CACHE_ROOT",
                "FULLMAG_RUNTIME_ROOT", "FULLMAG_FRONTEND_ROOT", "FULLMAG_FRONTEND_CONTAINER_ROOT"):
        environment[key] = "/managed-compose-render/" + key.lower()
    with tempfile.TemporaryDirectory(prefix="fullmag-compose-render-") as temporary:
        empty = Path(temporary) / "empty.env"
        empty.write_text("", encoding="utf-8")
        prefix = ["docker", "compose", "--env-file", str(empty), "--project-name", "fullmag-compose-render"]
        def render(arguments: list[str], env: dict[str, str]) -> dict:
            result = subprocess.run(prefix + arguments, env=env, capture_output=True,
                                    text=True, timeout=30, check=True)
            return json.loads(result.stdout)
        toolchain = render(["-f", str(REPO_ROOT / "compose.toolchain.yaml"),
                            "--profile", "toolchain", "config", "--format", "json"], environment)
        pins = toolchain["services"]["fem-gpu-toolchain"]["build"]["args"]
        for name in pins:
            environment.pop(name, None)
        arguments = ["-f", str(REPO_ROOT / "compose.yaml"), "--profile", "fem-gpu",
                     "build", "--print", "fem-gpu"]
        default = render(arguments, environment)["target"]["fem-gpu"].get("args", {})
        assert "FULLMAG_CUDA_BASE_IMAGE" not in default
        assert "FULLMAG_CUDA_BASE_IMAGE_DIGEST" not in default
        selected = render(arguments, {**environment, **pins})["target"]["fem-gpu"]["args"]
        assert all(selected[name] == value for name, value in pins.items())
