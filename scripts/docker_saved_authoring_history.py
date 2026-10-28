"""Pinned terminal history for saved-authoring restart; never mutates the store."""
import hashlib
import inspect
import json
import re


def validate_retained_catalogs(request):
    if "retained_run_catalogs" not in request:
        return None
    rows = request["retained_run_catalogs"]
    if not isinstance(rows, list) or not 0 < len(rows) <= 256:
        raise ValueError("retained run catalogs must be a bounded non-empty list")
    if "cancelled_preclaim" in request or "historical_preclaim" in request:
        raise ValueError("retained terminal history cannot mix preclaim recovery")
    runs = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"run_id", "sha256", "bytes", "tasks"}:
            raise ValueError("retained catalog pins differ")
        run = row["run_id"]
        if not isinstance(run, str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}", run) or run.endswith(".") or run in runs:
            raise ValueError("retained run identity is invalid or duplicated")
        runs.add(run)
        if not isinstance(row["sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]):
            raise ValueError("retained catalog digest is invalid")
        if type(row["bytes"]) is not int or not 0 < row["bytes"] <= 8 * 1024 * 1024:
            raise ValueError("retained catalog size exceeds budget")
        if not isinstance(row["tasks"], list) or not 0 < len(row["tasks"]) <= 4096:
            raise ValueError("retained catalog must contain bounded terminal tasks")
        tasks = set()
        for task in row["tasks"]:
            if not isinstance(task, dict) or set(task) != {"task_id", "lifecycle"}:
                raise ValueError("retained task pins differ")
            if not isinstance(task["task_id"], str) or not re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}", task["task_id"]) or task["task_id"] in tasks:
                raise ValueError("retained task identity is invalid or duplicated")
            tasks.add(task["task_id"])
            if task["lifecycle"] not in {"succeeded", "failed", "cancelled"}:
                raise ValueError("retained task is not terminal")
    return rows


def observe_retained_catalogs(store, request, read_regular):
    """Caller holds the store writer fence; compare exact bytes and terminal pins."""
    pins = validate_retained_catalogs(request)
    if pins is None:
        return None
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError("duplicate catalog key")
            value[key] = item
        return value
    def invalid(value):
        raise ValueError("non-finite catalog number")
    observed = []
    for pin in pins:
        raw = read_regular(store / "runs" / pin["run_id"] / "run_catalog.json")
        if len(raw) != pin["bytes"] or hashlib.sha256(raw).hexdigest() != pin["sha256"]:
            raise ValueError("retained catalog bytes changed")
        catalog = json.loads(raw, object_pairs_hook=unique, parse_constant=invalid)
        if (not isinstance(catalog, dict) or catalog.get("schema_version") != "run_catalog.v1"
                or catalog.get("run_id") != pin["run_id"] or type(catalog.get("revision")) is not int
                or catalog["revision"] < 1 or not isinstance(catalog.get("tasks"), list)):
            raise ValueError("retained catalog identity/schema differs")
        tasks = [{"task_id": task.get("task_id"), "lifecycle": task.get("lifecycle")}
                 for task in catalog["tasks"] if isinstance(task, dict)]
        if len(tasks) != len(catalog["tasks"]) or tasks != pin["tasks"]:
            raise ValueError("retained catalog task pins differ")
        observed.append(dict(pin))
    return observed


PROBE_FUNCTION = "import hashlib,inspect,json,re\n" + inspect.getsource(validate_retained_catalogs) + "\n" + inspect.getsource(observe_retained_catalogs)
