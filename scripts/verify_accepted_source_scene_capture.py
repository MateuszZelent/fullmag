"""Focused interpreted regression for canonical source capture; no solver/build.

Run only inside the managed backend, with an explicit Docker-volume output root.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import py_compile
from pathlib import Path
import subprocess
import sys
import sysconfig
import tempfile

CAPTURE_TIMEOUT_SECONDS = 90


def invoke(python, helper, source, fullmag, phase, expected=None):
    args = [python, "-B", "-S", "-c",
            "import sys; sys.path[:] = [p for p in sys.path if p]; import runpy; path=sys.argv.pop(1); runpy.run_path(path,run_name='__main__')",
            str(helper), "--phase", phase, "--script", str(source),
            "--fullmag-root", str(fullmag), "--scene-only"]
    if expected:
        args += ["--expected-inventory", expected]
    result = subprocess.run(args, capture_output=True, timeout=CAPTURE_TIMEOUT_SECONDS, cwd=source.parent,
                            env={"PATH": str(Path(python).parent), "PYTHONHASHSEED": "0", "PYTHONDONTWRITEBYTECODE": "1"})
    if len(result.stdout) > 8 * 1024 * 1024 or len(result.stderr) > 8 * 1024 * 1024:
        raise AssertionError("capture output exceeds consumer bound")
    document = None
    if result.returncode == 0:
        document = json.loads(next(line for line in reversed(result.stdout.decode().splitlines())
                                   if line.strip().startswith("{") and line.strip().endswith("}")))
    return result, document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fullmag-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    fullmag = args.fullmag_root.resolve(strict=True)
    output = args.output_dir.resolve(strict=True)
    helper = fullmag / "runtime/accepted_source_capture.py"
    cases = []
    with tempfile.TemporaryDirectory(prefix="source-scene-check-", dir=output) as temporary:
        source = Path(temporary) / "study.py"
        for name in ("ctypes.py", "runpy.py"):
            (Path(temporary) / name).write_text("raise RuntimeError('authored shadow executed')\n", encoding="utf-8")
        module = Path(temporary) / "captured_label.py"
        actual_source = b'# coding: latin-1\nlabel = "capture_caf\xe9"\n'
        cached_source = b'# coding: latin-1\nlabel = "cached_wrong"\n'
        assert len(actual_source) == len(cached_source)
        module.write_bytes(cached_source)
        cache = Path(py_compile.compile(str(module), doraise=True,
                                        invalidation_mode=py_compile.PycInvalidationMode.TIMESTAMP))
        cached_stat = module.stat()
        module.write_bytes(actual_source)
        os.utime(module, ns=(cached_stat.st_atime_ns, cached_stat.st_mtime_ns))
        cache_digest = hashlib.sha256(cache.read_bytes()).hexdigest()
        source.write_text('import fullmag as fm\nfrom captured_label import label\nstudy = fm.study(label)\nstudy.geometry_object(fm.Box(1e-6, 1e-6, 1e-6), name="body", object_id="body", type="geometry")\n', encoding="utf-8")
        result, inventory = invoke(sys.executable, helper, source, fullmag, "inventory")
        assert result.returncode == 0 and set(inventory) == {"capture"}, result.stderr.decode()
        executable = Path(sys.executable).resolve(strict=True)
        executable_records = [record for record in inventory["capture"]["records"]
                              if record["relative_path"] == "interpreter/" + executable.name]
        assert len(executable_records) == 1
        executable_record = executable_records[0]
        assert executable_record["absolute_path"] == str(executable)
        assert executable_record["role"] == "runtime"
        assert executable_record["sha256"] == hashlib.sha256(executable.read_bytes()).hexdigest()
        assert executable_record["sha256"] == inventory["capture"]["runtime"]["executable_sha256"]
        cases.append("canonical_executable_record_without_changing_spawned_interpreter")
        records = inventory["capture"]["records"]
        runtime = inventory["capture"]["runtime"]
        assert sum(record["byte_count"] for record in records if record["role"] == "runtime") == runtime["runtime_bytes"]
        assert runtime["runtime_bytes"] <= 128 * 1024 * 1024
        library = sysconfig.get_config_var("LIBRARY")
        libpl = sysconfig.get_config_var("LIBPL")
        archive = Path(libpl) / library if libpl and library and library.endswith(".a") else None
        paths = {record["absolute_path"] for record in records}
        if archive is not None and archive.is_file():
            assert str(archive) not in paths
            assert str(Path(libpl) / "Makefile") in paths
        assert any(record["relative_path"].startswith("stdlib/lib-dynload/") and record["relative_path"].endswith(".so") for record in records)
        assert any(record["relative_path"].startswith("numpy-libs/") for record in records)
        cases.append("bounded_runtime_retains_python_native_and_numpy_inputs")
        digest = inventory["capture"]["inventory_sha256"]
        result, exported = invoke(sys.executable, helper, source, fullmag, "export", digest)
        assert result.returncode == 0, result.stderr.decode()
        assert set(exported) == {"scene", "capture"} and isinstance(exported["scene"], dict)
        assert exported["capture"]["inventory_sha256"] == digest
        entry = exported["capture"]["entry_relative_path"]
        record = next(record for record in exported["capture"]["records"] if record["relative_path"] == entry)
        assert record["sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
        assert entry in exported["capture"]["observed_reads"]
        module_record = next(record for record in exported["capture"]["records"]
                             if record["relative_path"] == "source/captured_label.py")
        assert module_record["sha256"] == hashlib.sha256(actual_source).hexdigest()
        assert "source/captured_label.py" in exported["capture"]["observed_reads"]
        scene_text = json.dumps(exported["scene"], ensure_ascii=False)
        assert "capture_caf\u00e9" in scene_text and "cached_wrong" not in scene_text
        assert hashlib.sha256(cache.read_bytes()).hexdigest() == cache_digest
        assert all("__pycache__" not in record["relative_path"] for record in exported["capture"]["records"])
        assert all("__pycache__" not in path for path in exported["capture"]["observed_reads"])
        cases.append("encoding_cookie_source_wins_over_valid_conflicting_bytecode_cache")
        assert exported["capture"]["runtime"]["capture_policy"] == "trusted_readonly_dsl_observed_io.v2"
        assert exported["capture"]["runtime"]["native_io_completeness"] == "NOT_VERIFIED"
        assert "stdlib/ctypes/__init__.py" in exported["capture"]["observed_reads"]
        assert "source/ctypes.py" not in exported["capture"]["observed_reads"]
        assert "source/runpy.py" not in exported["capture"]["observed_reads"]
        cases.append("audited_ctypes_bootstrap_ignores_authored_and_cwd_shadows")
        cache.unlink()  # Only this private fixture cache; baseline must read the same source.
        env = dict(os.environ, PYTHONPATH=str(fullmag.parent), PYTHONDONTWRITEBYTECODE="1")
        # The ordinary loader needs the script's local dependency directory.
        # Append it after runtime paths so the deliberate stdlib shadows stay inert.
        canonical = subprocess.run([sys.executable, "-B", "-c",
                                    "import sys; sys.path.append(sys.argv.pop(1)); import runpy; runpy.run_module('fullmag.runtime.helper', run_name='__main__')",
                                    str(source.parent), "export-scene-document", "--script", str(source)],
                                   capture_output=True, timeout=30, env=env)
        assert canonical.returncode == 0, canonical.stderr.decode()
        expected = json.loads(next(line for line in reversed(canonical.stdout.decode().splitlines())
                                    if line.strip().startswith("{") and line.strip().endswith("}")))
        assert exported["scene"] == expected
        cases.append("real_scene_matches_canonical_producer_without_native_geometry")
        source.write_text(source.read_text(encoding="utf-8") + "# changed\n", encoding="utf-8")
        result, _ = invoke(sys.executable, helper, source, fullmag, "export", digest)
        assert result.returncode != 0
        cases.append("changed_inventory_rejected")
        source.write_text('from pathlib import Path\nPath(__file__).with_name("forbidden.txt").write_text("forbidden")\n', encoding="utf-8")
        result, inventory = invoke(sys.executable, helper, source, fullmag, "inventory")
        assert result.returncode == 0
        result, _ = invoke(sys.executable, helper, source, fullmag, "export", inventory["capture"]["inventory_sha256"])
        assert result.returncode != 0 and not source.with_name("forbidden.txt").exists()
        cases.append("scene_only_keeps_mutating_io_guard")
        if archive is not None and archive.is_file():
            source.write_text("from pathlib import Path\ntry:\n    Path(" + repr(str(archive)) + ").read_bytes()\nexcept Exception:\n    pass\nimport fullmag as fm\nstudy = fm.study('archive_guard')\nstudy.geometry_object(fm.Box(1e-6, 1e-6, 1e-6), name='body', object_id='body', type='geometry')\n", encoding="utf-8")
            result, inventory = invoke(sys.executable, helper, source, fullmag, "inventory")
            assert result.returncode == 0, result.stderr.decode()
            result, _ = invoke(sys.executable, helper, source, fullmag, "export", inventory["capture"]["inventory_sha256"])
            assert result.returncode != 0 and b"source_capture_observed_violation" in result.stderr
            cases.append("excluded_link_archive_read_rejected_even_if_script_catches_error")
        for expression in ("ctypes.CDLL(None)", "ctypes.PyDLL(None)", "ctypes.CDLL('')",
                           "ctypes.CDLL('/outside-pinned/libexample.so')", "sys.audit('ctypes.dlopen', None)",
                           "os.putenv('OPENBLAS_MAIN_FREE', '0')"):
            source.write_text("import ctypes, os, sys\ntry:\n    " + expression + "\nexcept Exception:\n    pass\nimport fullmag as fm\nstudy = fm.study('native_guard')\nstudy.geometry_object(fm.Box(1e-6, 1e-6, 1e-6), name='body', object_id='body', type='geometry')\n", encoding="utf-8")
            result, inventory = invoke(sys.executable, helper, source, fullmag, "inventory")
            assert result.returncode == 0, result.stderr.decode()
            result, _ = invoke(sys.executable, helper, source, fullmag, "export", inventory["capture"]["inventory_sha256"])
            assert result.returncode != 0 and b"source_capture_observed_violation" in result.stderr, result.stderr.decode()
        cases.append("authored_native_loads_and_affinity_mutation_stay_sticky_refusals")
        alias = Path(temporary) / "alias.py"
        alias.symlink_to(source)
        result, _ = invoke(sys.executable, helper, alias, fullmag, "inventory")
        assert result.returncode != 0 and b"source_capture_alias_or_symlink" in result.stderr
        cases.append("script_symlink_still_rejected")
        parent_alias = output / (Path(temporary).name + "-alias")
        parent_alias.symlink_to(Path(temporary), target_is_directory=True)
        try:
            result, _ = invoke(sys.executable, helper, parent_alias / source.name, fullmag, "inventory")
            assert result.returncode != 0 and b"source_capture_alias_or_symlink" in result.stderr
            result, _ = invoke(sys.executable, helper, Path(temporary), fullmag, "inventory")
            assert result.returncode != 0 and b"source_capture_regular_file_required" in result.stderr
        finally:
            parent_alias.unlink()
        cases.append("ancestor_symlink_and_nonregular_entry_still_rejected")
    print(json.dumps({"schema": "fullmag.accepted-source-scene-regression.v1", "cases": cases,
                      "solver_executed": False, "physics_qualified": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
