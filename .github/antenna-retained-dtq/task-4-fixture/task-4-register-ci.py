#!/usr/bin/env python3
"""Register and execute the real Task4 acceptance test inside an approved CI container.

The caller must supply a newly owned, disposable source copy with the marker below.
The source-only mode builds authority and calls native producers inside the registered CI test.
This hook never starts Docker, a runtime worker or a scientific operator run.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import sys

TEST_NAME = "task4_authenticated_acceptance::dtq_v2_publication_completion_cold_read_same_bytes"
MODULE_NAME = "task4_authenticated_acceptance"
REGISTRATION = "\n#[cfg(test)]\nmod task4_authenticated_acceptance;\n"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require_external_temporary_root(fixture_json, temporary_root):
    fixture_json = Path(fixture_json).resolve(strict=True)
    root = fixture_json.parent
    temporary_root = Path(temporary_root).resolve(strict=True)
    fixture = json.loads(fixture_json.read_text())
    if fixture.get("schema_version") == "fullmag.dtq.source_fixture.v1":
        generator = Path(__file__).resolve().parent / "task-4-source-fixture.py"
        if set(fixture) != {"schema_version", "generator_sha256"} or fixture["generator_sha256"] != digest(generator):
            raise RuntimeError("source-only request must pin the exact generator")
        return
    sources = []
    for name in ("prepublication_store", "archive_source_store"):
        value = fixture.get(name)
        if not isinstance(value, str) or not value:
            raise RuntimeError(f"fixture requires a relative source store path: {name}")
        relative = Path(value)
        if relative.is_absolute() or not relative.parts or any(part in (".", "..") for part in relative.parts):
            raise RuntimeError(f"fixture source store must use relative normal components: {name}")
        source = (root / relative).resolve(strict=True)
        if not source.is_relative_to(root) or not source.is_dir():
            raise RuntimeError(f"fixture source must be a directory inside the fixture root: {name}")
        sources.append(source)
    if any(temporary_root.is_relative_to(source) for source in sources):
        raise RuntimeError("managed test temporary root must not equal or lie inside either source store")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    args = parser.parse_args()
    fixture = os.environ.get("FULLMAG_DTQ_AUTHENTICATED_FIXTURE_JSON")
    if not fixture:
        raise RuntimeError("NOT VERIFIED: FULLMAG_DTQ_AUTHENTICATED_FIXTURE_JSON is required; no skip/pass")
    if not Path(fixture).is_file():
        raise RuntimeError("NOT VERIFIED: authenticated fixture JSON is unavailable")
    temporary = os.environ.get("FULLMAG_DTQ_TEST_TEMP_ROOT")
    if not temporary or not Path(temporary).is_dir():
        raise RuntimeError("FULLMAG_DTQ_TEST_TEMP_ROOT must name an existing managed test storage directory")
    require_external_temporary_root(fixture, temporary)
    if os.environ.get("FULLMAG_DTQ_MANAGED_CI") != "1":
        raise RuntimeError("invoke only from the approved managed CI container with FULLMAG_DTQ_MANAGED_CI=1")
    artifacts = Path(__file__).resolve().parent
    root = args.source_root.resolve(strict=True)
    origin = artifacts.parents[2]
    if root == origin:
        raise RuntimeError("registration refuses the original task checkout; supply an owned ephemeral CI source copy")
    marker = root / ".fullmag-dtq-ephemeral-ci-source.json"
    if marker.is_symlink() or not marker.is_file():
        raise RuntimeError("owned ephemeral source marker is required")
    if json.loads(marker.read_text()) != {"schema": "fullmag.dtq.ci_source.v1", "ephemeral": True, "owner": "retained-dtq-task4"}:
        raise RuntimeError("ephemeral source marker differs from the explicit test contract")
    pins = json.loads((artifacts / "task-4-fix3-source-pins.json").read_text())
    if len(pins) != 23:
        raise RuntimeError("Fix3 requires the 22 dependent production pins plus the CPU producer cfg pin")
    for name, expected in pins.items():
        path = root / name
        if path.is_symlink() or not path.resolve(strict=True).is_relative_to(root) or digest(path) != expected:
            raise RuntimeError(f"approved production source differs before registration: {name}")
    library = root / "crates/fullmag-runtime-control/src/lib.rs"
    test_source = library.parent / (MODULE_NAME + ".rs")
    setup_source = library.parent / "task4_source_fixture.rs"
    if test_source.exists() or test_source.is_symlink() or setup_source.exists() or setup_source.is_symlink():
        raise RuntimeError("test module destination must be absent")
    original = library.read_bytes()
    if MODULE_NAME.encode() in original:
        raise RuntimeError("test module is already registered")
    command = ["cargo", "test", "--locked", "-p", "fullmag-runtime-control", "--lib",
               "--features", "fullmag-runner/fem-native", TEST_NAME, "--", "--exact", "--nocapture"]
    installed = original + REGISTRATION.encode()
    module_bytes = (artifacts / "task-4-authenticated-acceptance.rs").read_bytes()
    setup_bytes = (artifacts / "task-4-source-fixture.rs").read_bytes()
    execution_env = os.environ.copy()
    execution_env["FULLMAG_DTQ_SOURCE_GENERATOR"] = str(artifacts / "task-4-source-fixture.py")
    execution_env["FULLMAG_DTQ_FIXTURE_PYTHON"] = sys.executable
    execution_env["FULLMAG_DTQ_CI_SOURCE_ROOT"] = str(root)
    created_setup = False
    created_module = False
    installed_library = False
    try:
        with setup_source.open("xb") as target:
            created_setup = True
            target.write(setup_bytes)
        with test_source.open("xb") as target:
            created_module = True
            target.write(module_bytes)
        library.write_bytes(installed)
        installed_library = True
        list_command = command[:-3] + ["--", "--list", "--exact"]
        print(json.dumps({"registered_test": TEST_NAME, "list_command": list_command, "command": command,
                          "source_root": str(root)}, sort_keys=True), flush=True)
        listed = subprocess.run(list_command, cwd=root, env=execution_env, check=False, text=True, capture_output=True)
        print(listed.stdout, end="", flush=True)
        print(listed.stderr, end="", file=sys.stderr, flush=True)
        if listed.returncode:
            raise RuntimeError(f"CI harness compile/list failed with exit {listed.returncode}")
        if f"{TEST_NAME}: test" not in listed.stdout.splitlines():
            raise RuntimeError("registered exact acceptance test was not listed; refuse a zero-test success")
        result = subprocess.run(command, cwd=root, env=execution_env, check=False)
    finally:
        # Only the exact bytes and single module created by this hook are eligible for cleanup.
        if installed_library:
            if library.read_bytes() != installed:
                raise RuntimeError("CI source lib changed concurrently; preserve it for inspection")
            library.write_bytes(original)
        if created_module:
            if test_source.read_bytes() != module_bytes:
                raise RuntimeError("CI test module changed concurrently; preserve it for inspection")
            test_source.unlink()
        if created_setup:
            if setup_source.read_bytes() != setup_bytes:
                raise RuntimeError("CI source setup changed concurrently; preserve it for inspection")
            setup_source.unlink()
        for name, expected in pins.items():
            if digest(root / name) != expected:
                raise RuntimeError(f"production source changed during CI acceptance: {name}")
    if result.returncode:
        raise SystemExit(result.returncode)
    print(json.dumps({"executed_test": TEST_NAME, "exit": 0, "production_23_pins_restored": True}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
