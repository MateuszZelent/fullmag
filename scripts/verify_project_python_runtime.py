#!/usr/bin/env python3
"""Run the managed runtime-free Python project-open smoke.

The route builds the real PyO3 ``_fullmag_core`` extension from the current
source snapshot, copies it into the resolver-owned run root with the active
Python extension suffix, and calls ``_fullmag_core.open_project_json`` on a
valid ``.fms`` archive.  It proves that the Python entrypoint is wired to the
same application boundary as the CLI without restoring a runtime or solving.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig
import uuid
import zipfile


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import capture_source_snapshot_identity as source_identity  # noqa: E402
import fullmag_storage as storage  # noqa: E402
from verify_session_persistence import toolchain_identity  # noqa: E402


PROFILE = "windows-project-python-runtime"
RECEIPT_SCHEMA = "fullmag_project_python_runtime_v1"


class PythonRuntimeError(RuntimeError):
    """A preflight, build, import, or provenance failure."""


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
        "project Python runtime run root",
    )
    return {
        "run_root": run_root,
        "target_dir": storage.validate_path(
            run_root / "cargo-target", build_storage, "project Python Cargo target"
        ),
        "temp_dir": storage.validate_path(
            temp_root / PROFILE / run_id,
            build_storage,
            "project Python temporary root",
        ),
        # This cache is already enrolled by the managed entrypoint routes. The
        # worktree storage lock prevents concurrent Cargo cache mutation.
        "cargo_home": storage.validate_path(
            cache_root / "project-entrypoint-check" / "cargo",
            build_storage,
            "project Python Cargo home",
        ),
        "rustup_home": storage.validate_path(
            cache_root / "project-entrypoint-check" / "rustup",
            build_storage,
            "project Python Rustup home",
        ),
        "receipt": storage.validate_path(
            run_root / "receipt.json", build_storage, "project Python receipt"
        ),
        "cargo_log": storage.validate_path(
            run_root / "cargo.log", build_storage, "project Python Cargo log"
        ),
        "python_log": storage.validate_path(
            run_root / "python.log", build_storage, "project Python log"
        ),
        "fixture": storage.validate_path(
            run_root / "project-open.fms", build_storage, "project Python fixture"
        ),
        "probe": storage.validate_path(
            run_root / "python_probe.py", build_storage, "project Python probe"
        ),
        "source_snapshot": storage.validate_path(
            run_root / "source-snapshot.v2.json",
            build_storage,
            "project Python source snapshot",
        ),
        "source_snapshot_after": storage.validate_path(
            run_root / "source-snapshot-after.v2.json",
            build_storage,
            "project Python post-run source snapshot",
        ),
        "extension": storage.validate_path(
            run_root / "_fullmag_core.pyd",
            build_storage,
            "project Python extension",
        ),
    }


def child_environment(
    layout: dict[str, object],
    paths: dict[str, Path],
    tools: dict[str, Path],
    identity: dict[str, object],
    repo_root: Path,
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
            "PYTHONNOUSERSITE": "1",
        }
    )
    bins: list[str] = [str(paths["run_root"])]
    for tool in (tools["cargo"], tools["rustc"]):
        parent = str(Path(tool).parent)
        if parent not in bins:
            bins.append(parent)
    old_path = env.get("PATH", "")
    env["PATH"] = os.pathsep.join(bins + ([old_path] if old_path else []))
    package_source = repo_root / "packages" / "fullmag-py" / "src"
    python_paths = [str(paths["run_root"]), str(package_source)]
    if env.get("PYTHONPATH"):
        python_paths.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(python_paths)
    env.pop("RUSTUP_TOOLCHAIN", None)
    return env


def write_fixture(path: Path) -> None:
    scene = {
        "version": "scene.v2",
        "revision": 0,
        "scene": {
            "id": "scene",
            "name": "Python project open smoke",
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
        "project_id": "project-python-entrypoint",
        "name": "Python project open smoke",
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


def write_probe(path: Path) -> None:
    path.write_text(
        """import importlib.util
import json
import sys

import _fullmag_core

