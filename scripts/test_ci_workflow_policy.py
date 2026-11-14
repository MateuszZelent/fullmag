"""Keep CI automatic only where it adds distinct coverage."""
from pathlib import Path
import shlex
import subprocess
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
MANUAL = (
    "eigensolve-api-source-contracts",
    "eigensolve-authoring-policy-contracts",
    "eigensolve-spectrum-scope-contracts",
    "frontend-3d-managed-fem",
    "readme-version-dashboard",
    "windows-msi-container",
    "react-doctor",
    "fem-positive-mass-contract",
)


def load(path):
    return yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


class WorkflowPolicyTests(unittest.TestCase):
    def test_specialist_and_operator_workflows_require_explicit_invocation(self):
        for name in MANUAL:
            with self.subTest(workflow=name):
                events = load(WORKFLOWS / f"{name}.yml")["on"]
                self.assertIn("workflow_dispatch", events)
                self.assertLessEqual(set(events), {"workflow_dispatch", "workflow_call"})

    def test_pushes_do_not_duplicate_feature_branch_pr_checks(self):
        for path in WORKFLOWS.glob("*.yml"):
            with self.subTest(workflow=path.name):
                workflow = load(path)
                events = workflow["on"]
                if "push" not in events:
                    continue
                branches = events["push"].get("branches", [])
                self.assertTrue(branches)
                self.assertLessEqual(set(branches), {"master", "main"})
                self.assertIn("pull_request", events)
                concurrency = workflow["concurrency"]
                self.assertEqual(concurrency["cancel-in-progress"], "true")
                self.assertIn("github.event.pull_request.number", concurrency["group"])

    def test_reusable_workflow_references_resolve(self):
        for path in WORKFLOWS.glob("*.yml"):
            for job in load(path)["jobs"].values():
                reference = job.get("uses", "")
                if reference.startswith("./"):
                    with self.subTest(workflow=path.name, reference=reference):
                        self.assertTrue((ROOT / reference).is_file())

    def test_retired_comsol_checks_remain_in_the_consumer_gate(self):
        jobs = load(WORKFLOWS / "dispersion-artifact-consumers.yml")["jobs"]
        runs = "\n".join(step.get("run", "") for step in jobs["artifact-consumer-contracts"]["steps"])
        for test in (
            "test_compare_comsol_a1_frequency_reference.py",
            "test_comsol_tracking_fields.py",
            "test_comsol_tracking_replay.py",
            "test_comsol_cross_run_matching.py",
            "test_comsol_signed_k_replay.py",
            "test_frequency_domain_generation.py",
        ):
            self.assertIn(test, runs)

    def test_terminal_attestation_fails_on_first_or_intermediate_native_error(self):
        job = load(WORKFLOWS / "dispersion-artifact-consumers.yml")["jobs"]["terminal-artifact-attestation"]
        self.assertEqual(job["strategy"]["matrix"]["os"], ["ubuntu-latest", "windows-latest"])
        # GitHub's explicit bash shell runs with -eo pipefail on both OSes.
        # Its default pwsh wrapper can otherwise report only the final exit code.
        shell = job.get("defaults", {}).get("run", {}).get("shell")
        self.assertEqual(shell, "bash")
        for step in job["steps"]:
            if "run" in step:
                self.assertEqual(step.get("shell", shell), "bash")
                self.assertNotIn(step.get("continue-on-error"), (True, "true"))
        for failing_index in (0, 1):
            with self.subTest(failing_index=failing_index):
                commands = ["bash -c " + shlex.quote("exit " + str(37 if i == failing_index else 0))
                            for i in range(3)]
                commands.append("printf terminal_attestation_must_not_reach_success")
                result = subprocess.run(
                    [shell, "--noprofile", "--norc", "-eo", "pipefail", "-c", "\n".join(commands)],
                    capture_output=True, text=True, check=False,
                )
                self.assertEqual(result.returncode, 37, result.stderr)
                self.assertNotIn("must_not_reach_success", result.stdout)

    def test_terminal_attestation_keeps_host_gates_on_both_operating_systems(self):
        job = load(WORKFLOWS / "dispersion-artifact-consumers.yml")["jobs"]["terminal-artifact-attestation"]
        common = "\n".join(step.get("run", "") for step in job["steps"] if "if" not in step)
        for name in (
            "test_managed_runtime_artifact_root", "test_fullmag_docker_runtime",
            "test_docker_startup_script", "test_docker_frontend_dev",
            "test_verify_docker_all_runtime", "test_docker_host_ledger",
            "test_bootstrap_docker_toolchain",
        ):
            with self.subTest(suite=name):
                self.assertIn("scripts/" + name + ".py", common)
        entrypoint, = [step for step in job["steps"]
                       if "scripts/test_docker_entrypoint_device_access.py" in step.get("run", "")]
        self.assertEqual(entrypoint.get("if"), "runner.os == 'Linux'")


if __name__ == "__main__":
    unittest.main()
