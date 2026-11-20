from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch
import unittest

import fullmag as fm
from fullmag.runtime.helper import main


RUNTIME_FLAG_KEYS = ("interactive_session_requested", "wait_for_solve")


def _script(
    name: str,
    *,
    interactive: bool = False,
    wait_for_solve: bool = False,
    raw_runtime_flags: tuple[object, object] | None = None,
    vector_count: int = 0,
) -> str:
    cell_length = vector_count if vector_count else 1
    lines = [
        "import fullmag as fm",
        f"fm.study({name!r})",
        "fm.engine('fdm')",
        f"fm.cell({cell_length}e-9, 1e-9, 1e-9)",
        f"fm.interactive({interactive!r})",
        f"film = fm.geometry(fm.Box({cell_length}e-9, 1e-9, 1e-9), name='film')",
        "film.Ms = 800e3",
        "film.Aex = 13e-12",
        "film.alpha = 0.02",
    ]
    if wait_for_solve:
        lines.append("fm.wait_for_solve(True)")
    if vector_count:
        lines.extend(
            [
                "direction = (0.5773502691896257, 0.5773502691896257, 0.5773502691896257)",
                f"film.m = fm.init.SampledMagnetization("
                f"[direction for _ in range({vector_count})])",
            ]
        )
    else:
        lines.append("film.m = fm.texture.uniform(1, 0, 0)")
    if raw_runtime_flags is not None:
        interactive_value, wait_value = raw_runtime_flags
        lines.extend(
            [
                f"fm.runtime_metadata('interactive_session_requested', {interactive_value!r})",
                f"fm.runtime_metadata('wait_for_solve', {wait_value!r})",
            ]
        )
    lines.append("fm.run(1e-12)")
    return "\n".join(lines) + "\n"


