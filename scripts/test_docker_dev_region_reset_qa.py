"""Pure contract regressions for the fixed S46 region-reset browser QA modes."""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import docker_dev_region_reset_qa as region_qa  # noqa: E402
from docker_build_control import BuildControlError, canonical  # noqa: E402
from bootstrap_docker_toolchain import control_volume_name  # noqa: E402


TOKEN = "a" * 32
DEV_ATTEMPT = "b" * 32
CURRENT_ATTEMPT = "d" * 32
RECREATION_ATTEMPT = "e" * 32
SOURCE_COMMIT = "c" * 40
BACKEND_CONTAINER = "1" * 64
FRONTEND_CONTAINER = "2" * 64
IMAGE_ID = "sha256:" + "3" * 64
DAEMON_ID = "4" * 64
SESSION = {"session_id": "session-1", "session_epoch": "s1@1", "request_scope_epoch": "api:1"}
STAGES = ["relax-a", "relax-b", "relax-c"]
SCOPE = "session=session-1&epoch=s1%401&request_scope_epoch=api%3A1"
HASHES = {
    key: ("d" if key == "fixture" else "e") * 64
    for key in region_qa.source_paths("s46-local-export")
}
SOURCE_TEXT = "# exported UI-authored recipe\nstudy = None\n"
SCRIPT_SHA = hashlib.sha256(SOURCE_TEXT.encode("utf-8")).hexdigest()
FRESH_STATE_EVIDENCE = {
    "previous_development_attempt": DEV_ATTEMPT,
    "previous_development_terminal_sha256": "5" * 64,
    "previous_state_root": "/tmp/fullmag-state/" + DEV_ATTEMPT,
    "previous_group_ledger_sha256": "6" * 64,
    "recreation_attempt": RECREATION_ATTEMPT,
    "generation_sha256": "7" * 64,
    "recreation_terminal_sha256": "8" * 64,
    "archive_terminal_sha256": "9" * 64,
    "archive_intent_sha256": "a" * 64,
    "retained_containers_sha256": "b" * 64,
    "helper_source_binding_sha256": "c" * 64,
    "current_development_attempt": CURRENT_ATTEMPT,
    "current_development_terminal_sha256": "d" * 64,
    "current_state_root": "/tmp/fullmag-state/" + CURRENT_ATTEMPT,
    "current_compose_sha256": "e" * 64,
    "current_group_ledger_sha256": "e" * 64,
}


def _edit(kind, revision, *, region=False):
    return {
        "kind": kind,
        "stage_id": "relax-b",
        **({"object_id": "film", "region_id": "left-half"} if region else {}),
        "before_revision": revision,
        "after_revision": revision + 1,
        "request_sha256": "e" * 64,
        "committed_scene_sha256": "f" * 64,
        "session_scope": SCOPE,
    }


def _result_identities(run_id, stages):
    return [{
        "project_id": "project-1",
        "study_id": "study-1",
        "source": {"run_id": run_id, "task_id": "task-1", "step_id": stage,
                   "case_id": "case-1", "attempt_id": "attempt-1", "ownership_epoch": 2},
        "authored_stage_id": stage,
        "artifact_id": "artifact-" + stage,
        "artifact_sha256": "1" * 64,
        "codec_id": "zarr",
        "codec_version": "1",
        "accepted_at": "2026-11-09T12:00:00Z",
    } for stage in stages]


def _run(run_id, stages):
    target = ({"kind": "stage_id", "stage_id": "relax-b"}
              if list(stages) == ["relax-b"] else {"kind": "study"})
    binding = {"requested_target": target, "run_id": run_id,
               "step_id": "relax-b" if target["kind"] == "stage_id" else None}
    return {"run_id": run_id, "command_id": "command-" + run_id,
            "execution_binding": binding, "status": "completed", "stage_ids": list(stages),
            "results": _result_identities(run_id, stages)}


def _parent_evidence(mode="s46-local-import"):
    return {
        "prior_attempt": TOKEN,
        "record_sha256": {"terminal": "2" * 64, "result": "3" * 64},
        "mode": mode.replace("-import", "-export"),
        "script_sha256": SCRIPT_SHA,
        "source_text": SOURCE_TEXT,
        "source_name": "p22-s46-" + ("local" if mode.startswith("s46-local-") else "independent") + ".py",
        "parent_development_attempt": DEV_ATTEMPT,
        "source_commit": SOURCE_COMMIT,
        "fresh_state": deepcopy(FRESH_STATE_EVIDENCE),
    }


