"""Prepare a pinned historical HTTP rejection; never publish or replay a POST.

The caller authenticates the controller and container observations, checks the
original exec has ended, and CAS-publishes under the existing reconciliation
protocol. A prepared result is not evidence of global API quiescence.
"""
import base64
from copy import deepcopy
import hashlib
import json
import re

import docker_startup_script as startup
from docker_build_control import BuildControlError

SCHEMA = "fullmag.docker-activation-preflight-reconciliation.v1"
CODES = {"docker_startup_output_mapping_required", "docker_startup_output_mapping_invalid"}
PREFIX = "Backend activation failed after publishing activation.json; retry is forbidden: "
HTTP_LINE = "fullmag_image_docker_startup_script.StartupScriptError: startup activation returned HTTP "
MAX_BYTES = 2 * 1024 * 1024


def _fail(message):
    raise BuildControlError("Activation preflight reconciliation: " + message)


def _matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("duplicate JSON field")
        result[key] = value
    return result


def _document(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_BYTES:
        _fail("invalid bounded evidence bytes")
    try:
        value = json.loads(raw, object_pairs_hook=_pairs)
    except (ValueError, UnicodeError) as error:
        raise BuildControlError("Invalid preflight evidence JSON") from error
    if not isinstance(value, dict):
        _fail("evidence is not an object")
    return value


def parse_rejection(error):
    """Accept only the complete final exception emitted by the fixed wrapper."""
    if (not isinstance(error, str) or len(error.encode()) > 8192
            or not error.startswith(PREFIX + "Traceback (most recent call last):\n")
            or error.count(HTTP_LINE) != 1
            or "truncated" in error.lower()):
        _fail("controller error is incomplete or ambiguous")
    final = error.split(HTTP_LINE)[1]
    if not final.startswith("422: ") or not final.endswith("\n"):
        _fail("not a completed HTTP 422 rejection")
    body = final[len("422: "):-1]
    if "\n" in body or len(body.encode()) >= 4096:
        _fail("response may be truncated or contain trailing output")
    value = _document(body.encode())
    if (set(value) != {"capability_reason", "code", "diagnostics", "error", "message", "revision_context"}
            or not isinstance(value["code"], str) or value["code"] not in CODES or value["capability_reason"] != value["code"]
            or value["diagnostics"] is not None or value["revision_context"] is not None
            or not isinstance(value["message"], str) or not value["message"].strip()
            or len(value["message"]) > 2048 or value["error"] != value["message"]):
        _fail("not an exact canonical output preflight rejection")
    return {"http_status": 422, "code": value["code"], "message": value["message"]}


def prepare_transaction(request, *, receipt_raw, marker_raw, provenance_raw,
                        authorization_raw, observed_containers,
                        matching_accepted_request, activation_exec_completed):
    """Return immutable originals and proposed terminal documents, without I/O.

    Container fingerprints and controller_sha256 are caller-authenticated pins;
    byte equality here does not independently attest Docker or controller code.
    The caller must recheck every pin immediately before CAS publication.
    """
    fields = {"schema", "attempt", "development_attempt", "config_sha256", "source_root",
              "compose_project", "port", "unknown_receipt_sha256", "started_marker_sha256",
              "provenance_sha256", "authorization_sha256", "containers", "controller_sha256"}
    if not isinstance(request, dict) or set(request) != fields:
        _fail("request fields differ")
    if type(request["port"]) is not int or not 1 <= request["port"] <= 65535:
        _fail("port pin invalid")
    if request.get("schema") != SCHEMA:
        _fail("request schema differs")
    if matching_accepted_request is not False or activation_exec_completed is not True:
        _fail("matching accepted request or unfinished activation")
    for field, pattern in (("attempt", r"[0-9a-f]{32}"),
                           ("development_attempt", r"[0-9a-f]{32}"),
                           ("config_sha256", r"[0-9a-f]{64}")):
        if not _matches(pattern, request[field]):
            _fail("invalid request pin: " + field)
    originals = {}
    raw_records = {"unknown_receipt": receipt_raw, "started_marker": marker_raw,
                   "provenance": provenance_raw, "authorization": authorization_raw}
    for name, raw in raw_records.items():
        _document(raw)
        digest = hashlib.sha256(raw).hexdigest()
        if request.get(name + "_sha256") != digest:
            _fail(name + " digest differs")
        originals[name] = {"sha256": digest, "base64": base64.b64encode(raw).decode()}
    containers = request.get("containers")
    if not isinstance(containers, dict) or set(containers) != {"backend", "frontend", "lease"}:
        _fail("container pins missing")
    for pin in containers.values():
        if (not isinstance(pin, dict) or set(pin) != {"id", "image", "started_at", "fingerprint"}
                or not _matches(r"[0-9a-f]{64}", pin.get("id", ""))
                or not _matches(r"sha256:[0-9a-f]{64}", pin.get("image", ""))
                or not _matches(r"[0-9a-f]{64}", pin.get("fingerprint", ""))
                or not isinstance(pin.get("started_at"), str) or not pin["started_at"]):
            _fail("container pin malformed")
    if len({pin["id"] for pin in containers.values()}) != 3:
        _fail("container IDs are not distinct")
    if observed_containers != containers:
        _fail("container incarnation differs")
    if not _matches(r"[0-9a-f]{64}", request.get("controller_sha256", "")):
        _fail("controller pin missing")
    receipt = _document(receipt_raw)
    marker = startup._validate_activation_receipt(_document(marker_raw))
    authorization = _document(authorization_raw)
    if _document(provenance_raw) != authorization:
        _fail("provenance authorization differs")
    if marker["state"] != "started" or marker["authorization"] != authorization:
        _fail("marker is not the exact original started authorization")
    if (receipt.get("schema") != "fullmag.docker-build-operation.v1"
            or receipt.get("phase") != "activation"
            or receipt.get("state") != "outcome-unknown-resources-retained"):
        _fail("controller receipt is not an unknown activation")
    for key in ("attempt", "compose_project"):
        if not isinstance(request.get(key), str) or not request[key] or receipt.get(key) != request[key]:
            _fail("receipt pin differs: " + key)
    inputs = receipt.get("inputs")
    if not isinstance(inputs, dict):
        _fail("receipt inputs missing")
    expected = {key: request[key] for key in ("development_attempt", "config_sha256", "source_root")}
    expected.update(backend_container=containers["backend"]["id"], image_id=containers["backend"]["image"],
                    provenance_sha256=request["provenance_sha256"])
    expected.update({key: authorization.get(key) for key in ("request_id", "source_sha256", "source_relative")})
    for key, value in expected.items():
        if value is None or inputs.get(key) != value:
            _fail("activation pin differs: " + key)
    if marker["provenance_sha256"] != request["provenance_sha256"]:
        _fail("marker provenance differs")
    key = inputs.get("activation_receipt_key", "")
    if key != hashlib.sha256(authorization["request_id"].encode("utf-8")).hexdigest():
        _fail("marker request key differs")
    path = "/opt/fullmag/control/backend/script-activation-" + key + "/activation.json"
    if (not _matches(r"[0-9a-f]{64}", key) or inputs.get("activation_receipt_key") != key
            or inputs.get("activation_receipt_path") != path):
        _fail("marker path differs")
    rejection = parse_rejection(receipt.get("error"))
    activation_result = {"schema": startup.RESPONSE_SCHEMA, "state": "rejected", "rejection": rejection,
                         **{key: authorization[key] for key in ("request_id", "source_sha256", "source_relative")}}
    terminal_marker = {**marker, "state": "rejected", "result": activation_result}
    startup._validate_activation_receipt(terminal_marker)
    result = deepcopy(receipt)
    result.update(state="failed-confirmed", activation_state="rejected",
                  reconciliation_reason="retained-controller-http-preflight-rejection")
    return {"schema": SCHEMA, "state": "prepared",
            "evidence_source": "retained-controller-http-rejection",
            "request": deepcopy(request), "originals": originals,
            "marker": terminal_marker, "result": result, "activation_result": activation_result}
