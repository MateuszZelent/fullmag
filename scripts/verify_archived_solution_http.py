"""Read-only HTTP checks against pinned archived solution payloads; no physics claim."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, ProxyHandler, Request

MAX_METADATA = 1024 * 1024
MAX_BINARY = 64 * 1024 * 1024


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def verify_slice(raw, expected, run):
    require(raw[:8] == b"FMDS\x01\x00\x00\x00" and len(raw) >= 12, "unsupported FMDS header")
    length = struct.unpack_from("<I", raw, 8)[0]
    require(0 < length <= MAX_METADATA and 12 + length <= len(raw), "invalid FMDS metadata length")
    meta = json.loads(raw[12:12 + length])
    payload = raw[12 + length:]
    for key, value in [("project_id", run["project_id"]), ("run_id", run["run_id"]),
                       ("solution_set_id", run["solution_set_id"]),
                       ("containing_solution_revision", run["revision"]),
                       ("member_id", expected["member_id"]), ("artifact_id", expected["artifact_id"]),
                       ("manifest_object_ref", expected["manifest_object_ref"])]:
        require(meta[key] == value, "FMDS owner mismatch: " + key)
    source = dict(expected["source"], solution_revision=str(expected["source"]["solution_revision"]))
    require(meta["source"] == source, "FMDS source differs from the archived tensor")
    descriptor, part_manifest = meta["descriptor"], meta["slice"]
    require(descriptor["unit"] == expected["unit"], "FMDS unit mismatch")
    for key, value in [("dataset_id", expected["dataset_id"]), ("dataset_revision", expected["dataset_revision"]),
                       ("sample_id", expected["sample_id"]), ("item_id", expected["item_id"]),
                       ("field_id", expected["field_id"]), ("element_offset", "0"),
                       ("element_count", str(expected["elements"])), ("total_elements", str(expected["elements"])),
                       ("component_count", str(expected["components"])), ("precision", "f64"),
                       ("byte_order", "little_endian"), ("payload_bytes", str(expected["payload_bytes"]))]:
        require(part_manifest[key] == value, "FMDS layout mismatch: " + key)
    require(len(payload) == expected["payload_bytes"] == expected["elements"] * expected["components"] * 8,
            "FMDS payload length mismatch")
    offset = 0
    require(len(part_manifest["parts"]) == len(expected["parts"]), "FMDS chunk count mismatch")
    for part, archived in zip(part_manifest["parts"], expected["parts"]):
        size = archived["bytes"]
        require(part["object_ref"] == archived["object_ref"] and part["plane"] == "values"
                and part["object_offset_bytes"] == "0" and part["plane_offset_bytes"] == str(offset)
                and part["byte_length"] == str(size), "FMDS chunk identity mismatch")
        require(part["range_sha256"] == "sha256:" + hashlib.sha256(payload[offset:offset + size]).hexdigest(),
                "FMDS range hash mismatch")
        offset += size
    require(offset == len(payload), "FMDS chunk coverage incomplete")
    digest = hashlib.sha256(payload).hexdigest()
    require(digest == expected["payload_sha256"], "HTTP values differ from the archived bytes")
    require(all(math.isfinite(value[0]) for value in struct.iter_unpack("<d", payload)), "nonfinite values")
    return {"payload_sha256": digest, "bytes": len(payload), "elements": expected["elements"],
            "components": expected["components"], "unit": expected["unit"]}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self, origin, timeout=60):
        parsed = urlsplit(origin)
        require(parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
                and not parsed.username and not parsed.password and parsed.path in ("", "/")
                and not parsed.query and not parsed.fragment, "explicit loopback API origin required")
        self.origin, self.timeout, self.requests = origin.rstrip("/"), timeout, 0
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def get(self, path, query=None, *, maximum=MAX_METADATA, expected_status=(200,)):
        require(path.startswith("/v2/") and not any(c in path for c in "?#\r\n"), "invalid resource path")
        self.requests += 1
        url = self.origin + path + (("?" + urlencode(query)) if query else "")
        try:
            response = self.opener.open(Request(url, method="GET"), timeout=self.timeout)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read(maximum + 1)
            require(len(raw) <= maximum, "HTTP response exceeds bound")
            require(response.code in expected_status,
                    f"HTTP {response.code} at {path}: {raw[:1200]!r}")
            return raw

    def json(self, path, query=None):
        return json.loads(self.get(path, query))


def current_identity(client):
    status = json.loads(client.get("/v2/sessions/current/status", expected_status=(200, 404)))
    require(isinstance(status, dict), "invalid current workspace status")
    if status.get("code") == "not_found":
        require(status.get("error") == "no active local live workspace"
                and status.get("message") == "no active local live workspace",
                "unexpected missing workspace response")
        return None
    require("code" not in status and isinstance(status.get("session"), dict) and "run" in status
            and (status["run"] is None or isinstance(status["run"], dict)), "invalid current workspace status")
    return {key: status[key] for key in ("session", "run")}


def verify_http(client, expectations):
    require(expectations["schema"] == "fullmag.archived_solution_http_expectations.v1"
            and len(expectations["runs"]) == 4, "four pinned archived runs required")
    status_before = current_identity(client)
    discovery = []
    for project in sorted({run["project_id"] for run in expectations["runs"]}):
        route = "/v2/persistence/projects/" + quote(project, safe="") + "/runs"
        summaries, cursor = [], None
        for _ in range(64):
            page = client.json(route, dict(limit="1", **({"cursor": cursor} if cursor else {})))
            summaries.extend(page["runs"])
            following = page.get("next_cursor")
            if following is None:
                break
            require(following != cursor, "run cursor did not advance")
            client.get(route, {"limit": "1", "cursor": "run-invalid-old-cursor"}, expected_status=(400,))
            cursor = following
        else:
            raise ValueError("run discovery exceeded page bound")
        ids = [row["run_id"] for row in summaries]
        require(len(ids) == len(set(ids)), "duplicate run across archive/current discovery")
        require({run["run_id"] for run in expectations["runs"] if run["project_id"] == project} <= set(ids),
                "archived runs missing from discovery")
        discovery.append({"project_id": project, "runs": ids})
    results = []
    for run in expectations["runs"]:
        project, run_id = quote(run["project_id"], safe=""), quote(run["run_id"], safe="")
        root = f"/v2/persistence/projects/{project}/runs/{run_id}"
        resource = client.json(root)
        require(resource["project_id"] == run["project_id"] and resource["run_id"] == run["run_id"]
                and resource["payload_fingerprint"] == run["payload_fingerprint"], "run owner mismatch")
        require([task["lifecycle"] for task in resource["tasks"]] == run["task_statuses"], "task history changed")
        found, cursor = [], None
        for _ in range(64):
            page = client.json(root + "/solution-sets", {"cursor": cursor} if cursor else None)
            found.extend(page["items"])
            following = page.get("next_cursor")
            if following is None:
                break
            require(following != cursor, "discovery cursor did not advance")
            cursor = following
        else:
            raise ValueError("discovery exceeded page bound")
        require(sum(item["solution_set_id"] == run["solution_set_id"] and item["revision"] == run["revision"]
                    for item in found) == 1, "pinned solution missing or ambiguous in discovery")
        revision_root = root + "/solution-sets/" + quote(run["solution_set_id"], safe="") + "/revisions/" + run["revision"]
        solution = client.json(revision_root)
        require(solution["execution_status"] == run["execution_status"], "solution execution history changed")
        fields = []
        for expected in run["datasets"]:
            artifact = revision_root + "/members/" + quote(expected["member_id"], safe="") + "/artifacts/" + quote(expected["artifact_id"], safe="")
            dataset = client.json(artifact + "/materialized-dataset")
            require(dataset["manifest_object_ref"] == expected["manifest_object_ref"]
                    and dataset["owner_solution_revision"] == str(expected["source"]["solution_revision"]),
                    "dataset manifest/owner revision mismatch")
            query = {key: expected[key] for key in ("dataset_id", "dataset_revision", "sample_id", "item_id", "field_id")}
            query.update(schema_version="1.0.0", expected_manifest_object_ref=expected["manifest_object_ref"],
                         element_offset="0", element_count=str(expected["elements"]), max_response_bytes=str(MAX_BINARY))
            raw = client.get(artifact + "/materialized-dataset/slice", query, maximum=MAX_BINARY + MAX_METADATA + 12)
            proof = verify_slice(raw, expected, run)
            wrong = dict(query, expected_manifest_object_ref="0" * 64)
            client.get(artifact + "/materialized-dataset/slice", wrong, expected_status=(409,))
            if expected["field_id"] == "field:H_ant":
                geometry = client.json(artifact + "/saved-field-geometry", {"include_antenna_source_context": "true"})
                require(geometry["source"]["tensor_object_ref"] == expected["source"]["tensor_object_ref"]
                        and int(geometry["node_count"]) == expected["elements"] and geometry["coordinate_unit"] == "m",
                        "H geometry differs from the archived tensor")
                if run["label"] == "H275":
                    require(geometry.get("antenna_source_context") is not None, "H-only antenna source geometry absent")
                proof["geometry_nodes"] = int(geometry["node_count"])
            fields.append({"field_id": expected["field_id"], **proof})
        results.append({"run_id": run["run_id"], "label": run["label"], "execution_status": run["execution_status"], "fields": fields})
    status_after = current_identity(client)
    require(status_before == status_after, "current authoring identity changed during GET checks")
    return {"schema": "fullmag.archived_solution_http_readback.v1", "status": "pass", "request_count": client.requests,
            "runs": results, "run_discovery": discovery, "new_solve": False, "mutating_http_requests": 0,
            "qualification": "NOT VERIFIED", "qualified_basis": False,
            "opis": "Dokładny odczyt zachowanych tensorów przez publiczne HTTP; bez kwalifikacji dokładności fizycznej."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--expected", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    require(not args.output.exists(), "refuse overwriting verification result")
    raw = args.expected.read_bytes()
    require(len(raw) <= MAX_METADATA and hashlib.sha256(raw).hexdigest() == args.expected_sha256,
            "expected input digest differs")
    report = {"status": "failed", "new_solve": False, "mutating_http_requests": 0}
    try:
        report = verify_http(Client(args.base_url), json.loads(raw))
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as file:
        json.dump(report, file, ensure_ascii=False, allow_nan=False, indent=2)
    print(json.dumps({key: report[key] for key in ("status", "request_count", "error") if key in report}))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
