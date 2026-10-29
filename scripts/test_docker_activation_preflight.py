"""Pure historical-rejection preparation; no Docker, API, or publication."""
from copy import deepcopy
import hashlib
import json
import unittest

import docker_activation_preflight as preflight
import docker_startup_script as startup
from docker_build_control import BuildControlError


def raw(value):
    return json.dumps(value, sort_keys=True).encode()


def error_text(code="docker_startup_output_mapping_required", status=422):
    body = {"code": code, "capability_reason": code, "diagnostics": None,
            "revision_context": None, "error": "output mapping required", "message": "output mapping required"}
    return (preflight.PREFIX + "Traceback (most recent call last):\n  fixed wrapper\n"
            + preflight.HTTP_LINE + str(status) + ": " + json.dumps(body) + "\n")


def fixture():
    auth = {"schema": startup.AUTHORIZATION_SCHEMA, "authorization": startup.AUTHORIZATION_KIND,
            "request_id": "preflight-request", "source_sha256": "a" * 64,
            "source_relative": "example.py", "container_script_path": "/opt/fullmag/source/example.py",
            "container_source_root": "/opt/fullmag/source", "source_size_bytes": 12}
    provenance = raw(auth)
    digest = hashlib.sha256(provenance).hexdigest()
    marker = startup._activation_receipt_started(auth, digest)
    containers = {name: {"id": char * 64, "image": "sha256:" + "d" * 64,
                         "started_at": "2026-10-22T01:02:03Z", "fingerprint": "e" * 64}
                  for name, char in (("backend", "b"), ("frontend", "c"), ("lease", "f"))}
    request = {"schema": preflight.SCHEMA, "attempt": "1" * 32, "development_attempt": "2" * 32,
               "config_sha256": "3" * 64, "source_root": "/home/source", "compose_project": "fullmag-test",
               "containers": containers, "controller_sha256": "4" * 64, "port": 3202}
    marker_key = hashlib.sha256(auth["request_id"].encode()).hexdigest()
    inputs = {key: request[key] for key in ("development_attempt", "config_sha256", "source_root")}
    inputs.update(backend_container=containers["backend"]["id"], image_id=containers["backend"]["image"],
                  provenance_sha256=digest, activation_receipt_key=marker_key,
                  activation_receipt_path="/opt/fullmag/control/backend/script-activation-" + marker_key + "/activation.json")
    inputs.update({key: auth[key] for key in ("request_id", "source_sha256", "source_relative")})
    receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": "activation",
               "state": "outcome-unknown-resources-retained", "attempt": request["attempt"],
               "compose_project": request["compose_project"], "inputs": inputs, "error": error_text()}
    kwargs = {"receipt_raw": raw(receipt), "marker_raw": raw(marker), "provenance_raw": provenance,
              "authorization_raw": raw(auth), "observed_containers": deepcopy(containers),
              "matching_accepted_request": False, "activation_exec_completed": True}
    for name, field in (("unknown_receipt", "receipt_raw"), ("started_marker", "marker_raw"),
                        ("authorization", "authorization_raw"), ("provenance", "provenance_raw")):
        request[name + "_sha256"] = hashlib.sha256(kwargs[field]).hexdigest()
    return request, kwargs


