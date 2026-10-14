"""Source routing regressions only; these do not execute an antenna runtime."""
import re
import unittest
from pathlib import Path


HOST = "crates/fullmag-cli/src/interactive_runtime_host.rs"
RUNNER = "crates/fullmag-runner/src/lib.rs"
WORKFLOW = "crates/fullmag-cli/src/antenna_workflow.rs"
ORCHESTRATOR = "crates/fullmag-cli/src/orchestrator.rs"


def source(relative):
    return (Path(__file__).resolve().parents[1] / relative).read_text(encoding="utf-8")


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


class AntennaObservationSourceTests(unittest.TestCase):
    def test_terminal_log_named_identity_applies_to_all_command_kinds(self):
        body = rust_block(source("crates/fullmag-api/src/session.rs"),
                          "fn command_has_terminal_log(")
        self.assertIn(
            "&& entry.command_id.as_deref().map_or(\n"
            "                    !requires_command_id,\n"
            "                    |command_id| command_id == record.command.command_id.as_str(),\n"
            "                )", body)
        self.assertIn("entry.timestamp_unix_ms >= min_timestamp", body)
        self.assertIn("entry.message.contains(marker)", body)
        self.assertIn('"compute_fields" | "compute_energies" | "load_state"', body)

    def test_final_template_resolves_before_ready_but_not_for_paused_pipeline(self):
        script = source(ORCHESTRATOR).split(
            "    if interactive_requested {\n        let awaiting_at_unix_ms", 1)[1]
        boundary = script.split("// Build session context", 1)[0]
        self.assertIn("if paused_stage.is_none()", boundary)
        self.assertIn(
            "resolve_active_antenna_stage_outputs(\n"
            "                &mut interactive_template_ir,\n"
            "                &published_antenna_outputs,\n"
            "            )?", boundary)
        self.assertLess(boundary.index("resolve_active_antenna_stage_outputs("),
                        boundary.index("apply_current_fem_overrides("))
        self.assertLess(script.index("resolve_active_antenna_stage_outputs("),
                        script.index('ctx.build_session(\n                    "awaiting_command"'))
        self.assertLess(script.index("resolve_active_antenna_stage_outputs("),
                        script.index("InteractiveRuntimeHost::new("))

    def test_each_interactive_stage_resolves_before_new_sequence_plan_and_attachment(self):
        script = source(ORCHESTRATOR).split(
            "    if interactive_requested {\n        let awaiting_at_unix_ms", 1)[1]
        stage = script.split("let Some(mut stage) =", 1)[1].split("let stage_time_frame =", 1)[0]
        resolution = (
            "if let Err(error) =\n"
            "                resolve_active_antenna_stage_outputs(&mut stage.ir, &published_antenna_outputs)")
        self.assertIn(resolution, stage)
        before_sequence = stage.split("if active_sequence.is_none()", 1)[0]
        self.assertIn("&command.command_id", before_sequence)
        self.assertIn("live_workspace.push_command_log(", before_sequence)
        self.assertIn("failed antenna stage-output resolution", before_sequence)
        self.assertIn("continue;", before_sequence.split(resolution, 1)[1])
        for action in ("apply_current_fem_overrides(", "validate_ir(&stage.ir)?",
                       "fullmag_plan::plan(&stage.ir)",
                       "attach_solved_antenna_drive_bases(&stage.ir"):
            self.assertLess(stage.index(resolution), stage.index(action))

    def test_output_resolution_preserves_atomicity_and_stage_activation(self):
        body = rust_block(source(ORCHESTRATOR), "fn resolve_active_antenna_stage_outputs(")
        self.assertIn(".is_active_for(problem.study.kind(), active_stage_id)", body)
        self.assertIn("for (index, reference) in resolved", body)
        self.assertLess(body.index(".ok_or_else("), body.index("for (index, reference) in resolved"))
        for forbidden in ("execute_antenna_field_solve", "stage_start_time_s",
                          "stage_waveform_origin_time_s", "latest", "activation ="):
            self.assertNotIn(forbidden, body)

    def test_consumer_reuses_checked_asset_boundary_and_owned_root(self):
        body = rust_block(source(WORKFLOW), "fn materialize_antenna_consumer_plan(")
        self.assertIn("workspace.current_artifact_dir()?", body)
        self.assertIn("attach_solved_antenna_drive_bases(problem, plan, &artifact_dir)?", body)
        for forbidden in ("execute_antenna_field_solve", "snapshot_problem", "unwrap_or", "std::env"):
            self.assertNotIn(forbidden, body)
        loader = rust_block(source("crates/fullmag-cli/src/orchestrator.rs"),
                            "fn attach_solved_antenna_drive_bases(")
        self.assertIn("current_antenna_solution_expectation(", loader)
        self.assertIn("load_expected_antenna_field_solution(artifact_dir, &expected)", loader)
        self.assertIn("materialize_fdm_solved_antenna_drives_v03", loader)
        self.assertIn("materialize_fem_solved_antenna_drives_v03", loader)

    def test_observation_plans_exact_problem_without_clock_or_activation_rewrite(self):
        text = source(WORKFLOW)
        body = rust_block(text, "fn plan_antenna_observation(")
        self.assertIn("fullmag_plan::plan(problem)", body)
        self.assertIn("materialize_antenna_consumer_plan(problem, &mut plan, workspace)?", body)
        for forbidden in ("StudyKind", "StudyIR", "active_stage_id", "start_time_s",
                          "waveform_origin_time_s", "execute_antenna_field_solve"):
            self.assertNotIn(forbidden, text)

    def test_consumer_validates_activation_before_resolving_artifact_root(self):
        body = rust_block(source(WORKFLOW), "fn materialize_antenna_consumer_plan(")
        gate = "if !crate::orchestrator::prepare_solved_antenna_drive_activation(problem, plan)?"
        self.assertTrue(gate in body, "activation preflight must precede artifact root resolution")
        self.assertIn("return Ok(());", body.split(gate, 1)[1].split("let artifact_dir", 1)[0])
        self.assertLess(body.index(gate), body.index("workspace.current_artifact_dir()?"))
        self.assertNotIn("solved_antenna_drives.is_empty()", body)
        self.assertLess(body.index("workspace.current_artifact_dir()?"),
                        body.index("attach_solved_antenna_drive_bases("))

    def test_activation_preflight_clears_inactive_or_absent_bases_in_both_lanes(self):
        text = source(ORCHESTRATOR)
        self.assertTrue("fn prepare_solved_antenna_drive_activation(" in text,
                        "a shared activation preflight must own validation and inactive clearing")
        body = rust_block(text, "fn prepare_solved_antenna_drive_activation(")
        self.assertIn("stage.study_kind != problem.study.kind()", body)
        self.assertIn("stage.active_stage_id.as_deref() != active_stage_id", body)
        self.assertLess(body.index("activation context differs"),
                        body.index("if !problem.solved_antenna_drives.iter().any("))
        inactive = body.split("if !problem.solved_antenna_drives.iter().any(", 1)[1]
        inactive = inactive.split("return Ok(false);", 1)[0]
        self.assertIn(".is_active_for(problem.study.kind(), active_stage_id)", inactive)
        for lane in ("Fem", "Fdm"):
            self.assertIn(f"BackendPlanIR::{lane}(plan) => plan.solved_antenna_drive_bases.clear()",
                          inactive)
        self.assertIn("return Ok(false);", body)
        self.assertIn("Ok(true)", body)
        for forbidden in ("artifact_dir", "current_artifact_dir", "load_expected_antenna_field_solution",
                          "execute_antenna_field_solve", "waveform_origin_time_s"):
            self.assertNotIn(forbidden, body)

    def test_attachment_preserves_strong_loading_after_the_shared_activation_gate(self):
        body = rust_block(source(ORCHESTRATOR), "fn attach_solved_antenna_drive_bases(")
        gate = "if !prepare_solved_antenna_drive_activation(problem, execution_plan)?"
        self.assertTrue(gate in body, "attachment must reuse the shared activation preflight")
        self.assertIn("return Ok(());", body.split(gate, 1)[1].split("let time_stage", 1)[0])
        self.assertNotIn("solved_antenna_drive_bases.clear()", body)
        for boundary in ("current_antenna_solution_expectation(",
                         "load_expected_antenna_field_solution(artifact_dir, &expected)",
                         "materialize_fdm_solved_antenna_drives_v03",
                         "materialize_fem_solved_antenna_drives_v03"):
            self.assertIn(boundary, body)
            self.assertLess(body.index(gate), body.index(boundary))

    def test_reconstruction_uses_loaded_plan_not_bare_problem_constructor(self):
        body = rust_block(source(HOST), "fn create_interactive_preview_runtime_from_problem(")
        self.assertIn("plan_antenna_observation(base_problem, live_workspace)?", body)
        self.assertIn("create_planned_interactive_runtime(base_problem, &plan, continuation_magnetization)", body)
        self.assertNotIn("fullmag_runner::create_interactive_runtime(", body)

    def test_all_reconstructed_observations_use_plan_aware_facade(self):
        text = source(HOST)
        for name, function in (
            ("fn refresh_interactive_preview_snapshot(", "snapshot_planned_problem_preview"),
            ("fn refresh_interactive_preview_fields(", "snapshot_planned_problem_vector_fields"),
            ("fn snapshot_interactive_preview_payload(", "snapshot_planned_problem_vector_field_batch"),
            ("fn refresh_multilayer_idle_preview(", "snapshot_planned_problem_vector_field_batch"),
        ):
            with self.subTest(name=name):
                body = rust_block(text, name)
                self.assertIn("plan_antenna_observation(&problem, live_workspace)?", body)
                self.assertIn(function, body)
                self.assertLess(body.index("apply_continuation_initial_state("),
                                body.index("plan_antenna_observation("))
                self.assertNotIn("fullmag_runner::snapshot_problem_", body)

    def test_private_remesh_candidate_loads_before_runtime_creation(self):
        body = rust_block(source(HOST), "fn prepare_base_problem(")
        self.assertIn("let mut plan = plan.clone();", body)
        self.assertIn("materialize_antenna_consumer_plan(&base_problem, &mut plan, live_workspace)?", body)
        self.assertLess(body.index("materialize_antenna_consumer_plan("),
                        body.index("create_planned_interactive_runtime("))
        self.assertNotIn("fullmag_plan::plan(", body)
        remesh = source("crates/fullmag-cli/src/orchestrator/manual_remesh.rs")
        self.assertEqual(remesh.count("InteractiveRuntimeHost::prepare_base_problem("), 2)
        for tail in remesh.split("InteractiveRuntimeHost::prepare_base_problem(")[1:]:
            self.assertIn("live_workspace,", tail.split(")?)", 1)[0])

    def test_planned_facade_never_replans_materialized_bases(self):
        text = source(RUNNER)
        for name in ("snapshot_planned_problem_preview", "snapshot_planned_problem_vector_fields",
                     "snapshot_planned_problem_vector_field_batch"):
            with self.subTest(name=name):
                body = rust_block(text, f"fn {name}(")
                self.assertNotIn("fullmag_plan::plan", body)
                self.assertNotIn("execute_antenna_field_solve", body)
                if name.endswith("batch"):
                    self.assertIn("snapshot_planned_problem_vector_fields(problem, plan, quantities, request)?", body)
                    self.assertIn("materialize_airbox_observation_snapshot(", body)
                else:
                    self.assertIn("require_physics_graph_runtime_provenance(problem, plan)?", body)
                    self.assertIn("match &plan.backend_plan", body)

    def test_existing_problem_facade_delegates_to_planned_facade(self):
        text = source(RUNNER)
        for suffix in ("preview", "vector_fields", "vector_field_batch"):
            with self.subTest(suffix=suffix):
                body = rust_block(text, f"fn snapshot_problem_{suffix}(")
                self.assertIn("let plan = fullmag_plan::plan(problem)?;", body)
                self.assertIn(f"snapshot_planned_problem_{suffix}(problem, &plan,", body)

    def test_pre_solve_fields_and_energies_load_the_same_checked_bases(self):
        text = source(ORCHESTRATOR)
        for name in ("refresh_problem_preview_state", "refresh_problem_energy_state"):
            with self.subTest(name=name):
                body = rust_block(text, f"fn {name}(")
                self.assertEqual(body.count("plan_antenna_observation(&problem, live_workspace)?"), 1)
                self.assertNotIn("fullmag_runner::snapshot_problem_", body)
                self.assertNotIn("fullmag_runner::create_interactive_runtime(", body)
                self.assertLess(body.index("apply_continuation_initial_state("),
                                body.index("plan_antenna_observation("))
                self.assertLess(body.index("plan_antenna_observation("),
                                body.index("live_workspace.update("))

    def test_runtime_preparation_errors_reach_explicit_commands(self):
        text = source(HOST)
        self.assertIsNotNone(re.search(r"fn ensure_base_runtime_ready\([^)]*\) -> Result<\(\)>", text),
                             "runtime preparation must return a fallible result")
        for name in ("compute_current_fields", "compute_current_energies", "load_state"):
            with self.subTest(name=name):
                body = rust_block(text, f"fn {name}(")
                self.assertRegex(body, r"self\.ensure_base_runtime_ready\([^;]*\)\?;")
        energies = rust_block(text, "fn compute_current_energies(")
        self.assertIn(".ok_or_else(", energies)
        self.assertIn("runtime.snapshot_step_stats()?", energies)
        ensure = rust_block(text, "fn ensure_base_runtime_ready(")
        self.assertIn("create_interactive_preview_runtime_from_problem(", ensure)
        self.assertIn(".context(\"Idle live preview runtime unavailable\")?", ensure)
        self.assertIn("return Err(", ensure)

    def test_failed_import_does_not_publish_continuation_or_generation(self):
        body = rust_block(source(HOST), "fn load_state(")
        validation = body.index("self.ensure_base_runtime_ready(")
        self.assertNotIn(".upload_magnetization(", body)
        for publication in ("self.preview_source.lock()", "live_workspace.update("):
            self.assertLess(validation, body.index(publication))

    def test_import_validation_uses_a_private_problem_and_canonical_planner(self):
        body = rust_block(source("crates/fullmag-cli/src/step_utils.rs"),
                          "fn validate_imported_magnetization(")
        self.assertIn("let mut candidate = base_problem.clone();", body)
        self.assertIn("apply_continuation_initial_state(&mut candidate, magnetization)?", body)
        self.assertIn("fullmag_plan::plan(&candidate)", body)
        for forbidden in ("live_workspace", "create_interactive_runtime", "execute_antenna_field_solve",
                          "plan_antenna_observation", "start_time_s", "waveform_origin_time_s"):
            self.assertNotIn(forbidden, body)

    def test_import_validates_even_when_the_host_does_not_retain_a_runtime(self):
        body = rust_block(source(HOST), "fn load_state(")
        validation = body.index("validate_imported_magnetization(&self.base_problem, &magnetization)?")
        for operation in ("self.ensure_base_runtime_ready(", "self.preview_source.lock()",
                          "live_workspace.update("):
            self.assertLess(validation, body.index(operation))

    def test_import_requires_the_resolved_global_flat_carrier(self):
        body = rust_block(source("crates/fullmag-cli/src/step_utils.rs"),
                          "fn validate_imported_magnetization(")
        for expression in ("match &plan.backend_plan", "fdm.initial_magnetization.len()",
                           "layer.initial_magnetization.len()", "fem.mesh.nodes.len()",
                           "magnetization.len() != expected_vectors", "global flat carrier"):
            self.assertIn(expression, body)
        for variant in ("Fem", "FemEigen", "FemFrequencyResponse"):
            self.assertIn(f"BackendPlanIR::{variant}(fem)", body)

    def test_source_only_shared_domain_is_not_gated_by_inline_mesh(self):
        body = rust_block(source("crates/fullmag-cli/src/step_utils.rs"),
                          "fn apply_continuation_initial_state(")
        gate = body.split("let planned_fem_node_count =", 1)[1].split(";", 1)[0]
        self.assertIn("has_shared_domain", gate)
        self.assertNotIn("shared_domain_node_count.is_some()", gate)

    def test_fem_import_fixtures_distinguish_local_and_global_and_source_only(self):
        text = source("crates/fullmag-cli/src/step_utils.rs")
        local = rust_block(text, "fn imported_fem_state_requires_global_nodes_not_local_initializer(")
        self.assertIn("fullmag_plan::plan(&local)", local)
        self.assertIn("expect_err", local)
        self.assertIn("global flat carrier", local)
        external = rust_block(text, "fn imported_fem_state_supports_multi_magnet_source_only_mesh(")
        for expression in ("asset.mesh = None", "asset.mesh_source = Some(",
                           "validate_imported_magnetization(", "serde_json::to_value(&problem)",
                           "let expected = fem.mesh.nodes.len()", "assert_eq!(expected, 8",
                           "for count in [5, expected - 1]"):
            self.assertIn(expression, external)

    def test_pre_solve_import_checks_candidate_before_publishing(self):
        body = source(ORCHESTRATOR).split('match cmd.kind.as_str() {', 1)[1]
        body = body.split("match classify_wait_for_solve_command(", 1)[0]
        self.assertIn(".and_then(|loaded_state|", body)
        validation = body.index("validate_imported_magnetization(&stages[0].ir, &loaded_state.values)?")
        for operation in ("continuation_magnetization = Some(", "continuation_source = None",
                          "continuation_completion = None", "live_workspace.update("):
            self.assertLess(validation, body.index(operation))
        self.assertIn('format!("Failed to load workspace state: {}", error)', body)

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
        self.assertIn('"Failed to load workspace state: missing state_path"', text)
        self.assertIn('"Failed to load workspace state: load-state is disabled', text)

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

    def test_idle_preparation_failure_does_not_disable_command_polling(self):
        body = rust_block(source(HOST), "fn enter_awaiting_command(")
        self.assertIn("if let Err(error) = self.ensure_base_runtime_ready(", body)
        self.assertIn("live_workspace.push_log(", body)
        self.assertIn("self.control.enable_command_polling();", body)
        self.assertNotIn("return;", body)

    def test_retained_runtime_and_async_generation_fence_are_preserved(self):
        text = source(HOST)
        body = rust_block(text, "fn compute_current_fields(")
        self.assertIn("runtime.snapshot_vector_fields(&quantities, &materialization_request)?", body)
        self.assertIn("return Ok(());", body)
        for forbidden in ("execute_streaming", "execute_antenna_field_solve", "advance("):
            self.assertNotIn(forbidden, body)
        async_body = rust_block(text, "fn spawn_interactive_preview_cache_refresh(")
        self.assertEqual(async_body.count("state.generation == generation"), 2)
        self.assertIn("&live_workspace,", async_body)
        self.assertLess(async_body.index("if !should_publish"),
                        async_body.index("replace_cached_preview_fields("))


if __name__ == "__main__":
    unittest.main()