def _report(mode, parent=None):
    is_import = mode.endswith("-import")
    is_local = mode.startswith("s46-local-")
    imported_sha = parent["script_sha256"] if parent else HASHES["fixture"]
    transactions = 2 if is_import else (3 if is_local else 2)
    command_count = 2 if is_import else 1
    request_counts = {
        "POST /v2/persistence/projects/from-script": 1,
        "POST /v2/sessions": 1,
        "POST /v2/sessions/current/model/transactions": transactions,
        "POST /v2/sessions/current/simulation/commands": command_count + 1,
    }
    if is_import:
        request_counts["POST /v2/sessions/current/model/syncs"] = 0
    else:
        request_counts["POST /v2/sessions/current/model/syncs"] = 1
    report = {
        "schema": region_qa.RESULT_SCHEMA,
        "scenario": "study-stage-rerun",
        "mode": mode,
        "state": "passed",
        "outcome": "completed" if is_import else "exported",
        "phase": "complete",
        "public_url": "http://127.0.0.1:3199",
        "probe_url": "http://frontend:8080",
        "source_hashes_before": HASHES,
        "source_hashes_after": HASHES,
        "api_instance_id": "api-instance-1",
        "session": SESSION,
        "command_count": command_count,
        "command_attempt_count": command_count,
        "grid_command_count": 1,
        "request_counts": request_counts,
        "read_cancellations": [],
        "successful_read_responses": [],
        "auxiliary_writes": [],
        "violations": [],
        "errors": {"page": [], "console": [], "http": []},
        "expected_empty_404": [],
        "expected_console_404": [],
        "cleanup_cancellations": [],
        "cleanup_errors": [],
        "edits": ([_edit("enable", 20)] if is_import else
                  ([_edit("region-reset", 10, region=True), _edit("disable", 11)] if is_local
                   else [_edit("disable", 10)])),
        "import": {"project_id": "project-1", "source_sha256": imported_sha,
                   "session_id": SESSION["session_id"],
                   "scene_revision": 20 if is_import else 10, "fidelity": "verified"},
        "reload": {"method": "page.reload", "response_status": 200, "identity_preserved": True,
                   "run_id": "run-stage-b" if is_import else "run-baseline"},
        "canvas": {"context_type": "WebGL2RenderingContext", "context_lost": False,
                   "drawing_buffer_width": 1440, "drawing_buffer_height": 900},
        "parent_evidence": parent,
    }
    if is_import:
        report["study"] = _run("run-study", ["relax-a", "relax-c"])
        report["stage_only"] = _run("run-stage-b", ["relax-b"])
    else:
        report["baseline"] = _run("run-baseline", STAGES)
        report["export"] = {"source_text": SOURCE_TEXT,
                            "source_name": "p22-s46-" + ("local" if is_local else "independent") + ".py",
                            "script_sha256": SCRIPT_SHA,
                            "scene_revision": report["edits"][-1]["after_revision"]}
    return report