class PreflightTests(unittest.TestCase):
    def test_prepared_only_preserves_history_and_existing_terminal_contract(self):
        request, kwargs = fixture()
        before = deepcopy((request, kwargs))
        result = preflight.prepare_transaction(request, **kwargs)
        self.assertEqual(result["state"], "prepared")
        self.assertEqual(result["result"]["state"], "failed-confirmed")
        self.assertEqual(result["result"]["error"], json.loads(kwargs["receipt_raw"])["error"])
        startup._validate_activation_receipt(result["marker"])
        self.assertEqual((request, kwargs), before)
        self.assertEqual(len(result["originals"]), 4)

    def test_only_exact_output_codes_and_status(self):
        for code in preflight.CODES:
            self.assertEqual(preflight.parse_rejection(error_text(code))["code"], code)
        for status in (400, 409, 500):
            with self.subTest(status=status), self.assertRaises(BuildControlError):
                preflight.parse_rejection(error_text(status=status))
        with self.assertRaises(BuildControlError):
            preflight.parse_rejection(error_text("validation_error"))

    def test_truncated_duplicate_and_extra_output_refused(self):
        text = error_text()
        for bad in (text[:-2], text + "tail", text + text, text.replace('"code":', '"code": "x", "code":'),
                    text.replace("required", "truncated"), "prefix missing" + text):
            with self.subTest(bad=bad), self.assertRaises(BuildControlError):
                preflight.parse_rejection(bad)

    def test_changed_pins_or_live_matching_execution_refused(self):
        for field in ("unknown_receipt_sha256", "started_marker_sha256", "provenance_sha256",
                      "authorization_sha256", "attempt", "config_sha256", "development_attempt", "source_root"):
            request, kwargs = fixture()
            request[field] = "0" * 64
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                preflight.prepare_transaction(request, **kwargs)
        for field, value in (("matching_accepted_request", True), ("activation_exec_completed", False)):
            request, kwargs = fixture()
            kwargs[field] = value
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                preflight.prepare_transaction(request, **kwargs)
        request, kwargs = fixture()
        kwargs["observed_containers"]["backend"]["started_at"] = "later"
        with self.assertRaises(BuildControlError):
            preflight.prepare_transaction(request, **kwargs)

    def test_malformed_pins_and_foreign_provenance_refused(self):
        for field in ("attempt", "development_attempt", "config_sha256", "controller_sha256"):
            for value in (None, 42, [], {}):
                request, kwargs = fixture()
                request[field] = value
                with self.subTest(field=field, value=value), self.assertRaises(BuildControlError):
                    preflight.prepare_transaction(request, **kwargs)
        for field in ("id", "image", "fingerprint"):
            request, kwargs = fixture()
            request["containers"]["backend"][field] = None
            with self.subTest(field=field), self.assertRaises(BuildControlError):
                preflight.prepare_transaction(request, **kwargs)
        request, kwargs = fixture()
        request["containers"]["lease"]["id"] = request["containers"]["backend"]["id"]
        kwargs["observed_containers"] = deepcopy(request["containers"])
        with self.assertRaises(BuildControlError):
            preflight.prepare_transaction(request, **kwargs)
        request, kwargs = fixture()
        provenance = json.loads(kwargs["provenance_raw"])
        provenance["request_id"] = "another-request"
        kwargs["provenance_raw"] = raw(provenance)
        request["provenance_sha256"] = hashlib.sha256(kwargs["provenance_raw"]).hexdigest()
        with self.assertRaises(BuildControlError):
            preflight.prepare_transaction(request, **kwargs)

    def test_foreign_marker_key_refused_even_with_consistent_path(self):
        request, kwargs = fixture()
        receipt = json.loads(kwargs["receipt_raw"])
        receipt["inputs"]["activation_receipt_key"] = "5" * 64
        receipt["inputs"]["activation_receipt_path"] = (
            "/opt/fullmag/control/backend/script-activation-" + "5" * 64 + "/activation.json")
        kwargs["receipt_raw"] = raw(receipt)
        request["unknown_receipt_sha256"] = hashlib.sha256(kwargs["receipt_raw"]).hexdigest()
        with self.assertRaises(BuildControlError):
            preflight.prepare_transaction(request, **kwargs)

    def test_terminal_marker_is_not_re_adjudicated(self):
        request, kwargs = fixture()
        first = preflight.prepare_transaction(request, **kwargs)
        kwargs["marker_raw"] = raw(first["marker"])
        request["started_marker_sha256"] = hashlib.sha256(kwargs["marker_raw"]).hexdigest()
        with self.assertRaises(BuildControlError):
            preflight.prepare_transaction(request, **kwargs)


if __name__ == "__main__":
    unittest.main()
