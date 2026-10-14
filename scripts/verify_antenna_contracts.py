#!/usr/bin/env python3
"""Run qualified antenna contract groups and retain a source-bound result."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from uuid import uuid4

from capture_source_snapshot_identity import SourceIdentityError, capture


GROUPS = (
    "model",
    "authoring",
    "native-current",
    "native-field",
    "artifact",
    "projection",
    "spectrum",
    "budget",
    "lifecycle",
    "fem-llg",
    "fdm-cpu",
    "fdm-gpu",
    "fem-gpu",
    "frequency-response",
    "browser",
    "all",
)
MODEL_TESTS = (
    "packages/fullmag-py/tests/test_antenna_layout.py",
    "packages/fullmag-py/tests/test_antenna_composition_contract.py",
)
AUTHORING_TESTS = (
    "packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py",
    "packages/fullmag-py/tests/test_antenna_layout.py",
    "packages/fullmag-py/tests/test_antenna_composition_contract.py",
    "packages/fullmag-py/tests/test_antenna_stage_workflow.py",
    "packages/fullmag-py/tests/test_current_transport.py",
    "packages/fullmag-py/tests/test_runtime_cli_state_transfer.py",
)
BROWSER_NODE_TEST = "apps/control-room/scripts/lib/antenna-authoring-browser.test.mjs"
BROWSER_VITEST_TESTS = (
    "apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.test.ts",
    "apps/control-room/src/modules/explorer/builders/antennaExplorerNodes.test.ts",
    "apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.test.ts",
    "apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.dom.test.tsx",
    "apps/control-room/src/modules/inspector/panels/TransportAuthoringInspectorModel.test.ts",
    "apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.test.ts",
    "apps/control-room/src/modules/inspector/panels/antenna/AntennaCompositionPanels.dom.test.tsx",
    "apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldBasisPreviewModel.test.ts",
    "apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldBasisPreview.dom.test.tsx",
    "apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.test.ts",
    "apps/control-room/src/shared/domain/physics/antennaStageValidation.test.ts",
    "apps/control-room/src/modules/inspector/panels/antenna/SolvedAntennaDriveEditorModel.test.ts",
    "apps/control-room/src/modules/inspector/panels/antenna/AntennaSpectrumComposerModel.test.ts",
    "apps/control-room/src/modules/inspector/panels/antenna/AntennaSourceSpectrumPayloadView.test.tsx",
    "apps/control-room/src/modules/inspector/panels/antenna/AntennaProjectionDriveComposerModel.test.ts",
    "apps/control-room/src/kernel/resources/antennaResources.test.ts",
)


def pytest_counts(output: str) -> tuple[int, int, int]:
    def count(label: str) -> int:
        match = re.search(rf"\b(\d+) {label}\b", output)
        return int(match.group(1)) if match else 0

    return count("passed"), count("failed"), count("skipped")


def node_test_counts(output: str) -> tuple[int, int, int, int]:
    def count(label: str) -> int:
        match = re.search(rf"^# {label} (\d+)$", output, re.MULTILINE)
        return int(match.group(1)) if match else 0

    return count("tests"), count("pass"), count("fail"), count("skipped")


def vitest_counts(output: str) -> tuple[int, int, int]:
    match = re.search(r"^\s*Tests\s+(.+)$", output, re.MULTILINE)
    if not match:
        return 0, 0, 0
    summary = match.group(1)

    def count(label: str) -> int:
        found = re.search(rf"\b(\d+) {label}\b", summary)
        return int(found.group(1)) if found else 0

    return count("passed"), count("failed"), count("skipped")


def managed_path(variable: str, storage_root: Path) -> Path:
    raw = os.environ.get(variable)
    if not raw:
        raise ValueError(f"{variable} is required from the storage resolver")
    path = Path(raw).resolve()
    if not path.is_relative_to(storage_root) or path == storage_root:
        raise ValueError(f"{variable} must be inside the managed storage root")
    return path


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in GROUPS:
        print(f"usage: verify_antenna_contracts.py {{{'|'.join(GROUPS)}}}", file=sys.stderr)
        return 2
    group = args[0]
    repo_root = Path(__file__).resolve().parents[1]
    storage_raw = os.environ.get("FULLMAG_PROJECT_STORAGE_ROOT")
    if not storage_raw:
        print("FULLMAG_PROJECT_STORAGE_ROOT is required", file=sys.stderr)
        return 2
    storage_root = Path(storage_raw).resolve()
    try:
        runs_root = managed_path("FULLMAG_RUNS_ROOT", storage_root)
        build_root = managed_path("FULLMAG_BUILD_ROOT", storage_root)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid4().hex[:8]
    report_dir = runs_root / "antenna-contracts" / run_id
    report_dir.mkdir(parents=True, exist_ok=False)
    source_before = capture(repo_root, qualification_inputs=("justfile", "scripts/verify_antenna_contracts.py"))
    (report_dir / "source-before.json").write_text(
        json.dumps(source_before, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    result: dict[str, object] = {
        "schema": "fullmag.antenna_contract_group.v1",
        "group": group,
        "device": "not_applicable" if group in ("model", "authoring") else "not_qualified",
        "head_commit": source_before["head_commit_full"],
        "source_snapshot_sha256": source_before["source_snapshot_sha256"],
        "dirty_path_content": source_before["dirty_path_content"],
        "test_count": 0,
        "passed_count": 0,
        "failed_count": 0,
        "skipped_count": 0,
        "command": None,
        "command_exit_code": None,
        "wrapper_exit_code": 3,
        "status": "not_qualified",
    }
    if group in ("model", "authoring"):
        python = build_root / "python-antenna-t01" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        python = python.resolve()
        if python.is_relative_to(build_root) and python.is_file():
            command = [
                str(python), "-m", "pytest", "-q", "-rs", "-p", "no:cacheprovider",
                *(MODEL_TESTS if group == "model" else AUTHORING_TESTS),
            ]
            result["command"] = command
            environment = os.environ.copy()
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            try:
                completed = subprocess.run(
                    command, cwd=repo_root, env=environment,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                    errors="replace", check=False,
                )
            except OSError as error:
                result.update({"status": "fail", "reason": f"test process could not start: {error}"})
                (report_dir / "test.log").write_text(f"{error}\n", encoding="utf-8")
            else:
                (report_dir / "test.log").write_text(completed.stdout, encoding="utf-8")
                passed, failed, skipped = pytest_counts(completed.stdout)
                result.update({
                    "command_exit_code": completed.returncode,
                    "test_count": passed + failed + skipped,
                    "passed_count": passed,
                    "failed_count": failed,
                    "skipped_count": skipped,
                    "status": "pass" if completed.returncode == 0 and passed > 0 and skipped == 0 else "fail",
                })
        else:
            result["reason"] = "managed antenna Python environment is missing"
    elif group == "browser":
        try:
            frontend_root = managed_path("FULLMAG_FRONTEND_ROOT", storage_root)
        except ValueError as error:
            result["reason"] = str(error)
        else:
            node = shutil.which("node")
            vitest = (repo_root / "apps/control-room/node_modules/vitest/vitest.mjs").resolve()
            if not node or not vitest.is_relative_to(frontend_root) or not vitest.is_file():
                result["reason"] = "managed Control Room Node/Vitest environment is missing"
            else:
                commands = [
                    [node, "--test", "--test-reporter=tap", BROWSER_NODE_TEST],
                    [node, str(vitest), "run", "--config", "apps/control-room/vitest.config.ts", *BROWSER_VITEST_TESTS],
                ]
                result["commands"] = commands
                environment = os.environ.copy()
                environment["NO_COLOR"] = "1"
                exit_codes: list[int | None] = []
                outputs: list[str] = []
                for command, log_name in zip(commands, ("node-test.log", "vitest.log"), strict=True):
                    try:
                        completed = subprocess.run(
                            command, cwd=repo_root, env=environment,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                            errors="replace", check=False,
                        )
                    except OSError as error:
                        exit_codes.append(None)
                        outputs.append(str(error))
                        (report_dir / log_name).write_text(f"{error}\n", encoding="utf-8")
                    else:
                        exit_codes.append(completed.returncode)
                        outputs.append(completed.stdout)
                        (report_dir / log_name).write_text(completed.stdout, encoding="utf-8")
                node_total, node_passed, node_failed, node_skipped = node_test_counts(outputs[0])
                vitest_passed, vitest_failed, vitest_skipped = vitest_counts(outputs[1])
                result.update({
                    "command_exit_codes": exit_codes,
                    "test_count": node_total + vitest_passed + vitest_failed + vitest_skipped,
                    "passed_count": node_passed + vitest_passed,
                    "failed_count": node_failed + vitest_failed,
                    "skipped_count": node_skipped + vitest_skipped,
                })
                if (
                    exit_codes != [0, 0]
                    or node_total == 0
                    or vitest_passed == 0
                    or node_total != node_passed + node_failed + node_skipped
                    or result["failed_count"] != 0
                    or result["skipped_count"] != 0
                ):
                    result.update({"status": "fail", "reason": "browser contract tests failed or did not run completely"})
                else:
                    result["reason"] = "Node/Vitest contracts passed; browser E2E and managed runtime are not qualified"
    else:
        result["reason"] = "this group has no qualified executable mapping yet"

    try:
        source_after = capture(repo_root, qualification_inputs=("justfile", "scripts/verify_antenna_contracts.py"))
    except (SourceIdentityError, OSError) as error:
        result["source_unchanged"] = False
        result["reason"] = f"source identity could not be recaptured: {error}"
        result["status"] = "fail"
    else:
        result["source_unchanged"] = source_after == source_before
        if not result["source_unchanged"]:
            result["status"] = "fail"
    result["wrapper_exit_code"] = 0 if result["status"] == "pass" else 3
    (report_dir / "result.json").write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"antenna contracts: {result['status']} ({group}); report: {report_dir}")
    return int(result["wrapper_exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