project_path = sys.argv[1]
payload = json.loads(_fullmag_core.open_project_json(project_path))
expected = {
    \"operation\": \"open_project\",
    \"project_id\": \"project-python-entrypoint\",
    \"dirty\": False,
    \"runtime\": \"untouched\",
    \"mode\": {\"kind\": \"read_write\"},
}
for key, value in expected.items():
    if payload.get(key) != value:
        raise RuntimeError(f\"Python project-open contract mismatch for {key}: {payload!r}\")
print(json.dumps({
    \"operation\": payload[\"operation\"],
    \"project_id\": payload[\"project_id\"],
    \"revision\": payload[\"revision\"],
    \"dirty\": payload[\"dirty\"],
    \"mode\": payload[\"mode\"],
    \"runtime\": payload[\"runtime\"],
    \"migration\": payload[\"migration\"],
    \"module_origin\": importlib.util.find_spec(\"_fullmag_core\").origin,
}))
""",
        encoding="utf-8",
        newline="\n",
    )


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def find_extension(target_dir: Path) -> Path:
    candidates = sorted(
        path
        for path in target_dir.rglob("*.dll")
        if path.is_file() and "fullmag_core" in path.stem.lower()
    )
    if not candidates:
        raise PythonRuntimeError(f"PyO3 _fullmag_core DLL not found below {target_dir}")
    return candidates[0]


def run(repo_root: Path) -> tuple[int, dict[str, object]]:
    if os.name != "nt":
        raise PythonRuntimeError(f"{PROFILE} is supported only on Windows")
    layout = storage.resolve_layout(repo_root, PROFILE)
    storage.initialize(layout)
    with storage.build_lock(layout):
        run_id = uuid.uuid4().hex
        paths = contained_run_paths(layout, run_id)
        for key in ("run_root", "target_dir", "temp_dir", "cargo_home", "rustup_home"):
            paths[key].mkdir(parents=True, exist_ok=True)
        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA,
            "route": "project-python-runtime",
            "profile": PROFILE,
            "run_id": run_id,
            "worktree_id": layout["worktree_id"],
            "repo_root": layout["repo_root"],
            "build_command": ["cargo", "build", "--locked", "--offline", "-p", "fullmag-py-core"],
            "runtime_scope": ["Python _fullmag_core.open_project_json(<fixture.fms>)"],
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
            receipt["python"] = {
                "executable": sys.executable,
                "version": sys.version,
                "extension_suffix": sysconfig.get_config_var("EXT_SUFFIX") or ".pyd",
            }
            write_fixture(paths["fixture"])
            write_probe(paths["probe"])
            env = child_environment(layout, paths, tools, identity, repo_root)
            with paths["cargo_log"].open("w", encoding="utf-8", newline="\n") as log:
                receipt["state"] = "building"
                write_atomic_json(paths["receipt"], receipt)
                build = subprocess.run(
                    [str(tools["cargo"]), "build", "--locked", "--offline", "-p", "fullmag-py-core"],
                    cwd=repo_root,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    text=True,
                    check=False,
                )
            receipt["build_exit_code"] = build.returncode
            if build.returncode != 0:
                raise PythonRuntimeError(f"fullmag PyO3 build failed with code {build.returncode}")
            native_extension = find_extension(paths["target_dir"])
            shutil.copy2(native_extension, paths["extension"])
            receipt["native_extension"] = str(native_extension)
            receipt["extension"] = str(paths["extension"])
            receipt["extension_sha256"] = sha256_file(paths["extension"])
            receipt["fixture_sha256"] = sha256_file(paths["fixture"])
            receipt["state"] = "running"
            write_atomic_json(paths["receipt"], receipt)
            command = [sys.executable, str(paths["probe"]), str(paths["fixture"])]
            with paths["python_log"].open("w", encoding="utf-8", newline="\n") as log:
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
            receipt["python_exit_code"] = result.returncode
            if result.returncode != 0:
                raise PythonRuntimeError(f"Python project open failed with code {result.returncode}")
            output = paths["python_log"].read_text(encoding="utf-8")
            payload = json.loads(output[output.find("{") :])
            receipt["project_open"] = payload
            source_after = source_identity.capture(repo_root, ignore_non_runtime_dirty=True)
            write_atomic_json(paths["source_snapshot_after"], source_after)
            receipt["source_identity_after"] = source_after
            changed = source_after["source_snapshot_sha256"] != identity["source_snapshot_sha256"]
            receipt["source_changed_during_run"] = changed
            if changed:
                raise PythonRuntimeError("source identity changed during Python runtime smoke")
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
            if paths["python_log"].is_file():
                receipt["python_log_sha256"] = sha256_file(paths["python_log"])
            write_atomic_json(paths["receipt"], receipt)
        print(json.dumps({"receipt": str(paths["receipt"]), "log": str(paths["python_log"]), "state": receipt["state"]}))
        return process_code, receipt


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        return run(args.repo_root.resolve())[0]
    except Exception as error:
        print(f"project Python runtime smoke failed before receipt: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
