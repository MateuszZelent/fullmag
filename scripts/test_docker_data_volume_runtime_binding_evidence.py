import copy
import hashlib
import json
import unittest

from scripts import docker_data_volume_runtime_binding_evidence as evidence
from scripts import fullmag_data_volume_runtime_binding as runtime_binding


def sha(character):
    return character * 64


def raw_record(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
    return {"sha256": hashlib.sha256(raw).hexdigest(), "value": copy.deepcopy(value)}


def reseal_record(records, path, witnesses):
    records[path] = raw_record(records[path]["value"])
    for ref in witnesses.values():
        if ref["path"] == path:
            ref["sha256"] = records[path]["sha256"]


def reseal_stop_links(records, witnesses):
    stop_sha = records[witnesses["stop"]["path"]]["sha256"]
    for role in ("recreation", "development"):
        path = witnesses[role]["path"]
        records[path]["value"]["terminal_observation"]["stop_sha256"] = stop_sha
        reseal_record(records, path, witnesses)


def reseal_snapshot(records, witnesses):
    stop_path = witnesses["stop"]["path"]
    snapshot_path = stop_path.replace("terminal.json", "idle-stop-containers.json")
    retained_path = witnesses["recreation"]["path"].replace("terminal.json", "retained-containers.json")
    records[snapshot_path] = raw_record(records[snapshot_path]["value"])
    records[retained_path] = raw_record(records[snapshot_path]["value"])
    records[stop_path]["value"]["idle_stop_containers_sha256"] = records[snapshot_path]["sha256"]
    reseal_record(records, stop_path, witnesses)
    reseal_stop_links(records, witnesses)


def reassign_development_attempt(records, witnesses, attempt):
    old_path = witnesses["development"]["path"]
    old_compose_path = old_path.replace("terminal.json", "compose.json")
    new_path = f"development/attempts/{attempt}/terminal.json"
    development = records.pop(old_path)["value"]
    compose = records.pop(old_compose_path)
    development["attempt"] = attempt
    records[new_path] = raw_record(development)
    records[new_path.replace("terminal.json", "compose.json")] = compose
    witnesses["development"] = {"path": new_path, "sha256": records[new_path]["sha256"]}


def fixture():
    project = "fullmag-worktree-fixture"
    control = "fullmag-build-control-fixture"
    source = "/srv/fullmag/source"
    state_root = "/srv/fullmag/storage/runtimes/fixture/state"
    old_attempt = "1" * 32
    old_pins = {
        "attempt": old_attempt,
        "config_sha256": sha("a"),
        "state_root": state_root,
        "backend": sha("b"),
        "frontend": sha("c"),
        "image_id": "sha256:" + "d" * 64,
        "runtime_witness_path": f"development/attempts/{old_attempt}/terminal.json",
        "runtime_witness_sha256": sha("e"),
    }
    plan = {
        "schema": "fullmag.data-volume-plan.v1",
        "volume_id": "f" * 32,
        "project_id": "fullmag-fixture",
        "worktree_id": "worktree-fixture",
        "compose_project": project,
        "source_root": source,
        "storage_root": "/srv/fullmag/storage",
        "mount_root": "/mnt/fullmag-data-volume",
        "runtime_root": "/srv/fullmag/storage/runtimes/fixture",
        "runtime_pins": old_pins,
        "observation": {
            "datasets": {
                "state": {
                    "canonical_root": state_root,
                    "device": 259,
                    "inode": 101,
                },
                "user_data": {
                    "canonical_root": "/srv/fullmag/storage/user-data/fixture",
                    "device": 259,
                    "inode": 202,
                },
            },
            "engine_id": "fixture-engine",
            "services": {
                "backend": {"nano_cpus": 40_000_000_000, "memory_bytes": 34_359_738_368},
                "frontend": {"nano_cpus": 4_000_000_000, "memory_bytes": 17_179_869_184},
            },
        },
    }

    stop_attempt = "7" * 32
    recreation_attempt = "8" * 32
    development_attempt = "9" * 32
    predecessor_attempt = "0" * 32
    predecessor_config = sha("1")
    predecessor_image = "sha256:" + "2" * 64
    stopped_ids = {"backend": sha("3"), "frontend": sha("4")}
    current_ids = {"backend": sha("5"), "frontend": sha("6")}
    current_image = "sha256:" + "7" * 64

    snapshot = {}
    for role in ("backend", "frontend"):
        snapshot[role] = {
            "Id": stopped_ids[role],
            "Image": predecessor_image,
            "State": {"Status": "exited", "Running": False, "ExitCode": 0, "Pid": 0},
            "Config": {
                "Labels": {
                    "com.docker.compose.project": project,
                    "com.docker.compose.service": role,
                    "org.fullmag.source.worktree-id": plan["worktree_id"],
                }
            },
        }
    snapshot_record = raw_record(snapshot)
    stop_path = f"iteration/attempts/{stop_attempt}/terminal.json"
    recreation_path = f"recreate-services/attempts/{recreation_attempt}/terminal.json"
    development_path = f"development/attempts/{development_attempt}/terminal.json"
    stop = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "iteration",
        "state": "succeeded",
        "attempt": stop_attempt,
        "compose_project": project,
        "control_volume": control,
        "inputs": {
            "attempt": predecessor_attempt,
            "config_sha256": predecessor_config,
            "source_root": source,
            "image_id": predecessor_image,
        },
        "config_sha256": predecessor_config,
        "backend_container": stopped_ids["backend"],
        "frontend_container": stopped_ids["frontend"],
        "idle_backend_stopped": True,
        "idle_stop_containers_sha256": snapshot_record["sha256"],
        "state_root": state_root,
        "started_at": 100.0,
        "finished_at": 101.0,
    }
    stop_record = raw_record(stop)
    stop_observation = {
        "schema": "fullmag.terminal-observation-context.v1",
        "stop_attempt": stop_attempt,
        "stop_sha256": stop_record["sha256"],
        "request_sha256": sha("8"),
        "proof_sha256": sha("9"),
    }
    recreation = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "recreate-services",
        "state": "succeeded",
        "attempt": recreation_attempt,
        "compose_project": project,
        "control_volume": control,
        "inputs": {"attempt": predecessor_attempt, "config_sha256": predecessor_config},
        "fresh_state": False,
        "previous_state_root": state_root,
        "removed_containers": [stopped_ids["backend"], stopped_ids["frontend"]],
        "terminal_observation": copy.deepcopy(stop_observation),
        "started_at": 102.0,
        "finished_at": 103.0,
    }
    recreation_record = raw_record(recreation)
    compose = {
        "name": project,
        "services": {"backend": {"image": current_image}, "frontend": {"image": current_image}},
    }
    compose_sha = hashlib.sha256(
        json.dumps(compose, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    development = {
        "schema": "fullmag.docker-build-operation.v1",
        "phase": "development",
        "state": "succeeded",
        "attempt": development_attempt,
        "compose_project": project,
        "control_volume": control,
        "inputs": {
            "source_root": source,
            "source_worktree_id": plan["worktree_id"],
            "source_project_id": plan["project_id"],
            "image_id": current_image,
        },
        "config_sha256": compose_sha,
        "state_root": state_root,
        "backend_container": current_ids["backend"],
        "frontend_container": current_ids["frontend"],
        "source_commit": "a" * 40,
        "source_snapshot_sha256": sha("b"),
        "backend_build_receipt_sha256": sha("c"),
        "terminal_observation": copy.deepcopy(stop_observation),
        "started_at": 104.0,
        "finished_at": 105.0,
    }
    development_record = raw_record(development)
    compose_record = raw_record(compose)
    records = {
        stop_path: stop_record,
        recreation_path: recreation_record,
        development_path: development_record,
        stop_path.replace("terminal.json", "idle-stop-containers.json"): snapshot_record,
        recreation_path.replace("terminal.json", "retained-containers.json"): raw_record(snapshot),
        development_path.replace("terminal.json", "compose.json"): compose_record,
    }
    witnesses = {
        "stop": {"path": stop_path, "sha256": stop_record["sha256"]},
        "recreation": {"path": recreation_path, "sha256": recreation_record["sha256"]},
        "development": {"path": development_path, "sha256": development_record["sha256"]},
    }
    return plan, project, control, source, witnesses, records, stopped_ids


class RuntimeBindingEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.plan, self.project, self.control, self.source, self.witnesses, self.records, self.stopped_ids = fixture()

    def qualify(self, plan=None, witnesses=None, records=None):
        return evidence.qualify_witnesses(
            self.plan if plan is None else plan,
            compose_project=self.project,
            control_volume=self.control,
            source_root=self.source,
            witnesses=self.witnesses if witnesses is None else witnesses,
            records=self.records if records is None else records,
        )

    def test_accepts_latest_stop_whose_parent_is_not_the_original_plan_runtime(self):
        original_plan = copy.deepcopy(self.plan)
        original_witnesses = copy.deepcopy(self.witnesses)
        original_records = copy.deepcopy(self.records)

        result = self.qualify()

        dev = self.records[self.witnesses["development"]["path"]]["value"]
        self.assertEqual(result["runtime_pins"]["attempt"], dev["attempt"])
        self.assertNotEqual(result["runtime_pins"]["attempt"], self.plan["runtime_pins"]["attempt"])
        self.assertEqual(result["runtime_pins"]["state_root"], self.plan["runtime_pins"]["state_root"])
        self.assertEqual(result["runtime_pins"]["backend"], dev["backend_container"])
        self.assertEqual(result["runtime_pins"]["frontend"], dev["frontend_container"])
        self.assertEqual(result["runtime_source"]["source_commit"], dev["source_commit"])
        self.assertEqual(result["compose"]["name"], self.project)
        self.assertEqual(result["stopped_pair"], self.stopped_ids)
        self.assertEqual(set(result), {"runtime_pins", "runtime_source", "compose", "stopped_pair"})
        self.assertEqual(runtime_binding.runtime_pins(result["runtime_pins"]), result["runtime_pins"])
        self.assertEqual(self.plan, original_plan)
        self.assertEqual(self.witnesses, original_witnesses)
        self.assertEqual(self.records, original_records)

    def test_accepts_model_supported_original_iteration_and_resume_witness_paths(self):
        for phase, witness_attempt in (
            ("iteration", "4c05652c62964b1c93bb80298660a663"),
            ("resume", "a" * 32),
        ):
            plan = copy.deepcopy(self.plan)
            plan["runtime_pins"]["runtime_witness_path"] = (
                f"{phase}/attempts/{witness_attempt}/terminal.json"
            )
            # Iteration witnesses may be a later attempt than the base plan attempt.
            self.assertNotEqual(witness_attempt, plan["runtime_pins"]["attempt"])
            with self.subTest(phase=phase):
                self.assertEqual(self.qualify(plan=plan)["runtime_pins"]["state_root"],
                                 plan["runtime_pins"]["state_root"])

    def test_rejects_runtime_witness_paths_outside_model_contract(self):
        for path in (
            "restart/attempts/" + "a" * 32 + "/terminal.json",
            "iteration/attempts/../terminal.json",
            "/iteration/attempts/" + "a" * 32 + "/terminal.json",
        ):
            plan = copy.deepcopy(self.plan)
            plan["runtime_pins"]["runtime_witness_path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.qualify(plan=plan)

    def test_rejects_common_stop_drift_and_invalid_request_or_proof_hash(self):
        mutations = []

        records = copy.deepcopy(self.records)
        records[self.witnesses["development"]["path"]]["value"]["terminal_observation"]["stop_attempt"] = "a" * 32
        changed_witnesses = copy.deepcopy(self.witnesses)
        reseal_record(records, changed_witnesses["development"]["path"], changed_witnesses)
        mutations.append(("development common stop", changed_witnesses, records))

        records = copy.deepcopy(self.records)
        records[self.witnesses["recreation"]["path"]]["value"]["terminal_observation"]["request_sha256"] = "invalid"
        changed_witnesses = copy.deepcopy(self.witnesses)
        reseal_record(records, changed_witnesses["recreation"]["path"], changed_witnesses)
        mutations.append(("invalid request digest", changed_witnesses, records))

        records = copy.deepcopy(self.records)
        records[self.witnesses["development"]["path"]]["value"]["terminal_observation"]["proof_sha256"] = sha("0")
        changed_witnesses = copy.deepcopy(self.witnesses)
        reseal_record(records, changed_witnesses["development"]["path"], changed_witnesses)
        mutations.append(("observation disagreement", changed_witnesses, records))

        for label, witnesses, records in mutations:
            with self.subTest(label=label), self.assertRaises(ValueError):
                self.qualify(witnesses=witnesses, records=records)

    def test_rejects_terminal_and_snapshot_digest_drift(self):
        witnesses = copy.deepcopy(self.witnesses)
        witnesses["stop"]["sha256"] = sha("0")
        with self.assertRaises(ValueError):
            self.qualify(witnesses=witnesses)

        records = copy.deepcopy(self.records)
        records[self.witnesses["stop"]["path"]]["sha256"] = sha("0")
        with self.assertRaises(ValueError):
            self.qualify(records=records)

        records = copy.deepcopy(self.records)
        snapshot_path = self.witnesses["stop"]["path"].replace("terminal.json", "idle-stop-containers.json")
        records[snapshot_path]["sha256"] = sha("0")
        with self.assertRaises(ValueError):
            self.qualify(records=records)

        records = copy.deepcopy(self.records)
        retained_path = self.witnesses["recreation"]["path"].replace("terminal.json", "retained-containers.json")
        records[retained_path]["value"]["backend"]["Id"] = sha("a")
        records[retained_path] = raw_record(records[retained_path]["value"])
        with self.assertRaises(ValueError):
            self.qualify(records=records)

    def test_rejects_foreign_image_source_or_service_identity(self):
        for label, path, field, value in (
            ("predecessor image", self.witnesses["stop"]["path"], "image_id", "sha256:" + "f" * 64),
            ("predecessor source", self.witnesses["stop"]["path"], "source_root", "/srv/foreign/source"),
        ):
            records = copy.deepcopy(self.records)
            records[path]["value"]["inputs"][field] = value
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_record(records, path, changed_witnesses)
            if path == changed_witnesses["stop"]["path"]:
                reseal_stop_links(records, changed_witnesses)
            with self.subTest(label=label), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)

        records = copy.deepcopy(self.records)
        snapshot_path = self.witnesses["stop"]["path"].replace("terminal.json", "idle-stop-containers.json")
        records[snapshot_path]["value"]["backend"]["Image"] = "sha256:" + "f" * 64
        changed_witnesses = copy.deepcopy(self.witnesses)
        reseal_snapshot(records, changed_witnesses)
        with self.assertRaises(ValueError):
            self.qualify(witnesses=changed_witnesses, records=records)

    def test_rejects_changed_original_or_recreated_state_root_and_fresh_state(self):
        for phase, field in (("recreation", "previous_state_root"), ("development", "state_root")):
            records = copy.deepcopy(self.records)
            records[self.witnesses[phase]["path"]]["value"][field] = "/srv/foreign/state"
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_record(records, changed_witnesses[phase]["path"], changed_witnesses)
            with self.subTest(phase=phase), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)

        records = copy.deepcopy(self.records)
        records[self.witnesses["recreation"]["path"]]["value"]["fresh_state"] = True
        changed_witnesses = copy.deepcopy(self.witnesses)
        reseal_record(records, changed_witnesses["recreation"]["path"], changed_witnesses)
        with self.assertRaises(ValueError):
            self.qualify(witnesses=changed_witnesses, records=records)

        changed_plan = copy.deepcopy(self.plan)
        changed_plan["runtime_pins"]["state_root"] = "/srv/foreign/state"
        with self.assertRaises(ValueError):
            self.qualify(plan=changed_plan)

    def test_rejects_wrong_removed_pair_or_stopped_process_not_cleanly_exited(self):
        records = copy.deepcopy(self.records)
        records[self.witnesses["recreation"]["path"]]["value"]["removed_containers"][0] = sha("a")
        changed_witnesses = copy.deepcopy(self.witnesses)
        reseal_record(records, changed_witnesses["recreation"]["path"], changed_witnesses)
        with self.assertRaises(ValueError):
            self.qualify(witnesses=changed_witnesses, records=records)

        snapshot_path = self.witnesses["stop"]["path"].replace("terminal.json", "idle-stop-containers.json")
        for key, value in (("Running", True), ("ExitCode", 1), ("Pid", 5), ("Status", "running")):
            records = copy.deepcopy(self.records)
            records[snapshot_path]["value"]["backend"]["State"][key] = value
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_snapshot(records, changed_witnesses)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)

    def test_rejects_current_development_reusing_a_stopped_container_id(self):
        for label, stopped_role in (("same role", "backend"), ("cross role", "frontend")):
            records = copy.deepcopy(self.records)
            records[self.witnesses["development"]["path"]]["value"]["backend_container"] = self.stopped_ids[stopped_role]
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_record(records, changed_witnesses["development"]["path"], changed_witnesses)
            with self.subTest(label=label), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)

    def test_rejects_development_attempt_reusing_its_stopped_parent(self):
        records = copy.deepcopy(self.records)
        witnesses = copy.deepcopy(self.witnesses)
        parent_attempt = records[witnesses["stop"]["path"]]["value"]["inputs"]["attempt"]
        reassign_development_attempt(records, witnesses, parent_attempt)
        with self.assertRaises(ValueError):
            self.qualify(witnesses=witnesses, records=records)

    def test_rejects_nonfinite_boolean_and_out_of_order_times(self):
        mutations = (("boolean", True), ("infinite", float("inf")), ("nan", float("nan")))
        for label, value in mutations:
            records = copy.deepcopy(self.records)
            records[self.witnesses["recreation"]["path"]]["value"]["started_at"] = value
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_record(records, changed_witnesses["recreation"]["path"], changed_witnesses)
            with self.subTest(label=label), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)

        records = copy.deepcopy(self.records)
        records[self.witnesses["recreation"]["path"]]["value"]["started_at"] = 99.0
        changed_witnesses = copy.deepcopy(self.witnesses)
        reseal_record(records, changed_witnesses["recreation"]["path"], changed_witnesses)
        with self.assertRaises(ValueError):
            self.qualify(witnesses=changed_witnesses, records=records)

    def test_rejects_wrong_scope_phase_terminal_state_or_witness_path(self):
        for label, phase, field, value in (
            ("foreign project", "development", "compose_project", "other"),
            ("foreign volume", "recreation", "control_volume", "other"),
            ("wrong phase", "stop", "phase", "resume"),
            ("not terminal success", "development", "state", "failed-confirmed"),
        ):
            records = copy.deepcopy(self.records)
            records[self.witnesses[phase]["path"]]["value"][field] = value
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_record(records, changed_witnesses[phase]["path"], changed_witnesses)
            with self.subTest(label=label), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)

        for field, value in (("attempt", "a" * 32), ("config_sha256", sha("0"))):
            records = copy.deepcopy(self.records)
            records[self.witnesses["recreation"]["path"]]["value"]["inputs"][field] = value
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_record(records, changed_witnesses["recreation"]["path"], changed_witnesses)
            with self.subTest(predecessor_field=field), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)

        witnesses = copy.deepcopy(self.witnesses)
        witnesses["stop"]["path"] = "iteration/attempts/../../terminal.json"
        with self.assertRaises(ValueError):
            self.qualify(witnesses=witnesses)

        records = copy.deepcopy(self.records)
        records["development/attempts/" + "a" * 32 + "/terminal.json"] = raw_record({})
        with self.assertRaises(ValueError):
            self.qualify(records=records)

        records = copy.deepcopy(self.records)
        del records[self.witnesses["development"]["path"].replace("terminal.json", "compose.json")]
        with self.assertRaises(ValueError):
            self.qualify(records=records)

    def test_rejects_development_compose_cas_and_source_digest_drift(self):
        compose_path = self.witnesses["development"]["path"].replace("terminal.json", "compose.json")
        records = copy.deepcopy(self.records)
        records[compose_path]["value"]["name"] = "foreign-project"
        records[compose_path] = raw_record(records[compose_path]["value"])
        with self.assertRaises(ValueError):
            self.qualify(records=records)

        for key, value in (("source_commit", "not-a-commit"), ("source_snapshot_sha256", "bad"),
                           ("backend_build_receipt_sha256", "bad")):
            records = copy.deepcopy(self.records)
            records[self.witnesses["development"]["path"]]["value"][key] = value
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_record(records, changed_witnesses["development"]["path"], changed_witnesses)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)

        for key, value in (("source_root", "/srv/foreign/source"),
                           ("source_worktree_id", "other-worktree"),
                           ("image_id", "sha256:bad")):
            records = copy.deepcopy(self.records)
            records[self.witnesses["development"]["path"]]["value"]["inputs"][key] = value
            changed_witnesses = copy.deepcopy(self.witnesses)
            reseal_record(records, changed_witnesses["development"]["path"], changed_witnesses)
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.qualify(witnesses=changed_witnesses, records=records)


if __name__ == "__main__":
    unittest.main()
