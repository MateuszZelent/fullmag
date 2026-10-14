#!/usr/bin/env python3
"""Run closed interpreted pytest regressions for the exact-layer mesher.

This managed source diagnostic is not solver or scientific qualification.
It uses the storage resolver and lock, and records custody for its own child process.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import traceback
import uuid
import xml.etree.ElementTree as ET

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
import fullmag_storage as storage
import verify_exact_layer_mesh_diagnostics as diagnostics

PROFILE = "windows-exact-layer-mesh-diagnostics"
RECEIPT_SCHEMA = "fullmag.exact_layer_production_mesh.v1"
CHILD_SCHEMA = "fullmag.exact_layer_production_mesh.child.v1"
TIMEOUT_SECONDS = 900
PARENT_TIMEOUT_SECONDS = 920
TERMINATE_GRACE_SECONDS = 15
SUITES = {
    "box": (
        "scripts/test_box_layered_airbox_mesh.py",
        None,
        (
            "test_public_de_model_shared_domain_realizes_six_layers",
            "test_public_box_default_airbox_cap_realizes_geometric_vertical_growth",
            "test_public_box_explicit_airbox_cap_below_body_hmax_is_preserved",
            "test_public_box_explicit_airbox_minimum_above_body_hmax_is_preserved",
        ),
    ),
    "scoped-ring": (
        "packages/fullmag-py/tests/test_meshing.py",
        "scoped_exact_ring_lower_bound_uses_layer_route_and_report or exact_layer_implicit_airbox_cap_coarsens_far_air",
        (
            "test_scoped_exact_ring_lower_bound_uses_layer_route_and_report",
            "test_exact_layer_implicit_airbox_cap_coarsens_far_air",
        ),
    ),
    "owner-fields": (
        "packages/fullmag-py/tests/test_meshing.py",
        "exact_layer_body_target_precedence_survives_air_and_local_fields or scoped_layer_plane_report_waits_for_postmesh_proof",
        (
            "test_exact_layer_body_target_precedence_survives_air_and_local_fields",
            "test_scoped_layer_plane_report_waits_for_postmesh_proof",
        ),
    ),
}
FINGERPRINT_FIELDS = {"python_package", "test_meshing", "meshing_production_fixtures", "box_layered_airbox_test", "production_mesh_driver", "mesh_diagnostic_helper"}


def _stamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _fingerprints(repo: Path) -> dict[str, str]:
    base = diagnostics._source_fingerprints(repo)
    result = {
        "python_package": base["python_package"],
        "test_meshing": base["test_fixture"],
        "meshing_production_fixtures": base["meshing_production_fixtures"],
        "box_layered_airbox_test": diagnostics._sha256_file(repo / "scripts/test_box_layered_airbox_mesh.py"),
        "mesh_diagnostic_helper": base["diagnostic_driver"],
        "production_mesh_driver": diagnostics._sha256_file(Path(__file__).resolve()),
    }
    if set(result) != FINGERPRINT_FIELDS:
        raise storage.StorageError("Production mesh source fingerprint scope is incomplete")
    return result


def _digest(values: dict[str, str]) -> str:
    raw = json.dumps(values, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _suite_label(suite: str) -> str:
    names = SUITES[suite][2]
    return "whole Box test file; required public cases: " + "; ".join(names) if suite == "box" else "; ".join(names)


def _module(name: str) -> dict[str, str]:
    module = importlib.import_module(name)
    origin = diagnostics._module_origin(module)
    version = getattr(module, "__version__", None)
    if version is None and name == "gmsh":
        getter = getattr(module, "version", None)
        version = getter() if callable(getter) else None
    if not origin or not Path(origin).is_file() or storage.is_link(Path(origin)) or version is None or not str(version).strip():
        raise storage.StorageError(f"Module {name} lacks a valid origin or version")
    return {"origin": origin, "version": str(version)}


def _junit(path: Path) -> tuple[dict[str, int], list[str]]:
    if not path.is_file() or storage.is_link(path):
        raise storage.StorageError("Pytest did not produce a regular JUnit report")
    root = ET.parse(path).getroot()
    suites = [root] if root.tag == "testsuite" else root.findall(".//testsuite")
    counts = {key: sum(int(suite.attrib.get(key, "0")) for suite in suites)
              for key in ("tests", "skipped", "failures", "errors")}
    names = [case.attrib.get("name", "") for case in root.findall(".//testcase")]
    return counts, names


class _CollectionCount:
    def __init__(self) -> None:
        self.collected = 0
        self.nodeids: list[str] = []
        self.passed_call_nodeids: set[str] = set()
        self.failed_reports: list[dict[str, str]] = []
        self.skipped_reports: list[dict[str, str]] = []

    def pytest_collection_finish(self, session) -> None:
        self.collected = len(session.items)
        self.nodeids = [str(item.nodeid) for item in session.items]

    def pytest_runtest_logreport(self, report) -> None:
        nodeid, when, outcome = str(report.nodeid), str(report.when), str(report.outcome)
        record = {"nodeid": nodeid, "when": when}
        if outcome == "failed":
            self.failed_reports.append(record)
        elif outcome == "skipped":
            self.skipped_reports.append(record)
        if when == "call" and outcome == "passed":
            self.passed_call_nodeids.add(nodeid)


def _child(repo: Path, run_root: Path, suite: str) -> int:
    if suite not in SUITES:
        raise storage.StorageError("Unsupported production mesh suite")
    layout = storage.resolve_layout(repo, PROFILE)
    run_root = storage.validate_path(run_root, layout["runs_root"], "production mesh run root")
    expected_parent = Path(layout["runs_root"]) / PROFILE
    if run_root.parent != expected_parent.resolve() or not run_root.is_dir() or storage.is_link(run_root):
        raise storage.StorageError("Production mesh run root is not the selected managed directory")
    relative_test, keyword, _expected_tests = SUITES[suite]
    test_path = storage.validate_path(repo / relative_test, repo, "selected production mesh tests")
    summary_path, log_path = run_root / "child-summary.json", run_root / "pytest.log"
    junit_path, basetemp = run_root / "junit.xml", run_root / "pytest-temp"
    if any(path.exists() for path in (summary_path, log_path, junit_path, basetemp)):
        raise storage.StorageError("Production mesh artifacts already exist; refusing overwrite")
    summary: dict[str, object] = {
        "schema": CHILD_SCHEMA, "state": "running", "suite": suite,
        "selected": _suite_label(suite), "pid": os.getpid(),
        "python_executable": str(Path(sys.executable).resolve()),
        "module_details": {}, "collected": 0, "collected_nodeids": [], "pytest_exit_code": None,
        "counts": None, "timeout_seconds": TIMEOUT_SECONDS, "timed_out": False,
        "qualification": "not_assessed", "log": str(log_path), "junit": str(junit_path),
    }
    storage.atomic_json(summary_path, summary)

    def timeout_child() -> None:
        summary.update(state="failed", timed_out=True, error="pytest exceeded 900 seconds")
        try:
            storage.atomic_json(summary_path, summary)
        finally:
            # The managed wrapper waits for this command process to exit.
            os._exit(124)

    watchdog = threading.Timer(TIMEOUT_SECONDS, timeout_child)
    watchdog.daemon = True
    watchdog.start()
    try:
        sys.path[:0] = [str(repo / "packages/fullmag-py/src"), str(repo / "packages/fullmag-py/tests")]
        summary["module_details"] = {name: _module(name) for name in ("pytest", "gmsh", "numpy")}
        pytest_args = [
            "-p", "no:cacheprovider", "-o", "addopts=", "--basetemp", str(basetemp),
            "--junitxml", str(junit_path), str(test_path),
        ]
        if keyword:
            pytest_args.extend(("-k", keyword))
        collection = _CollectionCount()

        with log_path.open("x", encoding="utf-8") as log:
            try:
                with redirect_stdout(log), redirect_stderr(log):
                    import pytest
                    exit_code = int(pytest.main(pytest_args, plugins=[collection]))
            finally:
                watchdog.cancel()
        counts, executed_names = _junit(junit_path)
        expected_tests = SUITES[suite][2]
        nodeids_complete = all(
            any(nodeid.endswith(name) for nodeid in collection.nodeids)
            for name in expected_tests
        )
        executed_complete = all(
            any(name.split("[", 1)[0] == expected for name in executed_names)
            for expected in expected_tests
        )
        exact_selection = suite == "box" or collection.collected == len(expected_tests)
        call_reports_complete = (
            len(collection.nodeids) == len(set(collection.nodeids))
            and collection.passed_call_nodeids == set(collection.nodeids)
        )
        subtest_records = max(0, counts["tests"] - collection.collected)
        passed = (
            exit_code == 0 and collection.collected > 0 and counts["tests"] >= collection.collected
            and counts["skipped"] == counts["failures"] == counts["errors"] == 0
            and not collection.failed_reports and not collection.skipped_reports
            and nodeids_complete and executed_complete and exact_selection and call_reports_complete
        )
        summary.update(
            state="completed" if passed else "failed", collected=collection.collected,
            collected_nodeids=collection.nodeids, executed_names=executed_names,
            passed_call_nodeids=sorted(collection.passed_call_nodeids),
            failed_reports=collection.failed_reports, skipped_reports=collection.skipped_reports,
            junit_subtest_records=subtest_records, pytest_exit_code=exit_code, counts=counts,
        )
        if not passed:
            summary["error"] = "pytest failed, skipped, or collected no tests"
    except Exception as error:
        summary.update(state="failed", error=f"{type(error).__name__}: {error}")
        try:
            with log_path.open("a", encoding="utf-8") as log:
                traceback.print_exc(file=log)
        except OSError:
            pass
    finally:
        if watchdog is not None:
            watchdog.cancel()
        storage.atomic_json(summary_path, summary)
    print(json.dumps({"child_summary": str(summary_path), "state": summary["state"]}))
    return 0 if summary["state"] == "completed" else 1


def _child_passed(value: object, suite: str, interpreter: Path) -> bool:
    if not isinstance(value, dict) or value.get("schema") != CHILD_SCHEMA:
        return False
    if (
        value.get("state") != "completed" or value.get("suite") != suite
        or value.get("python_executable") != str(interpreter)
        or value.get("timed_out") is not False or value.get("pytest_exit_code") != 0
        or not isinstance(value.get("collected"), int) or isinstance(value.get("collected"), bool)
        or value["collected"] <= 0
    ):
        return False
    details, counts = value.get("module_details"), value.get("counts")
    expected_tests = SUITES[suite][2]
    nodeids, executed = value.get("collected_nodeids"), value.get("executed_names")
    passed_calls = value.get("passed_call_nodeids")
    failed_reports, skipped_reports = value.get("failed_reports"), value.get("skipped_reports")
    if (
        not isinstance(nodeids, list) or not all(isinstance(item, str) for item in nodeids)
        or not isinstance(executed, list) or not all(isinstance(item, str) for item in executed)
        or not isinstance(passed_calls, list) or not all(isinstance(item, str) for item in passed_calls)
        or not isinstance(failed_reports, list) or not isinstance(skipped_reports, list)
    ):
        return False
    if len(nodeids) != len(set(nodeids)) or set(passed_calls) != set(nodeids):
        return False
    if failed_reports or skipped_reports:
        return False
    if suite != "box" and value["collected"] != len(expected_tests):
        return False
    if not all(any(isinstance(item, str) and item.endswith(name) for item in nodeids) for name in expected_tests):
        return False
    if not all(
        any(isinstance(item, str) and item.split("[", 1)[0] == name for item in executed)
        for name in expected_tests
    ):
        return False
    if not isinstance(details, dict) or set(details) != {"pytest", "gmsh", "numpy"}:
        return False
    if any(not isinstance(item, dict) or not item.get("origin") or not item.get("version") for item in details.values()):
        return False
    if not isinstance(counts, dict) or not all(
        isinstance(counts.get(key), int) and not isinstance(counts.get(key), bool)
        for key in ("tests", "skipped", "failures", "errors")
    ):
        return False
    subtest_records = value.get("junit_subtest_records")
    return (
        counts["tests"] >= value["collected"] > 0
        and isinstance(subtest_records, int) and not isinstance(subtest_records, bool)
        and subtest_records == counts["tests"] - value["collected"]
        and counts["skipped"] == counts["failures"] == counts["errors"] == 0
    )


def _parent(repo: Path, suite: str) -> int:
    if os.name != "nt" or suite not in SUITES:
        raise storage.StorageError("Select a supported suite on native Windows")
    repo = repo.resolve()
    if Path(storage.git(repo, "rev-parse", "--show-toplevel")).resolve() != repo:
        raise storage.StorageError("Repository root does not match the selected checkout")
    layout = storage.resolve_layout(repo, PROFILE)
    storage.initialize(layout)
    driver = storage.validate_path(Path(__file__).resolve(), repo, "production mesh verifier")
    with storage.build_lock(layout):
        parent = storage.validate_path(Path(layout["runs_root"]) / PROFILE, layout["runs_root"], "run parent")
        parent.mkdir(parents=True, exist_ok=True)
        run_root = storage.validate_path(parent / uuid.uuid4().hex, layout["runs_root"], "run root")
        run_root.mkdir(exist_ok=False)
        temp_root = run_root / "tmp"
        temp_root.mkdir()
        receipt_path, summary_path = run_root / "receipt.json", run_root / "child-summary.json"
        driver_log = run_root / "driver.log"
        interpreter = Path(sys.executable).resolve()
        source_before = _fingerprints(repo)
        head_before = storage.git(repo, "rev-parse", "HEAD")
        python_before = diagnostics._sha256_file(interpreter)
        process_record: dict[str, object] = {
            "pid": None, "spawned": False, "waited": False, "timed_out": False,
            "terminate_requested": False, "kill_requested": False, "exit_code": None,
            "timeout_seconds": PARENT_TIMEOUT_SECONDS,
            "terminate_grace_seconds": TERMINATE_GRACE_SECONDS,
        }
        receipt: dict[str, object] = {
            "schema": RECEIPT_SCHEMA, "state": "running", "profile": PROFILE,
            "execution_mode": "diagnostic", "lock": "fullmag_storage.build_lock",
            "suite": suite, "selected": _suite_label(suite), "repo_root": str(repo),
            "worktree_id": layout["worktree_id"], "head_before": head_before,
            "source_fingerprints_before": source_before, "source_digest_before": _digest(source_before),
            "python_executable": str(interpreter), "python_sha256_before": python_before,
            "qualification": "not_assessed", "unit_tests": "interpreted_pytest_no_native_compilation",
            "run_root": str(run_root), "log": str(run_root / "pytest.log"),
            "driver_log": str(driver_log), "junit": str(run_root / "junit.xml"),
            "started_at": _stamp(), "process": process_record,
        }
        storage.atomic_json(receipt_path, receipt)
        process: subprocess.Popen[bytes] | None = None
        exit_code = 2
        try:
            child_env = {**os.environ, **layout["env"]}
            pythonpath = [str(repo / "packages/fullmag-py/src"), str(repo / "packages/fullmag-py/tests")]
            if os.environ.get("PYTHONPATH"):
                pythonpath.append(os.environ["PYTHONPATH"])
            child_env.update(
                FULLMAG_REPO_ROOT=str(repo), FULLMAG_STORAGE_PROFILE=PROFILE,
                PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
                PYTEST_ADDOPTS="", PYTEST_PLUGINS="", PYTHONPATH=os.pathsep.join(pythonpath),
                TMPDIR=str(temp_root), TEMP=str(temp_root), TMP=str(temp_root),
            )
            command = [
                str(interpreter), "-B", "-u", str(driver), "--repo-root", str(repo),
                "--child", "--run-root", str(run_root), "--suite", suite,
            ]
            with driver_log.open("x", encoding="utf-8") as log:
                process = subprocess.Popen(
                    command, cwd=repo, env=child_env, stdout=log, stderr=subprocess.STDOUT,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                process_record.update(spawned=True, pid=process.pid)
                storage.atomic_json(receipt_path, receipt)
                try:
                    exit_code = int(process.wait(timeout=PARENT_TIMEOUT_SECONDS))
                except subprocess.TimeoutExpired:
                    process_record.update(timed_out=True, terminate_requested=True)
                    try:
                        process.terminate()
                    except OSError:
                        pass
                    try:
                        exit_code = int(process.wait(timeout=TERMINATE_GRACE_SECONDS))
                    except subprocess.TimeoutExpired:
                        process_record["kill_requested"] = True
                        try:
                            process.kill()
                        except OSError:
                            pass
                        exit_code = int(process.wait())
                process_record.update(waited=True, exit_code=exit_code)
            summary = json.loads(summary_path.read_text(encoding="utf-8")) if summary_path.is_file() else None
            receipt["child_summary"] = summary
            receipt["child_summary_valid"] = _child_passed(summary, suite, interpreter)
        except BaseException as error:
            receipt["error"] = f"{type(error).__name__}: {error}"
            if process is not None and process.poll() is None:
                process_record["terminate_requested"] = True
                try:
                    process.terminate()
                except OSError:
                    pass
                try:
                    exit_code = int(process.wait(timeout=TERMINATE_GRACE_SECONDS))
                except subprocess.TimeoutExpired:
                    process_record["kill_requested"] = True
                    try:
                        process.kill()
                    except OSError:
                        pass
                    exit_code = int(process.wait())
                process_record.update(waited=True, exit_code=exit_code)
        finally:
            try:
                source_after = _fingerprints(repo)
                head_after = storage.git(repo, "rev-parse", "HEAD")
                python_after = diagnostics._sha256_file(interpreter)
                receipt.update(
                    source_fingerprints_after=source_after, source_digest_after=_digest(source_after),
                    source_changed_during_run=source_before != source_after,
                    head_after=head_after, head_changed_during_run=head_before != head_after,
                    python_sha256_after=python_after, python_changed_during_run=python_before != python_after,
                )
                stable = source_before == source_after and head_before == head_after and python_before == python_after
            except Exception as error:
                stable = False
                receipt["after_snapshot_error"] = f"{type(error).__name__}: {error}"
            receipt.update(driver_exit_code=exit_code, finished_at=_stamp())
            receipt["state"] = (
                "completed" if process_record["waited"] is True and process_record["timed_out"] is False
                and exit_code == 0 and stable and receipt.get("child_summary_valid") is True else "failed"
            )
            storage.atomic_json(receipt_path, receipt)
            print(json.dumps({"receipt": str(receipt_path), "state": receipt["state"], "driver_exit_code": exit_code}))
        return 0 if receipt["state"] == "completed" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--suite", choices=tuple(SUITES), required=True)
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--run-root", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    repo = Path(args.repo_root).resolve()
    try:
        if args.child:
            if args.run_root is None:
                raise storage.StorageError("Managed child requires --run-root")
            return _child(repo, args.run_root.resolve(), args.suite)
        return _parent(repo, args.suite)
    except Exception as error:
        print(f"[exact-layer production mesh verifier] {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
