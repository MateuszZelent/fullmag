"""Contract tests for the shared Docker DEV compiler cache session (ADR 0085)."""

from contextlib import redirect_stderr
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker" / "all-in-one"))
import backend_dev as backend


def _tool(directory: Path, name: str) -> Path:
    path = directory / name
    path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


class SharedCompileCacheTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.cache = self.root / "shared-compile-cache"
        for name in ("sccache", "ccache"):
            (self.cache / name).mkdir(parents=True)
        self.tools = self.root / "bin"
        self.tools.mkdir()
        self.sccache = _tool(self.tools, "sccache")
        self.ccache = _tool(self.tools, "ccache")
        self.build_root = self.root / "build"
        (self.build_root / "tmp").mkdir(parents=True)
        self.workspace = self.build_root / "workspace"
        self.base = {"PATH": str(self.tools), "CARGO_INCREMENTAL": "1"}
        self.patches = [
            patch.object(backend, "SHARED_COMPILE_CACHE_ROOT", str(self.cache)),
            patch.dict(os.environ, {"FULLMAG_SHARED_COMPILE_CACHE": str(self.cache)}),
        ]
        for active in self.patches:
            active.start()

    def tearDown(self):
        for active in reversed(self.patches):
            active.stop()
        self._temporary.cleanup()

    def _environment(self):
        with redirect_stderr(io.StringIO()) as log:
            result = backend._shared_compile_cache_environment(
                self.workspace, self.build_root, self.base
            )
        return result, log.getvalue()

    def test_mounted_cache_wraps_rustc_and_native_compilers(self):
        variables, _ = self._environment()
        self.assertIsNotNone(variables)
        self.assertEqual(variables["RUSTC_WRAPPER"], str(self.sccache))
        self.assertEqual(variables["CARGO_INCREMENTAL"], "0")
        self.assertEqual(variables["SCCACHE_DIR"], str(self.cache / "sccache"))
        self.assertEqual(variables["CCACHE_DIR"], str(self.cache / "ccache"))
        self.assertEqual(variables["CCACHE_BASEDIR"], str(self.workspace))
        self.assertEqual(variables["CCACHE_COMPILERCHECK"], "content")
        for language in ("C", "CXX", "CUDA"):
            self.assertEqual(variables[f"CMAKE_{language}_COMPILER_LAUNCHER"], str(self.ccache))
        self.assertTrue(Path(variables["CCACHE_STATSLOG"]).is_relative_to(self.build_root))

    def test_absent_or_foreign_mount_disables_cache(self):
        with patch.dict(os.environ, {"FULLMAG_SHARED_COMPILE_CACHE": ""}):
            variables, log = self._environment()
        self.assertIsNone(variables)
        self.assertIn("phase=compile-cache state=disabled reason=not-mounted", log)
        with patch.dict(os.environ, {"FULLMAG_SHARED_COMPILE_CACHE": "/elsewhere"}):
            variables, log = self._environment()
        self.assertIsNone(variables)
        self.assertIn("reason=unexpected-mount", log)

    def test_missing_tool_or_symlinked_directory_disables_cache(self):
        self.ccache.unlink()
        variables, log = self._environment()
        self.assertIsNone(variables)
        self.assertIn("reason=tool-missing", log)
        _tool(self.tools, "ccache")
        target = self.root / "foreign"
        target.mkdir()
        (self.cache / "sccache").rmdir()
        (self.cache / "sccache").symlink_to(target, target_is_directory=True)
        variables, log = self._environment()
        self.assertIsNone(variables)
        self.assertIn("reason=unsafe-directory", log)

    def test_release_profile_never_uses_the_shared_cache(self):
        with patch.object(backend, "_compile_cache_tool") as tool:
            with backend._shared_compile_cache(
                self.workspace, self.build_root, self.base, "release"
            ) as selected:
                self.assertEqual(selected, self.base)
        tool.assert_not_called()

    def test_unavailable_server_falls_back_to_the_uncached_environment(self):
        failed = subprocess.CompletedProcess(["sccache"], 2, b"", b"")
        with patch.object(backend, "_compile_cache_tool", return_value=failed):
            with redirect_stderr(io.StringIO()) as log:
                with backend._shared_compile_cache(
                    self.workspace, self.build_root, self.base, backend.BACKEND_CARGO_PROFILE
                ) as selected:
                    self.assertEqual(selected, self.base)
        self.assertIn("reason=sccache-server-unavailable", log.getvalue())

    def test_session_reports_build_statistics_and_stops_the_server(self):
        stats = {"stats": {
            "cache_hits": {"counts": {"Rust": 410}},
            "cache_misses": {"counts": {"Rust": 12}},
            "requests_not_cacheable": 31,
        }}
        calls = []

        def tool(arguments, environment, *, capture=False):
            calls.append(arguments[1:])
            output = json.dumps(stats).encode() if capture else b""
            return subprocess.CompletedProcess(arguments, 0, output, b"")

        with patch.object(backend, "_compile_cache_tool", side_effect=tool):
            with redirect_stderr(io.StringIO()) as log:
                with backend._shared_compile_cache(
                    self.workspace, self.build_root, self.base, backend.BACKEND_CARGO_PROFILE
                ) as selected:
                    self.assertEqual(selected["RUSTC_WRAPPER"], str(self.sccache))
                    # Real ccache 4.5 logs carry several counters per invocation.
                    Path(selected["CCACHE_STATSLOG"]).write_text(
                        "# a.cpp\nprimary_storage_hit\ndirect_cache_hit\n"
                        "# b.cu\nprimary_storage_miss\ndirect_cache_miss\n"
                        "preprocessed_cache_miss\ncache_miss\n"
                        "# c.cpp\ndirect_cache_miss\npreprocessed_cache_hit\n"
                        "# test_mpi.cpp\npreprocessor_error\n",
                        encoding="utf-8",
                    )
        self.assertEqual(
            calls,
            [["--start-server"], ["--show-stats", "--stats-format=json"], ["--stop-server"]],
        )
        message = log.getvalue()
        self.assertIn("phase=compile-cache state=enabled rust=sccache native=ccache", message)
        self.assertIn(
            "phase=compile-cache state=stats native_hits=2 native_misses=1 "
            "native_uncacheable=1 rust_hits=410 rust_misses=12 rust_uncacheable=31",
            message,
        )

    def test_failed_make_still_stops_the_server(self):
        calls = []

        def tool(arguments, environment, *, capture=False):
            calls.append(arguments[1:])
            return subprocess.CompletedProcess(arguments, 0, b"{}", b"")

        with patch.object(backend, "_compile_cache_tool", side_effect=tool):
            with redirect_stderr(io.StringIO()):
                with self.assertRaises(RuntimeError):
                    with backend._shared_compile_cache(
                        self.workspace, self.build_root, self.base,
                        backend.BACKEND_CARGO_PROFILE,
                    ):
                        raise RuntimeError("make failed")
        self.assertIn(["--stop-server"], calls)

    def test_make_disables_incremental_only_for_the_sccache_wrapper(self):
        makefile = (Path(__file__).resolve().parents[1] / "Makefile").read_text(encoding="utf-8")
        self.assertIn('case "$${RUSTC_WRAPPER:-}" in', makefile)
        self.assertIn("*/sccache|sccache) build_incremental=0;", makefile)


if __name__ == "__main__":
    unittest.main()