def _encoded(report):
    return json.dumps(report, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"


def _parent_documents(mode="s46-local-export", *, mutate_terminal=None, mutate_result=None):
    source_root = ROOT.resolve(strict=True)
    worktree_id = "interactive-study-fixture"
    project = FakeControl.project
    volume = FakeControl.volume
    expected_sources = {
        key: ("4" if key == "fixture" else "5") * 64
        for key in region_qa.source_paths(mode)
    }
    source_text = SOURCE_TEXT
    terminal = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "browser-qa",
        "state": "succeeded",
        "attempt": TOKEN,
        "compose_project": project,
        "control_volume": volume,
        "inputs": {
            "scenario": "study-stage-rerun",
            "study_stage_rerun": mode,
            "study_stage_rerun_source_sha256": expected_sources,
            "source_root": str(source_root),
            "worktree_id": worktree_id,
            "source_commit": SOURCE_COMMIT,
            "development_attempt": DEV_ATTEMPT,
        },
    }
    result = {
        "schema": region_qa.RESULT_SCHEMA,
        "scenario": "study-stage-rerun",
        "mode": mode,
        "state": "passed",
        "outcome": "exported",
        "source_hashes_before": expected_sources,
        "source_hashes_after": expected_sources,
        "import": {"project_id": "project-1", "source_sha256": expected_sources["fixture"],
                   "session_id": SESSION["session_id"], "scene_revision": 10, "fidelity": "verified"},
        "export": {"source_text": source_text,
                    "source_name": "p22-s46-" + ("local" if mode.startswith("s46-local-") else "independent") + ".py",
                    "script_sha256": SCRIPT_SHA, "scene_revision": 12},
    }
    mutate_terminal and mutate_terminal(terminal)
    mutate_result and mutate_result(result)
    state_base = "/tmp/fullmag-state"
    ledger_subpath = "private/ledger"

    def dev_compose_and_ledger():
        from docker_group_ledger import HOST_ID_ENV, PROFILE, PRIVATE_GROUP_STORAGE_ENV, profile
        ledger_profile = profile(
            DAEMON_ID, project, volume, IMAGE_ID, ledger_subpath=ledger_subpath,
        )
        compose = {
            "name": project,
            "services": {"backend": {
                "image": IMAGE_ID,
                "environment": ledger_profile["backend"]["environment"],
                "volumes": ledger_profile["backend"]["volumes"],
            }},
            "volumes": {"group-ledger": ledger_profile["compose_volume"]},
        }
        ledger = {
            "schema": "fullmag.docker-group-ledger.v1", "profile": PROFILE,
            "daemon_id_sha256": DAEMON_ID, "compose_project": project,
            "volume_name": volume,
            "host_id": ledger_profile["environment"][HOST_ID_ENV],
        }
        self_assert = ledger_profile["environment"][PRIVATE_GROUP_STORAGE_ENV]
        return compose, ledger, self_assert

    previous_compose, previous_ledger, _ = dev_compose_and_ledger()
    current_compose, current_ledger, _ = dev_compose_and_ledger()
    previous_compose_sha = hashlib.sha256(canonical(previous_compose)).hexdigest()
    current_compose_sha = hashlib.sha256(canonical(current_compose)).hexdigest()
    previous = {
        "schema": "fullmag.docker-build-operation.v1", "phase": "development",
        "state": "succeeded", "attempt": DEV_ATTEMPT,
        "compose_project": project, "control_volume": volume, "control_namespace": "",
        "source_commit": SOURCE_COMMIT, "state_root": state_base + "/" + DEV_ATTEMPT,
        "config_sha256": previous_compose_sha,
        "backend_container": BACKEND_CONTAINER, "frontend_container": FRONTEND_CONTAINER,
        "started_at": 10, "finished_at": 30,
        "inputs": {
            "source_root": str(source_root), "source_worktree_id": worktree_id,
            "source_project_id": "fullmag", "source_checkout_kind": "worktree",
            "image_id": IMAGE_ID,
        },
    }
    current = {
        "schema": "fullmag.docker-build-operation.v1", "phase": "development",
        "state": "succeeded", "attempt": CURRENT_ATTEMPT,
        "compose_project": project, "control_volume": volume, "control_namespace": "",
        "source_commit": SOURCE_COMMIT, "state_root": state_base + "/" + CURRENT_ATTEMPT,
        "config_sha256": current_compose_sha,
        "backend_container": "3" * 64, "frontend_container": "4" * 64,
        "started_at": 50, "finished_at": 60,
        "inputs": {
            "source_root": str(source_root), "source_worktree_id": worktree_id,
            "source_project_id": "fullmag", "source_checkout_kind": "worktree",
            "image_id": IMAGE_ID,
        },
    }
    recreation_mapping = {
        "previous_runtime_control": "runtime-control",
        "archived_runtime_control": "runtime-archives/" + RECREATION_ATTEMPT,
        "fresh_runtime_control": "runtime-control",
        "fresh_runtime_services": "runtime-control/runtime-services",
        "preserved_group_ledger_role": "private/ledger",
        "previous_group_ledger": "private/ledger/ledger",
        "archived_group_ledger": "runtime-archives/" + RECREATION_ATTEMPT + "/group-ledger",
        "fresh_group_ledger": "private/ledger/ledger",
    }
    archive_intent = {
        "schema": "fullmag.docker-fresh-runtime-archive-intent.v1",
        "operation_attempt": RECREATION_ATTEMPT,
        "compose_project": project, "control_volume": volume, "control_namespace": "",
        "source_root": str(source_root), "previous_state_root": previous["state_root"],
        "removed_containers": {"backend": BACKEND_CONTAINER, "frontend": FRONTEND_CONTAINER},
        "preserved_group_ledger_volume": volume,
        "preserved_group_ledger_subpath": ledger_subpath,
        "mapping": recreation_mapping,
    }
    archive = {
        "schema": "fullmag.docker-fresh-runtime-archive-terminal.v1",
        "state": "succeeded", "operation_attempt": RECREATION_ATTEMPT,
        "compose_project": project, "control_volume": volume, "control_namespace": "",
        "preserved_group_ledger_volume": volume,
        "preserved_group_ledger_subpath": ledger_subpath,
        "mapping": recreation_mapping,
        "preserved_runtime_control_device_inode": "1:2",
        "archived_runtime_control_device_inode": "1:2",
        "fresh_runtime_control_device_inode": "1:3",
        "fresh_runtime_services_device_inode": "1:4",
        "preserved_group_ledger_device_inode": "2:1",
        "preserved_group_ledger_owner": "65532:65532",
        "preserved_group_ledger_mode": "750",
        "archived_group_ledger_device_inode": "2:1",
        "archived_group_ledger_owner": "65532:65532",
        "archived_group_ledger_mode": "750",
        "preserved_group_ledger_role_device_inode": "2:2",
        "fresh_group_ledger_role_device_inode": "2:2",
        "preserved_group_ledger_role_owner": "65532:65532",
        "fresh_group_ledger_role_owner": "65532:65532",
        "preserved_group_ledger_role_mode": "750",
        "fresh_group_ledger_role_mode": "750",
        "fresh_group_ledger_device_inode": "2:3",
        "fresh_group_ledger_owner": "65532:65532",
        "intent_sha256": hashlib.sha256(canonical(archive_intent) + b"\n").hexdigest(),
        "removed_containers": {"backend": BACKEND_CONTAINER, "frontend": FRONTEND_CONTAINER},
    }
    generation = {
        "schema": "fullmag.docker-group-ledger-generation.v1",
        "compose_project": project, "generation": RECREATION_ATTEMPT,
        "archive_terminal_path": "recreate-services/attempts/" + RECREATION_ATTEMPT
                                 + "/runtime-control-archive-terminal.json",
        "archive_terminal_sha256": hashlib.sha256(canonical(archive)).hexdigest(),
        "preserved_volume": volume, "preserved_subpath": ledger_subpath,
        "archived_group_ledger_path": recreation_mapping["archived_group_ledger"],
    }
    recreation_root = "recreate-services/attempts/" + RECREATION_ATTEMPT
    from docker_helper_source import SCHEMA as HELPER_SOURCE_SCHEMA, _binding_manifest_sha256
    helper_files = [
        {"path": "scripts/docker_startup_script.py", "mode": "100644",
         "git_blob": "a" * 40, "sha256": "1" * 64},
        {"path": "scripts/fullmag_storage.py", "mode": "100644",
         "git_blob": "b" * 40, "sha256": "2" * 64},
    ]
    helper_binding = {
        "schema": HELPER_SOURCE_SCHEMA, "root": str(source_root),
        "app_source_root": str(source_root), "commit": SOURCE_COMMIT,
        "manifest_sha256": _binding_manifest_sha256(SOURCE_COMMIT, helper_files),
        "files": helper_files,
        "startup_helper_hashes": {
            "docker_startup_script.py": "1" * 64,
            "fullmag_storage.py": "2" * 64,
        },
    }
    retained = {
        "backend": {"Id": BACKEND_CONTAINER},
        "frontend": {"Id": FRONTEND_CONTAINER},
    }
    recreation = {
        "schema": "fullmag.docker-build-operation.v1", "phase": "recreate-services",
        "state": "succeeded", "attempt": RECREATION_ATTEMPT,
        "compose_project": project, "control_volume": volume, "control_namespace": "",
        "fresh_state": True, "previous_state_root": previous["state_root"],
        "removed_containers": [BACKEND_CONTAINER, FRONTEND_CONTAINER],
        "runtime_control_archive": archive, "started_at": 40, "finished_at": 45,
        "helper_source": helper_binding,
        "inputs": {"attempt": DEV_ATTEMPT, "config_sha256": previous_compose_sha,
                   "helper_source": helper_binding},
    }
    documents = {
        "development/current.json": current,
        "development/verified.json": current,
        f"development/attempts/{DEV_ATTEMPT}/terminal.json": previous,
        f"development/attempts/{DEV_ATTEMPT}/receipt.json": previous,
        f"development/attempts/{DEV_ATTEMPT}/compose.json": previous_compose,
        f"development/attempts/{DEV_ATTEMPT}/group-ledger.json": previous_ledger,
        f"development/attempts/{CURRENT_ATTEMPT}/terminal.json": current,
        f"development/attempts/{CURRENT_ATTEMPT}/receipt.json": current,
        f"development/attempts/{CURRENT_ATTEMPT}/compose.json": current_compose,
        f"development/attempts/{CURRENT_ATTEMPT}/group-ledger.json": current_ledger,
        "group-ledger-generation.json": generation,
        f"{recreation_root}/terminal.json": recreation,
        f"{recreation_root}/receipt.json": recreation,
        f"{recreation_root}/runtime-control-archive-terminal.json": archive,
        f"{recreation_root}/runtime-control-archive-intent.json": archive_intent,
        f"{recreation_root}/retained-containers.json": retained,
        f"{recreation_root}/helper-source-binding.json": helper_binding,
        "recreate-services/current.json": recreation,
        "recreate-services/verified.json": recreation,
    }
    documents.update({
        f"browser-qa/attempts/{TOKEN}/terminal.json": canonical(terminal) + b"\n",
        f"browser-qa/attempts/{TOKEN}/result.json": canonical(result) + b"\n",
    })
    return documents, expected_sources


