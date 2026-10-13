"""Check auxiliary ownership on an owned production API, without computation."""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import uuid

import fullmag_storage as storage


def scene_fixture(document):
    scene = copy.deepcopy(document)
    scene["version"] = "scene.v2"
    scene["materials"] = [{"id": "material-id", "name": "Film material",
        "properties": {"Ms": 800000., "Aex": 13e-12, "alpha": .01}}]
    scene["magnetization_assets"] = [{"id": "initial-id", "name": "Uniform",
        "kind": "uniform", "value": [1., 0., 0.]}]
    scene["objects"] = []
    for index, (identity, name, role) in enumerate((
        ("magnetic-id", "Magnetic film", "magnet"),
        ("antenna-id", "Readable antenna", "antenna"),
        ("second-id", "Second antenna", "antenna"),
        ("conductor-id", "Readable conductor", "conductor"),
        ("electrode-id", "Readable electrode", "electrode"),
        ("geometry-id", "Passive geometry", "geometry"),
    )):
        item = {"id": identity, "name": name, "role": role,
            "geometry": {"geometry_kind": "box", "geometry_params": {
                "size": [100e-9, 20e-9, 10e-9]}},
            "transform": {"translation": [index * 200e-9, 0., 0.]},
            "material_ref": "material-id" if role == "magnet" else ""}
        if role == "magnet":
            item["magnetization_ref"] = "initial-id"
        scene["objects"].append(item)
    scene["study"].update(requested_backend="fdm", requested_device="cpu",
        requested_precision="double", requested_mode="strict",
        exchange_enabled=True, demag_enabled=False)
    scene["study"].pop("external_field", None)
    scene["editor"] = {}
    return scene


def expected_objects(scene):
    objects = [{"schema_version": "physics_object.v1", "object_id": item["id"],
        "name": item["name"].strip() or item["id"],
        "type": item["role"],
        "geometry_id": item["name"].strip() or item["id"]}
        for item in scene["objects"] if item["role"] != "magnet"]
    return sorted(objects, key=lambda item: (item["geometry_id"], item["object_id"]))


def canonical_objects(objects):
    # These optional fields are omitted by serde and emitted empty by Python.
    result = copy.deepcopy(objects)
    for item in result:
        if item.get("material_assignment_ids") == []:
            item.pop("material_assignment_ids")
        if item.get("label", "not-none") is None:
            item.pop("label")
    return result


def cases(base):
    yield "public-auxiliary-types-two-antennas", copy.deepcopy(base), True
    renamed = copy.deepcopy(base)
    renamed["objects"][1]["name"] = "Renamed antenna"
    yield "rename-preserves-immutable-id", renamed, True
    reordered = copy.deepcopy(base)
    reordered["objects"].reverse()
    yield "reorder-preserves-sorted-inventory", reordered, True
    blank = copy.deepcopy(base)
    blank["objects"][1]["name"] = "  "
    yield "whitespace-name-uses-immutable-id", blank, True
    padded = copy.deepcopy(base)
    padded["objects"][1]["name"] = "  Readable antenna  "
    yield "padded-display-name-is-trimmed", padded, True
    magnetic = copy.deepcopy(base)
    magnetic["objects"] = magnetic["objects"][:1]
    yield "magnetic-only-omits-empty-auxiliary-inventory", magnetic, True
    for label, index, field, value in (
        ("invalid-role-refused", 1, "role", "imaginary"),
        ("duplicate-immutable-id-refused", 2, "id", "antenna-id"),
        ("duplicate-geometry-name-refused", 2, "name", "Readable antenna"),
        ("auxiliary-id-magnetic-alias-refused", 1, "id", "Magnetic film"),
        ("empty-immutable-id-refused", 1, "id", "  "),
        ("trimmed-geometry-name-collision-refused", 2, "name", "  Readable antenna  "),
        ("padded-immutable-id-refused", 1, "id", " antenna-id "),
        ("padded-presentation-role-refused", 1, "role", " antenna "),
        ("uppercase-presentation-role-refused", 1, "role", "Antenna"),
    ):
        changed = copy.deepcopy(base)
        changed["objects"][index][field] = value
        yield label, changed, False


def semantic_refusal(label, body):
    if not isinstance(body, dict):
        return False
    text = " ".join(str(body.get(field, "")) for field in ("error", "message")).lower()
    if "geometry-name" in label:
        return "geometry" in text and any(word in text for word in ("ambiguous", "duplicate", "collision"))
    if "magnetic-alias" in label:
        return "magnetic" in text and any(word in text for word in ("alias", "conflict"))
    if "role" in label:
        return ("role" in text or "presentation type" in text) and any(word in text for word in ("unsupported", "canonical"))
    if "immutable-id" in label:
        if "object" not in text or "id" not in text:
            return False
        reason = "duplicate" if label.startswith("duplicate") else "empty" if label.startswith("empty") else "whitespace"
        return reason in text
    return False