class RuntimeFlagsExportTests(unittest.TestCase):
    def tearDown(self) -> None:
        fm.reset()

    def _export(
        self,
        source: Path,
        *,
        runtime_flags_only: bool = False,
        source_snapshot: Path | None = None,
    ) -> tuple[int, str, str]:
        args = ["export-run-config", "--script", str(source), "--skip-geometry-assets"]
        if source_snapshot is not None:
            args.extend(["--source-snapshot", str(source_snapshot)])
        if runtime_flags_only:
            args.append("--runtime-flags-only")
        stdout = StringIO()
        stderr = StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                status = main(args)
            except SystemExit as error:
                status = int(error.code)
        return status, stdout.getvalue(), stderr.getvalue()

    @staticmethod
    def _runtime_flags(config: dict[str, object]) -> dict[str, object]:
        metadata = config["ir"]["problem_meta"]["runtime_metadata"]
        return {key: metadata[key] for key in RUNTIME_FLAG_KEYS if key in metadata}

    def test_thin_export_matches_canonical_flags_and_honors_source_snapshot(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "workspace.py"
            snapshot = root / "captured.py"
            source.write_text(_script("uncaptured", interactive=False), encoding="utf-8")
            snapshot.write_text(
                _script("captured", interactive=True, wait_for_solve=True),
                encoding="utf-8",
            )

            full_status, full_raw, _ = self._export(source, source_snapshot=snapshot)
            thin_status, thin_raw, _ = self._export(
                source,
                runtime_flags_only=True,
                source_snapshot=snapshot,
            )

        self.assertEqual(full_status, 0)
        self.assertEqual(thin_status, 0)
        full = json.loads(full_raw)
        thin = json.loads(thin_raw)
        self.assertEqual(full["ir"]["problem_meta"]["name"], "captured")
        self.assertEqual(
            thin,
            {"ir": {"problem_meta": {"runtime_metadata": self._runtime_flags(full)}}},
        )
        self.assertEqual(
            thin["ir"]["problem_meta"]["runtime_metadata"],
            {"interactive_session_requested": True, "wait_for_solve": True},
        )
        # The normal command remains the full run-config envelope.
        self.assertIn("stages", full)
        self.assertIn("study_pipeline", full)
        self.assertIn("magnets", full["ir"])

    def test_thin_export_keeps_false_and_missing_values_without_defaults(self) -> None:
        cases = (
            ("disabled", False, False),
            ("wait_without_interactive", False, True),
        )
        for name, interactive, wait_for_solve in cases:
            with self.subTest(name=name), TemporaryDirectory() as temporary:
                source = Path(temporary) / "runtime_flags.py"
                source.write_text(
                    _script(name, interactive=interactive, wait_for_solve=wait_for_solve),
                    encoding="utf-8",
                )
                full_status, full_raw, _ = self._export(source)
                thin_status, thin_raw, _ = self._export(source, runtime_flags_only=True)

            self.assertEqual((full_status, thin_status), (0, 0))
            full = json.loads(full_raw)
            thin = json.loads(thin_raw)
            flags = thin["ir"]["problem_meta"]["runtime_metadata"]
            self.assertEqual(flags, self._runtime_flags(full))
            self.assertIs(flags["interactive_session_requested"], False)
            if wait_for_solve:
                self.assertIs(flags["wait_for_solve"], True)
            else:
                self.assertNotIn("wait_for_solve", flags)

    def test_thin_export_preserves_authored_flag_types(self) -> None:
        with TemporaryDirectory() as temporary:
            source = Path(temporary) / "runtime_flags_types.py"
            source.write_text(
                _script(
                    "typed_flags",
                    raw_runtime_flags=("false", 1),
                ),
                encoding="utf-8",
            )
            full_status, full_raw, _ = self._export(source)
            thin_status, thin_raw, _ = self._export(source, runtime_flags_only=True)

        self.assertEqual((full_status, thin_status), (0, 0))
        full = json.loads(full_raw)
        thin = json.loads(thin_raw)
        flags = thin["ir"]["problem_meta"]["runtime_metadata"]
        self.assertEqual(flags, self._runtime_flags(full))
        self.assertEqual(flags, {"interactive_session_requested": "false", "wait_for_solve": 1})

    def test_thin_export_reads_authoring_flags_without_ir_or_execution_identity(self) -> None:
        loaded = SimpleNamespace(
            pipeline_base_problem=lambda: SimpleNamespace(runtime_metadata={
                "interactive_session_requested": "false", "wait_for_solve": 1,
                "other": "not exported",
            }),
        )
        stdout = StringIO()
        with (
            patch("fullmag.runtime.helper._load_script", return_value=loaded),
            patch("fullmag.runtime.helper._write_executed_problem_ir_identity") as identity,
            redirect_stdout(stdout), redirect_stderr(StringIO()),
        ):
            status = main(["export-run-config", "--script", "unused.py", "--runtime-flags-only"])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(stdout.getvalue()), {"ir": {"problem_meta": {
            "runtime_metadata": {"interactive_session_requested": "false", "wait_for_solve": 1}
        }}})
        identity.assert_not_called()

    def test_thin_export_preserves_malformed_authoring_metadata_for_rejection(self) -> None:
        for problem, expected in ((SimpleNamespace(), None), (SimpleNamespace(runtime_metadata=None), None),
                                  (SimpleNamespace(runtime_metadata="invalid"), "invalid")):
            with self.subTest(problem=problem):
                loaded = SimpleNamespace(pipeline_base_problem=lambda: problem)
                stdout = StringIO()
                with patch("fullmag.runtime.helper._load_script", return_value=loaded), redirect_stdout(stdout), redirect_stderr(StringIO()):
                    self.assertEqual(main(["export-run-config", "--script", "unused.py", "--runtime-flags-only"]), 0)
                self.assertEqual(json.loads(stdout.getvalue())["ir"]["problem_meta"]["runtime_metadata"], expected)

    def test_stage_only_gpu_bb_exports_runtime_flags_before_base_ir_validation(self) -> None:
        with TemporaryDirectory() as temporary:
            source = Path(temporary) / "gpu_bb.py"
            source.write_text("""import fullmag as fm
study = fm.study('stage-only-bb')
study.engine('fem')
study.device('gpu', precision='double')
study.fem_bb_preconditioner('exchange_mass')
study.interactive(True)
body = study.geometry(fm.Box(20e-9, 20e-9, 20e-9), name='body')
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.init.UniformMagnetization((1, 0, 0))
body.mesh(maximum_element_size=20e-9, order=1)
study.relax(algorithm='projected_gradient_bb', max_steps=2, tolA=1e-6)
study.wait_for_solve(True)
""", encoding="utf-8")
            status, raw, _ = self._export(source, runtime_flags_only=True)
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(raw)["ir"]["problem_meta"]["runtime_metadata"], {
            "interactive_session_requested": True, "wait_for_solve": True,
        })

    def test_large_initial_state_is_omitted_from_thin_output(self) -> None:
        vector_count = 18_528
        with TemporaryDirectory() as temporary:
            source = Path(temporary) / "large_initial_state.py"
            source.write_text(
                _script("large_initial_state", vector_count=vector_count),
                encoding="utf-8",
            )
            full_status, full_raw, _ = self._export(source)
            thin_status, thin_raw, _ = self._export(source, runtime_flags_only=True)

        self.assertEqual((full_status, thin_status), (0, 0))
        full = json.loads(full_raw)
        thin = json.loads(thin_raw)
        initial = full["ir"]["magnets"][0]["initial_magnetization"]["values"]
        self.assertEqual(len(initial), vector_count)
        self.assertGreater(len(full_raw.encode("utf-8")), 1024 * 1024)
        self.assertLess(len(thin_raw.encode("utf-8")), 16 * 1024)
        expected = {"ir": {"problem_meta": {"runtime_metadata": self._runtime_flags(full)}}}
        self.assertEqual(thin, expected)
        self.assertNotIn("magnets", thin["ir"])
        self.assertNotIn("geometry_assets", thin["ir"])
        self.assertNotIn("stages", thin)


if __name__ == "__main__":
    unittest.main()
