"""Pure regressions for the nonce-scoped managed CSS HMR proof draft.

These tests do not start Docker, a browser, a frontend, or the native Windows
operator. They exercise bounded source creation/update/cleanup and Compose /
protocol guards on ordinary temporary files.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def _load_hmr_module():
    scripts = str(ROOT / "scripts")
    import sys

    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    spec = importlib.util.spec_from_file_location("docker_dev_hmr_qa_draft", ROOT / "scripts" / "docker_dev_hmr_qa.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load HMR wrapper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DockerDevHmrQaContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hmr = _load_hmr_module()

    def test_reconciliation_reads_the_emitted_intent_bytes(self):
        import base64
        hmr = self.hmr
        page = hmr._page_bytes("12345678")
        before = hmr._css_bytes()
        candidate = hmr._candidate_css_bytes(before, "12345678")
        intent = {
            "page_bytes_b64": base64.b64encode(page).decode("ascii"),
            "css_before_b64": base64.b64encode(before).decode("ascii"),
            "css_candidate_b64": base64.b64encode(candidate).decode("ascii"),
        }
        for prefix, data in (("page", page), ("css_before", before), ("css_candidate", candidate)):
            intent[prefix + "_bytes"] = len(data)
            intent[prefix + "_sha256"] = hmr._sha256(data)
        for prefix, data in (("page", page), ("css_before", before), ("css_candidate", candidate)):
            hmr._validate_intent_bytes(intent, prefix, data)
            altered = dict(intent)
            altered[prefix + "_sha256"] = "0" * 64
            with self.assertRaises(hmr.BuildControlError):
                hmr._validate_intent_bytes(altered, prefix, data)
        with self.assertRaises(hmr.BuildControlError):
            hmr._validate_intent_bytes({**intent, "page_bytes_b64": "!"}, "page", page)

    def test_reconcile_replaces_current_before_terminal_and_lease_release(self):
        import os
        import subprocess
        hmr = self.hmr
        attempt = "a" * 32
        project = "fullmag-worktree-hmr"
        for previous_attempt in (None, attempt, "b" * 32):
            with tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                relative = hmr.HMR_PHASE + "/attempts/" + attempt
                (base / relative).mkdir(parents=True)
                active = base / "active"
                active.write_bytes((attempt + "\n").encode())
                receipt = {"attempt": attempt, "phase": hmr.HMR_PHASE, "compose_project": project, "state": "outcome-unknown-resources-retained"}
                payload = hmr.canonical(receipt) + b"\n"
                (base / relative / "receipt.json").write_bytes(payload)
                if previous_attempt is not None:
                    previous = {**receipt, "attempt": previous_attempt}
                    (base / hmr.HMR_PHASE / "current.json").write_bytes(hmr.canonical(previous) + b"\n")
                terminal = {**receipt, "state": "failed-confirmed"}
                control = SimpleNamespace(project=project, path=lambda name: str(base / name), helper_args=lambda script: ["--entrypoint", script])
                def capture(arguments, **kwargs):
                    environment = dict(os.environ)
                    for index, value in enumerate(arguments):
                        if value == "--env":
                            key, value = arguments[index + 1].split("=", 1)
                            environment[key] = value
                    result = subprocess.run(["bash", "-c", arguments[-1]], capture_output=True, env=environment)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertTrue(active.exists(), "Only the lease holder may release its active marker")
                    self.assertEqual(json.loads((base / hmr.HMR_PHASE / "current.json").read_bytes()), terminal)
                    self.assertEqual(json.loads((base / relative / "terminal.json").read_bytes()), terminal)
                    return result
                def read_raw(_control, name, optional=False):
                    path = base / name
                    return path.read_bytes() if path.exists() else None
                with patch.object(hmr, "_control_raw", side_effect=read_raw), patch.object(hmr, "bounded_capture", side_effect=capture), patch("docker_volume_activation_reconcile._probe_helper_absence", side_effect=lambda _name: (active.unlink(), "absence-proof")[1]):
                    hmr._publish_reconciled_terminal(control, relative, attempt, hmr._sha256(payload), terminal)
                self.assertFalse(active.exists())

    def test_nonce_route_files_are_private_and_css_candidate_is_bounded(self):
        hmr = self.hmr
        nonce = "12345678"
        paths = hmr._probe_relatives(nonce)
        self.assertEqual(paths["route"], "apps/control-room/app/fullmag-hmr-probe-12345678")
        self.assertEqual(paths["css"], "apps/control-room/src/design/styles/fullmag-hmr-probe-12345678.module.css")
        page = hmr._page_bytes(nonce).decode()
        self.assertIn("@/design/styles/fullmag-hmr-probe-12345678.module.css", page)
        self.assertIn('data-fullmag-hmr-probe="fullmag-hmr-probe-12345678"', page)
        self.assertIn('data-fullmag-hmr-client="pending"', page)
        self.assertIn('data-fullmag-hmr-client", "ready"', page)
        self.assertIn('className={styles["fm-hmr-probe"]}', page)
        original = b".fm-hmr-probe {\r\n  display: block;\r\n}\r\n"
        candidate = hmr._candidate_css_bytes(original, nonce)
        self.assertIn(b"--fm-docker-hmr-probe: hmr-12345678;\r\n", candidate)
        self.assertEqual(candidate.count(b"--fm-docker-hmr-probe"), 1)
        with self.assertRaises(hmr.BuildControlError):
            hmr._candidate_css_bytes(candidate, nonce)

    def test_create_update_restore_and_cleanup_are_cas_bound(self):
        hmr = self.hmr
        nonce = "12345678"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            route = root / "fullmag-hmr-probe-12345678"
            route.mkdir()
            styles = root / "styles"
            styles.mkdir()
            page_path = route / "page.tsx"
            css_path = styles / "fullmag-hmr-probe-12345678.module.css"
            page = hmr._page_bytes(nonce)
            before = hmr._css_bytes()
            candidate = hmr._candidate_css_bytes(before, nonce)
            page_path.write_bytes(page)
            css_path.write_bytes(before)
            route_signature = hmr._directory_signature(route)
            page_signature = hmr._file_signature(page_path)
            css_signature = hmr._file_signature(css_path)
            candidate_signature = hmr._write_probe_locked(css_path, before, css_signature, candidate, relative="page/css")
            restored_signature = hmr._write_probe_locked(css_path, candidate, candidate_signature, before, relative="page/css")
            paths = {
                "route_path": route,
                "page_path": page_path,
                "css_path": css_path,
                "route": "apps/control-room/app/fullmag-hmr-probe-12345678",
                "page": "apps/control-room/app/fullmag-hmr-probe-12345678/page.tsx",
                "css": "apps/control-room/src/design/styles/fullmag-hmr-probe-12345678.module.css",
            }
            cleanup = hmr._cleanup_probe_files(
                paths,
                attempt="a" * 32,
                route_signature=route_signature,
                page_bytes=page,
                page_signature=page_signature,
                css_before=before,
                css_candidate=candidate,
                css_before_signature=restored_signature,
                css_candidate_signature=candidate_signature,
            )
            self.assertEqual(cleanup["state"], "absent")
            self.assertFalse(route.exists())

    def test_foreign_css_edit_is_preserved_and_blocks_cleanup(self):
        hmr = self.hmr
        nonce = "12345678"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            route = root / "fullmag-hmr-probe-12345678"
            route.mkdir()
            styles = root / "styles"
            styles.mkdir()
            page_path = route / "page.tsx"
            css_path = styles / "fullmag-hmr-probe-12345678.module.css"
            page = hmr._page_bytes(nonce)
            before = hmr._css_bytes()
            candidate = hmr._candidate_css_bytes(before, nonce)
            page_path.write_bytes(page)
            css_path.write_bytes(candidate)
            route_signature = hmr._directory_signature(route)
            page_signature = hmr._file_signature(page_path)
            candidate_signature = hmr._file_signature(css_path)
            foreign = b".fm-hmr-probe {\n  color: red;\n}\n"
            css_path.write_bytes(foreign)
            paths = {
                "route_path": route,
                "page_path": page_path,
                "css_path": css_path,
                "route": "route",
                "page": "route/page.tsx",
                "css": "apps/control-room/src/design/styles/fullmag-hmr-probe-12345678.module.css",
            }
            with self.assertRaises(hmr.ConcurrentProbeEdit):
                hmr._cleanup_probe_files(
                    paths,
                    attempt="a" * 32,
                    route_signature=route_signature,
                    page_bytes=page,
                    page_signature=page_signature,
                    css_before=before,
                    css_candidate=candidate,
                    css_before_signature=candidate_signature,
                    css_candidate_signature=candidate_signature,
                )
            self.assertEqual(css_path.read_bytes(), foreign)

    def test_foreign_route_identity_is_preserved_and_blocks_cleanup(self):
        hmr = self.hmr
        nonce = "12345678"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            route = root / "fullmag-hmr-probe-12345678"
            route.mkdir()
            styles = root / "styles"
            styles.mkdir()
            page_path = route / "page.tsx"
            css_path = styles / "fullmag-hmr-probe-12345678.module.css"
            page = hmr._page_bytes(nonce)
            before = hmr._css_bytes()
            candidate = hmr._candidate_css_bytes(before, nonce)
            page_path.write_bytes(page)
            css_path.write_bytes(before)
            route_signature = hmr._directory_signature(route)
            page_signature = hmr._file_signature(page_path)
            css_signature = hmr._file_signature(css_path)
            foreign_route = root / "foreign-route"
            route.rename(foreign_route)
            route.mkdir()
            foreign = route / "foreign.txt"
            foreign.write_bytes(b"preserve")
            paths = {
                "route_path": route,
                "page_path": route / "page.tsx",
                "css_path": css_path,
                "route": "route",
                "page": "route/page.tsx",
                "css": "apps/control-room/src/design/styles/fullmag-hmr-probe-12345678.module.css",
            }
            with self.assertRaises(hmr.ConcurrentProbeEdit):
                hmr._cleanup_probe_files(
                    paths,
                    attempt="a" * 32,
                    route_signature=route_signature,
                    page_bytes=page,
                    page_signature=page_signature,
                    css_before=before,
                    css_candidate=candidate,
                    css_before_signature=css_signature,
                    css_candidate_signature=css_signature,
                )
            self.assertEqual(foreign.read_bytes(), b"preserve")

    def test_plan_only_candidate_uses_same_inode_without_mtime_pin(self):
        hmr = self.hmr
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "probe.module.css"
            before = hmr._css_bytes()
            candidate = hmr._candidate_css_bytes(before, "12345678")
            target.write_bytes(before)
            initial = hmr._file_signature(target)
            observed = hmr._write_probe_locked(target, before, initial, candidate, relative="probe")
            self.assertEqual(observed["device"], initial["device"])
            self.assertEqual(observed["inode"], initial["inode"])
            self.assertTrue(hmr._signature_matches(observed, hmr._same_inode_signature(initial)))
            self.assertNotEqual(target.read_bytes(), before)

    def test_compose_mounts_are_private_and_route_is_pinned(self):
        hmr = self.hmr
        identity = {
            "project_name": "fullmag-worktree-hmr",
            "network_name": "fullmag-worktree-hmr_fullmag",
            "project_id": "fullmag",
            "worktree_id": "hmr-fixture",
            "checkout_kind": "worktree",
            "source_root": str(ROOT),
        }
        control = SimpleNamespace(volume="fullmag-control-hmr")
        attempt = "a" * 32
        harness_hashes = {"algorithm": "sha256", "runner": "a" * 64, "loopback_proxy": "b" * 64}
        document = hmr._compose_document(ROOT, identity, hmr.browser_qa.DEFAULT_BROWSER_IMAGE, "fullmag-frontend-hmr", control, "browser-hmr-css/attempts/" + attempt + "/exchange", 3197, 120, attempt, "/fullmag-hmr-probe-12345678", harness_hashes)
        service = document["services"][hmr.HMR_SERVICE]
        self.assertNotIn("ports", service)
        self.assertEqual(service["cap_drop"], ["ALL"])
        self.assertEqual(service["security_opt"], ["no-new-privileges:true"])
        self.assertEqual(service["environment"]["CONTROL_ROOM_HMR_ROUTE_PATH"], "/fullmag-hmr-probe-12345678")
        self.assertEqual(json.loads(service["environment"]["CONTROL_ROOM_HMR_HARNESS_SOURCE_SHA256"]), harness_hashes)
        mounts = {mount["target"]: mount for mount in service["volumes"]}
        self.assertTrue(mounts["/state/development"]["read_only"])
        self.assertTrue(mounts["/state/development/workspace/apps/control-room/scripts"]["read_only"])
        self.assertFalse(mounts["/control"]["read_only"])
        self.assertEqual(mounts["/control"]["volume"]["subpath"], "browser-hmr-css/attempts/" + attempt + "/exchange")

    def test_inspected_control_mount_must_prove_subpath(self):
        hmr = self.hmr
        subpath = "browser-hmr-css/attempts/" + "a" * 32 + "/exchange"
        document = {"HostConfig": {"Mounts": [{"Type": "volume", "Source": "control", "Target": "/control", "VolumeOptions": {"Subpath": subpath}}]}}
        self.assertEqual(hmr._control_subpath_from_inspect(document, "/control"), subpath)
        missing = {"HostConfig": {"Mounts": [{"Type": "volume", "Source": "control", "Target": "/control"}]}}
        self.assertIsNone(hmr._control_subpath_from_inspect(missing, "/control"))

    def test_success_removal_requires_exact_absence_probe_after_exit_and_rm(self):
        hmr = self.hmr
        events = []

        def observed_exit(helper_id, *, expected_exit_codes):
            events.append(("wait", helper_id, expected_exit_codes))
            return 0

        def capture(*args, **kwargs):
            events.append((args[0], args[1]))
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")

        with patch.object(hmr, "_wait_browser_helper", side_effect=observed_exit), patch.object(hmr, "_confirmed_helper_absence", side_effect=["b" * 64, "c" * 64]), patch.object(hmr, "docker_capture", side_effect=capture):
            operation = {"daemon_pending": False}
            absence = hmr._remove_helper(operation, "a" * 64, hmr._helper_name("a" * 32))
        self.assertEqual(len(absence), 64)
        self.assertEqual(events, [("wait", "a" * 64, {0}), ("rm", "a" * 64)])
        self.assertTrue(operation["daemon_pending"])

    def test_helper_name_is_full_attempt_and_windows_cleanup_fences_writers(self):
        hmr = self.hmr
        attempt = "a" * 32
        self.assertEqual(hmr._helper_name(attempt), "fullmag-browser-hmr-" + attempt)
        self.assertEqual(hmr.WINDOWS_PROBE_SHARE_MODE, 0x1)
        source = (ROOT / "scripts" / "docker_dev_hmr_qa.py").read_text(encoding="utf-8")
        self.assertIn("WINDOWS_PROBE_SHARE_MODE", source)
        self.assertNotIn("CreateFileW(str(path), 0x80000000 | 0x00010000 | 0x80, 0x7", source)

    def test_reconciliation_removes_only_records_with_ownership_proof(self):
        hmr = self.hmr
        nonce = "12345678"
        attempt = "a" * 32
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            route = root / "fullmag-hmr-probe-12345678"
            route.mkdir()
            styles = root / "styles"
            styles.mkdir()
            page_path = route / "page.tsx"
            css_path = styles / "fullmag-hmr-probe-12345678.module.css"
            page = hmr._page_bytes(nonce)
            before = hmr._css_bytes()
            candidate = hmr._candidate_css_bytes(before, nonce)
            page_path.write_bytes(page)
            css_path.write_bytes(before)
            paths = {
                "route_path": route,
                "page_path": page_path,
                "css_path": css_path,
                "route": "apps/control-room/app/fullmag-hmr-probe-12345678",
                "page": "apps/control-room/app/fullmag-hmr-probe-12345678/page.tsx",
                "css": "apps/control-room/src/design/styles/fullmag-hmr-probe-12345678.module.css",
            }
            route_record = hmr._directory_record(relative=paths["route"], signature=hmr._directory_signature(route), nonce=nonce)
            css_record = hmr._source_record(state="created", relative=paths["css"], data=before, signature=hmr._file_signature(css_path), nonce=nonce)
            cleanup = hmr._cleanup_reconciled_probe_files(
                paths,
                attempt=attempt,
                nonce=nonce,
                route_record=route_record,
                page_record=None,
                css_record=css_record,
                css_candidate_record=None,
                css_restored_record=None,
                page_bytes=page,
                css_before=before,
                css_candidate=candidate,
            )
            self.assertEqual(cleanup["state"], "not-verified")
            self.assertTrue(page_path.exists())
            self.assertFalse(css_path.exists())
            self.assertTrue(route.exists())

    def test_success_terminal_requires_post_close_intent_marker(self):
        hmr = self.hmr
        source = (ROOT / "apps/control-room/scripts/docker-dev-hmr-qa.mjs").read_text(encoding="utf-8")
        self.assertLess(source.index("await browser.close()"), source.index("const terminal ="))
        self.assertIn("intentional_close", source)

    def test_protocol_and_identity_guards_reject_partial_or_drifted_records(self):
        hmr = self.hmr
        attempt = "a" * 32
        nonce = "12345678"
        route = "/fullmag-hmr-probe-12345678"
        baseline = {
            "session": {"session_id": "s", "session_epoch": "e", "request_scope_epoch": "r"},
            "dom": {"tag_name": "MAIN", "attribute": "fullmag-hmr-probe-12345678", "class_name": "probe_hash", "connected": True, "same_element": True},
            "document_token": "document-token",
        }
        observation = {"schema": hmr.HMR_PROTOCOL_SCHEMA, "state": "candidate-verified", "attempt": attempt, "nonce": nonce, "route_path": route, "property": "hmr-12345678", "navigation_count": 0, **baseline}
        hmr._validate_observation(observation, attempt=attempt, state="candidate-verified", nonce=nonce, baseline=baseline, expected_property="hmr-12345678", route_path=route)
        for mutation in ({"attempt": "b" * 32}, {"state": "ready"}, {"navigation_count": 1}, {"route_path": "/workspace"}, {"property": ""}):
            altered = dict(observation)
            altered.update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(hmr.BuildControlError):
                hmr._validate_observation(altered, attempt=attempt, state="candidate-verified", nonce=nonce, baseline=baseline, expected_property="hmr-12345678", route_path=route)

    def test_wait_for_record_fails_fast_on_failed_sibling_terminal(self):
        hmr = self.hmr
        attempt = "a" * 32
        target = f"{hmr.HMR_PHASE}/attempts/{attempt}/exchange/helper-ready.json"
        sibling = f"{hmr.HMR_PHASE}/attempts/{attempt}/exchange/helper-terminal.json"

        class Control:
            def read(self, relative, optional=False):
                if relative == sibling:
                    return {
                        "schema": hmr.HMR_PROTOCOL_SCHEMA,
                        "state": "failed-confirmed",
                        "attempt": attempt,
                        "error": "SyntaxError: Unexpected end of JSON input",
                    }
                return None

        with self.assertRaises(hmr.ControlOutcomeUnknown) as raised:
            hmr._wait_for_record(Control(), target, timeout=300)
        self.assertIn("failed", str(raised.exception))

    def test_terminal_success_rejects_late_css_error_and_incomplete_hmr(self):
        hmr = self.hmr
        diagnostics = {"pageerrors": [], "hmr": {
            "connected": True, "synced": True, "building": False,
            "closed": False, "intentional_close": True, "errors": [], "failure": None,
        }}
        hmr._validate_success_diagnostics({"diagnostics": diagnostics})
        for mutation in (
            {"pageerrors": [{"error": "Cannot read properties of null (reading removeChild)"}]},
            {"hmr": {**diagnostics["hmr"], "errors": [{"message": "compile failed"}]}},
            {"hmr": {**diagnostics["hmr"], "failure": "socket failed"}},
            {"hmr": {**diagnostics["hmr"], "closed": True, "intentional_close": False}},
            {"hmr": {**diagnostics["hmr"], "intentional_close": False}},
            {"hmr": {**diagnostics["hmr"], "building": True}},
            {"hmr": {**diagnostics["hmr"], "synced": False}},
            {"hmr": {**diagnostics["hmr"], "connected": False}},
            {"hmr": {}},
            {"pageerrors": None},
        ):
            with self.subTest(mutation=mutation), self.assertRaises(hmr.BuildControlError):
                hmr._validate_success_diagnostics({"diagnostics": {**diagnostics, **mutation}})
        with self.assertRaises(hmr.BuildControlError):
            hmr._validate_success_diagnostics({})

    def test_harness_source_hashes_require_exact_before_after_evidence(self):
        hmr = self.hmr
        expected = {"algorithm": "sha256", "runner": "a" * 64, "loopback_proxy": "b" * 64}
        ready = {"harness_source_sha256": {"algorithm": "sha256", "runner_before": "a" * 64, "loopback_proxy_before": "b" * 64}}
        hmr._validate_harness_ready(ready, expected)
        terminal = {"harness_source_sha256": {"algorithm": "sha256", "runner_before": "a" * 64, "runner_after": "a" * 64, "loopback_proxy_before": "b" * 64, "loopback_proxy_after": "b" * 64, "unchanged": True}}
        hmr._validate_harness_terminal(terminal, expected)
        for mutation in (
            {"runner_after": "c" * 64},
            {"unchanged": False},
            {"runner_before": "c" * 64},
        ):
            altered = {"harness_source_sha256": dict(terminal["harness_source_sha256"])}
            altered["harness_source_sha256"].update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(hmr.BuildControlError):
                hmr._validate_harness_terminal(altered, expected)

    def test_harness_source_paths_are_pinned_to_runner_and_loopback_proxy(self):
        hmr = self.hmr
        self.assertEqual(hmr.HARNESS_SOURCE_RELATIVES, {
            "runner": "apps/control-room/scripts/docker-dev-hmr-qa.mjs",
            "loopback_proxy": "apps/control-room/scripts/lib/browser-qa-loopback-proxy.mjs",
        })
        source = (ROOT / "apps/control-room/scripts/docker-dev-hmr-qa.mjs").read_text(encoding="utf-8")
        self.assertIn("fileURLToPath(import.meta.url)", source)
        self.assertIn('new URL("./lib/browser-qa-loopback-proxy.mjs", import.meta.url)', source)
        self.assertIn("readHarnessSourceHashes", source)
        self.assertIn("data-fullmag-hmr-client", source)
        self.assertIn("page.on(\"websocket\"", source)
        self.assertIn("framereceived", source)
        self.assertIn("frame?.payload", source)
        self.assertIn("parsed?.type", source)
        self.assertIn("reloadpage", source)
        self.assertIn("pageerror", source)
        self.assertIn("waitForHmrConnection", source)

    def test_app_runtime_fence_uses_docker_inspect_restart_count(self):
        hmr = self.hmr
        backend_id, frontend_id = "a" * 64, "b" * 64
        documents = [
            {"Id": backend_id, "RestartCount": 0, "State": {"Running": True, "StartedAt": "2026-10-21T01:00:00Z"}},
            {"Id": frontend_id, "RestartCount": 0, "State": {"Running": True, "StartedAt": "2026-10-21T01:01:00Z"}},
        ]
        with patch.object(hmr.browser_qa, "_inspect", side_effect=documents):
            before = hmr._app_service_runtime_fence(backend_id, frontend_id)
        self.assertEqual(before["backend"]["restart_count"], 0)
        self.assertEqual(before["frontend"]["container_id"], frontend_id)
        hmr._validate_app_service_runtime_fence(before, before, backend_id, frontend_id)
        for change in ({"restart_count": 1}, {"started_at": "2026-10-21T02:00:00Z"}):
            after = json.loads(json.dumps(before))
            after["backend"].update(change)
            with self.subTest(change=change), self.assertRaises(hmr.ControlOutcomeUnknown):
                hmr._validate_app_service_runtime_fence(before, after, backend_id, frontend_id)
        stopped = json.loads(json.dumps(documents))
        stopped[0]["State"]["Running"] = False
        with patch.object(hmr.browser_qa, "_inspect", side_effect=stopped):
            with self.assertRaises(hmr.ControlOutcomeUnknown):
                hmr._app_service_runtime_fence(backend_id, frontend_id)

    def test_just_recipe_uses_managed_hmr_wrapper(self):
        text = (ROOT / "justfile").read_text(encoding="utf-8")
        start = text.index("docker-dev-hmr-qa")
        recipe = text[start:start + 700]
        self.assertIn("docker_dev_hmr_qa.py", recipe)
        self.assertNotIn("docker run", recipe)


if __name__ == "__main__":
    unittest.main()
