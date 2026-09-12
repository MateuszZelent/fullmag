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


if __name__ == "__main__":
    unittest.main()
