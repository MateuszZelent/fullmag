"""Source-only antenna authored/runtime identity gates; no Rust/native compilation."""
from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def source(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def rust_block(text: str, marker: str) -> str:
    start = text.index("{", text.index(marker))
    depth = 1
    cursor = start + 1
    while depth:
        depth += (text[cursor] == "{") - (text[cursor] == "}")
        cursor += 1
    return text[start + 1 : cursor - 1]


class AntennaStageIdentitySourceTests(unittest.TestCase):
    def test_mapping_has_one_optional_field_across_cli_api_and_public_record(self) -> None:
        for path, symbol in (
            ("crates/fullmag-cli/src/types.rs", "struct CurrentLiveStageExecutionRecord"),
            ("crates/fullmag-api/src/types.rs", "struct StageExecutionRecord"),
            ("crates/fullmag-api/src/schemas/runtime.rs", "struct StageExecutionRecordResource"),
        ):
            block = rust_block(source(path), symbol)
            self.assertEqual(block.count("pub antenna_solve_stage_id: Option<String>"), 1)
            self.assertIn("pub stage_id:", block)
        for path in ("crates/fullmag-cli/src/types.rs", "crates/fullmag-api/src/types.rs"):
            self.assertRegex(source(path), r"#\[serde\(default[^\n]*\)\]\s+pub antenna_solve_stage_id")

    def test_mapping_uses_only_actual_antenna_actions_not_pipeline_node_or_alias(self) -> None:
        block = rust_block(source("crates/fullmag-cli/src/orchestrator.rs"), "fn attach_stage_antenna_solve_identity")
        self.assertRegex(block, r"AntennaExternalLeadInspection \{ input, \.\. \}\)\s*=>\s*\{\s*Some\(input\.stage\.id\.clone\(\)\)")
        self.assertRegex(block, r"AntennaFieldSolve \{ stage_id, \.\. \}\)\s*=>\s*\{\s*Some\(stage_id\.clone\(\)\)")
        self.assertIn("_ => None", block)
        for forbidden in ("active_stage_id", "runtime_metadata", "entrypoint_kind", "format!", ".find("):
            self.assertNotIn(forbidden, block)

    def test_all_five_scripted_publications_attach_identity_before_publishing(self) -> None:
        text = source("crates/fullmag-cli/src/orchestrator.rs")
        publications = re.findall(
            r"let mut next_stage_execution\s*=\s*scripted_stage_execution_state(?:_with_completion)?\([\s\S]*?(?:state|snapshot)\.stage_execution = Some\(next_stage_execution\);",
            text,
        )
        self.assertEqual(len(publications), 5)
        for publication in publications:
            self.assertEqual(publication.count("attach_stage_antenna_solve_identity("), 1)
            self.assertRegex(publication, r"attach_stage_antenna_solve_identity\(\s*&mut next_stage_execution,\s*stage_index,\s*stage\.action\.as_ref\(\),\s*\)")
            self.assertIn("preserve_terminal_stage_history(", publication)

    def test_pending_and_interactive_records_do_not_infer_identity(self) -> None:
        text = source("crates/fullmag-cli/src/orchestrator.rs")
        for symbol in ("fn scripted_stage_execution_state(", "fn stage_record("):
            self.assertIn("antenna_solve_stage_id: None", rust_block(text, symbol))
        self.assertIn("antenna_solve_stage_id: previous.antenna_solve_stage_id", rust_block(text, "fn mark_current("))
        self.assertIn("previous.stages[index].clone()", rust_block(text, "fn preserve_terminal_stage_history("))

    def test_execution_envelope_and_record_are_projected_from_captured_owner(self) -> None:
        schema = rust_block(source("crates/fullmag-api/src/schemas/runtime.rs"), "struct StageExecutionResource")
        for field in ("session_id", "session_epoch", "request_scope_epoch", "run_id"):
            self.assertIn(f"pub {field}: String", schema)
        handler = rust_block(source("crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs"), "pub async fn get_stage_execution(")
        self.assertIn("capture_current_live_request_context", handler)
        self.assertIn("ensure_current_live_request_context", handler)
        self.assertIn("session_id: request_context.session_id.clone()", handler)
        self.assertIn("session_epoch: crate::router_v2::handlers::sessions::current_live_session_epoch(snapshot)", handler)
        self.assertIn("request_scope_epoch: request_context.request_scope_epoch.clone()", handler)
        self.assertIn("snapshot.run.as_ref().map(|run| run.run_id.clone())", handler)
        self.assertIn("snapshot.session.run_id.clone()", handler)
        self.assertIn("antenna_solve_stage_id: record.antenna_solve_stage_id.clone()", handler)

    def test_existing_api_record_literals_keep_explicit_none_without_compiling_tests(self) -> None:
        count = 0
        for path in ("crates/fullmag-api/src/session.rs", "crates/fullmag-api/src/router_v2/tests.rs"):
            literals = re.findall(r"StageExecutionRecord \{\s+stage_id:[^\n]*\n([^\n]+)", source(path))
            count += len(literals)
            for next_line in literals:
                self.assertIn("antenna_solve_stage_id: None", next_line)
        self.assertEqual(count, 32)


if __name__ == "__main__":
    unittest.main()
