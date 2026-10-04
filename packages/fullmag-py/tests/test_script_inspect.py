from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from fullmag.runtime import helper as runtime_helper
from fullmag.runtime.script_inspect import SCRIPT_INSPECT_SCHEMA, inspect_script


class ScriptInspectTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write(self, name: str, content: bytes | str) -> Path:
        path = self.dir / name
        path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
        return path

    def test_never_executes_the_script(self) -> None:
        marker = self.dir / "marker.txt"
        script = self.write(
            "canary.py",
            f'"""Canary script."""\n'
            f"import os\n"
            f"open({str(marker)!r}, 'w').write('executed')\n"
            f"raise SystemExit(3)\n",
        )
        result = inspect_script(script)
        self.assertFalse(marker.exists())
        self.assertEqual(result["syntax"], {"ok": True})
        self.assertEqual(result["summary"], "Canary script.")

    def test_full_report_for_fullmag_style_script(self) -> None:
        body = (
            '"""First line of docs.\n\nMore text."""\n'
            "import os\n"
            "import fullmag as fm\n"
            "from fullmag import units\n"
            "import definitely_not_installed_pkg.sub\n"
            "import sibling_helper\n"
            "DEFAULT_UNTIL = 2 * 1e-9\n"
            "fm.interactive()\n"
            "device = os.environ.get('FULLMAG_SP5_DEVICE', 'cpu')\n"
            "a = os.environ['ALPHA']\n"
            "b = os.getenv('BETA')\n"
            "if 'GAMMA' in os.environ:\n    pass\n"
            "c = os.environ[some_variable]\n"
        )
        script = self.write("sp5.py", body)
        self.write("sibling_helper.py", "x = 1\n")
        result = inspect_script(script)
        self.assertEqual(result["schema"], SCRIPT_INSPECT_SCHEMA)
        self.assertEqual(len(result["sha256"]), 64)
        self.assertEqual(result["bytes"], len(body.encode("utf-8")))
        self.assertEqual(result["lines"], len(body.splitlines()))
        self.assertEqual(result["encoding"], "utf-8")
        self.assertEqual(result["summary"], "First line of docs.")
        self.assertEqual(result["env_reads"], ["ALPHA", "BETA", "FULLMAG_SP5_DEVICE", "GAMMA"])
        self.assertEqual(result["declares"], {"default_until": 2e-9, "interactive": True})
        imports = result["imports"]
        self.assertTrue(imports["fullmag"])
        self.assertEqual(imports["unresolved"], ["definitely_not_installed_pkg"])
        self.assertEqual(imports["local"], ["sibling_helper"])
        self.assertNotIn("os", imports["unresolved"])
        json.dumps(result)

    def test_aliased_os_and_from_imports_are_tracked(self) -> None:
        script = self.write(
            "alias.py",
            "import os as system\n"
            "from os import environ as env, getenv as ge\n"
            "system.environ['A']\nenv.get('B')\nge('C')\nenv['D']\n",
        )
        self.assertEqual(inspect_script(script)["env_reads"], ["A", "B", "C", "D"])

    def test_syntax_error_reports_position_and_still_hashes(self) -> None:
        script = self.write("bad.py", "x = 1\ndef broken(:\n    pass\n")
        result = inspect_script(script)
        self.assertFalse(result["syntax"]["ok"])
        self.assertEqual(result["syntax"]["line"], 2)
        self.assertIsInstance(result["syntax"]["column"], int)
        self.assertTrue(result["syntax"]["message"])
        self.assertEqual(len(result["sha256"]), 64)
        self.assertEqual(result["env_reads"], [])

    def test_utf8_bom_is_detected_and_parses(self) -> None:
        script = self.write("bom.py", b"\xef\xbb\xbf" + "# α\nx = 1\n".encode("utf-8"))
        result = inspect_script(script)
        self.assertEqual(result["encoding"], "utf-8-bom")
        self.assertEqual(result["syntax"], {"ok": True})
        self.assertEqual(result["lines"], 2)

    def test_non_utf8_is_reported_as_other_without_raising(self) -> None:
        script = self.write("latin.py", b"# \xb5\nx = 1\n")
        result = inspect_script(script)
        self.assertEqual(result["encoding"], "other")
        self.assertFalse(result["syntax"]["ok"])
        self.assertIn("UTF-8", result["syntax"]["message"])
        utf16 = self.write("utf16.py", "x = 1\n".encode("utf-16"))
        self.assertEqual(inspect_script(utf16)["encoding"], "other")

    def test_default_until_requires_a_literal(self) -> None:
        script = self.write("dynamic.py", "import os\nDEFAULT_UNTIL = float(os.environ['T'])\n")
        result = inspect_script(script)
        self.assertIsNone(result["declares"]["default_until"])
        self.assertIsNone(result["declares"]["interactive"])
        self.assertEqual(result["env_reads"], ["T"])

    def test_interactive_false_literal(self) -> None:
        script = self.write("quiet.py", "import fullmag as fm\nfm.interactive(False)\n")
        self.assertIs(inspect_script(script)["declares"]["interactive"], False)

    def test_helper_command_prints_json(self) -> None:
        script = self.write("cli.py", '"""Doc."""\nx = 1\n')
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            exit_code = runtime_helper.main(["inspect-script", "--script", str(script)])
        self.assertEqual(exit_code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["schema"], SCRIPT_INSPECT_SCHEMA)
        self.assertEqual(payload["summary"], "Doc.")


if __name__ == "__main__":
    unittest.main()
