"""Interpret the publication Python selector without builds or runtime launches."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
POWERSHELL = shutil.which("powershell.exe") or shutil.which("pwsh")
INTERPRETER = os.environ.get("FULLMAG_TEST_PUBLICATION_PYTHON")
PYTHON_ROOT = os.environ.get("FULLMAG_TEST_PUBLICATION_PYTHON_ROOT")


def probe(parent):
    command = r'''
param([string]$Launcher,[string]$Adapter,[string]$Interpreter,[string]$Root,[string]$Parent)
$ErrorActionPreference="Stop"
foreach ($entry in @(@($Launcher,"Resolve-NativePublicationPython"),
                     @($Adapter,"Resolve-FullmagStoragePath"),
                     @($Adapter,"Assert-FullmagStoragePath"))) {
  $tokens=$null; $errors=$null
  $ast=[System.Management.Automation.Language.Parser]::ParseFile($entry[0],[ref]$tokens,[ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
  $name=$entry[1]
  $functions=@($ast.FindAll({param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
  },$true))
  if ($functions.Count -ne 1) { throw "Missing selector function $name" }
  . ([scriptblock]::Create($functions[0].Extent.Text))
}
$PythonExe=$Interpreter; $PythonRoot=$Parent
$StorageLayout=@{storage_root=$Root}
$selected=Resolve-NativePublicationPython
$observation=(& $selected -B -c "import os,json; print(json.dumps({'ppid':os.getppid()}))" | Out-String) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Selected interpreter probe failed" }
@{selected=$selected; launcher_pid=$PID; publisher_parent=$observation.ppid} | ConvertTo-Json -Compress
'''
    # -Command accepts the script block and separate arguments without writing a script.
    escaped = lambda value: "'" + str(value).replace("'", "''") + "'"
    script = "& {" + command + "} " + " ".join(escaped(value) for value in (
        ROOT / "scripts/windows/run_fullmag.ps1",
        ROOT / "scripts/windows/fullmag_storage.ps1",
        INTERPRETER, PYTHON_ROOT, parent,
    ))
    return subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script],
                          capture_output=True, text=True, timeout=30)


@unittest.skipUnless(POWERSHELL and INTERPRETER and PYTHON_ROOT,
                     "PowerShell and explicit managed Python/storage paths required")
class PublicationPythonTests(unittest.TestCase):
    def test_publication_interpreter_is_direct_child_of_launcher(self):
        result = probe(PYTHON_ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed["publisher_parent"], observed["launcher_pid"])
        self.assertTrue(Path(observed["selected"]).is_file())
        self.assertTrue(Path(observed["selected"]).resolve().is_relative_to(Path(PYTHON_ROOT).resolve()))

    def test_publication_interpreter_outside_python_root_is_rejected(self):
        result = probe(Path(INTERPRETER).parent)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be contained", result.stderr)

    def test_publication_call_does_not_reintroduce_path_or_venv_redirector(self):
        source = (ROOT / "scripts/windows/run_fullmag.ps1").read_text(encoding="utf-8")
        self.assertTrue('$publicationPython = Resolve-NativePublicationPython' in source,
                        "Publication must resolve its real managed interpreter")
        self.assertTrue('(& $publicationPython -B (Join-Path $PSScriptRoot "stable_launch.py")' in source,
                        "Publication must invoke the real interpreter directly")
        guard = (ROOT / "scripts/windows/stable_launch.py").read_text(encoding="utf-8")
        self.assertIn('if launcher_pid != os.getppid():', guard)
        self.assertIn('status.get("launch_nonce") != expected_nonce', guard)


if __name__ == "__main__":
    unittest.main()
