"""Check the CPython Docker recipe without compiling Python or its test helpers."""
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest


class DockerPythonNoTestBuildTests(unittest.TestCase):
    def setUp(self):
        dockerfile = Path(__file__).resolve().parents[1] / "docker/fem-gpu/Dockerfile"
        self.step = dockerfile.read_text().split('RUN python_archive="Python-${PYTHON_VERSION}.tar.xz"', 1)[1].split("\nRUN ", 1)[0]
        self.commands = self.step.replace("\\\n", "").split(" && ")

    def test_configure_omits_cpython_test_extensions_and_suites(self):
        configure = next(command.strip() for command in self.commands if command.strip().startswith("./configure "))
        self.assertIn("--disable-test-modules", shlex.split(configure))

    def test_limited_api_examples_are_disabled_before_configure(self):
        setup = next(command.strip() for command in self.commands if " > Modules/Setup.local" in command)
        with tempfile.TemporaryDirectory() as directory:
            modules = Path(directory) / "Modules"
            modules.mkdir()
            subprocess.run(["/bin/sh", "-c", setup], cwd=directory, check=True)
            self.assertEqual((modules / "Setup.local").read_text().splitlines(),
                             ["*disabled*", "xxlimited", "xxlimited_35"])
        self.assertLess(self.step.index(" > Modules/Setup.local"), self.step.index("./configure "))

    @unittest.skipUnless(shutil.which("make"), "GNU make dry-run check requires make")
    def test_build_and_install_skip_embedding_helper_prerequisites(self):
        make_commands = [command.strip() for command in self.commands if command.strip().startswith("make ")]
        self.assertEqual(len(make_commands), 2)
        with tempfile.TemporaryDirectory() as directory:
            # Model the upstream build_all dependency: no recipe is executed.
            (Path(directory) / "Makefile").write_text(
                "all: build_all\n"
                "build_all: interpreter Programs/_testembed\n"
                "interpreter:\n\t@echo production-interpreter\n"
                "Programs/_testembed: Programs/_testembed.o\n\t@echo embedding-test-link\n"
                "Programs/_testembed.o:\n\t@echo embedding-test-compile\n"
                "altinstall: build_all\n\t@echo production-install\n")
            for command in make_commands:
                with self.subTest(command=command):
                    argv = shlex.split(re.sub(r'"\$\(nproc\)"', "2", command))
                    result = subprocess.run([*argv, "--dry-run"], cwd=directory,
                                            text=True, capture_output=True, check=True)
                    self.assertIn("production-interpreter", result.stdout)
                    self.assertNotIn("embedding-test", result.stdout)


if __name__ == "__main__":
    unittest.main()
