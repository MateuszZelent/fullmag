"""HTTP contract tests for the container-local runner API."""

from __future__ import annotations

import http.client
from dataclasses import replace
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch


SCRIPT_ROOT = Path(__file__).resolve().parents[2]
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from local_runner import container_api as container_api_module  # noqa: E402
from local_runner.container_api import (  # noqa: E402
    APICallbacks,
    MAX_RESPONSE_BYTES,
    _encode_json,
    _retention_page_response,
    create_server,
)


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

    def test_scoped_maintenance_preview_preserves_request_body(self):
        def preview(body):
            self.calls.append(('preview', body))
            return {'scope': body['scope'], 'plan_id': 'plan-01234567', 'status': 'planning'}
        self.server.callbacks = replace(self.server.callbacks, retention_plan_preview=preview)
        body = {'scope': 'sources', 'job_ids': ['a' * 32]}
        status, _, response = self.request('POST', '/api/v1/retention/plans', body=body)
        self.assertEqual(200, status)
        self.assertEqual('sources', self.json_body(response)['scope'])
        self.assertIn(('preview', body), self.calls)

    def test_retention_plan_get_repeats_read_only_list_without_preview(self):
        listed = {'items': [{'plan_id': 'plan-01234567', 'status': 'preview'}], 'total': 1}

        def list_plans():
            self.calls.append(('retention_plan_list',))
            return listed

        def preview(*_args):
            self.calls.append(('preview',))
            raise AssertionError('GET must not create a preview')

        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_list=list_plans,
            retention_plan_preview=preview,
        )
        for _ in range(2):
            status, _, response = self.request('GET', '/api/v1/retention/plans')
            self.assertEqual(200, status)
            self.assertEqual(listed, self.json_body(response))
        self.assertEqual([('retention_plan_list',), ('retention_plan_list',)], self.calls)

    def test_retention_plan_get_uses_read_only_legacy_fallback_not_preview(self):
        legacy = {'candidates': [], 'retained': []}

        def legacy_retention():
            self.calls.append(('retention',))
            return legacy

        def preview(*_args):
            self.calls.append(('preview',))
            raise AssertionError('GET must not create a preview')

        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_list=None,
            retention=legacy_retention,
            retention_plan_preview=preview,
        )
        status, _, response = self.request('GET', '/api/v1/retention/plans')
        self.assertEqual(200, status)
        self.assertEqual(legacy, self.json_body(response))
        self.assertEqual([('retention',)], self.calls)

    def test_retention_plan_get_fails_closed_without_a_read_only_callback(self):
        def preview(*_args):
            self.calls.append(('preview',))
            raise AssertionError('GET must not create a preview')

        self.server.callbacks = replace(
            self.server.callbacks,
            retention=None,
            retention_plan_list=None,
            retention_plan_preview=preview,
        )
        status, _, response = self.request('GET', '/api/v1/retention/plans')
        self.assertEqual(503, status)
        self.assertEqual('retention_unavailable', self.json_body(response)['error'])
        self.assertEqual([], self.calls)

    def test_legacy_preview_cannot_silently_ignore_a_new_scope(self):
        status, _, response = self.request('POST', '/api/v1/retention/plans', body={'scope': 'runtime'})
        self.assertEqual(503, status)
        self.assertEqual('maintenance_scope_unavailable', self.json_body(response)['error'])
        self.assertNotIn(('retention',), self.calls)

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

    def test_retention_ack_and_poll_are_authenticated_and_poll_does_not_apply(self):
        pid = 'plan-1234abcd'
        self.server.callbacks = replace(self.server.callbacks,
            retention_plan_apply=lambda value: self.calls.append(('apply', value)) or {'plan_id': value, 'status': 'accepted'},
            retention_plan_get=lambda value: self.calls.append(('poll', value)) or {'plan_id': value, 'status': 'running'})
        route = '/api/v1/retention/plans/' + pid
        self.assertEqual(401, self.request('POST', route + '/apply', body={}, token='wrong')[0])
        self.assertEqual(401, self.request('GET', route, token='wrong')[0])
        self.assertEqual([], self.calls)
        status, _, payload = self.request('POST', route + '/apply', body={})
        self.assertEqual(200, status)
        self.assertEqual('accepted', self.json_body(payload)['status'])
        for _ in range(2):
            status, _, payload = self.request('GET', route)
            self.assertEqual(200, status)
            self.assertEqual(pid, self.json_body(payload)['plan_id'])
        self.assertEqual([('apply', pid), ('poll', pid), ('poll', pid)], self.calls)

    def test_large_retention_detail_is_paged_and_bound_to_collection_revision(self):
        plan_id = 'plan-1234abcd'
        current = {
            'plan_id': plan_id,
            'scope': 'sources',
            'status': 'succeeded',
            'applied': True,
            'candidates': [
                {'candidate_id': f'candidate-{index:03d}', 'reason': 'x' * 70000}
                for index in range(40)
            ],
            'retained': [],
            'items': [{'job_id': f'job-{index:03d}', 'status': 'compacted'} for index in range(63)],
        }
        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_get=lambda value: self.calls.append(('poll', value)) or current,
        )
        route = f'/api/v1/retention/plans/{plan_id}'
        status, _, payload = self.request('GET', route)
        self.assertEqual(200, status)
        self.assertLessEqual(len(payload), MAX_RESPONSE_BYTES)
        initial = self.json_body(payload)
        self.assertEqual('paged', initial['representation'])
        self.assertFalse(initial['complete'])
        self.assertEqual(40, initial['collections']['candidates']['total'])
        self.assertGreater(initial['collections']['candidates']['returned'], 0)
        self.assertEqual(
            initial['collections']['candidates']['returned'],
            initial['collections']['candidates']['next_cursor'],
        )
        self.assertEqual(63, initial['collections']['items']['total'])
        self.assertEqual(63, initial['compacted_items_count'])
        self.assertRegex(initial['collections']['candidates']['revision'], r'^[a-f0-9]{64}$')

        revision = initial['collections']['candidates']['revision']
        cursor = initial['collections']['candidates']['next_cursor']
        stale_cursor = cursor
        candidate_ids = [entry['candidate_id'] for entry in initial['candidates']]
        while cursor is not None:
            status, _, payload = self.request(
                'GET',
                f'{route}?collection=candidates&cursor={cursor}&limit=5&revision={revision}',
            )
            self.assertEqual(200, status)
            self.assertLessEqual(len(payload), MAX_RESPONSE_BYTES)
            page = self.json_body(payload)['page']
            self.assertEqual(cursor, page['offset'])
            self.assertEqual(revision, page['revision'])
            self.assertGreater(page['returned'], 0)
            candidate_ids.extend(entry['candidate_id'] for entry in page['entries'])
            cursor = page['next_cursor']
        self.assertEqual(
            [f'candidate-{index:03d}' for index in range(40)],
            candidate_ids,
            'all candidate pages must preserve the original stable order without gaps or duplicates',
        )

        current = {
            **current,
            'candidates': [{**current['candidates'][0], 'reason': 'changed'}] + current['candidates'][1:],
        }
        status, _, payload = self.request(
            'GET',
            f'{route}?collection=candidates&cursor={stale_cursor}&limit=5&revision={revision}',
        )
        self.assertEqual(409, status)
        self.assertEqual('retention_collection_revision_conflict', self.json_body(payload)['error'])

    def test_retention_projection_bounds_unknown_fields_and_collection_envelope(self):
        plan_id = 'plan-0badcafe'
        plan = {
            'plan_id': plan_id,
            'scope': 'runtime',
            'status': 'preview',
            'candidates': [
                {'candidate_id': f'candidate-{index:03d}', 'detail': 'x' * 70000}
                for index in range(20)
            ],
            'retained': [],
            'items': [],
            'processed_jobs': {'nested': {'detail': 'y' * 100000}},
        }
        plan.update({
            f'unrecognized_collection_{index:03d}': [{'detail': 'z' * 1000}]
            for index in range(24)
        })
        long_field_name = 'untrusted_' + ('k' * 1000)
        plan[long_field_name] = {'nested': {'detail': 'w' * 100000}}
        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_get=lambda _value: plan,
        )
        route = f'/api/v1/retention/plans/{plan_id}'

        status, _, payload = self.request('GET', route)

        self.assertEqual(200, status)
        self.assertLessEqual(len(payload), MAX_RESPONSE_BYTES)
        initial = self.json_body(payload)
        self.assertEqual('paged', initial['representation'])
        self.assertFalse(initial['complete'])
        self.assertNotIn('processed_jobs', initial)
        self.assertNotIn(long_field_name, initial['omitted_fields'])
        self.assertLessEqual(len(initial['omitted_fields']), 16)
        self.assertTrue(initial['omitted_fields_truncated'])
        self.assertGreaterEqual(initial['omitted_fields_count'], 26)
        self.assertLessEqual(
            set(initial['collections']),
            {'candidates', 'retained', 'items', 'reference_errors', 'protected_external'},
        )
        self.assertNotIn('unrecognized_collection_000', initial)

        revision = initial['collections']['candidates']['revision']
        status, _, page_payload = self.request(
            'GET',
            f'{route}?collection=candidates&cursor=0&limit=1&revision={revision}',
        )
        self.assertEqual(200, status)
        self.assertLessEqual(len(page_payload), MAX_RESPONSE_BYTES)
        page = self.json_body(page_payload)
        self.assertEqual(1, page['page']['returned'])
        self.assertNotIn('error', page)

    def test_retention_page_query_is_strict_and_nonzero_cursor_requires_revision(self):
        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_get=lambda value: self.calls.append(('poll', value)) or {'plan_id': value, 'candidates': []},
        )
        calls_before = len(self.calls)
        route = '/api/v1/retention/plans/plan-1234abcd'
        invalid_queries = (
            '?collection=candidates&cursor=0&limit=101',
            '?collection=candidates&cursor=1&limit=10',
            '?collection=candidates&collection=items&cursor=0&limit=10',
            '?collection=candidates&cursor=0&limit=10&unexpected=x',
            '?collection=candidates&cursor=-1&limit=10',
        )
        for query in invalid_queries:
            with self.subTest(query=query):
                status, _, payload = self.request('GET', route + query)
                self.assertEqual(400, status)
                self.assertEqual('invalid_request', self.json_body(payload)['error'])
        self.assertEqual(calls_before, len(self.calls))

    def test_oversized_retention_detail_item_is_an_explicit_blocked_page(self):
        plan_id = 'plan-5678abcd'
        plan = {
            'plan_id': plan_id,
            'scope': 'execution',
            'status': 'preview',
            'candidates': [{'path': 'very-large', 'reason': 'z' * (MAX_RESPONSE_BYTES + 4096)}],
            'retained': [],
        }
        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_get=lambda _value: plan,
        )
        route = f'/api/v1/retention/plans/{plan_id}'
        status, _, payload = self.request('GET', route)
        self.assertEqual(200, status)
        self.assertLessEqual(len(payload), MAX_RESPONSE_BYTES)
        initial = self.json_body(payload)
        meta = initial['collections']['candidates']
        self.assertEqual(1, meta['total'])
        self.assertEqual(0, meta['returned'])
        self.assertEqual(0, meta['next_cursor'])
        status, _, payload = self.request(
            'GET',
            f'{route}?collection=candidates&cursor=0&limit=1&revision={meta["revision"]}',
        )
        self.assertEqual(200, status)
        self.assertLessEqual(len(payload), MAX_RESPONSE_BYTES)
        page = self.json_body(payload)['page']
        self.assertTrue(page['blocked'])
        self.assertEqual('retention_page_item_too_large', page['error'])
        self.assertEqual(0, page['blocked_cursor'])
        self.assertIsNone(page['next_cursor'])
        self.assertEqual([], page['entries'])

    def test_near_budget_prefix_and_oversized_next_item_stays_bounded(self):
        plan_id = 'plan-6789abcd'
        plan = {
            'plan_id': plan_id,
            'scope': 'execution',
            'status': 'preview',
            'candidates': [
                {'path': 'near-budget', 'reason': ''},
                {'path': 'oversized-next', 'reason': 'z' * (MAX_RESPONSE_BYTES + 4096)},
            ],
            'retained': [],
        }
        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_get=lambda _value: plan,
        )
        route = f'/api/v1/retention/plans/{plan_id}'
        status, _, payload = self.request('GET', route)
        self.assertEqual(200, status)
        initial = self.json_body(payload)
        revision = initial['collections']['candidates']['revision']
        query = {'collection': 'candidates', 'cursor': 0, 'revision': revision}
        prefix = _retention_page_response(plan, {**query, 'limit': 1})
        blocked = _retention_page_response(plan, {**query, 'limit': 2})
        blocked_metadata_bytes = len(_encode_json(blocked)) - len(_encode_json(prefix))
        self.assertGreater(blocked_metadata_bytes, 0)
        first_reason_length = MAX_RESPONSE_BYTES - len(_encode_json(prefix)) - blocked_metadata_bytes + 1
        self.assertGreater(first_reason_length, 0)
        plan['candidates'][0]['reason'] = 'a' * first_reason_length

        status, _, payload = self.request('GET', route)
        self.assertEqual(200, status)
        refreshed = self.json_body(payload)
        revision = refreshed['collections']['candidates']['revision']
        status, _, page_payload = self.request(
            'GET',
            f'{route}?collection=candidates&cursor=0&limit=2&revision={revision}',
        )

        self.assertEqual(200, status)
        self.assertLessEqual(len(page_payload), MAX_RESPONSE_BYTES)
        response = self.json_body(page_payload)
        self.assertNotEqual('response_too_large', response.get('error'))
        page = response['page']
        self.assertTrue(page['blocked'])
        self.assertIn(
            page['error'],
            {'retention_page_item_too_large', 'retention_detail_envelope_unrepresentable'},
        )
        self.assertEqual(page['returned'], len(page['entries']))
        self.assertIn(page['next_cursor'], (None, page['offset'] + page['returned']))

    def test_small_retention_detail_keeps_legacy_shape_and_large_apply_is_bounded(self):
        plan_id = 'plan-90abcdef'
        small = {'plan_id': plan_id, 'scope': 'execution', 'status': 'preview', 'candidates': []}
        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_get=lambda _value: small,
        )
        status, _, payload = self.request('GET', f'/api/v1/retention/plans/{plan_id}')
        self.assertEqual(200, status)
        self.assertEqual(small, self.json_body(payload))

        result = {
            'plan_id': plan_id,
            'scope': 'sources',
            'status': 'succeeded',
            'applied': True,
            'items': [
                {'job_id': f'job-{index:03d}', 'status': 'compacted', 'detail': 'q' * 50000}
                for index in range(40)
            ],
        }
        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_apply=lambda _value: result,
        )
        status, _, payload = self.request('POST', f'/api/v1/retention/plans/{plan_id}/apply', body={})
        self.assertEqual(200, status)
        self.assertLessEqual(len(payload), MAX_RESPONSE_BYTES)
        applied = self.json_body(payload)
        self.assertEqual('paged', applied['representation'])
        self.assertEqual(40, applied['collections']['items']['total'])
        self.assertEqual(40, applied['compacted_items_count'])

    def test_retention_cancel_requires_auth_valid_plan_id_and_empty_payload(self):
        pid = 'plan-01234567'
        self.server.callbacks = replace(
            self.server.callbacks,
            retention_plan_cancel=lambda value: self.calls.append(('retention_cancel', value)) or {
                'plan_id': value, 'scope': 'execution', 'status': 'cancel_requested', 'applied': False,
            },
        )
        route = '/api/v1/retention/plans/' + pid + '/cancel'

        self.assertEqual(401, self.request('POST', route, body={}, token='wrong')[0])
        self.assertEqual([], self.calls)
        self.assertEqual(404, self.request('POST', '/api/v1/retention/plans/invalid/cancel', body={})[0])
        self.assertEqual(400, self.request('POST', route, body={'unexpected': True})[0])
        self.assertEqual([], self.calls)

        status, _, payload = self.request('POST', route, body={})
        self.assertEqual(200, status)
        self.assertEqual('cancel_requested', self.json_body(payload)['status'])
        self.assertEqual([('retention_cancel', pid)], self.calls)

    def test_retention_cancel_fails_closed_without_backend_capability(self):
        self.server.callbacks = replace(self.server.callbacks, retention_plan_cancel=None)

        status, _, payload = self.request(
            'POST', '/api/v1/retention/plans/plan-01234567/cancel', body={})

        self.assertEqual(503, status)
        self.assertEqual('retention_cancel_unavailable', self.json_body(payload)['error'])
        self.assertEqual([], self.calls)

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

    def test_ui_dir_prefers_complete_workspace_sources_over_stale_generated_dirs(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            module_file = repo / "scripts" / "local_runner" / "container_api.py"
            module_file.parent.mkdir(parents=True)
            module_file.touch()

            source_ui = repo / "apps" / "runner-console"
            (source_ui / "src").mkdir(parents=True)
            (source_ui / "index.html").write_text("canonical source", encoding="utf-8")
            (source_ui / "styles.css").write_text("canonical styles", encoding="utf-8")
            (source_ui / "src" / "app.js").write_text("canonical app", encoding="utf-8")

            packaged_ui = module_file.parent / "ui_dist"
            packaged_ui.mkdir()
            (packaged_ui / "index.html").write_text("stale packaged UI", encoding="utf-8")
            stale_workspace_dist = source_ui / "dist"
            stale_workspace_dist.mkdir()
            (stale_workspace_dist / "index.html").write_text("stale workspace UI", encoding="utf-8")

            with patch.object(container_api_module, "__file__", str(module_file)):
                self.assertEqual(source_ui.resolve(), container_api_module._ui_dir())

    def test_ui_dir_preserves_packaged_candidates_and_missing_ui_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            module_file = repo / "scripts" / "local_runner" / "container_api.py"
            module_file.parent.mkdir(parents=True)
            module_file.touch()

            packaged_ui = module_file.parent / "ui_dist"
            packaged_ui.mkdir()
            (packaged_ui / "index.html").write_text("packaged UI", encoding="utf-8")
            workspace_dist = repo / "apps" / "runner-console" / "dist"
            workspace_dist.mkdir(parents=True)
            (workspace_dist / "index.html").write_text("workspace package", encoding="utf-8")

            with patch.object(container_api_module, "__file__", str(module_file)):
                self.assertEqual(packaged_ui.resolve(), container_api_module._ui_dir())

                unavailable_package = packaged_ui.with_name("ui_dist-unavailable")
                packaged_ui.rename(unavailable_package)
                self.assertEqual(workspace_dist.resolve(), container_api_module._ui_dir())

                unavailable_dist = workspace_dist.with_name("dist-unavailable")
                workspace_dist.rename(unavailable_dist)
                self.assertIsNone(container_api_module._ui_dir())

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

        # 11. POST /api/v1/retention/plans/{id}/apply (honest preview_only when no executor)
        status, _, payload = self.request("POST", "/api/v1/retention/plans/plan-abc123/apply")
        self.assertEqual(200, status)
        body = self.json_body(payload)
        self.assertEqual("plan-abc123", body["plan_id"])
        self.assertFalse(body["applied"])
        self.assertEqual("preview_only", body["status"])
        self.assertEqual(0, body["reclaimed_bytes"])
        self.assertEqual("cleanup_executor_not_enabled", body["error"])

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

        self.assertEqual(200, self.request(
            "GET",
            "/api/v1/jobs?status=running&page=2&worktree=master&sort=oldest&cursor=opaque-cursor",
        )[0])
        self.assertEqual("running", recorded["paginated_jobs"]["status"])
        self.assertEqual("2", recorded["paginated_jobs"]["page"])
        self.assertEqual("master", recorded["paginated_jobs"]["worktree"])
        self.assertEqual("oldest", recorded["paginated_jobs"]["sort"])
        self.assertEqual("opaque-cursor", recorded["paginated_jobs"]["cursor"])

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
