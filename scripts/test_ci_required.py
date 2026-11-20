import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "ci"))

import ci_required


class ChangedPathTests(unittest.TestCase):
    def test_changed_paths_include_both_sides_of_a_rename(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)

            def git(*args):
                return subprocess.check_output(
                    ["git", *args], cwd=repo, text=True, stderr=subprocess.PIPE
                ).strip()

            git("init", "--quiet")
            git("config", "user.email", "ci@example.invalid")
            git("config", "user.name", "CI")
            (repo / "old.py").write_text("stable content\n", encoding="utf-8")
            git("add", "old.py")
            git("commit", "--quiet", "-m", "base")
            base = git("rev-parse", "HEAD")
            git("mv", "old.py", "new.py")
            git("commit", "--quiet", "-m", "rename")
            head = git("rev-parse", "HEAD")

            self.assertEqual(
                ci_required.changed_paths(repo, base, head),
                {"old.py", "new.py"},
            )

    def test_noop_diff_has_no_changed_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
            subprocess.run(
                ["git", "config", "user.email", "ci@example.invalid"],
                cwd=repo,
                check=True,
            )
            subprocess.run(
                ["git", "config", "user.name", "CI"], cwd=repo, check=True
            )
            (repo / "file.txt").write_text("one\n", encoding="utf-8")
            subprocess.run(["git", "add", "file.txt"], cwd=repo, check=True)
            subprocess.run(
                ["git", "commit", "--quiet", "-m", "base"], cwd=repo, check=True
            )
            head = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=repo, text=True
            ).strip()

            self.assertEqual(ci_required.changed_paths(repo, head, head), set())

    def test_missing_diff_commit_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
            with self.assertRaises(ci_required.GateSelectionError):
                ci_required.changed_paths(repo, "a" * 40, "b" * 40)


class GatePlanTests(unittest.TestCase):
    def test_empty_diff_selects_the_full_stack(self):
        rules = {"docs": ["public_docs/site/**"]}
        self.assertEqual(
            ci_required.select_gates([], rules),
            {"bootstrap": True, "contract_guard": True, "docs": True},
        )

    def test_unsupported_glob_syntax_fails_closed(self):
        rules = ci_required.load_rules()
        rules["abl_live_browser"][0] = "apps/control-room/?/app.ts"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            path.write_text(json.dumps(rules), encoding="utf-8")
            with self.assertRaises(ci_required.GateSelectionError):
                ci_required.load_rules(path)

    def test_path_patterns_cover_root_and_nested_globstar_paths(self):
        self.assertTrue(ci_required.path_matches("README.md", "**/README.md"))
        self.assertTrue(ci_required.path_matches("a/b/README.md", "**/README.md"))
        self.assertTrue(ci_required.path_matches("crates/a/src/lib.rs", "crates/**/src/*.rs"))
        self.assertFalse(ci_required.path_matches("crates/a/src/lib.ts", "crates/**/src/*.rs"))

    def test_renamed_path_selects_gate_by_old_or_new_name(self):
        rules = {"docs": ["public_docs/site/**"]}
        self.assertTrue(
            ci_required.select_gates(
                ["public_docs/site/old.md", "internal/new.md"], rules
            )["docs"]
        )

    def test_docs_only_pull_request_skips_bootstrap_but_keeps_docs_and_guard(self):
        rules = {"documentation": ["public_docs/site/**"], "python": ["packages/fullmag-py/**"]}
        self.assertEqual(
            ci_required.select_gates(
                [
                    "public_docs/site/physics/dmi.md",
                    "public_docs/site/physics/dmi.source-map.json",
                ],
                rules,
                event_name="pull_request",
            ),
            {
                "bootstrap": False,
                "contract_guard": True,
                "documentation": True,
                "python": False,
            },
        )

    def test_mixed_docs_and_source_pull_request_keeps_full_bootstrap(self):
        rules = {"documentation": ["public_docs/site/**"], "python": ["packages/fullmag-py/**"]}
        plan = ci_required.select_gates(
            ["public_docs/site/physics/dmi.md", "packages/fullmag-py/src/fullmag/api.py"],
            rules,
            event_name="pull_request",
        )
        self.assertTrue(all(plan.values()))

    def test_docs_only_plan_allows_only_the_planned_bootstrap_skip(self):
        expected = {
            "bootstrap": False,
            "contract_guard": True,
            "documentation": True,
        }
        results = {
            "bootstrap": "skipped",
            "contract_guard": "success",
            "documentation": "success",
        }
        ci_required.validate_results(expected, results, "success")

    def test_docs_only_paths_on_push_keep_full_bootstrap(self):
        rules = {"documentation": ["public_docs/site/**"]}
        plan = ci_required.select_gates(
            ["public_docs/site/physics/dmi.md"], rules, event_name="push"
        )
        self.assertTrue(plan["bootstrap"])

    def test_docs_in_fixtures_are_not_eligible_for_optimization(self):
        rules = {"documentation": ["public_docs/site/**"]}
        plan = ci_required.select_gates(
            ["public_docs/site/fixtures/example.md"], rules, event_name="pull_request"
        )
        self.assertTrue(plan["bootstrap"])

    def test_changes_to_ci_workflow_select_all_path_gates(self):
        rules = {"docs": ["public_docs/site/**"], "python": ["packages/fullmag-py/**"]}
        self.assertEqual(
            ci_required.select_gates(
                [".github/workflows/ci-required.yml"], rules
            ),
            {
                "bootstrap": True,
                "contract_guard": True,
                "docs": True,
                "python": True,
            },
        )

    def test_unknown_path_selects_the_full_stack(self):
        rules = {"docs": ["public_docs/site/**"], "python": ["packages/fullmag-py/**"]}
        plan = ci_required.select_gates(["unclassified/new-input.bin"], rules)
        self.assertTrue(all(plan.values()))

    def test_mixed_gate_paths_select_the_full_stack(self):
        rules = {"docs": ["public_docs/site/**"], "python": ["packages/fullmag-py/**"]}
        plan = ci_required.select_gates(
            ["public_docs/site/physics/dmi.rst", "packages/fullmag-py/src/fullmag/api.py"],
            rules,
        )
        self.assertTrue(all(plan.values()))

    def test_newline_path_fails_closed(self):
        rules = {"docs": ["public_docs/site/**"]}
        with self.assertRaises(ci_required.GateSelectionError):
            ci_required.select_gates(["public_docs/site/odd\nname.md"], rules)

    def test_non_ci_source_uses_only_matching_path_gate(self):
        rules = {"docs": ["public_docs/site/**"], "python": ["packages/fullmag-py/**"]}
        self.assertEqual(
            ci_required.select_gates(["packages/fullmag-py/src/fullmag/api.py"], rules),
            {
                "bootstrap": True,
                "contract_guard": True,
                "docs": False,
                "python": True,
            },
        )


