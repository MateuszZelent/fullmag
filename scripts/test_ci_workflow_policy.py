"""Keep PR CI centralized, path-complete, and fail-closed."""
import json
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github/workflows"
PATH_RULES = ROOT / ".github/ci-required-paths.json"
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
GATE_WORKFLOWS = {
    "abl_live_browser": "abl-live-browser",
    "dispersion_artifact_consumers": "dispersion-artifact-consumers",
    "documentation": "documentation",
    "eigensolve_damping_oracle": "eigensolve-damping-oracle",
    "eigensolve_method_contracts": "eigensolve-method-contracts",
    "eigensolve_ui_method_contracts": "eigensolve-ui-method-contracts",
    "pypi_build": "pypi-publish",
    "scoped_mesh_fields": "scoped-mesh-fields",
    "shifted_ksp_true_convergence": "shifted-ksp-true-convergence",
}
CALL_JOBS = {
    "bootstrap": ".github/workflows/bootstrap.yml",
    "contract_guard": ".github/workflows/contract-guard.yml",
    "abl_live_browser": ".github/workflows/abl-live-browser.yml",
    "dispersion_artifact_consumers": ".github/workflows/dispersion-artifact-consumers.yml",
    "documentation": ".github/workflows/documentation-build.yml",
    "eigensolve_damping_oracle": ".github/workflows/eigensolve-damping-oracle.yml",
    "eigensolve_method_contracts": ".github/workflows/eigensolve-method-contracts.yml",
    "eigensolve_ui_method_contracts": ".github/workflows/eigensolve-ui-method-contracts.yml",
    "pypi_build": ".github/workflows/pypi-build.yml",
    "scoped_mesh_fields": ".github/workflows/scoped-mesh-fields.yml",
    "shifted_ksp_true_convergence": ".github/workflows/shifted-ksp-true-convergence.yml",
}


def load(path):
    return yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


class WorkflowPolicyTests(unittest.TestCase):
    def test_specialist_and_operator_workflows_require_explicit_invocation(self):
        for name in MANUAL:
            with self.subTest(workflow=name):
                events = load(WORKFLOWS / f"{name}.yml")["on"]
                self.assertIn("workflow_dispatch", events)
                self.assertLessEqual(set(events), {"workflow_dispatch", "workflow_call"})

    def test_required_ci_workflow_always_creates_one_pr_check(self):
        workflow = load(WORKFLOWS / "ci-required.yml")
        events = workflow["on"]
        self.assertIn("pull_request", events)
        self.assertNotIn("paths", events["pull_request"])
        self.assertIn("edited", events["pull_request"]["types"])
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertIn("ci-required", workflow["concurrency"]["group"])
        self.assertIn("github.event.pull_request.number", workflow["concurrency"]["group"])

        required = workflow["jobs"]["required"]
        self.assertEqual(required["name"], "CI / required")
        self.assertEqual(required["if"], "always()")
        self.assertIn("gate_plan", required["needs"])
        for gate in CALL_JOBS:
            self.assertIn(gate, required["needs"])
            self.assertEqual(
                workflow["jobs"][gate]["uses"],
                f"./{CALL_JOBS[gate]}",
            )
        self.assertIn("ci_required.py validate", required["steps"][-1]["run"])

    def test_callees_are_reusable_and_do_not_duplicate_pr_runs(self):
        callee_files = {
            ".github/workflows/bootstrap.yml",
            ".github/workflows/contract-guard.yml",
            *CALL_JOBS.values(),
        }
        for relative in sorted(callee_files):
            with self.subTest(workflow=relative):
                events = load(ROOT / relative)["on"]
                self.assertIn("workflow_call", events)
                self.assertNotIn("pull_request", events)

    def test_path_rules_cover_all_previously_automatic_pr_gates_and_push_filters(self):
        rules = json.loads(PATH_RULES.read_text(encoding="utf-8"))
        self.assertEqual(set(rules), set(GATE_WORKFLOWS))
        for gate, name in GATE_WORKFLOWS.items():
            with self.subTest(gate=gate):
                workflow = load(WORKFLOWS / f"{name}.yml")
                push = workflow["on"].get("push", {})
                push_paths = push.get("paths", [])
                self.assertLessEqual(set(push_paths), set(rules[gate]))

    def test_ui_and_abl_rules_include_build_dependencies(self):
        rules = json.loads(PATH_RULES.read_text(encoding="utf-8"))
        required = {
            "Cargo.lock",
            "Cargo.toml",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "package.json",
            "patches/**",
            "**/patches/**",
            "apps/control-room/package.json",
        }
        for gate in ("abl_live_browser", "eigensolve_ui_method_contracts"):
            with self.subTest(gate=gate):
                self.assertTrue(required.issubset(set(rules[gate])))

    def test_rust_method_gate_tracks_workspace_and_crate_dependencies(self):
        rules = json.loads(PATH_RULES.read_text(encoding="utf-8"))
        self.assertTrue(
            {
                "Cargo.lock",
                "Cargo.toml",
                "rust-toolchain.toml",
                ".cargo/**",
                "crates/**",
                "backends/**",
            }.issubset(set(rules["eigensolve_method_contracts"]))
        )

    def test_documentation_rule_tracks_validator_contract_and_helpers(self):
        rules = json.loads(PATH_RULES.read_text(encoding="utf-8"))
        self.assertTrue(
            {
                ".agents/skills/scientific-documentation-contract/**",
                "scripts/test_documentation_changelog_tabs.py",
                "scripts/check_public_docs_boundary.py",
                "public_docs/site/conf.py",
                "public_docs/site/requirements.txt",
            }.issubset(set(rules["documentation"]))
        )

    def test_documentation_build_and_publish_permissions_are_separated(self):
        build = load(WORKFLOWS / "documentation-build.yml")
        self.assertEqual(build["permissions"], {"contents": "read"})
        self.assertNotIn("id-token", build["permissions"])
        self.assertNotIn("pages", build["permissions"])
        self.assertEqual(
            build["jobs"]["build"]["permissions"],
            {"contents": "read"},
        )

        publisher = load(WORKFLOWS / "documentation.yml")
        deploy = publisher["jobs"]["deploy"]
        self.assertEqual(deploy["permissions"]["pages"], "write")
        self.assertEqual(deploy["permissions"]["id-token"], "write")
        self.assertIn("actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346", [
            step.get("uses", "") for step in deploy["steps"]
        ])

    def test_pypi_build_and_publish_permissions_are_separated(self):
        build = load(WORKFLOWS / "pypi-build.yml")
        self.assertEqual(build["permissions"], {"contents": "read"})
        self.assertNotIn("id-token", build["permissions"])
        publisher = load(WORKFLOWS / "pypi-publish.yml")
        events = publisher["on"]
        self.assertNotIn("pull_request", events)
        self.assertIn("workflow_dispatch", events)
        self.assertEqual(
            publisher["jobs"]["build"]["uses"],
            "./.github/workflows/pypi-build.yml",
        )
        for job_name in ("publish-testpypi", "publish-pypi"):
            with self.subTest(job=job_name):
                self.assertEqual(
                    publisher["jobs"][job_name]["permissions"]["id-token"],
                    "write",
                )
                self.assertIn(
                    "pypa/gh-action-pypi-publish@7245906fb61fa33a13554f9d5fb856fe61758086",
                    [step.get("uses", "") for step in publisher["jobs"][job_name]["steps"]],
                )

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


if __name__ == "__main__":
    unittest.main()