def request(origin, path, *, method="GET", payload=None, timeout=15):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(origin + path, data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read()
        return response.status, json.loads(raw) if raw else None


def exercise(origin, run_root, receipt):
    code, created = request(origin, "/v2/sessions", method="POST", payload={
        "name": "Owned antenna inventory regression", "backend": "fdm",
        "device": "cpu", "precision": "double"})
    if code != 201 or not created.get("session_id"):
        raise AssertionError((code, created))
    receipt["session_id"] = created["session_id"]
    code, initial = request(origin, "/v2/sessions/current/model/scene")
    if code != 200:
        raise AssertionError((code, initial))
    base = scene_fixture(initial)
    from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir

    scenarios = list(cases(base))
    receipt["expected_check_count"] = len(scenarios)
    for label, scene, positive in scenarios:
        observed = {"name": label, "passed": False, "expected_acceptance": positive}
        receipt["checks"].append(observed)
        try:
            # PUT operates on the current revision, never the user's session.
            code, current = request(origin, "/v2/sessions/current/model/scene")
            if code != 200:
                raise AssertionError((code, current))
            scene["revision"] = current["revision"]
            put_code, authored = request(origin, "/v2/sessions/current/model/scene",
                method="PUT", payload=scene)
            observed.update(put_status=put_code, put_response=authored)
            if positive:
                if put_code != 200:
                    raise AssertionError(f"Scena poprawna odrzucona: HTTP {put_code}: {authored}")
                graph_code, graph = request(origin, "/v2/sessions/current/model/physics-graph")
                observed.update(graph_status=graph_code, graph_response=graph)
                if graph_code != 200:
                    raise AssertionError(f"Zasób grafu odrzucony: HTTP {graph_code}: {graph}")
                expected = expected_objects(authored)
                try:
                    ir = scene_document_to_problem_ir(authored, requested_backend="fdm",
                        requested_device="cpu", requested_precision="double",
                        requested_mode="strict", source_root=run_root)
                except Exception as error:
                    observed["python_capture_error"] = f"{type(error).__name__}: {error}"
                    raise AssertionError("Publiczny capture Python nie obsługuje sceny: " + observed["python_capture_error"]) from error
                observed["python_objects"] = ir.get("physics_graph", {}).get("objects", [])
                if canonical_objects(observed["python_objects"]) != expected:
                    raise AssertionError("Inventory API różni się od publicznego capture Python")
                if ir.get("geometry_assets") is not None:
                    raise AssertionError("Regresja nie może materializować siatek")
                magnetic_ids = {item.get("object_id") for item in ir.get("magnets", [])}
                if "magnetic-id" not in magnetic_ids:
                    raise AssertionError("Capture Python utracił magnetyk")
                if graph.get("objects", []) != expected:
                    raise AssertionError(f"Błędna tożsamość obiektów: {graph.get('objects')} != {expected}")
                if not expected and "objects" in graph:
                    raise AssertionError("Pusty inventory musi być pominięty, nie opublikowany jako []")
                if graph.get("modules") != [] or graph.get("edges") != []:
                    raise AssertionError("Typ prezentacyjny nie może aktywować modułów fizyki")
                if graph["scene_revision"] != authored["revision"] or graph["schema_version"] != "physics_graph.v1":
                    raise AssertionError("Niepoprawna wersja lub rewizja grafu")
                observed["passed"] = True
            else:
                try:
                    scene_document_to_problem_ir(scene, requested_backend="fdm",
                        requested_device="cpu", requested_precision="double",
                        requested_mode="strict", source_root=run_root)
                except ValueError as error:
                    observed["python_capture_error"] = str(error)
                    if not semantic_refusal(label, {"message": str(error)}):
                        raise AssertionError("Odmowa capture Python nie potwierdza błędu tego przypadku") from error
                else:
                    raise AssertionError("Publiczny capture Python dopuścił błędne powiązanie")
                if put_code in (400, 409, 422):
                    # A revision conflict is not evidence of semantic refusal.
                    if put_code == 409:
                        raise AssertionError("Konflikt rewizji nie dowodzi odmowy semantycznej")
                    if not semantic_refusal(label, authored):
                        raise AssertionError(f"Odmowa PUT nie potwierdza błędu semantycznego tego przypadku: {authored}")
                    observed["passed"] = True
                elif put_code == 200:
                    graph_code, graph = request(origin, "/v2/sessions/current/model/physics-graph")
                    observed.update(graph_status=graph_code, graph_response=graph)
                    if graph_code not in (400, 409, 422) or "physics_graph_normalization_failed" not in json.dumps(graph):
                        raise AssertionError(f"Błędna scena dopuszczona do grafu: HTTP {graph_code}: {graph}")
                    if not semantic_refusal(label, graph):
                        raise AssertionError(f"Odmowa grafu nie potwierdza błędu semantycznego tego przypadku: {graph}")
                    observed["passed"] = True
                else:
                    raise AssertionError(f"Niewłaściwa odmowa: HTTP {put_code}: {authored}")
        except Exception as error:
            observed["error"] = f"{type(error).__name__}: {error}"


def main():
    parser = argparse.ArgumentParser(description="Izolowana regresja inventory anten w API i publicznym Pythonie")
    parser.add_argument("--executable", required=True, type=Path)
    parser.add_argument("--expected-sha256", help="Opcjonalny oczekiwany digest produkcyjnego API")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parent.parent
    executable = args.executable
    if not executable.is_absolute() or not executable.is_file():
        parser.error("--executable musi być istniejącą ścieżką absolutną")
    executable = executable.resolve()
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    if args.expected_sha256 is not None and digest != args.expected_sha256:
        parser.error("Digest API różni się od --expected-sha256")
    layout = storage.resolve_layout(repo, "windows-native-fdm-cpu-dev")
    run_root = storage.validate_path(Path(layout["runs_root"]) / "antenna-graph-inventory" / uuid.uuid4().hex,
        layout["runs_root"], "inventory regression evidence")
    run_root.mkdir(parents=True, exist_ok=False)
    temporary = run_root / "temporary"
    temporary.mkdir()
    receipt = {"schema": "fullmag.antenna_graph_inventory.v1", "state": "running",
        "repo_root": str(repo), "worktree_id": layout["worktree_id"],
        "executable": str(executable), "executable_sha256": digest,
        "verifier_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "python_executable": sys.executable,
        "python_executable_sha256": hashlib.sha256(Path(sys.executable).read_bytes()).hexdigest(),
        "capture_source_root": str(repo / "packages/fullmag-py/src"),
        "qualification": "Izolowany produkcyjny HTTP + publiczny Python capture; bez siatek, solvera, LLG ani UI",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": []}
    receipt_path = run_root / "receipt.json"
    storage.atomic_json(receipt_path, receipt)
    child = None
    log_path = run_root / "api.log"
    old_tempdir = tempfile.tempdir
    try:
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        if port in (3197, 8081):
            raise RuntimeError("Wybrano zastrzeżony port użytkownika")
        env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMPUTERNAME") if key in os.environ}
        env.update(FULLMAG_REPO_ROOT=str(repo), FULLMAG_STATE_ROOT=str(run_root / "state"),
            FULLMAG_API_PORT=str(port), FULLMAG_DISABLE_STATIC_CONTROL_ROOM="1",
            FULLMAG_PYTHON=str(Path(layout["build_root"]) / "python/fullmag/Scripts/python.exe"),
            FULLMAG_PROJECT_STORAGE_ROOT=layout["storage_root"], FULLMAG_RUNS_ROOT=str(run_root / "runs"),
            PYTHONDONTWRITEBYTECODE="1", TEMP=str(temporary), TMP=str(temporary), TMPDIR=str(temporary))
        tempfile.tempdir = str(temporary)
        sys.path.insert(0, str(repo / "packages/fullmag-py/src"))
        sys.dont_write_bytecode = True
        with log_path.open("x", encoding="utf-8") as log:
            child = subprocess.Popen([str(executable)], cwd=repo, env=env,
                stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            receipt["process"] = {"pid": child.pid, "port": port, "waited": False}
            storage.atomic_json(receipt_path, receipt)
            origin = f"http://127.0.0.1:{port}"
            deadline = time.monotonic() + 30
            while True:
                if child.poll() is not None:
                    raise RuntimeError(f"Własny proces API zakończył start: {child.returncode}; {log_path}")
                try:
                    code, _ = request(origin, "/v2/platform/development-backend", timeout=2)
                    if code != 200:
                        raise RuntimeError(f"Startup API: HTTP {code}")
                    break
                except urllib.error.URLError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f"Timeout własnego API; {log_path}")
                    time.sleep(.1)
            exercise(origin, run_root, receipt)
    except Exception:
        receipt["error"] = traceback.format_exc()
    finally:
        tempfile.tempdir = old_tempdir
        if child is not None:
            if child.poll() is None:
                receipt["process"]["stop_requested_by_verifier"] = True
                child.terminate()
            receipt["process"]["exit_code"] = child.wait(timeout=15)
            receipt["process"]["waited"] = True
        receipt["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        receipt["executable_sha256_after"] = hashlib.sha256(executable.read_bytes()).hexdigest()
        receipt["verifier_sha256_after"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        receipt["log_sha256"] = hashlib.sha256(log_path.read_bytes()).hexdigest() if log_path.exists() else None
        passed = (not receipt.get("error") and bool(receipt.get("expected_check_count"))
            and len(receipt["checks"]) == receipt["expected_check_count"]
            and all(item["passed"] for item in receipt["checks"])
            and receipt["executable_sha256_after"] == digest
            and receipt["verifier_sha256_after"] == receipt["verifier_sha256"])
        receipt["state"] = "completed" if passed else "failed"
        receipt["receipt_path"] = str(receipt_path)
        storage.atomic_json(receipt_path, receipt)
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
