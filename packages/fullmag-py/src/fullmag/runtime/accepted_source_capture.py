"""Bounded preimage capture for trusted authored scripts; not a security sandbox."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import sysconfig

SCHEMA = "fullmag.script-source-capture.v1"
SOURCE_LIMIT = 8 * 1024 * 1024
RUNTIME_LIMIT = 128 * 1024 * 1024
FILE_LIMIT = 32 * 1024 * 1024
FILE_COUNT_LIMIT = 8192


def regular(path: Path) -> Path:
    absolute = Path(os.path.abspath(path))
    for ancestor in (absolute, *absolute.parents):
        if ancestor.is_symlink():
            raise RuntimeError("source_capture_alias_or_symlink")
    resolved = absolute.resolve(strict=True)
    if resolved != absolute or not stat.S_ISREG(resolved.stat().st_mode):
        raise RuntimeError("source_capture_regular_file_required")
    return resolved


def read_identity(path: Path) -> tuple[int, str]:
    path = regular(path)
    before = path.stat()
    if before.st_size > FILE_LIMIT:
        raise RuntimeError("source_capture_file_budget")
    with path.open("rb") as stream:
        data = stream.read(FILE_LIMIT + 1)
        after = os.fstat(stream.fileno())
    end = path.stat()
    if len(data) != before.st_size or len(data) > FILE_LIMIT or (
        before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns
    ) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or (
        after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
    ) != (end.st_dev, end.st_ino, end.st_size, end.st_mtime_ns):
        raise RuntimeError("source_capture_changed_during_read")
    return len(data), hashlib.sha256(data).hexdigest()


def inventory(script: Path, fullmag: Path) -> dict:
    script = regular(script)
    owned = script.parent
    fullmag = fullmag.resolve(strict=True)
    stdlib = Path(sysconfig.get_path("stdlib")).resolve(strict=True)
    site = Path(sysconfig.get_path("purelib")).resolve(strict=True)
    roots = [("source", owned, "source"), ("fullmag", fullmag, "runtime"),
             ("stdlib", stdlib, "runtime")]
    # Explicit approved package closure, including native NumPy/OpenBLAS payloads.
    if (site / "numpy").is_dir():
        roots.append(("numpy", site / "numpy", "runtime"))
        if (site / "numpy.libs").is_dir():
            roots.append(("numpy-libs", site / "numpy.libs", "runtime"))
        infos = sorted(site.glob("numpy-*.dist-info"))
        if len(infos) != 1:
            raise RuntimeError("source_capture_numpy_distribution_identity")
        roots.append(("numpy-dist-info", infos[0], "runtime"))
    records = []
    paths = set()
    keys = set()
    totals = {"source": 0, "runtime": 0}

    def add(path: Path, key: str, role: str) -> None:
        actual = regular(path)
        if str(actual) in paths:
            raise RuntimeError("source_capture_overlapping_roots")
        if key.casefold() in keys or any(p in ("", ".", "..") for p in key.split("/")):
            raise RuntimeError("source_capture_path_collision")
        size, digest = read_identity(actual)
        totals[role] += size
        if totals["source"] > SOURCE_LIMIT or totals["runtime"] > RUNTIME_LIMIT:
            raise RuntimeError("source_capture_aggregate_budget")
        paths.add(str(actual)); keys.add(key.casefold())
        records.append({"relative_path": key, "asset_id": "script-file-" + hashlib.sha256(key.encode()).hexdigest(),
                        "sha256": digest, "byte_count": size, "role": role, "absolute_path": str(actual)})
        if len(records) > FILE_COUNT_LIMIT:
            raise RuntimeError("source_capture_file_count")

    for label, root, role in roots:
        for directory, dirs, files in os.walk(root, followlinks=False):
            # No bytecode cache is executed in accepted capture; source loader is forced below.
            dirs[:] = sorted(d for d in dirs if d not in {"__pycache__", ".git"}
                              and not (label == "stdlib" and d in {"site-packages", "dist-packages"}))
            for name in dirs:
                if (Path(directory) / name).is_symlink():
                    raise RuntimeError("source_capture_symlink_directory")
            for name in sorted(files):
                path = Path(directory) / name
                add(path, label + "/" + path.relative_to(root).as_posix(), role)
    executable = regular(Path(sys.executable))
    add(executable, "interpreter/" + executable.name, "runtime")
    prefix = Path(sys.base_prefix).resolve(strict=True)
    native = prefix / "DLLs"
    if native.is_dir():
        for path in sorted(native.rglob("*")):
            if path.is_file():
                add(path, "interpreter/DLLs/" + path.relative_to(native).as_posix(), "runtime")
    for path in sorted(prefix.iterdir()):
        if path.is_file() and path != executable and (
            path.suffix.lower() == ".dll" or (
                path.name.lower().startswith(("python", "libpython"))
                and path.suffix.lower() in {".so", ".zip", "._pth"}
            )
        ):
            add(path, "interpreter/" + path.name, "runtime")
    records.sort(key=lambda r: r["relative_path"])
    fullmag_identity = [{k: r[k] for k in ("relative_path", "sha256", "byte_count")} for r in records if r["relative_path"].startswith("fullmag/")]
    numpy_version = None
    if (site / "numpy").is_dir():
        metadata = infos[0] / "METADATA"
        numpy_version = next((line.removeprefix("Version: ").strip() for line in metadata.read_text(encoding="utf-8").splitlines() if line.startswith("Version: ")), None)
        if not numpy_version:
            raise RuntimeError("source_capture_numpy_version_missing")
    payload = {"schema_version": SCHEMA, "entry_relative_path": "source/" + script.name,
               "records": records, "runtime": {"python_version": sys.version, "implementation": sys.implementation.name,
               "executable_sha256": next(r["sha256"] for r in records if r["absolute_path"] == str(executable)),
               "numpy_version": numpy_version,
               "fullmag_source_tree_sha256": hashlib.sha256(json.dumps(fullmag_identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
               "fullmag_version_binding": "source_tree_only",
               "capture_policy": "trusted_readonly_dsl_observed_io.v1", "native_io_completeness": "NOT_VERIFIED", "source_bytes": totals["source"], "runtime_bytes": totals["runtime"]}}
    payload["inventory_sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return payload


def exported_config(script: Path, options: dict, pins: dict) -> dict:
    pinned = {r["absolute_path"]: r for r in pins["records"]}
    busy = False
    observed = set()
    violations = []

    def refuse(reason):
        violations.append(reason)
        raise RuntimeError(reason)

    def audit_event(event: str, args: tuple) -> None:
        nonlocal busy
        if busy:
            return
        if event.startswith(("socket.", "subprocess.", "os.exec", "os.spawn")) or event in {
            "os.system", "os.fork", "builtins.input", "os.chdir", "os.putenv", "os.unsetenv",
            "os.remove", "os.rename", "os.mkdir", "os.rmdir", "os.link", "os.symlink", "os.truncate",
        }:
            refuse("source_capture_nondurable_or_mutating_resource")
        if event in {"ctypes.dlopen", "os.add_dll_directory"}:
            resource = args[0]
            if not isinstance(resource, (str, bytes)) or not resource:
                refuse("source_capture_unpinned_native_resource")
            path = Path(os.fsdecode(resource)).resolve(strict=True)
            if event == "ctypes.dlopen" and str(path) not in pinned:
                refuse("source_capture_unpinned_native_library")
            if event == "os.add_dll_directory" and not any(Path(p).parent == path for p in pinned):
                refuse("source_capture_unpinned_native_directory")
        if event == "import" and len(args) > 1 and args[1]:
            busy = True
            try:
                origin = regular(Path(args[1]))
                if str(origin) not in pinned:
                    refuse("source_capture_unpinned_import_origin")
            finally:
                busy = False
        if event == "open":
            resource, mode, flags = args
            if not isinstance(resource, (str, bytes, os.PathLike)):
                refuse("source_capture_descriptor_resource")
            if (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
            ):
                refuse("source_capture_write_not_supported")
            busy = True
            try:
                path = regular(Path(os.fsdecode(resource)))
                record = pinned.get(str(path))
                if record is None:
                    refuse("source_capture_read_outside_pinned_closure")
                size, digest = read_identity(path)
                if (size, digest) != (record["byte_count"], record["sha256"]):
                    refuse("source_capture_preimage_changed")
                observed.add(record["relative_path"])
            finally:
                busy = False

    def audit(event: str, args: tuple) -> None:
        try:
            audit_event(event, args)
        except Exception:
            violations.append("source_capture_audit_resource_refused")
            raise

    sys.dont_write_bytecode = True
    import importlib.machinery
    # Force source bytes, avoiding unverifiable cached bytecode provenance.
    def source_code(loader, fullname):
        source = loader.get_source(fullname)
        if source is None:
            refuse("source_capture_source_module_required")
        return compile(source, loader.get_filename(fullname), "exec", dont_inherit=True)
    importlib.machinery.SourceFileLoader.get_code = source_code
    sys.addaudithook(audit)
    # Restrict import search to the declared closure; no inherited PYTHONPATH/vendor fallback.
    fullmag_root = Path(options.pop("fullmag_root"))
    stdlib = Path(sysconfig.get_path("stdlib"))
    site = Path(sysconfig.get_path("purelib"))
    sys.path[:] = [str(script.parent), str(fullmag_root.parent), str(stdlib), str(stdlib / "lib-dynload"),
                   str(Path(sys.base_prefix) / "DLLs"), str(site)]
    from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
    from fullmag.runtime.loader import load_problem_from_script
    from fullmag.runtime.run_config_export import export_run_config, RunConfigExportOptions
    loaded = load_problem_from_script(script)
    backend = BackendTarget(options["backend"]) if options.get("backend") else None
    mode = ExecutionMode(options["mode"]) if options.get("mode") else None
    precision = ExecutionPrecision(options["precision"]) if options.get("precision") else None
    ir = loaded.to_ir(requested_backend=backend, execution_mode=mode, execution_precision=precision,
                      asset_cache=loaded.problem.geometry_asset_cache, include_geometry_assets=True,
                      _copy_cached_geometry_assets=False)
    config = export_run_config(loaded, ir, options=RunConfigExportOptions(
        requested_backend=backend, execution_mode=mode, execution_precision=precision,
        include_geometry_assets=True, source_root=loaded.source_path.parent, source_stem=loaded.source_path.stem))
    # No scientific execution, native geometry builder, profile binding or Submit occurs here.
    busy = True
    try:
        if inventory(script, fullmag_root)["inventory_sha256"] != pins["inventory_sha256"]:
            raise RuntimeError("source_capture_post_inventory_changed")
        for record in pins["records"]:
            if read_identity(Path(record["absolute_path"])) != (record["byte_count"], record["sha256"]):
                refuse("source_capture_postimage_changed")
    finally:
        busy = False
    if violations:
        raise RuntimeError("source_capture_observed_violation")
    pins["observed_reads"] = sorted(observed)
    return config


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["inventory", "export"], required=True)
    parser.add_argument("--script", required=True)
    parser.add_argument("--fullmag-root", required=True)
    parser.add_argument("--expected-inventory")
    parser.add_argument("--backend"); parser.add_argument("--mode"); parser.add_argument("--precision")
    args = parser.parse_args()
    script = regular(Path(args.script))
    pins = inventory(script, Path(args.fullmag_root))
    if args.phase == "inventory":
        print(json.dumps({"capture": pins}, separators=(",", ":")))
        return
    if not args.expected_inventory or pins["inventory_sha256"] != args.expected_inventory:
        raise RuntimeError("source_capture_inventory_changed_before_export")
    config = exported_config(script, {"fullmag_root": args.fullmag_root, "backend": args.backend,
                                      "mode": args.mode, "precision": args.precision}, pins)
    print(json.dumps({"config": config, "capture": pins}, separators=(",", ":")))


if __name__ == "__main__":
    main()
