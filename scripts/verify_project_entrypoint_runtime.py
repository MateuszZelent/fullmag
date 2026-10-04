#!/usr/bin/env python3
"""Run the managed runtime-free CLI project-open smoke.

The route builds the real ``fullmag`` CLI from the current source snapshot,
creates a minimal valid ``.fms`` archive inside the resolver-owned run root,
and executes only ``fullmag project open``.  It is intentionally separate from
the compile-only entrypoint check: a successful compile does not prove that
the shared application adapter is wired into the CLI process.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
import zipfile


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_source_snapshot_identity as source_identity  # noqa: E402
import fullmag_storage as storage  # noqa: E402
from verify_session_persistence import toolchain_identity  # noqa: E402


PROFILE = "windows-project-entrypoint-runtime"
RECEIPT_SCHEMA = "fullmag_project_entrypoint_runtime_v1"


class EntrypointRuntimeError(RuntimeError):
    """A preflight, build, CLI, or provenance failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def contained_run_paths(layout: dict[str, object], run_id: str) -> dict[str, Path]:
    build_storage = Path(str(layout["build_storage_root"]))
    build_root = Path(str(layout["build_root"]))
    cache_root = Path(str(layout["cache_root"]))
    temp_root = Path(str(layout["temp_root"]))
    run_root = storage.validate_path(
        build_root / PROFILE / run_id,
        build_storage,
        "project entrypoint runtime run root",
    )
    return {
        "run_root": run_root,
        "target_dir": storage.validate_path(
            run_root / "cargo-target", build_storage, "project entrypoint Cargo target"
        ),
        "temp_dir": storage.validate_path(
            temp_root / PROFILE / run_id,
            build_storage,
            "project entrypoint temporary root",
        ),
        # Reuse the already enrolled entrypoint toolchain cache.  The storage
        # lock is per worktree, so compile-only and runtime entrypoint routes
        # cannot mutate this Cargo cache concurrently.
        "cargo_home": storage.validate_path(
            cache_root / "project-entrypoint-check" / "cargo",
            build_storage,
            "project entrypoint Cargo home",
        ),
        "rustup_home": storage.validate_path(
            cache_root / "project-entrypoint-check" / "rustup",
            build_storage,
            "project entrypoint Rustup home",
        ),
        "receipt": storage.validate_path(
            run_root / "receipt.json", build_storage, "project entrypoint receipt"
        ),
        "cargo_log": storage.validate_path(
            run_root / "cargo.log", build_storage, "project entrypoint Cargo log"
        ),
        "cli_log": storage.validate_path(
            run_root / "cli.log", build_storage, "project entrypoint CLI log"
        ),
        "fixture": storage.validate_path(
            run_root / "project-open.fms", build_storage, "project entrypoint fixture"
        ),
        "source_snapshot": storage.validate_path(
            run_root / "source-snapshot.v2.json",
            build_storage,
            "project entrypoint source snapshot",
        ),
        "source_snapshot_after": storage.validate_path(
            run_root / "source-snapshot-after.v2.json",
            build_storage,
            "project entrypoint post-run source snapshot",
        ),
    }


def child_environment(
    layout: dict[str, object], paths: dict[str, Path], tools: dict[str, Path], identity: dict[str, object]
) -> dict[str, str]:
    env = {str(key): str(value) for key, value in os.environ.items()}
    env.update({str(key): str(value) for key, value in layout["env"].items()})
    env.update(
        {
            "FULLMAG_STORAGE_PROFILE": PROFILE,
            "CARGO_TARGET_DIR": str(paths["target_dir"]),
            "FULLMAG_CARGO_TARGET_DIR": str(paths["target_dir"]),
            "FULLMAG_CARGO_TARGET_ROOT": str(paths["target_dir"]),
            "CARGO_HOME": str(paths["cargo_home"]),
            "RUSTUP_HOME": str(paths["rustup_home"]),
            "RUSTC": str(tools["rustc"]),
            "TMPDIR": str(paths["temp_dir"]),
            "TEMP": str(paths["temp_dir"]),
            "TMP": str(paths["temp_dir"]),
            "FULLMAG_SOURCE_GIT_COMMIT": str(identity["head_commit_full"]),
            "FULLMAG_SOURCE_WORKTREE_STATE": "dirty"
            if identity["source_snapshot_dirty"]
            else "clean",
            "FULLMAG_SOURCE_SNAPSHOT_SHA256": str(identity["source_snapshot_sha256"]),
        }
    )
    bins: list[str] = []
    for tool in (tools["cargo"], tools["rustc"]):
        parent = str(Path(tool).parent)
        if parent not in bins:
            bins.append(parent)
    old_path = env.get("PATH", "")
    env["PATH"] = os.pathsep.join(bins + ([old_path] if old_path else []))
    env.pop("RUSTUP_TOOLCHAIN", None)
    return env


