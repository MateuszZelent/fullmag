"""HTTP contract tests for the container-local runner API."""

from __future__ import annotations

import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest


SCRIPT_ROOT = Path(__file__).resolve().parents[2]
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from local_runner.container_api import APICallbacks, create_server  # noqa: E402


class ContainerAPITests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = self.root / "config.json"
        self.config.write_text(json.dumps({"bearer_token": "unit-test-secret"}), encoding="utf-8")
        self.calls = []
        callbacks = APICallbacks(
            submit=lambda payload: self.calls.append(("submit", payload)) or {"job_id": "job-1", "state": "queued"},
            list=lambda: self.calls.append(("list",)) or [{"job_id": "job-1", "state": "queued"}],
            get=lambda job_id: self.calls.append(("get", job_id)) or {"job_id": job_id, "state": "succeeded"},
            logs=lambda job_id: self.calls.append(("logs", job_id)) or "worker output\n",
            cancel=lambda job_id: self.calls.append(("cancel", job_id)) or {
                "job_id": job_id,
                "state": "cancel_requested",
            },
            stop=lambda: self.calls.append(("stop",)) or {"state": "stopping"},
            resume=lambda: self.calls.append(("resume",)) or {"resumed": True},
            retention=lambda: self.calls.append(("retention",)) or {"candidates": [], "retained": []},
        )
        self.server = create_server(callbacks, config_path=self.config, host="127.0.0.1", port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, *, body=None, token="unit-test-secret", headers=None):
        request_headers = {"Authorization": f"Bearer {token}"}
        if headers:
            request_headers.update(headers)
        encoded = None
        if body is not None:
            encoded = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")
            request_headers["Content-Length"] = str(len(encoded))
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=encoded, headers=request_headers)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, dict(response.getheaders()), payload

    @staticmethod
    def json_body(payload):
        return json.loads(payload.decode("utf-8"))

    def test_health_and_all_fixed_routes_use_json_callbacks(self):
        status, _, payload = self.request("GET", "/health")
        self.assertEqual(200, status)
        self.assertTrue(self.json_body(payload)["ok"])
        self.assertTrue(self.json_body(payload)["api"]["started_at"])
        self.assertTrue(self.json_body(payload)["api"]["last_request_at"])

        self.assertEqual(200, self.request("GET", "/jobs")[0])
        self.assertEqual(200, self.request("GET", "/jobs/job-1")[0])
        status, _, payload = self.request("GET", "/jobs/job-1/logs")
        self.assertEqual(200, status)
        self.assertEqual("worker output\n", self.json_body(payload)["logs"])
        self.assertEqual(201, self.request("POST", "/jobs", body={"operation": "build"})[0])
        self.assertEqual(200, self.request("POST", "/jobs/job-1/cancel")[0])
        self.assertEqual(200, self.request("POST", "/stop")[0])
        self.assertEqual(200, self.request("POST", "/resume")[0])
        self.assertEqual(200, self.request("GET", "/retention")[0])
        self.assertEqual(
            [
                "list",
                "get",
                "logs",
                "submit",
                "cancel",
                "stop",
                "resume",
                "retention",
            ],
            [call[0] for call in self.calls],
        )

    def test_bearer_auth_is_required_and_token_is_not_in_error_response(self):
        status, _, payload = self.request("GET", "/jobs", token="wrong")
        self.assertEqual(401, status)
        self.assertNotIn(b"unit-test-secret", payload)
        self.assertEqual([], self.calls)

        status, _, payload = self.request("GET", "/jobs", headers={"Authorization": "Basic unit-test-secret"})
        self.assertEqual(401, status)
        self.assertNotIn(b"unit-test-secret", payload)

    def test_origin_is_rejected_without_cors_headers(self):
        status, headers, payload = self.request("GET", "/jobs", headers={"Origin": "http://evil.invalid"})
        self.assertEqual(403, status)
        self.assertNotIn("access-control-allow-origin", {key.lower() for key in headers})
        self.assertNotIn(b"unit-test-secret", payload)
        self.assertEqual([], self.calls)

    def test_body_limit_and_json_shape_are_enforced(self):
        oversized = b"{" + b"\"x\":\"" + b"a" * (64 * 1024) + b"\"}"
        status, _, _ = self.request("POST", "/jobs", body=oversized)
        self.assertEqual(413, status)
        self.assertEqual([], self.calls)

        status, _, _ = self.request("POST", "/jobs", body=b"not-json")
        self.assertEqual(400, status)
        status, _, _ = self.request("POST", "/jobs", body=["not", "an", "object"])
        self.assertEqual(400, status)

    def test_cancel_and_stop_allow_empty_callbacks_without_false_not_found(self):
        calls = []
        self.server.callbacks = APICallbacks(
            submit=lambda payload: None,
            list=lambda: [],
            get=lambda job_id: None,
            logs=lambda job_id: None,
            cancel=lambda job_id: calls.append(("cancel", job_id)),
            stop=lambda: calls.append(("stop",)),
        )
        self.assertEqual(200, self.request("POST", "/jobs/job-1/cancel")[0])
        self.assertEqual(200, self.request("POST", "/stop")[0])
        self.assertEqual([("cancel", "job-1"), ("stop",)], calls)
        self.assertEqual(400, self.request("POST", "/jobs/job-1/cancel", body=b"not-json")[0])
        self.assertEqual([("cancel", "job-1"), ("stop",)], calls)

    def test_fixed_routes_reject_originated_paths_and_unsupported_methods(self):
        self.assertEqual(404, self.request("GET", "/jobs/job-1/unknown")[0])
        self.assertEqual(404, self.request("GET", "/jobs/../config")[0])
        status, headers, _ = self.request("PUT", "/jobs")
        self.assertEqual(405, status)
        self.assertIn("POST", headers["Allow"])
        self.assertEqual([], self.calls)

    def test_callback_exceptions_are_not_reflected_or_logged(self):
        token = "unit-test-secret"
        self.server.callbacks = APICallbacks(
            submit=lambda payload: (_ for _ in ()).throw(RuntimeError(token)),
            list=lambda: [],
            get=lambda job_id: None,
            logs=lambda job_id: None,
            cancel=lambda job_id: None,
            stop=lambda: None,
        )
        status, _, payload = self.request("POST", "/jobs", body={"operation": "build"})
        self.assertEqual(500, status)
        self.assertNotIn(token.encode("utf-8"), payload)

    def test_unavailable_submit_is_not_an_invalid_payload(self):
        from local_runner.container_api import APIUnavailable

        self.server.callbacks = APICallbacks(
            submit=lambda payload: (_ for _ in ()).throw(APIUnavailable("paused")),
            list=lambda: [],
            get=lambda job_id: None,
            logs=lambda job_id: None,
            cancel=lambda job_id: None,
            stop=lambda: None,
        )
        status, _, payload = self.request("POST", "/jobs", body={"operation": "build"})
        self.assertEqual(503, status)
        self.assertEqual({"error": "runner_unavailable"}, self.json_body(payload))

    def test_ui_routes_serve_static_files_and_redirect(self):
        # 0. / redirects to /ui/
        status, headers, _ = self.request("GET", "/")
        self.assertEqual(301, status)
        self.assertEqual("/ui/", headers.get("Location") or headers.get("location"))

        # 1. /ui redirects to /ui/
        status, headers, _ = self.request("GET", "/ui")
        self.assertEqual(301, status)
        self.assertEqual("/ui/", headers.get("Location") or headers.get("location"))

        # 2. /ui/ serves index.html
        status, headers, payload = self.request("GET", "/ui/")
        self.assertEqual(200, status)
        content_type = headers.get("Content-Type") or headers.get("content-type")
        self.assertIn("text/html", content_type)
        self.assertIn(b"Fullmag Build Runner", payload)

        # 3. /ui/styles.css serves stylesheet
        status, headers, payload = self.request("GET", "/ui/styles.css")
        self.assertEqual(200, status)
        content_type = headers.get("Content-Type") or headers.get("content-type")
        self.assertIn("text/css", content_type)

        # 4. SPA subroute /ui/storage serves index.html
        status, headers, payload = self.request("GET", "/ui/storage")
        self.assertEqual(200, status)
        content_type = headers.get("Content-Type") or headers.get("content-type")
        self.assertIn("text/html", content_type)
        self.assertIn(b"Fullmag Build Runner", payload)

        # 5. Path traversal attempt rejected
        status, _, _ = self.request("GET", "/ui/../config.json")
        self.assertEqual(404, status)

    def test_browser_session_exchange_and_cookie_authentication(self):
        # Invalid token returns 401
        status, _, payload = self.request("POST", "/api/v1/auth/session", body={"token": "bad-secret"})
        self.assertEqual(401, status)
        self.assertEqual({"error": "invalid_token"}, self.json_body(payload))

        # Valid token creates session and returns Set-Cookie
        status, headers, payload = self.request("POST", "/api/v1/auth/session", body={"token": "unit-test-secret"})
        self.assertEqual(200, status)
        data = self.json_body(payload)
        self.assertTrue(data["ok"])
        self.assertTrue(data["authenticated"])
        set_cookie = headers.get("Set-Cookie") or headers.get("set-cookie")
        self.assertIsNotNone(set_cookie)
        self.assertIn("runner_session=", set_cookie)
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=Strict", set_cookie)

        # Extract session token from cookie
        cookie_val = set_cookie.split(";")[0]

        # Call authenticated endpoint without Bearer header, only with Cookie
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        conn.request("GET", "/api/v1/overview", headers={"Cookie": cookie_val})
        resp = conn.getresponse()
        resp_payload = resp.read()
        conn.close()

        self.assertEqual(200, resp.status)
        overview_data = json.loads(resp_payload.decode("utf-8"))
        self.assertIn("worker", overview_data)
        self.assertIn("storage", overview_data)

        # Matching Origin from local host is accepted
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        conn.request(
            "POST",
            "/api/v1/auth/session",
            body=json.dumps({"token": "unit-test-secret"}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": f"http://127.0.0.1:{self.server.server_port}",
                "Host": f"127.0.0.1:{self.server.server_port}",
            },
        )
        resp = conn.getresponse()
        self.assertEqual(200, resp.status)
        conn.close()

    def test_v1_observability_and_storage_endpoints(self):
        # 1. GET /api/v1/overview
        status, _, payload = self.request("GET", "/api/v1/overview")
        self.assertEqual(200, status)
        self.assertIn("worker", self.json_body(payload))

        # 2. GET /api/v1/jobs
        status, _, payload = self.request("GET", "/api/v1/jobs?limit=10")
        self.assertEqual(200, status)

        # 3. GET /api/v1/storage/volumes
        status, _, payload = self.request("GET", "/api/v1/storage/volumes")
        self.assertEqual(200, status)

        # 4. GET /api/v1/storage/resources
        status, _, payload = self.request("GET", "/api/v1/storage/resources")
        self.assertEqual(200, status)

        # 5. GET /api/v1/processes
        status, _, payload = self.request("GET", "/api/v1/processes")
        self.assertEqual(200, status)

        # 6. GET /api/v1/alerts
        status, _, payload = self.request("GET", "/api/v1/alerts")
        self.assertEqual(200, status)

        # 7. GET /api/v1/events
        status, _, payload = self.request("GET", "/api/v1/events?limit=20")
        self.assertEqual(200, status)

        # 8. GET /api/v1/retention/policy
        status, _, payload = self.request("GET", "/api/v1/retention/policy")
        self.assertEqual(200, status)

        # 9. PUT /api/v1/retention/policy
        status, _, payload = self.request("PUT", "/api/v1/retention/policy", body={"mode": "preview"})
        self.assertEqual(200, status)

        # 10. POST /api/v1/retention/plans
        status, _, payload = self.request("POST", "/api/v1/retention/plans")
        self.assertEqual(200, status)

        # 11. POST /api/v1/retention/plans/{id}/apply (idempotent apply route)
        status, _, payload = self.request("POST", "/api/v1/retention/plans/plan-abc123/apply")
        self.assertEqual(200, status)
        self.assertEqual("plan-abc123", self.json_body(payload)["plan_id"])
        self.assertTrue(self.json_body(payload)["applied"])

        # 12. POST /api/v1/resources/test-res/pin
        status, _, payload = self.request("POST", "/api/v1/resources/test-res/pin", body={"pinned": True})
        self.assertEqual(200, status)
        self.assertTrue(self.json_body(payload)["pinned"])

        # 13. GET /api/v1/jobs/{id}/events, /logs, /metrics, /resources
        self.assertEqual(200, self.request("GET", "/api/v1/jobs/job-1/events")[0])
        self.assertEqual(200, self.request("GET", "/api/v1/jobs/job-1/logs")[0])
        self.assertEqual(200, self.request("GET", "/api/v1/jobs/job-1/metrics")[0])
        self.assertEqual(200, self.request("GET", "/api/v1/jobs/job-1/resources")[0])

    def test_v1_custom_callbacks_dispatch_correct_arguments(self):
        recorded = {}
        self.server.callbacks = APICallbacks(
            submit=lambda payload: None,
            list=lambda: [],
            get=lambda job_id: {"job_id": job_id},
            logs=lambda job_id: f"logs for {job_id}",
            cancel=lambda job_id: None,
            stop=lambda: None,
            paginated_jobs=lambda q: recorded.setdefault("paginated_jobs", q) or {"items": []},
            job_detail=lambda jid: recorded.setdefault("job_detail", jid) or {"job_id": jid, "stages": []},
            job_events=lambda jid: recorded.setdefault("job_events", jid) or [{"event": "test"}],
            job_metrics=lambda jid: recorded.setdefault("job_metrics", jid) or [{"ram_mb": 128}],
            job_resources=lambda jid: recorded.setdefault("job_resources", jid) or [{"name": "exec"}],
            retention_plan_apply=lambda pid: recorded.setdefault("retention_plan_apply", pid) or {"applied": True, "plan_id": pid},
            pin_resource=lambda rid, body: recorded.setdefault("pin_resource", (rid, body)) or {"resource_id": rid, "pinned": body.get("pinned", True)},
        )

        self.assertEqual(200, self.request("GET", "/api/v1/jobs?status=running&page=2&worktree=master&sort=oldest")[0])
        self.assertEqual("running", recorded["paginated_jobs"]["status"])
        self.assertEqual("2", recorded["paginated_jobs"]["page"])
        self.assertEqual("master", recorded["paginated_jobs"]["worktree"])
        self.assertEqual("oldest", recorded["paginated_jobs"]["sort"])

        self.assertEqual(200, self.request("GET", "/api/v1/jobs/job-xyz")[0])
        self.assertEqual("job-xyz", recorded["job_detail"])

        self.assertEqual(200, self.request("GET", "/api/v1/jobs/job-xyz/events")[0])
        self.assertEqual("job-xyz", recorded["job_events"])

        self.assertEqual(200, self.request("GET", "/api/v1/jobs/job-xyz/metrics")[0])
        self.assertEqual("job-xyz", recorded["job_metrics"])

        self.assertEqual(200, self.request("GET", "/api/v1/jobs/job-xyz/resources")[0])
        self.assertEqual("job-xyz", recorded["job_resources"])

        self.assertEqual(200, self.request("POST", "/api/v1/retention/plans/plan-999/apply")[0])
        self.assertEqual("plan-999", recorded["retention_plan_apply"])

        self.assertEqual(200, self.request("POST", "/api/v1/resources/res-123/pin", body={"pinned": False, "reason": "test unpin"})[0])
        self.assertEqual(("res-123", {"pinned": False, "reason": "test unpin"}), recorded["pin_resource"])

    def test_default_port_is_48765_and_configurable_via_env(self):
        import os
        from unittest.mock import patch
        from local_runner import container_api

        self.assertEqual(48765, container_api.DEFAULT_PORT)

        with patch.object(container_api.RunnerAPIServer, "__init__", return_value=None) as mock_init:
            with patch.dict(os.environ, {}, clear=True):
                container_api.create_server(self.server.callbacks, config_path=self.config, host="127.0.0.1", port=None)
                self.assertEqual(("127.0.0.1", 48765), mock_init.call_args[0][0])

            with patch.dict(os.environ, {"FULLMAG_RUNNER_PORT": ""}):
                container_api.create_server(self.server.callbacks, config_path=self.config, host="127.0.0.1", port=None)
                self.assertEqual(("127.0.0.1", 48765), mock_init.call_args[0][0])

            with patch.dict(os.environ, {"FULLMAG_RUNNER_PORT": "   "}):
                container_api.create_server(self.server.callbacks, config_path=self.config, host="127.0.0.1", port=None)
                self.assertEqual(("127.0.0.1", 48765), mock_init.call_args[0][0])

            with patch.dict(os.environ, {"FULLMAG_RUNNER_PORT": "54321"}):
                container_api.create_server(self.server.callbacks, config_path=self.config, host="127.0.0.1", port=None)
                self.assertEqual(("127.0.0.1", 54321), mock_init.call_args[0][0])

            with patch.dict(os.environ, {"FULLMAG_RUNNER_PORT": "invalid"}):
                with self.assertRaises(container_api.APIError):
                    container_api.create_server(self.server.callbacks, config_path=self.config, host="127.0.0.1", port=None)

            with patch.dict(os.environ, {"FULLMAG_RUNNER_PORT": "70000"}):
                with self.assertRaises(container_api.APIError):
                    container_api.create_server(self.server.callbacks, config_path=self.config, host="127.0.0.1", port=None)


if __name__ == "__main__":
    unittest.main()