class RequiredResultTests(unittest.TestCase):
    def test_success_and_expected_skip_pass(self):
        expected = {
            "bootstrap": True,
            "contract_guard": True,
            "docs": False,
        }
        results = {
            "bootstrap": "success",
            "contract_guard": "success",
            "docs": "skipped",
        }
        ci_required.validate_results(expected, results, "success")

    def test_selected_gate_may_not_be_skipped(self):
        expected = {"bootstrap": True, "contract_guard": True, "docs": True}
        results = {
            "bootstrap": "success",
            "contract_guard": "success",
            "docs": "skipped",
        }
        with self.assertRaises(ci_required.GateSelectionError):
            ci_required.validate_results(expected, results, "success")

    def test_contract_guard_cannot_be_skipped_by_a_plan(self):
        expected = {
            "bootstrap": True,
            "contract_guard": False,
            "documentation": False,
        }
        results = {
            "bootstrap": "success",
            "contract_guard": "skipped",
            "documentation": "skipped",
        }
        with self.assertRaises(ci_required.GateSelectionError):
            ci_required.validate_results(expected, results, "success")

    def test_bootstrap_skip_requires_the_docs_only_plan_shape(self):
        invalid_plans = (
            {
                "bootstrap": False,
                "contract_guard": True,
                "documentation": False,
            },
            {
                "bootstrap": False,
                "contract_guard": True,
                "documentation": True,
                "pypi_build": True,
            },
        )
        for expected in invalid_plans:
            with self.subTest(expected=expected):
                results = {
                    gate: "success" if selected else "skipped"
                    for gate, selected in expected.items()
                }
                with self.assertRaises(ci_required.GateSelectionError):
                    ci_required.validate_results(expected, results, "success")

    def test_failures_and_cancellations_never_pass(self):
        expected = {"bootstrap": True, "contract_guard": True}
        for state in ("failure", "cancelled", "timed_out", "unknown"):
            with self.subTest(state=state):
                results = {"bootstrap": "success", "contract_guard": state}
                with self.assertRaises(ci_required.GateSelectionError):
                    ci_required.validate_results(expected, results, "success")

    def test_a_failed_or_skipped_plan_never_passes(self):
        expected = {"bootstrap": True, "contract_guard": True}
        results = {"bootstrap": "success", "contract_guard": "success"}
        for state in ("failure", "cancelled", "skipped"):
            with self.subTest(state=state):
                with self.assertRaises(ci_required.GateSelectionError):
                    ci_required.validate_results(expected, results, state)

    def test_unexpected_execution_of_an_unselected_gate_fails(self):
        expected = {"bootstrap": True, "contract_guard": True, "docs": False}
        results = {
            "bootstrap": "success",
            "contract_guard": "success",
            "docs": "success",
        }
        with self.assertRaises(ci_required.GateSelectionError):
            ci_required.validate_results(expected, results, "success")


if __name__ == "__main__":
    unittest.main()
