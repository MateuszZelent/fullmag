"""Bootstrap source contracts only; no Rust compilation, HTTP writes or solver execution."""
import unittest

from test_command_result_identity_source import rust_block, source

CLI = "crates/fullmag-cli/src/scratch_runtime.rs"
API = "crates/fullmag-api/src/script.rs"


class ScratchBootstrapSourceTests(unittest.TestCase):
    def test_sync_deadline_does_not_change_pinned_fast_get_client(self):
        text = source(CLI)
        self.assertIn("Duration::from_secs(1)", rust_block(text, "fn pinned_client("))
        self.assertIn(".default_headers(headers)", rust_block(text, "fn pinned_client("))
        self.assertIn("const MODEL_SYNC_TIMEOUT: Duration = Duration::from_secs(35);", text)
        self.assertIn(".timeout(MODEL_SYNC_TIMEOUT)", rust_block(text, "fn render_current_scene("))
        self.assertIn(".take(MAX_SYNC_ERROR_BODY_BYTES)", rust_block(text, "fn render_current_scene("))

    def test_sync_bounds_both_paths_without_changing_capture_consumers(self):
        text = source(API)
        sync = rust_block(text, "fn sync_current_live_script_with_request(")
        self.assertIn("rewrite_script_via_python_helper_with_policy(", sync)
        self.assertIn("PythonHelperOutputPolicy::Bounded", sync)
        self.assertIn("render_scene_document_via_python_helper_bounded(", sync)
        self.assertIn("Duration::from_secs(30)", text)
        self.assertIn("PythonHelperOutputPolicy::Capture", rust_block(text, "fn run_python_helper("))
        self.assertIn("run_python_helper_with_policy(repo_root, &helper_args, policy)",
                      rust_block(text, "fn rewrite_script_via_python_helper_with_policy("))

    def test_terminal_reason_is_retained_and_owner_is_revalidated_before_failure_post(self):
        text = source(CLI)
        run = rust_block(text, "fn run(")
        terminal = run.split("if let Some(error) = bootstrap_retry.terminal_error.as_deref()", 1)[1]
        terminal = terminal.split("match render_current_scene", 1)[0]
        self.assertLess(terminal.index("bootstrap_owner_is_current("), terminal.index("report_command_failure("))
        self.assertIn("continue;", terminal)
        guard = rust_block(text, "fn bootstrap_owner_is_current(")
        self.assertEqual(guard.count("current_session_matches("), 2)
        self.assertIn("pending_compute_command", guard)
        self.assertIn("owner.command_id", guard)
        self.assertIn("self.owner.as_ref() != Some(&owner)", rust_block(text, "fn select_owner("))
        self.assertIn("MAX_BOOTSTRAP_ATTEMPTS", rust_block(text, "fn record_failure("))
        self.assertIn("is_char_boundary", rust_block(text, "fn record_failure("))
        self.assertIn("const MAX_BOOTSTRAP_ATTEMPTS: u8 = 3;", text)
        self.assertIn("const MAX_BOOTSTRAP_ERROR_BYTES: usize = 4 * 1024;", text)
        self.assertIn("bootstrap_retry.record_failure(&error, false)", run)
        self.assertIn("retryable_bootstrap_error(&error)", run)

    def test_transient_classification_keeps_408_429_and_server_errors_retryable(self):
        body = rust_block(source(CLI), "fn retryable_bootstrap_error(")
        self.assertIn("status.is_server_error()", body)
        self.assertIn("408 | 429", body)
        self.assertIn("error.is_timeout() || error.is_connect()", body)


if __name__ == "__main__":
    unittest.main()
