from __future__ import annotations

import copy
from contextlib import redirect_stdout
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import struct
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import smoke_antenna_external_lead_inspection as smoke


class InspectionHttpSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        # HTTP harness data only: this bundle is NOT a valid numerical artifact.
        self.payloads = {
            "bundle": b"opaque test bytes, not a native bundle",
            "sample_positions": struct.pack("<3d", 1e-9, 2e-9, 3e-9),
            "magnetic_field": struct.pack("<3d", -2.0, 0.0, 4.0),
            "device_vertex_ids": struct.pack("<2Q", 7, 3),
            "device_potential": struct.pack("<2d", 1.0, -1.0),
        }
        self.digest = "sha256:" + "a" * 64
        self.resource = {
            "resource_id": "data/antenna/stages/stage-000/external-lead-inspection",
            "session_id": "session", "session_epoch": "epoch", "run_id": "run",
            "runtime_stage_id": "stage-000", "stage_revision": 3,
            "record_content_digest": "sha256:" + "b" * 64,
            "schema_version": "antenna_external_lead_stage_output.v1",
            "stage_kind": "antenna_field_solve", "resolved_action": "external_lead_inspection",
            "stage_id": "authored", "port_mode_id": "port", "output_id": "output",
            "status": "inspection_only", "qualification": "NOT VERIFIED",
            "field_scope": "external_electrode_truncation",
            "outputs": [{"kind": "antenna_external_lead_inspection",
                         "manifest_ref": "antenna/external_lead_solutions/output/" + "a" * 64 + "/manifest.v1.json",
                         "payload_units": {"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"},
                         "reused_existing": False, "inspection_ref": {
                "stage_id": "authored", "output_id": "output", "content_digest": self.digest,
            }}],
            "manifest": {
                "schema_version": "antenna_external_lead_solution.v1",
                "validation_scope": "manifest_only", "content_digest": self.digest,
                "sampling_carrier": {"sample_count": 1},
            },
        }
        for kind, (path, scalar, layout, unit, count) in {
            "bundle": ("bundle.v1.bin", "ordered_binary_v1", "accepted_external_lead_bundle.ordered.v1", "1", len(self.payloads["bundle"])),
            "sample_positions": ("sample_positions.f64le.bin", "float64_le", "sample_xyz_interleaved", "m", 3),
            "magnetic_field": ("H.f64le.bin", "float64_le", "sample_xyz_interleaved", "A/m", 3),
            "device_vertex_ids": ("device_vertex_ids.u64le.bin", "uint64_le", "authored_device_vertex_order", "1", 2),
            "device_potential": ("device_V.f64le.bin", "float64_le", "authored_device_vertex_order", "V", 2),
        }.items():
            payload = self.payloads[kind]
            self.resource["manifest"][kind] = {
                "path": path, "scalar_type": scalar, "layout": layout, "unit": unit,
                "value_count": count, "byte_count": len(payload), "sha256": sha256(payload).hexdigest(),
            }
        self.calls: list[tuple[str, dict[str, str]]] = []

    def response(self, status: int, body: bytes = b"", **headers: str) -> smoke.HttpResult:
        return smoke.HttpResult(status, headers, body)

    def serve(self, origin: str, path: str, headers: dict[str, str], limit: int) -> smoke.HttpResult:
        self.calls.append((path, headers))
        parsed = urlsplit(path)
        if "/payloads/" not in parsed.path:
            if headers.get("If-None-Match") == '"metadata"':
                return self.response(304, etag='"metadata"', **{"cache-control": "no-cache"})
            return self.response(200, json.dumps(self.resource).encode(), etag='"metadata"',
                                 **{"content-type": "application/json", "cache-control": "no-cache"})
        kind = parsed.path.rsplit("/", 1)[1]
        digest = parse_qs(parsed.query).get("content_digest", [None])[0]
        if kind not in self.payloads or digest is None:
            return self.response(400, b'{"code":"bad_request"}', **{"content-type": "application/json"})
        if digest != self.digest:
            return self.response(409, b'{"code":"inspection_digest_mismatch"}', **{"content-type": "application/json"})
        body = self.payloads[kind]
        common = {"etag": f'"{kind}"', "accept-ranges": "bytes", "cache-control": "no-cache"}
        if headers.get("If-None-Match") == common["etag"]:
            return self.response(304, **common)
        if "Range" in headers:
            first, last = headers["Range"].removeprefix("bytes=").split("-", 1)
            if int(first) >= len(body):
                return self.response(416, **common, **{"content-range": f"bytes */{len(body)}"})
            end = int(last)
            return self.response(206, body[int(first):end + 1], **common,
                                 **{"content-type": "application/octet-stream", "content-range": f"bytes {first}-{end}/{len(body)}"})
        return self.response(200, body, **common, **{"content-type": "application/octet-stream"})

    def run_smoke(self, fetch=None):
        with patch.object(smoke, "request", side_effect=fetch or self.serve):
            return smoke.verify("http://127.0.0.1:8080", "stage-000")

    def test_all_payloads_ranges_cache_and_digest_gates_without_qualification(self) -> None:
        result = self.run_smoke()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["scope"], "http_inspection_integrity_only")
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertFalse(result["physics_qualified"])
        self.assertEqual(len(result["payloads"]), 5)
        self.assertEqual(len(self.calls), 25)
        self.assertTrue(all(call[0].startswith("/v2/sessions/current/data/antenna/stages/stage-000/") for call in self.calls))

    def test_invalid_manifest_units_counts_and_sizes_fail_before_binary_io(self) -> None:
        for key, value in [("unit", "A/m/A"), ("value_count", 4), ("byte_count", smoke.MAX_BINARY_BYTES + 1), ("sha256", "Z" * 64)]:
            original = copy.deepcopy(self.resource)
            with self.subTest(key=key):
                self.resource["manifest"]["magnetic_field"][key] = value
                self.calls.clear()
                with self.assertRaises(smoke.SmokeError):
                    self.run_smoke()
                self.assertEqual(len(self.calls), 1)
            self.resource = original

    def test_sha_error_and_nonfinite_float_are_not_success(self) -> None:
        self.payloads["magnetic_field"] = struct.pack("<3d", -2.0, 0.0, 5.0)
        with self.assertRaisesRegex(smoke.SmokeError, "SHA"):
            self.run_smoke()
        self.payloads["magnetic_field"] = struct.pack("<3d", float("nan"), 0.0, 5.0)
        self.resource["manifest"]["magnetic_field"]["sha256"] = sha256(self.payloads["magnetic_field"]).hexdigest()
        with self.assertRaisesRegex(smoke.SmokeError, "finite"):
            self.run_smoke()

    def test_partial_response_bytes_or_content_range_cannot_drift(self) -> None:
        for mutation in ["bytes", "range"]:
            def broken(*args):
                response = self.serve(*args)
                if response.status == 206:
                    if mutation == "bytes":
                        return smoke.HttpResult(206, response.headers, b"wrong")
                    return smoke.HttpResult(206, {**response.headers, "content-range": "bytes 0-2/3"}, response.body)
                return response
            with self.subTest(mutation=mutation), self.assertRaises(smoke.SmokeError):
                self.run_smoke(broken)

    def test_conditional_read_must_have_empty_body_and_same_etag(self) -> None:
        def broken(*args):
            response = self.serve(*args)
            if response.status == 304:
                return smoke.HttpResult(304, response.headers, b"not empty")
            return response
        with self.assertRaises(smoke.SmokeError):
            self.run_smoke(broken)

    def test_final_metadata_revision_change_invalidates_the_entire_run(self) -> None:
        def changed(*args):
            if args[2].get("If-None-Match") == '"metadata"':
                return self.response(200, b'{}', etag='"new-metadata"')
            return self.serve(*args)
        with self.assertRaisesRegex(smoke.SmokeError, "revision"):
            self.run_smoke(changed)

    def test_http_origin_cannot_carry_credentials_remote_host_or_redirect_target(self) -> None:
        for origin in ["http://example.com:8080", "http://user:secret@localhost:8080", "http://localhost:8080/other", "http://localhost:8080/?token=x", "file:///tmp/session"]:
            with self.subTest(origin=origin), self.assertRaises(smoke.SmokeError):
                smoke.validate_origin(origin)
        for origin in ["http://localhost:8080", "http://127.0.0.1:8080/", "http://[::1]:8080"]:
            self.assertEqual(smoke.validate_origin(origin), origin.rstrip("/"))

    def test_metadata_requires_record_digest_and_raw_reference_before_binary_io(self) -> None:
        for key in ["record_content_digest", "reference"]:
            original = copy.deepcopy(self.resource)
            with self.subTest(key=key):
                if key == "reference":
                    self.resource["outputs"][0]["inspection_ref"]["asset_id"] = "legacy"
                else:
                    self.resource.pop(key)
                self.calls.clear()
                with self.assertRaises(smoke.SmokeError):
                    self.run_smoke()
                self.assertEqual(len(self.calls), 1)
            self.resource = original

    def test_nested_output_cannot_promote_units_namespace_or_kind(self) -> None:
        for key, value in [("kind", "antenna_field_solution"), ("manifest_ref", "../manifest.v1.json"),
                           ("payload_units", {"H": "A/m/A"}), ("ready", True), ("reused_existing", 0)]:
            original = copy.deepcopy(self.resource)
            with self.subTest(key=key):
                self.resource["outputs"][0][key] = value
                self.calls.clear()
                with self.assertRaises(smoke.SmokeError):
                    self.run_smoke()
                self.assertEqual(len(self.calls), 1)
            self.resource = original

    def test_etag_must_be_one_strong_opaque_tag(self) -> None:
        for tag in ['W/"abc"', '"a", "b"', '"white space"', '"line\nbreak"']:
            with self.subTest(tag=tag), self.assertRaises(smoke.SmokeError):
                smoke.strong_etag(self.response(200, etag=tag, **{"cache-control": "no-cache"}))
        self.assertEqual(smoke.strong_etag(self.response(200, etag='"a,b"', **{"cache-control": "no-cache"})), '"a,b"')

    def test_partial_and_unsatisfiable_ranges_require_data_plane_headers(self) -> None:
        for status, header in [(206, "content-type"), (206, "accept-ranges"), (416, "accept-ranges")]:
            def broken(*args):
                response = self.serve(*args)
                if response.status == status:
                    return smoke.HttpResult(status, {key: value for key, value in response.headers.items() if key != header}, response.body)
                return response
            with self.subTest(status=status, header=header), self.assertRaises(smoke.SmokeError):
                self.run_smoke(broken)

    def test_sample_count_cannot_exceed_the_reader_bound(self) -> None:
        self.resource["manifest"]["sampling_carrier"]["sample_count"] = 2_000_000
        self.calls.clear()
        with self.assertRaisesRegex(smoke.SmokeError, "sample count"):
            self.run_smoke()
        self.assertEqual(len(self.calls), 1)

    def test_real_loopback_transport_is_get_only_bounded_and_does_not_redirect(self) -> None:
        visited = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                visited.append((self.command, self.path))
                status, body = 200, b"abc"
                if self.path == "/v2/redirect":
                    status, body = 302, b""
                elif self.path == "/v2/error":
                    status, body = 422, b"invalid"
                elif self.path == "/v2/oversize":
                    body = b"x" * 11
                elif self.path == "/v2/truncated":
                    self.send_response(200)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    self.wfile.write(b"5\r\na")
                    self.close_connection = True
                    return
                self.send_response(status)
                if status == 302:
                    self.send_header("Location", "/v2/must-not-be-visited")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            origin = f"http://127.0.0.1:{server.server_port}"
            with patch.dict("os.environ", {"HTTP_PROXY": "http://127.0.0.1:1", "NO_PROXY": ""}):
                self.assertEqual(smoke.request(origin, "/v2/success", {}, 10).body, b"abc")
                self.assertEqual(smoke.request(origin, "/v2/redirect", {}, 10).status, 302)
                self.assertEqual(smoke.request(origin, "/v2/error", {}, 10).status, 422)
                with self.assertRaisesRegex(smoke.SmokeError, "bound"):
                    smoke.request(origin, "/v2/oversize", {}, 10)
                with self.assertRaisesRegex(smoke.SmokeError, "read failed"):
                    smoke.request(origin, "/v2/truncated", {}, 10)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=1)
        self.assertEqual(visited, [("GET", f"/v2/{name}") for name in ("success", "redirect", "error", "oversize", "truncated")])

    def test_cli_failure_remains_unqualified_machine_readable_json(self) -> None:
        output = io.StringIO()
        with patch.object(smoke, "verify", side_effect=smoke.SmokeError("deliberate failure")), redirect_stdout(output):
            self.assertEqual(smoke.main(["--origin", "http://localhost:8080", "--stage-id", "stage-000"]), 1)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertFalse(result["physics_qualified"])


if __name__ == "__main__":
    unittest.main()