def write_fixture(path: Path) -> None:
    scene = {
        "version": "scene.v2",
        "revision": 0,
        "scene": {
            "id": "scene",
            "name": "CLI project open smoke",
            "source_of_truth": "ui",
            "authoring_schema": "mesh-first-fem.v1",
        },
        "objects": [
            {
                "object_id": "object-1",
                "name": "Incomplete body",
                "type": "box",
                "transform": {
                    "rotation": [0, 0, 0.5, 0.8660254],
                    "scale": [2, 3, 4],
                },
                "future_object_field": {"keep": True},
            }
        ],
        "future": {"keep": True},
    }
    definition = {
        "schema": "fullmag.project.v1",
        "project_id": "project-cli-entrypoint",
        "name": "CLI project open smoke",
        "revision": 0,
        "scene": scene,
    }
    manifest = {
        "format": "fullmag.project.archive.v1",
        "project_schema": "fullmag.project.v1",
        "scene_schema": "scene.v2",
        "definition": "project/definition.json",
        "scene": "project/scene_document.json",
        "source": "project/main.py",
        "assets": [],
        "opaque_documents": [],
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest/project.json", json.dumps(manifest, separators=(",", ":")))
        archive.writestr("project/definition.json", json.dumps(definition, separators=(",", ":")))
        archive.writestr("project/scene_document.json", json.dumps(scene, separators=(",", ":")))
        archive.writestr("project/main.py", "print('runtime-free project open')\n")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(repo_root: Path) -> tuple[int, dict[str, object]]:
    if os.name != "nt":
        raise EntrypointRuntimeError(f"{PROFILE} is supported only on Windows")
    layout = storage.resolve_layout(repo_root, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        run_id = uuid.uuid4().hex
        paths = contained_run_paths(layout, run_id)
        for key in ("run_root", "target_dir", "temp_dir", "cargo_home", "rustup_home"):
            paths[key].mkdir(parents=True, exist_ok=True)
        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA,
            "route": "project-entrypoint-runtime",
            "profile": PROFILE,
            "run_id": run_id,
            "worktree_id": layout["worktree_id"],
            "repo_root": layout["repo_root"],
            "build_command": ["cargo", "build", "--locked", "--offline", "-p", "fullmag-cli"],
            "runtime_scope": ["fullmag project open <fixture.fms>"],
            "paths": {key: str(value) for key, value in paths.items()},
            "started_at": utc_now(),
            "state": "preflight",
        }
        process_code = 2
        try:
            identity = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot"], identity)
            receipt["source_identity"] = identity
            toolchain, tools = toolchain_identity()
            receipt["toolchain"] = toolchain
            write_fixture(paths["fixture"])
            env = child_environment(layout, paths, tools, identity)
            with paths["cargo_log"].open("w", encoding="utf-8", newline="\n") as log:
                receipt["state"] = "building"
                write_atomic_json(paths["receipt"], receipt)
                build = subprocess.run(
                    [str(tools["cargo"]), "build", "--locked", "--offline", "-p", "fullmag-cli"],
                    cwd=repo_root,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    text=True,
                    check=False,
                )
            receipt["build_exit_code"] = build.returncode
            if build.returncode != 0:
                raise EntrypointRuntimeError(f"fullmag CLI build failed with code {build.returncode}")
            binary = paths["target_dir"] / "debug" / ("fullmag.exe" if os.name == "nt" else "fullmag")
            if not binary.is_file() or binary.stat().st_size == 0:
                raise EntrypointRuntimeError(f"fullmag CLI binary is missing or empty: {binary}")
            receipt["binary"] = str(binary)
            receipt["binary_sha256"] = sha256_file(binary)
            receipt["fixture_sha256"] = sha256_file(paths["fixture"])
            receipt["state"] = "running"
            write_atomic_json(paths["receipt"], receipt)
            command = [str(binary), "project", "open", str(paths["fixture"])]
            with paths["cli_log"].open("w", encoding="utf-8", newline="\n") as log:
                result = subprocess.run(
                    command,
                    cwd=repo_root,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    text=True,
                    check=False,
                )
            receipt["execution_command"] = command
            receipt["cli_exit_code"] = result.returncode
            if result.returncode != 0:
                raise EntrypointRuntimeError(f"fullmag project open failed with code {result.returncode}")
            cli_output = paths["cli_log"].read_text(encoding="utf-8")
            json_start = cli_output.find("{")
            if json_start < 0:
                raise EntrypointRuntimeError("CLI project-open output did not contain a JSON payload")
            payload = json.loads(cli_output[json_start:])
            if (
                payload.get("operation") != "open_project"
                or payload.get("runtime") != "untouched"
                or payload.get("dirty") is not False
                or payload.get("project_id") != "project-cli-entrypoint"
                or payload.get("mode", {}).get("kind") != "read_write"
            ):
                raise EntrypointRuntimeError("CLI project-open contract mismatch")
            receipt["project_open"] = {
                "project_id": payload["project_id"],
                "revision": payload["revision"],
                "dirty": payload["dirty"],
                "mode": payload["mode"],
                "runtime": payload["runtime"],
                "migration": payload["migration"],
            }
            source_after = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot_after"], source_after)
            receipt["source_identity_after"] = source_after
            changed = source_after["source_snapshot_sha256"] != identity["source_snapshot_sha256"]
            receipt["source_changed_during_run"] = changed
            if changed:
                raise EntrypointRuntimeError("source identity changed during CLI runtime smoke")
            receipt["state"] = "passed"
            process_code = 0
        except BaseException as error:
            receipt["state"] = "failed"
            receipt["error"] = f"{type(error).__name__}: {error}"
            process_code = 1
        finally:
            receipt["finished_at"] = utc_now()
            receipt["exit_code"] = process_code
            if paths["cargo_log"].is_file():
                receipt["cargo_log_sha256"] = sha256_file(paths["cargo_log"])
            if paths["cli_log"].is_file():
                receipt["cli_log_sha256"] = sha256_file(paths["cli_log"])
            write_atomic_json(paths["receipt"], receipt)
        print(json.dumps({"receipt": str(paths["receipt"]), "log": str(paths["cli_log"]), "state": receipt["state"]}))
        return process_code, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        return run(args.repo_root.resolve())[0]
    except Exception as error:
        print(f"project entrypoint runtime smoke failed before receipt: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
