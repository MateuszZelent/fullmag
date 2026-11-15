#!/usr/bin/env python3
"""Prepare exact Task4 CI inputs in a bounded, owned disposable source copy."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

INPUTS_SHA256 = "3e8d1b9fcb6babb428c03e25c3359bac273bb88d34325dcbdc9923bbdc0b62a4"
REGISTRATION = b"\n#[cfg(test)]\nmod task4_authenticated_acceptance;\n"
LIB = "crates/fullmag-runtime-control/src/lib.rs"
CFG = "crates/fullmag-runner/src/antenna_field_solution/closed_loop_execution.rs"
OLD_MODULE = "crates/fullmag-runtime-control/src/task4_authenticated_acceptance.rs"
SETUP_MODULE = "crates/fullmag-runtime-control/src/task4_source_fixture.rs"
MARKER_NAME = ".fullmag-dtq-ephemeral-ci-source.json"
MARKER = {"schema": "fullmag.dtq.ci_source.v1", "ephemeral": True, "owner": "retained-dtq-task4"}
SOURCE_ITEMS = ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo", "crates",
                "packages/fullmag-py", "apps/desktop/src-tauri", "native", "backends",
                "benchmarks/fem-llg/qualification-registry-v1.json",
                "scripts/rust/build_version_stamp.rs", "examples/exchange_relax.py")
EXCLUDED = {".git", ".superpowers", "target", "node_modules", "__pycache__", ".venv",
            ".fullmag", ".fullmag-build", ".fullmag-cache", ".next", "storage", "results",
            ".aws", ".ssh", ".credentials",
            "worktrees", "secrets", ".secrets", "dist", "build"}
MAX_FILES = 20000
MAX_BYTES = 256 * 1024 * 1024
MAX_FILE_BYTES = 32 * 1024 * 1024

def signature(raw):
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

def inside(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False

def regular(root, name):
    path = root / name
    if path.is_symlink() or not path.is_file() or path.resolve(strict=True) != path:
        raise ValueError("Expected a regular non-symlink source: " + name)
    return path

def load_inputs(data):
    raw = regular(data, "task-4-fixture-ci-inputs.json").read_bytes()
    if signature(raw)["sha256"] != INPUTS_SHA256:
        raise ValueError("Exact fixture CI inputs hash differs")
    inputs = json.loads(raw)
    for name, expected in inputs["payload"].items():
        if signature(regular(data, name).read_bytes()) != expected:
            raise ValueError("Exact frozen fixture payload differs: " + name)
    pins = json.loads((data / "task-4-fix3-source-pins.json").read_bytes())
    if len(pins) != 23 or pins != inputs["production_after"]:
        raise ValueError("Exact 23 Fix3 production pins differ")
    request = json.loads((data / "task-4-source-fixture-request.json").read_bytes())
    if request != {"schema_version": "fullmag.dtq.source_fixture.v1",
                   "generator_sha256": inputs["payload"]["task-4-source-fixture.py"]["sha256"]}:
        raise ValueError("Source request must pin the exact generator")
    return inputs

def check_before(root, inputs, require_marker):
    if require_marker:
        marker = regular(root, MARKER_NAME)
        if json.loads(marker.read_bytes()) != MARKER:
            raise ValueError("Owned ephemeral source marker differs")
    for name, expected in inputs["production_after"].items():
        raw = regular(root, name).read_bytes()
        if name == LIB:
            match = signature(raw) == inputs["registered_library"]
            match = match and raw.endswith(REGISTRATION)
            match = match and signature(raw[:-len(REGISTRATION)])["sha256"] == expected
        elif name == CFG:
            match = signature(raw) == inputs["cfg_before"]
            match = match and raw.count(b'feature = "fem-gpu"') == 4
            match = match and signature(raw.replace(b'feature = "fem-gpu"', b'feature = "fem-native"'))["sha256"] == expected
        else:
            match = signature(raw)["sha256"] == expected
        if not match:
            raise ValueError("Exact production before-pin differs: " + name)
    if signature(regular(root, OLD_MODULE).read_bytes()) != inputs["legacy_module"]:
        raise ValueError("Exact legacy compile-only module differs")
    setup = root / SETUP_MODULE
    if setup.exists() or setup.is_symlink():
        raise ValueError("New fixture setup module must be absent")

def check_after(root, inputs):
    for name, expected in inputs["production_after"].items():
        if signature(regular(root, name).read_bytes())["sha256"] != expected:
            raise ValueError("Exact production after-pin differs: " + name)
    for name in (OLD_MODULE, SETUP_MODULE):
        if (root / name).exists() or (root / name).is_symlink():
            raise ValueError("CI modules must be absent before/after hook")

def prepare(root, data):
    root = root.resolve(strict=True)
    data = data.resolve(strict=True)
    if root == data.parents[2]:
        raise ValueError("Refuse original source tree; require owned disposable copy")
    inputs = load_inputs(data)
    check_before(root, inputs, require_marker=True)
    # All expected bytes, both destinations and ownership are checked before the first write.
    cfg = (root / CFG).read_bytes()
    lib = (root / LIB).read_bytes()
    (root / CFG).write_bytes(cfg.replace(b'feature = "fem-gpu"', b'feature = "fem-native"'))
    (root / LIB).write_bytes(lib[:-len(REGISTRATION)])
    (root / OLD_MODULE).unlink()
    check_after(root, inputs)
    print(json.dumps({"production_23_pins": True, "legacy_module_removed_exactly": True,
                      "cfg_tokens_replaced": 4}, sort_keys=True))

def inventory(root):
    files = []
    for item in SOURCE_ITEMS:
        start = root / item
        # Cargo permits a checkout with no project-local configuration directory.
        if item == ".cargo" and not start.exists() and not start.is_symlink():
            continue
        if not start.exists() or start.is_symlink():
            raise ValueError("Required source item unavailable: " + item)
        if start.is_file():
            files.append(regular(root, item))
            continue
        for directory, names, entries in os.walk(start, followlinks=False):
            names[:] = sorted(n for n in names if n not in EXCLUDED and not n.startswith(".env") and not n.endswith(".zarr"))
            for name in names:
                if (Path(directory) / name).is_symlink():
                    raise ValueError("Source inventory refuses symlink directory")
            for name in sorted(entries):
                if name in EXCLUDED or name.startswith(".env") or name.endswith((".pem", ".key", ".pfx", ".p12", ".zarr", ".npz", ".npy", ".so", ".a", ".o", ".dll", ".exe", ".pyc")):
                    continue
                path = Path(directory) / name
                files.append(regular(root, str(path.relative_to(root))))
    total = 0
    for path in files:
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            raise ValueError("Source inventory exceeds per-file byte bound")
        total += size
    if len(files) > MAX_FILES or total > MAX_BYTES:
        raise ValueError("Source inventory exceeds file/total byte bound")
    return files

def preflight(root, data):
    inputs = load_inputs(data)
    check_before(root, inputs, require_marker=False)
    return inputs, inventory(root)

def copy_source(root, destination, data):
    root = root.resolve(strict=True)
    destination = destination.absolute()
    parent = destination.parent.resolve(strict=True)
    if destination.parent != parent or destination.exists() or destination.is_symlink() or destination == root:
        raise ValueError("Disposable source destination must be new")
    if any(inside(parent, root / item) for item in SOURCE_ITEMS):
        raise ValueError("Disposable copy must be outside the bounded source inventory")
    inputs, files = preflight(root, data)
    destination.mkdir()
    for path in files:
        target = destination / path.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    (destination / MARKER_NAME).write_text(json.dumps(MARKER, sort_keys=True) + "\n")
    check_before(destination, inputs, require_marker=True)
    print(json.dumps({"source_files_copied": len(files), "source_copy": str(destination)}, sort_keys=True))

def run(root, temporary_root, data):
    if os.environ.get("FULLMAG_DTQ_MANAGED_CI") != "1":
        raise ValueError("Only approved managed CI may execute the fixture")
    temporary_root = temporary_root.resolve(strict=True)
    # The shell passes the existing managed build root, never an operator store.
    owned = Path(tempfile.mkdtemp(prefix="task4-fixture-ci-", dir=temporary_root))
    source = owned / "source"
    test_temp = owned / "test-temp"
    copy_source(root, source, data)
    prepare(source, data)
    test_temp.mkdir()
    inputs = load_inputs(data)
    env = os.environ.copy()
    env["FULLMAG_DTQ_AUTHENTICATED_FIXTURE_JSON"] = str(data / "task-4-source-fixture-request.json")
    env["FULLMAG_DTQ_TEST_TEMP_ROOT"] = str(test_temp)
    # sys.executable is also the exact interpreter forwarded by the existing hook.
    result = subprocess.run([sys.executable, "-B", str(data / "task-4-register-ci.py"),
                             "--source-root", str(source)], env=env, check=False)
    check_after(source, inputs)
    print(json.dumps({"owned_ci_tree": str(owned), "hook_exit": result.returncode,
                      "production_23_pins_restored": True}, sort_keys=True))
    return result.returncode

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "prepare", "copy", "run"))
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--temporary-root", type=Path)
    args = parser.parse_args()
    data = Path(__file__).resolve().parent
    if args.action == "preflight":
        if args.temporary_root is None:
            parser.error("preflight requires --temporary-root")
        root = args.source_root.resolve(strict=True)
        temporary_root = args.temporary_root.resolve(strict=True)
        if not temporary_root.is_dir() or any(inside(temporary_root, root / item) for item in SOURCE_ITEMS):
            raise ValueError("Managed temporary root must be an existing directory outside source inventory")
        inputs, files = preflight(root, data)
        print(json.dumps({"source_preflight": True, "source_items": list(SOURCE_ITEMS),
                          "source_files": len(files), "source_bytes": sum(path.stat().st_size for path in files),
                          "production_23_before_pins_verified": True,
                          "project_cargo_absent": not (root / ".cargo").exists()}, sort_keys=True))
    elif args.action == "prepare":
        prepare(args.source_root, data)
    elif args.action == "copy":
        if args.destination is None:
            parser.error("copy requires --destination")
        copy_source(args.source_root, args.destination, data)
    else:
        if args.temporary_root is None:
            parser.error("run requires --temporary-root")
        return run(args.source_root, args.temporary_root, data)
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
