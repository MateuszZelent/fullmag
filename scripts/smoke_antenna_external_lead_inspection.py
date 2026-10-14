#!/usr/bin/env python3
"""Read-only HTTP inspection smoke; never qualifies native antenna physics."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from hashlib import sha256
from http.client import HTTPException
import json
import math
import re
import struct
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_BINARY_BYTES = 128 << 20
MAX_METADATA_BYTES = 1 << 20
PAYLOADS = {
    "bundle": ("bundle.v1.bin", "ordered_binary_v1", "accepted_external_lead_bundle.ordered.v1", "1", 1),
    "sample_positions": ("sample_positions.f64le.bin", "float64_le", "sample_xyz_interleaved", "m", 8),
    "magnetic_field": ("H.f64le.bin", "float64_le", "sample_xyz_interleaved", "A/m", 8),
    "device_vertex_ids": ("device_vertex_ids.u64le.bin", "uint64_le", "authored_device_vertex_order", "1", 8),
    "device_potential": ("device_V.f64le.bin", "float64_le", "authored_device_vertex_order", "V", 8),
}
CURRENT_POLICY = {
    "schema_version": "accepted_external_lead_current_display.ordered.v1",
    "operator_version": "fem_accepted_external_lead_current_display.v1",
    "current_evaluator_version": "fem_generic_affine_rt0.v1",
    "sampling_policy": "cell_center_and_cell_local_vertices.v1",
    "center_policy": "vertex_quarter_sum.long_double.v1",
    "normalization": "raw_authored_current", "coordinate_unit": "m",
    "current_density_unit": "A/m^2",
}
CURRENT_PAYLOAD = ("current_display.v1.bin", "ordered_binary_v1",
                   "accepted_external_lead_current_display.ordered.v1", "A/m^2", 1)


class SmokeError(ValueError):
    pass


@dataclass(frozen=True)
class HttpResult:
    status: int
    headers: dict[str, str]
    body: bytes


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeError(message)


def validate_origin(origin: str) -> str:
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError as error:
        raise SmokeError("invalid HTTP origin") from error
    require(
        parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1")
        and parsed.username is None and parsed.password is None
        and parsed.path in ("", "/") and "?" not in origin and "#" not in origin
        and (port is None or 0 < port <= 65535),
        "origin must be a credential-free loopback HTTP origin without a path/query/fragment",
    )
    return origin.rstrip("/")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(origin: str, path: str, headers: dict[str, str], limit: int) -> HttpResult:
    origin = validate_origin(origin)
    require(path.startswith("/v2/") and not path.startswith("//"), "invalid API path")
    require(type(limit) is int and 0 <= limit <= MAX_BINARY_BYTES, "invalid response bound")
    # Do not forward loopback inspection requests through proxy environments.
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        try:
            response = opener.open(Request(origin + path, headers=headers, method="GET"), timeout=30)
        except HTTPError as error:
            response = error
        with response:
            body = response.read(limit + 1)
            require(len(body) <= limit, "HTTP response exceeds declared read bound")
            return HttpResult(response.code, {key.lower(): value for key, value in response.headers.items()}, body)
    except (URLError, OSError, HTTPException) as error:
        raise SmokeError("HTTP inspection read failed") from error


def strong_etag(response: HttpResult) -> str:
    etag = response.headers.get("etag", "")
    require(len(etag) >= 2 and etag.startswith('"') and etag.endswith('"')
            and all(ord(c) == 0x21 or 0x23 <= ord(c) <= 0x7e or 0x80 <= ord(c) <= 0xff for c in etag[1:-1]), "missing single strong ETag")
    require(response.headers.get("cache-control") == "no-cache", "missing no-cache policy")
    return etag


def json_body(response: HttpResult, status: int) -> dict:
    require(response.status == status, f"expected HTTP {status}, received {response.status}")
    require(response.headers.get("content-type", "").split(";", 1)[0] == "application/json", "expected JSON response")
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate HTTP JSON key")
            result[key] = value
        return result
    try:
        value = json.loads(response.body, object_pairs_hook=unique_object,
                           parse_constant=lambda _: require(False, "non-finite HTTP JSON token"))
    except (UnicodeError, ValueError) as error:
        raise SmokeError("invalid JSON response") from error
    require(isinstance(value, dict), "expected JSON object")
    return value


def validate_descriptor(descriptor, kind, spec):
    path, scalar, layout, unit, width = spec
    require(isinstance(descriptor, dict) and set(descriptor) == {
        "path", "scalar_type", "layout", "unit", "value_count", "byte_count", "sha256"},
        f"missing or invalid {kind} descriptor")
    require(all(descriptor.get(key) == value for key, value in {
        "path": path, "scalar_type": scalar, "layout": layout, "unit": unit}.items()),
        f"invalid {kind} path/type/layout/unit")
    count, size = descriptor.get("value_count"), descriptor.get("byte_count")
    require(type(count) is int and count > 0 and type(size) is int
            and 0 < size <= MAX_BINARY_BYTES and size == count * width,
            f"invalid {kind} count/size")
    require(isinstance(descriptor.get("sha256"), str)
            and re.fullmatch(r"[0-9a-f]{64}", descriptor["sha256"]) is not None,
            f"invalid {kind} SHA")


def validate_current_receipt(receipt):
    require(isinstance(receipt, dict) and set(receipt) == set(CURRENT_POLICY) | {"cell_count", "payload"},
            "invalid current display receipt shape")
    require(all(receipt.get(key) == value for key, value in CURRENT_POLICY.items()),
            "invalid current display policy/SI")
    count = receipt["cell_count"]
    require(type(count) is int and 0 < count <= MAX_BINARY_BYTES // 1501,
            "invalid current display cell count")
    validate_descriptor(receipt["payload"], "current_snapshot", CURRENT_PAYLOAD)
    require(count * 1501 < receipt["payload"]["byte_count"], "current snapshot framing/count mismatch")


def validate_resource(resource: dict, stage_id: str) -> tuple[dict, str]:
    require(resource.get("runtime_stage_id") == stage_id, "runtime stage identity mismatch")
    require(resource.get("resource_id") == f"data/antenna/stages/{stage_id}/external-lead-inspection", "resource identity mismatch")
    for key in ("session_id", "session_epoch", "request_scope_epoch", "run_id", "stage_id", "output_id", "port_mode_id"):
        require(isinstance(resource.get(key), str) and bool(resource[key].strip())
                and len(resource[key]) <= 4096 and "\0" not in resource[key], f"missing or invalid {key}")
    require(isinstance(resource.get("record_content_digest"), str) and re.fullmatch(r"sha256:[0-9a-f]{64}", resource["record_content_digest"]) is not None, "invalid record digest")
    require(type(resource.get("stage_revision")) is int and resource["stage_revision"] >= 0, "invalid stage revision")
    require(isinstance(resource.get("schema_version"), str), "invalid inspection schema_version type")
    generation = {"antenna_external_lead_stage_output.v1": 1,
                  "antenna_external_lead_stage_output.v2": 2}.get(resource.get("schema_version"))
    require(generation is not None, "unexpected inspection schema_version")
    for key, expected in {
        "stage_kind": "antenna_field_solve",
        "resolved_action": "external_lead_inspection", "status": "inspection_only",
        "qualification": "NOT VERIFIED", "field_scope": "external_electrode_truncation",
    }.items():
        require(resource.get(key) == expected, f"unexpected inspection {key}")
    require(not any(key in resource for key in ("asset_id", "solution_ref", "quantity", "ready", "H_per_A", "capabilities", "device_current")), "inspection was promoted to a field basis")
    outputs = resource.get("outputs")
    require(isinstance(outputs, list) and len(outputs) == 1 and isinstance(outputs[0], dict), "expected one inspection output")
    output = outputs[0]
    require(set(output) == {"kind", "inspection_ref", "manifest_ref", "payload_units", "reused_existing"}
            and output["kind"] == "antenna_external_lead_inspection" and type(output["reused_existing"]) is bool, "invalid or promoted inspection output")
    reference = output.get("inspection_ref")
    require(isinstance(reference, dict) and set(reference) == {"stage_id", "output_id", "content_digest"}, "missing or promoted inspection reference")
    require(reference.get("stage_id") == resource["stage_id"] and reference.get("output_id") == resource["output_id"], "authored output identity mismatch")
    digest = reference.get("content_digest")
    require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is not None, "invalid inspection digest")
    require(output["manifest_ref"] == f"antenna/external_lead_solutions/{resource['output_id']}/{digest[7:]}/manifest.v{generation}.json", "invalid inspection manifest reference")
    units = {"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"}
    if generation == 2:
        units["J_charge"] = "A/m^2"
    require(output["payload_units"] == units, "invalid inspection payload units")
    manifest = resource.get("manifest")
    require(isinstance(manifest, dict), "missing inspection manifest")
    require(manifest.get("schema_version") == f"antenna_external_lead_solution.v{generation}" and manifest.get("validation_scope") == "manifest_only", "invalid manifest validation scope/generation")
    require("capabilities" not in manifest and "device_current" not in manifest,
            "manifest-only metadata cannot declare display availability")
    if generation == 2:
        validate_current_receipt(manifest.get("current_display"))
    else:
        require("current_display" not in manifest, "legacy manifest cannot declare current snapshot")
    require(manifest.get("content_digest") == digest, "manifest reference digest mismatch")
    sampling = manifest.get("sampling_carrier")
    require(isinstance(sampling, dict) and type(sampling.get("sample_count")) is int and 1 <= sampling["sample_count"] <= 1_000_000, "invalid sample count")
    for kind, spec in PAYLOADS.items():
        validate_descriptor(manifest.get(kind), kind, spec)
    require(manifest["sample_positions"]["value_count"] == manifest["magnetic_field"]["value_count"] == 3 * sampling["sample_count"], "xyz/sample count mismatch")
    require(manifest["device_vertex_ids"]["value_count"] == manifest["device_potential"]["value_count"], "device ID/potential count mismatch")
    return manifest, digest


def session_scope(resource: dict, request_scope_epoch: str) -> str:
    # Match encodeURIComponent, not form encoding (which would use '+').
    return "&".join(f"{key}=" + quote(value, safe="-_.!~*'()") for key, value in (
        ("session", resource["session_id"]), ("epoch", resource["session_epoch"]),
        ("request_scope_epoch", request_scope_epoch),
    ))


def verify_binary(origin, path, scope_headers, kind, descriptor, *, fetch=None):
    """Check one immutable binary resource, including its cache/range contract."""
    fetch = request if fetch is None else fetch
    response = fetch(origin, path, scope_headers, descriptor["byte_count"])
    require(response.status == 200, f"{kind}: expected HTTP 200, received {response.status}")
    require(response.headers.get("content-type") == "application/octet-stream" and response.headers.get("accept-ranges") == "bytes", f"{kind}: invalid binary headers")
    etag = strong_etag(response)
    require(len(response.body) == descriptor["byte_count"], f"{kind}: byte count mismatch")
    require(sha256(response.body).hexdigest() == descriptor["sha256"], f"{kind}: SHA mismatch")
    if descriptor["scalar_type"] == "float64_le":
        require(all(math.isfinite(value) for (value,) in struct.iter_unpack("<d", response.body)), f"{kind}: non-finite float")
    cached = fetch(origin, path, {**scope_headers, "If-None-Match": etag}, MAX_METADATA_BYTES)
    require(cached.status == 304 and not cached.body and strong_etag(cached) == etag, f"{kind}: invalid conditional response")
    end = min(15, len(response.body) - 1)
    partial = fetch(origin, path, {**scope_headers, "Range": f"bytes=0-{end}"}, MAX_METADATA_BYTES)
    require(partial.status == 206 and partial.body == response.body[:end + 1]
            and partial.headers.get("content-type") == "application/octet-stream"
            and partial.headers.get("accept-ranges") == "bytes"
            and partial.headers.get("content-range") == f"bytes 0-{end}/{len(response.body)}"
            and strong_etag(partial) == etag, f"{kind}: invalid partial response")
    outside = fetch(origin, path, {**scope_headers, "Range": f"bytes={len(response.body)}-"}, MAX_METADATA_BYTES)
    require(outside.status == 416 and not outside.body and outside.headers.get("accept-ranges") == "bytes"
            and outside.headers.get("content-range") == f"bytes */{len(response.body)}"
            and strong_etag(outside) == etag, f"{kind}: invalid unsatisfiable range")
    return response.body, etag


def verify(origin: str, stage_id: str) -> dict[str, object]:
    origin = validate_origin(origin)
    require(bool(stage_id.strip()) and len(stage_id) <= 4096 and "\0" not in stage_id, "invalid runtime stage ID")
    path = f"/v2/sessions/current/data/antenna/stages/{quote(stage_id, safe='')}/external-lead-inspection"
    metadata = request(origin, path, {}, MAX_METADATA_BYTES)
    resource = json_body(metadata, 200)
    metadata_etag = strong_etag(metadata)
    manifest, digest = validate_resource(resource, stage_id)
    scope_headers = {"x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"])}
    checked = []
    descriptors = {kind: manifest[kind] for kind in PAYLOADS}
    if "current_display" in manifest:
        descriptors["current_snapshot"] = manifest["current_display"]["payload"]
        import antenna_rt0_fixture_check as framing
        require(all(descriptors[kind]["byte_count"] <= framing.LIMIT for kind in ("bundle", "current_snapshot")),
                "current snapshot/bundle exceeds bounded fixture decode support")
    retained = {}
    for kind, descriptor in descriptors.items():
        binary = f"{path}/payloads/{kind}?{urlencode({'content_digest': digest})}"
        body, etag = verify_binary(origin, binary, scope_headers, kind, descriptor)
        if "current_snapshot" in descriptors and kind in ("bundle", "current_snapshot"):
            retained[kind] = body
        checked.append({"kind": kind, "sha256": descriptor["sha256"], "byte_count": len(body), "unit": descriptor["unit"], "etag": etag})
    if retained:
        from antenna_current_display_fixture_check import decode_current_snapshot
        try:
            decode_current_snapshot(retained["current_snapshot"], bundle_bytes=retained["bundle"],
                                    receipt=manifest["current_display"])
        except (ValueError, UnicodeError) as error:
            raise SmokeError("invalid bounded current snapshot/bundle association") from error
    field_path = f"{path}/payloads/magnetic_field"
    json_body(request(origin, field_path, {**scope_headers, "If-None-Match": "*"}, MAX_METADATA_BYTES), 400)
    changed_digest = "sha256:" + ("0" if digest[7] != "0" else "1") + digest[8:]
    mismatch = f"{field_path}?{urlencode({'content_digest': changed_digest})}"
    require(json_body(request(origin, mismatch, {**scope_headers, "If-None-Match": "*"}, MAX_METADATA_BYTES), 409).get("code") == "inspection_digest_mismatch", "missing digest mismatch gate")
    json_body(request(origin, f"{path}/payloads/RT0?{urlencode({'content_digest': digest})}", {**scope_headers, "If-None-Match": "*"}, MAX_METADATA_BYTES), 400)
    stale_headers = {
        "x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"] + "-stale-smoke"),
        "If-None-Match": "*", "Range": "bytes=0-7",
    }
    antenna_path = "/v2/sessions/current/data/antenna"
    scope_paths = [
        f"{antenna_path}/stages/{quote(stage_id, safe='')}/output-catalog",
        f"{antenna_path}/field-solutions/scope-probe",
        f"{antenna_path}/field-solutions/scope-probe/payloads/magnetic_field_per_ampere?port_mode_id=scope-probe",
        f"{antenna_path}/source-spectra/scope-probe",
        f"{antenna_path}/source-spectra/scope-probe/payloads/power",
        path, f"{field_path}?{urlencode({'content_digest': digest})}",
    ]
    if "current_snapshot" in descriptors:
        scope_paths.append(f"{path}/payloads/current_snapshot?{urlencode({'content_digest': digest})}")
    for scope_path in scope_paths:
        rejected = json_body(request(origin, scope_path, stale_headers, MAX_METADATA_BYTES), 409)
        require(rejected.get("error") == "request_context_stale", "missing stale request incarnation gate")
    final = request(origin, path, {**scope_headers, "If-None-Match": metadata_etag}, MAX_METADATA_BYTES)
    require(final.status == 304 and not final.body and strong_etag(final) == metadata_etag, "inspection revision changed during smoke")
    return {
        "schema": "fullmag.antenna_external_lead_http_smoke.v1", "status": "pass",
        "scope": "http_inspection_integrity_only", "qualification": "NOT VERIFIED", "physics_qualified": False,
        **{key: resource[key] for key in ("session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id", "stage_revision", "record_content_digest")},
        "stale_scope_routes_checked": len(scope_paths),
        "current_snapshot_decoded": bool(retained), "native_canonical_bundle_redecoded": False,
        "inspection_ref": resource["outputs"][0]["inspection_ref"], "metadata_etag": metadata_etag, "payloads": checked,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True, help="Loopback HTTP origin, e.g. http://127.0.0.1:8080")
    parser.add_argument("--stage-id", required=True, help="Exact runtime stage ID, not authored ID")
    args = parser.parse_args(argv)
    try:
        result = verify(args.origin, args.stage_id)
    except SmokeError as error:
        result = {"schema": "fullmag.antenna_external_lead_http_smoke.v1", "status": "fail", "scope": "http_inspection_integrity_only", "qualification": "NOT VERIFIED", "physics_qualified": False, "reason": str(error)}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