class FakeControl:
    project = "fullmag-worktree-interactive-study-fixture"
    volume = control_volume_name(project)
    identity = {"worktree_id": "interactive-study-fixture", "project_id": "fullmag",
                "checkout_kind": "worktree"}
    namespace = ""

    def __init__(self, documents):
        self.documents = documents
        self.reads = []

    def read(self, relative, *, optional=False):
        self.reads.append(relative)
        if relative not in self.documents:
            if optional:
                return None
            raise BuildControlError("missing fixture document: " + relative)
        value = self.documents[relative]
        return deepcopy(value) if isinstance(value, dict) else json.loads(value)

    def read_bytes(self, relative, *, optional=False, maximum=4 * 1024 * 1024):
        self.reads.append(relative)
        if relative not in self.documents:
            if optional:
                return None
            raise BuildControlError("missing fixture bytes: " + relative)
        value = self.documents[relative]
        raw = value if isinstance(value, bytes) else canonical(value) + b"\n"
        if len(raw) > maximum:
            raise BuildControlError("fixture too large")
        return raw


class RegionResetQaTests(unittest.TestCase):
    def test_source_paths_are_fixed_and_pair_export_import_by_variant(self):
        self.assertEqual(set(region_qa.MODES), {
            "s46-local-export", "s46-independent-export", "s46-local-import", "s46-independent-import",
        })
        local_export = region_qa.source_paths("s46-local-export")
        local_import = region_qa.source_paths("s46-local-import")
        independent_export = region_qa.source_paths("s46-independent-export")
        independent_import = region_qa.source_paths("s46-independent-import")
        self.assertEqual(local_export, local_import)
        self.assertEqual(independent_export, independent_import)
        self.assertNotEqual(local_export["fixture"], independent_export["fixture"])
        self.assertGreaterEqual(len(local_export), 20)
        self.assertLessEqual(len(local_export), 32)
        for key, path in {
            "start_screen": "apps/control-room/src/modules/start/StartScreen.tsx",
            "start_screen_state": "apps/control-room/src/modules/start/model/startScreenState.ts",
            "start_screen_host_adapter": "apps/control-room/src/modules/start/model/startScreenHostAdapter.ts",
            "mesh_build_dialog": "apps/control-room/src/modules/overlay/MeshBuildDialog.tsx",
            "start_commands": "apps/control-room/src/modules/start/model/startCommands.ts",
            "start_rail": "apps/control-room/src/modules/start/rail/StartRail.tsx",
        }.items():
            self.assertEqual(local_export.get(key), path)
        self.assertEqual(local_export["fixture"], "examples/interactive_study/fdm_cpu_three_relax_region_ui_baseline.py")
        self.assertEqual(independent_export["fixture"], "examples/interactive_study/fdm_cpu_three_relax_region_reset.py")
        for path in local_export.values():
            self.assertFalse(path.startswith("/"))
            self.assertNotIn("..", Path(path).parts)
            self.assertTrue((ROOT / path).is_file(), path)
        with self.assertRaises(BuildControlError):
            region_qa.source_paths("study")

    def test_parent_evidence_shape_is_bound_to_import_variant_and_exact_bytes(self):
        evidence = _parent_evidence()
        self.assertEqual(region_qa.validate_parent_evidence(evidence, "s46-local-import"), evidence)
        for key, value in [
            ("prior_attempt", "../" + TOKEN),
            ("mode", "s46-independent-export"),
            ("script_sha256", "0" * 64),
            ("source_name", "../../outside.py"),
            ("source_text", "x" * 65537),
            ("parent_development_attempt", "not-an-attempt"),
            ("source_commit", "not-a-commit"),
            ("record_sha256", {"terminal": "f" * 64}),
        ]:
            changed = deepcopy(evidence)
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(BuildControlError):
                region_qa.validate_parent_evidence(changed, "s46-local-import")
        extra = {**evidence, "source_path": "/tmp/arbitrary.py"}
        with self.assertRaises(BuildControlError):
            region_qa.validate_parent_evidence(extra, "s46-local-import")
        with self.assertRaises(BuildControlError):
            region_qa.validate_parent_evidence(evidence, "s46-independent-import")
        with self.assertRaises(BuildControlError):
            region_qa.validate_parent_evidence(evidence, "s46-local-export")

    def test_load_parent_evidence_pins_raw_terminal_and_result_for_same_group(self):
        documents, sources = _parent_documents()
        control = FakeControl(documents)
        evidence = region_qa.load_parent_evidence(
            control, TOKEN, source_root=ROOT, mode="s46-local-import", expected_sources=sources,
        )
        self.assertEqual(evidence["prior_attempt"], TOKEN)
        self.assertEqual(evidence["mode"], "s46-local-export")
        self.assertEqual(evidence["source_text"], SOURCE_TEXT)
        self.assertEqual(evidence["script_sha256"], SCRIPT_SHA)
        self.assertEqual(evidence["parent_development_attempt"], DEV_ATTEMPT)
        self.assertEqual(evidence["fresh_state"]["previous_development_attempt"], DEV_ATTEMPT)
        self.assertEqual(evidence["fresh_state"]["current_development_attempt"], CURRENT_ATTEMPT)
        self.assertEqual(evidence["fresh_state"]["recreation_attempt"], RECREATION_ATTEMPT)
        self.assertNotEqual(evidence["parent_development_attempt"], CURRENT_ATTEMPT)
        terminal_raw = documents[f"browser-qa/attempts/{TOKEN}/terminal.json"]
        result_raw = documents[f"browser-qa/attempts/{TOKEN}/result.json"]
        self.assertEqual(evidence["record_sha256"], {
            "terminal": hashlib.sha256(terminal_raw).hexdigest(),
            "result": hashlib.sha256(result_raw).hexdigest(),
        })
        self.assertIn("development/current.json", control.reads)

    def test_parent_loader_requires_one_exact_p_to_r_to_n_fresh_state_transition(self):
        recreation_root = "recreate-services/attempts/" + RECREATION_ATTEMPT
        helper_binding_path = recreation_root + "/helper-source-binding.json"

        def wrong_helper_commit(docs):
            from docker_helper_source import _binding_manifest_sha256
            binding = deepcopy(docs[helper_binding_path])
            binding["commit"] = "9" * 40
            binding["manifest_sha256"] = _binding_manifest_sha256(binding["commit"], binding["files"])
            docs[helper_binding_path] = binding
            for path in (recreation_root + "/terminal.json", recreation_root + "/receipt.json",
                         "recreate-services/current.json", "recreate-services/verified.json"):
                docs[path]["helper_source"] = binding
                docs[path]["inputs"]["helper_source"] = binding

        cases = [
            ("missing archive", lambda docs: docs.pop(
                recreation_root + "/runtime-control-archive-terminal.json")),
            ("changed archive", lambda docs: docs[recreation_root + "/runtime-control-archive-terminal.json"]
             .update(mapping={"foreign": "archive"})),
            ("foreign predecessor", lambda docs: [
                docs[recreation_root + "/terminal.json"]["inputs"].update(attempt="f" * 32),
                docs[recreation_root + "/receipt.json"]["inputs"].update(attempt="f" * 32),
                docs["recreate-services/current.json"]["inputs"].update(attempt="f" * 32),
                docs["recreate-services/verified.json"]["inputs"].update(attempt="f" * 32),
            ]),
            ("inconsistent successor", lambda docs: [
                docs["development/current.json"].update(started_at=44),
                docs["development/verified.json"].update(started_at=44),
                docs[f"development/attempts/{CURRENT_ATTEMPT}/terminal.json"].update(started_at=44),
                docs[f"development/attempts/{CURRENT_ATTEMPT}/receipt.json"].update(started_at=44),
            ]),
            ("missing helper binding", lambda docs: docs.pop(helper_binding_path)),
            ("wrong helper commit", wrong_helper_commit),
            ("wrong fresh root", lambda docs: [
                docs["development/current.json"].update(state_root="/tmp/other-root/" + CURRENT_ATTEMPT),
                docs["development/verified.json"].update(state_root="/tmp/other-root/" + CURRENT_ATTEMPT),
                docs[f"development/attempts/{CURRENT_ATTEMPT}/terminal.json"].update(
                    state_root="/tmp/other-root/" + CURRENT_ATTEMPT),
                docs[f"development/attempts/{CURRENT_ATTEMPT}/receipt.json"].update(
                    state_root="/tmp/other-root/" + CURRENT_ATTEMPT),
            ]),
        ]
        for label, mutate in cases:
            documents, sources = _parent_documents()
            mutate(documents)
            with self.subTest(label=label), self.assertRaises(BuildControlError):
                region_qa.load_parent_evidence(
                    FakeControl(documents), TOKEN, source_root=ROOT,
                    mode="s46-local-import", expected_sources=sources,
                )

    def test_large_valid_helper_binding_receipts_fit_the_bounded_two_mib_limit(self):
        documents, sources = _parent_documents()
        recreation_root = "recreate-services/attempts/" + RECREATION_ATTEMPT
        helper_binding_path = recreation_root + "/helper-source-binding.json"
        binding = deepcopy(documents[helper_binding_path])
        files = list(binding["files"])
        files.extend({
            "path": f"scripts/zzzz-p22-helper-{index:04d}.py",
            "mode": "100644", "git_blob": f"{index + 10:040x}",
            "sha256": f"{index + 10:064x}",
        } for index in range(2500))
        binding["files"] = files
        from docker_helper_source import _binding_manifest_sha256
        binding["manifest_sha256"] = _binding_manifest_sha256(binding["commit"], files)
        documents[helper_binding_path] = binding
        for path in (recreation_root + "/terminal.json", recreation_root + "/receipt.json",
                     "recreate-services/current.json", "recreate-services/verified.json"):
            documents[path]["helper_source"] = binding
            documents[path]["inputs"]["helper_source"] = binding
        recreation_raw = canonical(documents[recreation_root + "/terminal.json"]) + b"\n"
        self.assertGreater(len(recreation_raw), 512 * 1024)
        self.assertLess(len(recreation_raw), 2 * 1024 * 1024)
        evidence = region_qa.load_parent_evidence(
            FakeControl(documents), TOKEN, source_root=ROOT,
            mode="s46-local-import", expected_sources=sources,
        )
        self.assertEqual(evidence["fresh_state"]["helper_source_binding_sha256"],
                         hashlib.sha256(canonical(binding) + b"\n").hexdigest())

    def test_parent_fresh_state_evidence_rejects_foreign_or_incomplete_lineage(self):
        evidence = _parent_evidence()
        for mutate in (
            lambda x: x["fresh_state"].update(previous_development_attempt="f" * 32),
            lambda x: x["fresh_state"].update(recreation_attempt=DEV_ATTEMPT),
            lambda x: x["fresh_state"].update(current_development_attempt=DEV_ATTEMPT),
            lambda x: x["fresh_state"].update(archive_terminal_sha256="not-a-hash"),
            lambda x: x["fresh_state"].update(current_state_root="/tmp/fullmag-state/another-attempt"),
            lambda x: x["fresh_state"].pop("generation_sha256"),
        ):
            changed = deepcopy(evidence)
            mutate(changed)
            with self.subTest(mutate=mutate), self.assertRaises(BuildControlError):
                region_qa.validate_parent_evidence(changed, "s46-local-import")

    def test_parent_loader_rejects_wrong_state_variant_source_group_or_control_volume(self):
        cases = [
            (lambda t: t.update(state="failed-confirmed"), None, None),
            (lambda t: t["inputs"].update(study_stage_rerun="s46-independent-export"), None, None),
            (lambda t: t["inputs"].update(source_root="/different/source"), None, None),
            (lambda t: t.update(compose_project="another-project"), None, None),
            (lambda t: t.update(control_volume="another-control"), None, None),
            (lambda t: t["inputs"].update(worktree_id="another-worktree"), None, None),
            (None, lambda r: r.update(outcome="completed"), None),
            (None, lambda r: r["export"].update(script_sha256="0" * 64), None),
            (None, lambda r: r["import"].update(fidelity="not_checked"), None),
            (None, None, "s46-independent-import"),
        ]
        for terminal_mutator, result_mutator, mode in cases:
            documents, sources = _parent_documents(
                mutate_terminal=terminal_mutator, mutate_result=result_mutator,
            )
            with self.subTest(terminal=terminal_mutator, result=result_mutator, mode=mode), self.assertRaises(BuildControlError):
                region_qa.load_parent_evidence(
                    FakeControl(documents), TOKEN, source_root=ROOT,
                    mode=mode or "s46-local-import", expected_sources=sources,
                )

    def test_export_and_import_reports_require_exact_runs_edits_counts_reload_and_error_boundaries(self):
        for mode in region_qa.MODES:
            is_import = mode.endswith("-import")
            parent = _parent_evidence(mode) if is_import else None
            report = _report(mode, parent)
            parsed = region_qa.parse_result(
                _encoded(report), report["public_url"], report["probe_url"], HASHES, mode, parent,
            )
            self.assertEqual(parsed["outcome"], "completed" if is_import else "exported")
            self.assertEqual(parsed["command_count"], 2 if is_import else 1)

    def test_result_parser_rejects_parent_outcome_or_pin_drift_and_uncertain_writes(self):
        base = _report("s46-local-import", _parent_evidence())
        mutations = [
            lambda x: x.update(mode="s46-independent-import"),
            lambda x: x.update(outcome="unknown"),
            lambda x: x.update(state="failed"),
            lambda x: x.update(source_hashes_after={"runner": "0" * 64}),
            lambda x: x.update(parent_evidence={**x["parent_evidence"], "script_sha256": "0" * 64}),
            lambda x: x["reload"].update(identity_preserved=False),
            lambda x: x["errors"]["http"].append("unexpected HTTP error"),
            lambda x: x["violations"].append("unexpected write"),
            lambda x: x["parent_evidence"].update(prior_attempt="f" * 32),
            lambda x: x["import"].update(fidelity="not_checked"),
            lambda x: x["study"]["execution_binding"].update(run_id="foreign-run"),
            lambda x: x["stage_only"]["execution_binding"].update(
                requested_target={"kind": "study"}),
            lambda x: x["stage_only"].update(command_id=x["study"]["command_id"]),
            lambda x: x["stage_only"]["results"][0]["source"].update(run_id="foreign-run"),
            lambda x: x["reload"].update(run_id="run-study"),
            lambda x: x["edits"][0].update(session_scope="session=other&epoch=other&request_scope_epoch=other"),
            lambda x: x["edits"][0].update(committed_scene_sha256="not-a-digest"),
            lambda x: x["expected_empty_404"].append("/v2/sessions/current/model/scene"),
            lambda x: x["cleanup_errors"].append("context close failed"),
            lambda x: x["cleanup_cancellations"].append(
                {"method": "POST", "path": "/v2/sessions/current/model/transactions",
                 "failure": "net::ERR_ABORTED"}),
        ]
        for mutate in mutations:
            value = deepcopy(base)
            mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(BuildControlError):
                region_qa.parse_result(_encoded(value), value["public_url"], value["probe_url"], HASHES,
                                       "s46-local-import", _parent_evidence())
        for outcome in ("unknown", "not-dispatched"):
            value = deepcopy(base)
            value.update(outcome=outcome, state="failed")
            with self.subTest(outcome=outcome), self.assertRaises(BuildControlError):
                region_qa.parse_result(_encoded(value), value["public_url"], value["probe_url"], HASHES,
                                       "s46-local-import", _parent_evidence())

    def test_result_parser_rejects_wrong_stage_sets_command_counts_edits_and_extra_requests(self):
        base = _report("s46-local-export")
        mutations = [
            lambda x: x["baseline"].update(stage_ids=["relax-a", "relax-c"]),
            lambda x: x["baseline"].update(results=x["baseline"]["results"][:2]),
            lambda x: x.update(command_count=2),
            lambda x: x.update(command_attempt_count=2),
            lambda x: x["edits"][1].update(kind="enable"),
            lambda x: x["edits"][0].update(region_id="right-half"),
            lambda x: x["edits"][1].update(after_revision=99),
            lambda x: x["request_counts"].update({"POST /v2/sessions/current/simulation/commands": 99}),
            lambda x: x["request_counts"].update({"PATCH /v2/sessions/current/model/scene": 1}),
            lambda x: x["request_counts"].update({"GET /v2/sessions/current/status": 161}),
            lambda x: x["request_counts"].update({"PATCH /v2/sessions/current/visualization/state": 5}),
            lambda x: x["request_counts"].update({"POST /v2/sessions/current/visualization/client-acks": 17}),
            lambda x: x.update(grid_command_count=2),
            lambda x: x.update(failed_write_observations=[{"http_status": 409}]),
            lambda x: x.update(failed_write_observations=None),
            lambda x: x.update(failed_write_observations={}),
            lambda x: x["canvas"].update(context_lost=True),
            lambda x: x["import"].update(scene_revision=9),
            lambda x: x["baseline"]["execution_binding"].update(
                requested_target={"kind": "stage_id", "stage_id": "relax-b"}),
            lambda x: x["baseline"]["results"][0]["source"].update(run_id="foreign-run"),
            lambda x: x["baseline"]["results"][2].update(authored_stage_id="relax-a"),
        ]
        for mutate in mutations:
            value = deepcopy(base)
            mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(BuildControlError):
                region_qa.parse_result(_encoded(value), value["public_url"], value["probe_url"], HASHES,
                                       "s46-local-export")
        bounded_auxiliary = deepcopy(base)
        camera_write = {"method": "PATCH", "path": "/v2/sessions/current/visualization/state",
                        "body": {"camera": {"fov_degrees": 45, "orthographic_scale": None,
                            "position": [1, 2, 3], "projection": "perspective", "target": [0, 0, 0],
                            "up": [0, 1, 0]}}, "session_scope": SCOPE,
                        "api_instance_id": "api-instance-1", "status": 200}
        ack_write = {"method": "POST", "path": "/v2/sessions/current/visualization/client-acks",
                     "body": {"client_id": "viewport-1", "revision": 1, "status": "rendered"},
                     "session_scope": SCOPE, "api_instance_id": "api-instance-1", "status": 200}
        bounded_auxiliary["request_counts"].update({
            "PATCH /v2/sessions/current/visualization/state": 4,
            "POST /v2/sessions/current/visualization/client-acks": 16,
        })
        bounded_auxiliary["auxiliary_writes"] = [camera_write] * 4 + [ack_write] * 16
        bounded_auxiliary["cleanup_cancellations"] = [
            {"method": "GET", "path": "/v2/sessions/current/status", "failure": "net::ERR_ABORTED"},
            {"method": "HEAD", "path": "/", "failure": "net::ERR_ABORTED"},
        ]
        region_qa.parse_result(_encoded(bounded_auxiliary), bounded_auxiliary["public_url"],
                               bounded_auxiliary["probe_url"], HASHES, "s46-local-export")

    def test_independent_profile_rejects_local_assignment_receipt_and_import_parent_is_required(self):
        independent = _report("s46-independent-export")
        self.assertEqual(region_qa.parse_result(_encoded(independent), independent["public_url"],
            independent["probe_url"], HASHES, "s46-independent-export")["edits"], independent["edits"])
        independent["edits"].insert(0, _edit("region-reset", 10, region=True))
        with self.assertRaises(BuildControlError):
            region_qa.parse_result(_encoded(independent), independent["public_url"], independent["probe_url"],
                                   HASHES, "s46-independent-export")
        local_import = _report("s46-local-import", _parent_evidence())
        with self.assertRaises(BuildControlError):
            region_qa.parse_result(_encoded(local_import), local_import["public_url"], local_import["probe_url"],
                                   HASHES, "s46-local-import", None)

    def test_auxiliary_camera_and_client_ack_writes_require_exact_scoped_receipts(self):
        base = _report("s46-local-export")
        base["request_counts"].update({
            "PATCH /v2/sessions/current/visualization/state": 1,
            "POST /v2/sessions/current/visualization/client-acks": 1,
        })
        base["auxiliary_writes"] = [
            {"method": "PATCH", "path": "/v2/sessions/current/visualization/state",
             "body": {"camera": {"fov_degrees": 45, "orthographic_scale": None,
                 "position": [1, 2, 3], "projection": "perspective", "target": [0, 0, 0],
                 "up": [0, 1, 0]}}, "session_scope": SCOPE,
             "api_instance_id": "api-instance-1", "status": 200},
            {"method": "POST", "path": "/v2/sessions/current/visualization/client-acks",
             "body": {"client_id": "viewport-1", "revision": 1, "status": "rendered"},
             "session_scope": SCOPE, "api_instance_id": "api-instance-1", "status": 200},
        ]
        region_qa.parse_result(_encoded(base), base["public_url"], base["probe_url"], HASHES,
                               "s46-local-export")
        mutations = [
            lambda x: x["auxiliary_writes"][0].update(session_scope="foreign"),
            lambda x: x["auxiliary_writes"][0].update(api_instance_id="another-api"),
            lambda x: x["auxiliary_writes"][0].update(status=500),
            lambda x: x["auxiliary_writes"][0]["body"].update(extra=True),
            lambda x: x["auxiliary_writes"][1]["body"].update(status="failed"),
            lambda x: x["auxiliary_writes"][1]["body"].update(extra=True),
            lambda x: x["request_counts"].update({"POST /v2/sessions/current/visualization/client-acks": 2}),
            lambda x: x["auxiliary_writes"][0].update(path="/v2/sessions/current/model/transactions"),
        ]
        for mutate in mutations:
            value = deepcopy(base)
            mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(BuildControlError):
                region_qa.parse_result(_encoded(value), value["public_url"], value["probe_url"], HASHES,
                                       "s46-local-export")

    def test_health_read_cancellation_requires_exact_correlated_positive_probe(self):
        base = _report("s46-independent-import", _parent_evidence("s46-independent-import"))
        health_key = "GET /v2/platform/health"
        cancellation = {
            "method": "GET", "path": "/v2/platform/health",
            "failure": "net::ERR_ABORTED", "phase": "preflight",
            "api_instance_id": base["api_instance_id"],
        }
        success = {
            "method": "GET", "path": "/v2/platform/health", "status": 200,
            "api_instance_id": base["api_instance_id"],
        }
        base["request_counts"][health_key] = 2
        base["read_cancellations"] = [cancellation]
        base["successful_read_responses"] = [success]
        for phase in ("preflight", "import", "reload"):
            value = deepcopy(base)
            value["read_cancellations"][0]["phase"] = phase
            region_qa.parse_result(_encoded(value), value["public_url"], value["probe_url"],
                                   HASHES, "s46-independent-import", _parent_evidence("s46-independent-import"))

        mutations = [
            lambda x: x["read_cancellations"][0].update(path="/v2/other/health"),
            lambda x: x["read_cancellations"][0].update(method="HEAD"),
            lambda x: x["read_cancellations"][0].update(api_instance_id="foreign-api"),
            lambda x: x["read_cancellations"][0].update(phase="cleanup"),
            lambda x: x["read_cancellations"][0].update(failure="net::ERR_FAILED"),
            lambda x: x["successful_read_responses"].clear(),
            lambda x: x["successful_read_responses"][0].update(status=503),
            lambda x: x["successful_read_responses"][0].update(api_instance_id="foreign-api"),
            lambda x: x["read_cancellations"][0].pop("phase"),
            lambda x: x.pop("read_cancellations"),
            lambda x: x.pop("successful_read_responses"),
            lambda x: x["request_counts"].update({health_key: 1}),
            lambda x: x["errors"]["http"].append("GET /v2/platform/health failed"),
            lambda x: x["errors"]["page"].append("uncaught page error"),
            lambda x: x["errors"]["console"].append("unexpected console error"),
        ]
        for mutate in mutations:
            value = deepcopy(base)
            mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(BuildControlError):
                region_qa.parse_result(_encoded(value), value["public_url"], value["probe_url"],
                                       HASHES, "s46-independent-import",
                                       _parent_evidence("s46-independent-import"))

        over_cancellations = deepcopy(base)
        over_cancellations["request_counts"][health_key] = 10
        over_cancellations["read_cancellations"] *= 5
        over_cancellations["successful_read_responses"] *= 5
        with self.assertRaises(BuildControlError):
            region_qa.parse_result(_encoded(over_cancellations), over_cancellations["public_url"],
                                   over_cancellations["probe_url"], HASHES,
                                   "s46-independent-import", _parent_evidence("s46-independent-import"))

        over_successes = deepcopy(base)
        over_successes["request_counts"][health_key] = 20
        over_successes["read_cancellations"] = []
        over_successes["successful_read_responses"] *= 17
        with self.assertRaises(BuildControlError):
            region_qa.parse_result(_encoded(over_successes), over_successes["public_url"],
                                   over_successes["probe_url"], HASHES,
                                   "s46-independent-import", _parent_evidence("s46-independent-import"))


    def test_resource_cancellation_requires_later_same_scope_completed_response(self):
        report = _report("s46-local-export")
        path = "/v2/sessions/current/model/readiness"
        canceled = {"method": "GET", "path": path, "failure": "net::ERR_ABORTED",
                    "phase": "build-study", "api_instance_id": report["api_instance_id"],
                    "session_scope": SCOPE, "event_sequence": 1}
        completed = {"method": "GET", "path": path, "status": 200,
                     "api_instance_id": report["api_instance_id"],
                     "request_api_instance_id": report["api_instance_id"],
                     "session_scope": SCOPE, "event_sequence": 2}
        report.update(resource_read_cancellations=[canceled], successful_resource_read_responses=[completed],
                      loopback_proxy_failures=[])
        report["request_counts"]["GET " + path] = 2
        region_qa.parse_result(_encoded(report), report["public_url"], report["probe_url"], HASHES, "s46-local-export")
        changes = [
            lambda q: q.update(successful_resource_read_responses=[]),
            lambda q: q["successful_resource_read_responses"][0].update(event_sequence=1),
            lambda q: q["successful_resource_read_responses"][0].update(session_scope="foreign"),
            lambda q: q["successful_resource_read_responses"][0].update(api_instance_id="foreign"),
            lambda q: q["successful_resource_read_responses"][0].update(request_api_instance_id="foreign"),
            lambda q: q["successful_resource_read_responses"][0].update(path="/v2/platform/health"),
            lambda q: q["successful_resource_read_responses"][0].update(status=500),
            lambda q: q["resource_read_cancellations"][0].update(method="POST"),
            lambda q: q["resource_read_cancellations"][0].update(phase="preflight"),
            lambda q: q["resource_read_cancellations"][0].update(event_sequence=True),
            lambda q: q["request_counts"].update({"GET " + path: 1}),
            lambda q: q.update(resource_read_cancellations=[canceled] * 33),
            lambda q: q.update(loopback_proxy_failures=["QA frontend proxy timed out"]),
            lambda q: q.update(loopback_proxy_failures=None),
            lambda q: q["resource_read_cancellations"][0].update(path=[]),
            lambda q: q["resource_read_cancellations"][0].update(phase={}),
            lambda q: q.update(successful_resource_read_responses=[completed, completed]),
        ]
        for mutate in changes:
            value = deepcopy(report)
            mutate(value)
            with self.subTest(mutate=mutate), self.assertRaises(BuildControlError):
                region_qa.parse_result(_encoded(value), value["public_url"], value["probe_url"], HASHES, "s46-local-export")


if __name__ == "__main__":
    unittest.main()
