"""CLI/API command-result source checks; no Rust tests or solver execution."""
import os
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ORCHESTRATOR = "crates/fullmag-cli/src/orchestrator.rs"


def source(relative):
    tree = os.environ.get("FULLMAG_COMMAND_RESULT_SOURCE_TREE", "WORKTREE")
    if tree == "WORKTREE":
        return (ROOT / relative).read_text(encoding="utf-8")
    reference = ":" + relative if tree == "INDEX" else tree + ":" + relative
    return subprocess.check_output(
        ["git", "show", reference], cwd=ROOT, text=True, encoding="utf-8"
    )


def rust_block(text, marker):
    name = marker.removeprefix("fn ").removesuffix("(")
    match = re.search(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+" + re.escape(name) + r"\(", text)
    if match is None:
        raise ValueError(f"missing function declaration: {name}")
    start = text.index("{", match.end())
    depth = 1
    cursor = start + 1
    while depth:
        depth += (text[cursor] == "{") - (text[cursor] == "}")
        cursor += 1
    return text[start + 1:cursor - 1]


class CommandResultIdentitySourceTests(unittest.TestCase):
    def test_energy_completion_never_uses_old_scalars_or_idle_readiness(self):
        body = rust_block(source("crates/fullmag-api/src/session.rs"),
                          "fn infer_dispatched_command_completion(")
        energies = body.split('"compute_energies"', 1)[1].split('"set_solver_profile"', 1)[0]
        self.assertIn('command_has_terminal_log(record, snapshot, "Compute energies failed")', energies)
        self.assertIn('command_has_terminal_log(record, snapshot, "Energies computed")', energies)
        self.assertNotIn("snapshot.scalar_rows", energies)
        self.assertNotIn("snapshot_runtime_accepts_commands", energies)

    def test_import_errors_share_the_reconciler_terminal_marker(self):
        text = source(ORCHESTRATOR)
        self.assertFalse('"State import command is missing state_path"' in text,
                         "missing-path errors must use the terminal import marker")
        self.assertFalse('"Failed to apply imported workspace state:' in text,
                         "apply failures must use the terminal import marker")
        self.assertTrue('"Failed to load workspace state: missing state_path"' in text, "missing-path result has no terminal marker")
        self.assertTrue('"Failed to load workspace state: load-state is disabled' in text, "paused import refusal has no terminal marker")

    def test_compute_and_import_terminal_logs_have_exact_command_identity(self):
        text = source(ORCHESTRATOR).split("#[cfg(test)]\nmod tests", 1)[0]
        markers = ("Compute fields failed", "Field snapshots computed", "Compute energies failed",
                   "Energies computed", "Failed to load workspace state", "Loaded workspace state from")
        owners = {"cmd": 0, "command": 0}
        for match in re.finditer(r"\.push_(?:command_)?log\(", text):
            start = match.end() - 1
            cursor, depth = start + 1, 1
            while depth:
                depth += (text[cursor] == "(") - (text[cursor] == ")")
                cursor += 1
            call = text[match.start():cursor]
            if not any(marker in call for marker in markers):
                continue
            self.assertTrue(call.startswith(".push_command_log("), "uncorrelated terminal log")
            owner = re.search(r"push_command_log\(\s*&(cmd|command)\.command_id,", call)
            self.assertIsNotNone(owner, "terminal result must use the captured command ID")
            owners[owner.group(1)] += 1
        self.assertEqual(owners, {"cmd": 7, "command": 9})

    def test_reconciler_requires_id_and_field_result_not_cached_readiness_alone(self):
        text = source("crates/fullmag-api/src/session.rs")
        helper = rust_block(text, "fn command_has_terminal_log(")
        self.assertIn('"compute_fields" | "compute_energies" | "load_state"', helper)
        self.assertIn("entry.command_id.as_deref().map_or(", helper)
        self.assertIn("!requires_command_id,", helper)
        self.assertIn("|command_id| command_id == record.command.command_id.as_str()", helper)
        self.assertIn("entry.timestamp_unix_ms >= min_timestamp", helper)
        body = rust_block(text, "fn infer_dispatched_command_completion(")
        fields = body.split('"compute_fields"', 1)[1].split('"compute_energies"', 1)[0]
        self.assertIn('command_has_terminal_log(record, snapshot, "Field snapshots computed")', fields)
        self.assertIn("&& command_readiness_matches_requirements(record, snapshot)", fields)

    def test_cli_emits_existing_optional_wire_identity_under_log_lock(self):
        cli_type = source("crates/fullmag-cli/src/types.rs").split("struct EngineLogEntry {", 1)[1].split("}", 1)[0]
        self.assertIn("pub command_id: Option<String>", cli_type)
        self.assertIn('#[serde(default, skip_serializing_if = "Option::is_none")]', cli_type)
        body = rust_block(source("crates/fullmag-cli/src/live_workspace.rs"), "fn push_command_log(")
        self.assertIn("push_engine_log(&mut state.engine_log, level, message)", body)
        self.assertIn("entry.command_id = Some(command_id.to_string())", body)
        self.assertLess(body.index("entry.command_id ="), body.index("self.publish_snapshot()"))
        self.assertIn("self.state.lock()", body)
        upsert = rust_block(source("crates/fullmag-cli/src/formatting.rs"), "fn upsert_engine_log_tail(")
        self.assertLess(upsert.index("last.command_id.is_none()"), upsert.index("last.message = message"))

    def test_rust_fixture_covers_missing_foreign_stale_and_same_millisecond_results(self):
        body = rust_block(source("crates/fullmag-api/src/session.rs"),
                          "fn snapshot_reconciliation_requires_fresh_exact_identity_for_compute_and_import_results(")
        for kind in ("compute_fields", "compute_energies", "load_state"):
            self.assertEqual(body.count(f'("{kind}",'), 2)
        for case in ('engine_log(dispatched_at, "system", marker)',
                     'command_engine_log("cmd-other", dispatched_at, "system", marker)',
                     'command_engine_log("cmd-target", dispatched_at - 1, "system", marker)',
                     '"cmd-target", dispatched_at, "system", marker,'):
            self.assertIn(case, body)
        self.assertIn("command_readiness_matches_requirements(&record, &current), Ok(true)", body)
        self.assertIn("Some(expected)", body)

    def test_negative_readiness_fixtures_already_have_the_correlated_success(self):
        text = source("crates/fullmag-api/src/session.rs")
        for name in ("snapshot_reconciliation_requires_each_requested_quantity_for_current_generation",
                     "snapshot_reconciliation_does_not_accept_pending_materialization_status"):
            with self.subTest(name=name):
                body = rust_block(text, f"fn {name}(")
                self.assertIn('"cmd-fields"', body)
                self.assertIn('"Field snapshots computed for the current magnetization"', body)
                self.assertLess(body.index("command_engine_log("),
                                body.index("assert!(!reconcile_dispatched_command_ledger_from_snapshot("))

    def test_router_fixtures_publish_results_explicitly_not_during_reconciliation(self):
        text = source("crates/fullmag-api/src/router_v2/tests.rs")
        publisher = rust_block(text, "fn publish_compute_fields_result(")
        self.assertIn("command_id: Some(command_id.to_string())", publisher)
        self.assertIn("timestamp_unix_ms: 1_700_000_001_000", publisher)
        self.assertEqual(text.count("publish_compute_fields_result(&state,"), 5)
        for name in ("dispatch_compute_fields_command", "reconcile_compute_fields_command"):
            body = rust_block(text, f"fn {name}(")
            self.assertNotIn("engine_log.push", body)
            self.assertNotIn("publish_compute_fields_result", body)


if __name__ == "__main__":
    unittest.main()
