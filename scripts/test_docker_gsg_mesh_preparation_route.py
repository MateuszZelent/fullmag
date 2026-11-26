"""Exercise the exact just/shell preparation boundary without Docker or meshing."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class MeshPreparationRouteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = Path(__file__).resolve().parents[1]
        self.fake = self.root / "python3"
        self.fake.write_text("#!/usr/bin/python3\nimport json,sys\nif sys.argv[1:2] != ['-c']: print(json.dumps(sys.argv[1:]))\n")
        self.fake.chmod(0o755)
        self.environment = dict(os.environ, FULLMAG_STORAGE_PYTHON=str(self.fake))
        self.arguments = [str(self.repo), "a" * 32, "b" * 64, "35"]

    def recipe(self):
        result = subprocess.run(["just", "--dry-run", "docker-dev-gsg-mesh-prepare", *self.arguments],
                                cwd=self.repo, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stderr.strip()

    def invoke(self, body):
        return subprocess.run(["bash", str(self.repo / "scripts/just_storage_shell.sh"), body],
                              env=self.environment, capture_output=True, text=True)

    def test_real_just_recipe_preserves_all_pins_and_uses_fixed_controller(self):
        for level in ("50", "35", "25", "corner25", "corner12p5", "retained-edges92", "retained-corner12p5"):
            with self.subTest(level=level):
                self.arguments[-1] = level
                result = self.invoke(self.recipe())
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), ["-B", str(self.repo / "scripts/docker_gsg_mesh_preparation.py"),
                    "--source-root", str(self.repo), "--attempt", "a" * 32,
                    "--config-sha256", "b" * 64, "--level", level])

    def test_fine_reference_modes_preserve_request_pin_without_shell_evaluation(self):
        marker=self.root/'must-not-exist'
        for mode in ('junction-fine-preflight','junction-fine-run'):
            result=subprocess.run(['just','--dry-run','docker-dev-gsg-reference',str(self.repo),
                                   'a'*32,'b'*64,mode,'c'*64],
                                  cwd=self.repo,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            body=result.stderr.strip()
            observed=self.invoke(body)
            self.assertEqual(observed.returncode,0,observed.stderr)
            values=json.loads(observed.stdout)
            self.assertEqual(values[-4:],['--mode',mode,'--request-sha256','c'*64])
            bad=self.invoke(body+f'; touch {marker}')
            self.assertEqual(bad.returncode,2)
            self.assertFalse(marker.exists())

    def test_explicit_86k_work_profile_reaches_only_the_fixed_reference_controller(self):
        work="gsg_junction_fine_reference_86k_v1"
        for mode in ("junction-fine-preflight","junction-fine-run"):
            command=["just","--dry-run","docker-dev-gsg-reference",str(self.repo),"a"*32,"b"*64,mode,"c"*64,work]
            dry=subprocess.run(command,cwd=self.repo,capture_output=True,text=True)
            self.assertEqual(dry.returncode,0,dry.stderr)
            result=self.invoke(dry.stderr.strip())
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)[-6:],
                ["--mode",mode,"--request-sha256","c"*64,"--work-profile",work])
            bad=self.invoke(dry.stderr.strip().replace(work,"unknown-work-profile"))
            self.assertEqual(bad.returncode,2)

    def test_prestart_close_recipe_is_closed_and_defaults_to_preview(self):
        marker = self.root/"must-not-exist"
        for pin in ("", "c"*64):
            command = ["just", "--dry-run", "docker-dev-gsg-prestart-close", str(self.repo), "a"*32, "b"*64]
            if pin: command.append(pin)
            dry = subprocess.run(command, cwd=self.repo, capture_output=True, text=True)
            self.assertEqual(dry.returncode, 0, dry.stderr)
            observed = self.invoke(dry.stderr.strip())
            self.assertEqual(observed.returncode, 0, observed.stderr)
            expected = ["-B", str(self.repo/"scripts/docker_gsg_mesh_preparation.py"),
                        "--source-root", str(self.repo), "--attempt", "a"*32,
                        "--config-sha256", "b"*64, "--level", "retained-corner12p5", "--close-prestart"]
            if pin: expected.extend(["--preview-sha256", pin])
            self.assertEqual(json.loads(observed.stdout), expected)
            for suffix in ("; touch "+str(marker), " --apply", " --preview-sha256 'short'"):
                refused = self.invoke(dry.stderr.strip()+suffix)
                self.assertEqual(refused.returncode, 2)
                self.assertFalse(marker.exists())

    def test_invalid_level_and_pins_are_rejected_before_controller(self):
        for index, bad in ((1, "short"), (2, "not-a-hash"), (3, "75"), (3, "../50"), (3, "corner35"), (3, "../corner25"), (3, "corner12p6"), (3, "../corner12p5")):
            with self.subTest(index=index, value=bad):
                original = self.arguments[index]
                self.arguments[index] = bad
                result = self.invoke(self.recipe())
                self.arguments[index] = original
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")

    def test_extra_command_or_execution_flag_is_rejected_without_evaluation(self):
        marker = self.root / "must-not-exist"
        for suffix in (f"; touch {marker}", " --submit-only", " --api-url http://127.0.0.1:8081"):
            with self.subTest(suffix=suffix):
                result = self.invoke(self.recipe() + suffix)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
