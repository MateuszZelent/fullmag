"""Interpretive regressions for managed Linux host-store readmission."""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import io
import json
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import docker_linux_host_readmission as readmission
from docker_build_control import BuildControl, ControlOutcomeUnknown


REQUEST = {
    "schema_version": readmission.OPERATOR_SCHEMA,
    "request_id": "12345678-1234-4234-8234-123456789abc",
    "source_root": "/repo",
    "compose_project": "fullmag-master",
    "development_attempt": "a" * 32,
    "compose_config_sha256": "1" * 64,
    "backend_container_id": "b" * 64,
    "frontend_container_id": "c" * 64,
    "old_image_id": "sha256:" + "d" * 64,
    "expected_certificate_sha256": "2" * 64,
    "expected_owner_sha256": "3" * 64,
    "old_host_device": 17,
    "new_host_device": 18,
    "expected_inode": 19,
    "filesystem_uuid": "12345678-1234-4234-8234-123456789abc",
    "runtime_owner_sha256": "4" * 64,
    "process_receipt_sha256": "5" * 64,
    "runtime_config_sha256": "6" * 64,
    "launch_sha256": "7" * 64,
}


def _raw(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _record(raw):
    return {"sha256": hashlib.sha256(raw).hexdigest(),
            "base64": base64.b64encode(raw).decode("ascii")}


def _foreign_alias_proof(alias, container_id):
    alias_sha = hashlib.sha256(alias.encode()).hexdigest()
    kernel = {
        "schema": "fullmag.docker-bind-overlap-proof.v1",
        "decision": "disjoint",
        "probe_schema": "fullmag.docker-bind-overlap-probe.v1",
        "candidate_alias_sha256": alias_sha,
        "reference_root_sha256": "a" * 64,
        "reference_marker_sha256": "b" * 64,
        "reference_marker_size": 10,
        "reference_marker_stat": {},
        "reference_stat": {},
        "reference_mount": {},
        "candidate_mounts": [],
        "candidate_stat": {},
        "mountinfo_sha256": "c" * 64,
    }
    return {
        "schema": "fullmag.foreign-bind-disjoint-proof.v1",
        "decision": "disjoint",
        "container_id": container_id,
        "image_id": "sha256:" + "d" * 64,
        "started_at": "2026-10-27T10:00:00Z",
        "status": "running",
        "running": True,
        "pid": 234,
        "inspection_sha256": "e" * 64,
        "candidate_alias_sha256": alias_sha,
        "reference_root_sha256": "a" * 64,
        "kernel_proof": kernel,
    }


def _daemon_state_fixture(*, frontend_state=False):
    backend_alias = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Master/backend-state"
    frontend_alias = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Master/frontend-state"
    state_source = "/srv/fullmag/storage"
    compose = {"services": {
        "backend": {
            "volumes": [{"type": "bind", "source": state_source, "target": "/state"}],
            "x-fullmag-daemon-binds": {"/state": backend_alias},
        },
        "frontend": {
            "volumes": [{"type": "volume", "source": "frontend-build",
                         "target": "/state/development"}],
            "x-fullmag-daemon-binds": {},
        },
    }}
    actual = {
        "backend": {"Mounts": [{"Type": "bind", "Source": backend_alias,
                                  "Destination": "/state"}]},
        "frontend": {"Mounts": [{"Type": "volume", "Name": "frontend-build",
                                   "Destination": "/state/development"}]},
    }
    if frontend_state:
        compose["services"]["frontend"]["volumes"].append(
            {"type": "bind", "source": state_source, "target": "/state"})
        compose["services"]["frontend"]["x-fullmag-daemon-binds"]["/state"] = frontend_alias
        actual["frontend"]["Mounts"].append(
            {"Type": "bind", "Source": frontend_alias, "Destination": "/state"})
    return compose, actual, backend_alias, frontend_alias, state_source


def _snapshot():
    certificate = b'{"host_device":17}'
    owner = b'{ "host_device" : 17 }'
    plan = {
        "schema": "fullmag.linux-native-readmission-plan.v1",
        "plan_sha256": "8" * 64,
        "state_root": "/state",
        "planned_new_evidence": {
            "certificate": _record(b'{"host_device":18}'),
            "owner_marker": _record(b'{"host_device":18}'),
        },
    }
    raw = {
        "request": _raw(REQUEST),
        "terminal": b"terminal receipt",
        "compose": b"compose record",
        "certificate": certificate,
        "owner_marker": owner,
        "sentinel": b"sentinel",
        "restart": b"restart",
        "probe": b"historical probe",
        "runtime_owner": b"runtime owner",
        "process_receipt": b"process receipt",
        "runtime_config": b"runtime config",
        "launch": b"launch record",
    }
    plan["archived_evidence"] = {name: _record(raw[name]) for name in
                                 ("certificate", "owner_marker", "sentinel", "restart", "probe")}
    return {"plan": plan, "raw": raw, "state_root": "/state",
            "pair": "old/old", "context": {"compose_project": REQUEST["compose_project"],
                        "filesystem_uuid": REQUEST["filesystem_uuid"]}}


class EngineIdentityTests(unittest.TestCase):
    def test_engine_info_id_is_opaque_while_raw_identity_remains_exact(self):
        identifiers = [
            "81a2002d-4c88-48aa-b4da-fed771788cfa",
            "a" * 64,
            "7TRN:IPZB:QYBB:VPBQ:UMPP:KARE:6ZNR:XE6T:7EWV:PKF4:ZOJD:TPYS",
        ]
        for identity in identifiers:
            with self.subTest(identity=identity), patch.object(readmission, "docker_capture", return_value=SimpleNamespace(stdout=(identity + "\n").encode())):
                self.assertEqual(readmission._engine_id(), identity)
        for raw in [b"\n", b"bad\nidentity", b"x" * 257, b"\xff"]:
            with self.subTest(raw=raw), patch.object(readmission, "docker_capture", return_value=SimpleNamespace(stdout=raw)):
                with self.assertRaises(ValueError):
                    readmission._engine_id()


class DockerTimestampTests(unittest.TestCase):
    def actual(self, started, finished):
        return {"State": {"Status": "exited", "Running": False, "Paused": False,
                          "Restarting": False, "Pid": 0, "ExitCode": 255,
                          "StartedAt": started, "FinishedAt": finished}}

    def test_rfc3339_nano_is_supported_without_changing_raw_inspection(self):
        for fraction in ["1", "12", "123", "123456", "1234567", "12345678", "123456789"]:
            for zone in ["Z", "+00:00"]:
                actual = self.actual("2020-10-26T22:31:33." + fraction + zone,
                                     "2020-10-27T06:46:17.729041395Z")
                before = _raw(actual)
                readmission._validate_stopped_state(actual)
                self.assertEqual(_raw(actual), before)

    def test_nanosecond_order_and_invalid_dates_are_fail_closed(self):
        actual = self.actual("2020-10-26T22:31:33.123456789Z", "2020-10-26T22:31:33.123456788Z")
        with self.assertRaisesRegex(ValueError, "precedes"):
            readmission._validate_stopped_state(actual)
        for timestamp in ["2020-02-30T00:00:00Z", "2020-10-26T22:31:33.1234567890Z", "2020-10-26T22:31:33", "2999-01-01T00:00:00Z"]:
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                readmission._validate_stopped_state(self.actual(timestamp, timestamp))


class FakeControl:
    def __init__(self):
        self.project = REQUEST["compose_project"]
        self.volume = "control-vol"
        self.prepared = 0
        self.writes = {}
        self.reads = {}
        self.operation_attempts = []

    def prepare(self):
        self.prepared += 1

    @contextmanager
    def operation(self, phase, inputs):
        attempt = "e" * 32 if not self.operation_attempts else "f" * 32
        root = phase + "/attempts/" + attempt
        receipt = {"schema": "fullmag.docker-build-operation.v1", "phase": phase,
                   "attempt": attempt, "compose_project": self.project,
                   "control_volume": self.volume, "inputs": inputs}
        operation = {"root": root, "receipt": receipt, "helper_container_id": "9" * 64}
        self.operation_attempts.append(operation)
        try:
            yield operation
        except BaseException:
            receipt["state"] = "failed-confirmed"
            terminal = json.dumps(receipt, sort_keys=True).encode()
            self.writes[root + "/terminal.json"] = terminal
            self.reads[root + "/terminal.json"] = terminal
            raise
        else:
            receipt["state"] = "succeeded"
            terminal = json.dumps(receipt, sort_keys=True).encode()
            self.writes[root + "/terminal.json"] = terminal
            self.reads[root + "/terminal.json"] = terminal

    def write_bytes(self, relative, payload):
        self.writes[relative] = bytes(payload)
        self.reads[relative] = bytes(payload)

    def read_bytes(self, relative, *, optional=False, **_kwargs):
        result = self.reads.get(relative)
        if result is None and not optional:
            raise FileNotFoundError(relative)
        return result


class FinishedLockHelper:
    """A helper that has exited but leaves its complete protocol in stdout."""
    def __init__(self, output):
        self.stdin = io.BytesIO()
        self.stdout = tempfile.TemporaryFile()
        self.stdout.write(output)
        self.stdout.seek(0)

    def poll(self):
        return 0

    def wait(self, timeout=None):
        return 0


class TimedOutLockHelper(FinishedLockHelper):
    def wait(self, timeout=None):
        raise readmission.subprocess.TimeoutExpired("managed-docker-probe", timeout)


@contextmanager
def _tracking_lock(flags, name):
    flags[name] = True
    try:
        yield "8" * 64
    finally:
        flags[name] = False


class DockerLinuxHostReadmissionTests(unittest.TestCase):
    def test_operator_schema_is_exact_and_strict_integer_rejects_boolean(self):
        parsed = readmission.parse_operator_bytes(_raw(REQUEST))
        self.assertEqual(parsed, REQUEST)
        with self.assertRaises(ValueError):
            readmission.parse_operator_bytes(_raw({**REQUEST, "unexpected": True}))
        with self.assertRaises(ValueError):
            readmission.parse_operator_bytes(_raw({**REQUEST, "expected_inode": True}))
        duplicate = b'{"schema":"x","schema":"y"}'
        with self.assertRaises(ValueError):
            readmission.parse_operator_bytes(duplicate)

    def test_stopped_service_requires_exact_stopped_state_and_sensible_times(self):
        actual = {
            "Id": REQUEST["backend_container_id"],
            "Image": REQUEST["old_image_id"],
            "Config": {"Image": "fullmag:dev", "Labels": {
                "com.docker.compose.project": REQUEST["compose_project"],
                "com.docker.compose.service": "backend"}},
            "State": {"Status": "exited", "Running": False, "Paused": False,
                      "Restarting": False, "Pid": 0, "ExitCode": 0,
                      "StartedAt": "2026-10-27T10:00:00Z",
                      "FinishedAt": "2026-10-27T10:05:00Z"},
        }
        readmission._validate_stopped_state(actual)
        for key, value in (("Running", True), ("Paused", True), ("Restarting", True),
                           ("Pid", True), ("Pid", 1), ("ExitCode", False)):
            changed = json.loads(json.dumps(actual))
            changed["State"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                readmission._validate_stopped_state(changed)
        changed = json.loads(json.dumps(actual))
        changed["State"]["FinishedAt"] = "0001-01-01T00:00:00Z"
        with self.assertRaises(ValueError):
            readmission._validate_stopped_state(changed)

    def test_daemon_state_aliases_accepts_frontend_without_any_state_identity(self):
        compose, actual, backend_alias, _frontend_alias, state_source = _daemon_state_fixture()
        self.assertEqual(
            readmission._daemon_state_aliases(compose, actual),
            {backend_alias, state_source},
        )

    def test_daemon_state_aliases_accepts_frontend_state_only_with_all_exact_pins(self):
        compose, actual, backend_alias, frontend_alias, state_source = _daemon_state_fixture(
            frontend_state=True)
        self.assertEqual(
            readmission._daemon_state_aliases(compose, actual),
            {backend_alias, frontend_alias, state_source},
        )

    def test_daemon_state_aliases_rejects_missing_duplicate_and_mismatched_pins(self):
        mutations = (
            ("backend missing actual", lambda c, a: a["backend"].update(Mounts=[])),
            ("backend missing declaration",
             lambda c, _a: c["services"]["backend"].update(volumes=[])),
            ("backend duplicate actual",
             lambda _c, a: a["backend"]["Mounts"].append(dict(a["backend"]["Mounts"][0]))),
            ("backend daemon pin mismatch",
             lambda c, _a: c["services"]["backend"]["x-fullmag-daemon-binds"].update(
                 {"/state": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Other/state"})),
            ("frontend actual is undeclared",
             lambda _c, a: a["frontend"]["Mounts"].append(
                 {"Type": "bind", "Source": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Other/state",
                  "Destination": "/state"})),
            ("frontend declaration has no actual mount",
             lambda c, _a: c["services"]["frontend"]["volumes"].append(
                 {"type": "bind", "source": "/srv/fullmag/storage", "target": "/state"})),
            ("frontend daemon pin has no actual mount",
             lambda c, _a: c["services"]["frontend"]["x-fullmag-daemon-binds"].update(
                 {"/state": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Other/state"})),
            ("frontend duplicate actual",
             lambda _c, a: a["frontend"]["Mounts"].append(dict(a["frontend"]["Mounts"][-1]))),
            ("frontend duplicate declaration",
             lambda c, _a: c["services"]["frontend"]["volumes"].append(
                 {"type": "bind", "source": "/srv/fullmag/storage", "target": "/state"})),
            ("frontend mismatched daemon pin",
             lambda c, _a: c["services"]["frontend"]["x-fullmag-daemon-binds"].update(
                 {"/state": "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Other/state"})),
        )
        for label, mutate in mutations:
            with self.subTest(case=label):
                compose, actual, *_pins = _daemon_state_fixture(
                    frontend_state=label.startswith("frontend duplicate")
                    or label == "frontend mismatched daemon pin")
                mutate(compose, actual)
                with self.assertRaises(ValueError):
                    readmission._daemon_state_aliases(compose, actual)

    def test_running_consumer_guard_checks_state_alias_control_and_ledger_mounts(self):
        base = {"Id": "9" * 64, "State": {"Running": True}, "Mounts": []}
        readmission._assert_no_live_consumers(
            [base], state_paths=["/storage/fullmag"], control_volume="control-vol",
            ledger_mounts={("volume", "ledger-vol")}, allowed_ids=set(),
        )
        for mount in (
            {"Type": "bind", "Source": "/storage/fullmag/runs/x", "Destination": "/other"},
            {"Type": "bind", "Source": "/storage/fullmag", "Destination": "/elsewhere"},
            {"Type": "volume", "Name": "control-vol", "Destination": "/data"},
            {"Type": "volume", "Name": "ledger-vol", "Destination": "/ledger"},
        ):
            changed = {**base, "Mounts": [mount]}
            with self.subTest(mount=mount), self.assertRaises(ValueError):
                readmission._assert_no_live_consumers(
                    [changed], state_paths=["/storage/fullmag"], control_volume="control-vol",
                    ledger_mounts={("volume", "ledger-vol")}, allowed_ids=set(),
                )
        # Guest destinations do not identify host data. The same /state path
        # is safe when its bind source is a separate host store.
        readmission._assert_no_live_consumers(
            [{**base, "Mounts": [{"Type": "bind", "Source": "/other",
                                   "Destination": "/state"}]}],
            state_paths=["/storage/fullmag"], control_volume="control-vol",
            ledger_mounts={("volume", "ledger-vol")}, allowed_ids=set(),
        )
        controlled = {**base, "Id": "8" * 64,
                      "Mounts": [{"Type": "volume", "Name": "control-vol", "Destination": "/control"}]}
        readmission._assert_no_live_consumers(
            [controlled], state_paths=["/storage/fullmag"], control_volume="control-vol",
            ledger_mounts={("volume", "ledger-vol")}, allowed_ids={"8" * 64},
        )


    def test_known_state_alias_and_its_relatives_never_bypass_raw_overlap(self):
        alias = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu2/" + "a" * 64
        for source in (alias, alias + "/runs", alias.rsplit("/", 1)[0]):
            calls = []
            def canonicalize(_item):
                calls.append("canonical")
                return {source: "/independent/store"}
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "retained Linux state"):
                readmission._assert_no_live_consumers(
                    [{"Id": "9" * 64, "Mounts": [{"Type": "bind", "Source": source,
                        "Destination": "/data", "RW": True}]}],
                    state_paths=["/storage/fullmag"], state_alias_sources=[alias],
                    control_volume="control-vol", ledger_mounts={("volume", "ledger-vol")},
                    allowed_ids=set(), canonicalize_foreign=canonicalize,
                )
            self.assertEqual(calls, [], "raw protected overlap must precede any resolver")

    def test_desktop_drive_paths_are_not_local_posix_disjoint_proof(self):
        for source in ("/run/desktop/mnt/host/c/work", "/run/desktop/mnt/host/e/storage",
                       "/host_mnt/c/work", "/mnt/host/e/storage", "/run/desktop/mnt/host",
                       "//host_mnt/c/work", "//run/desktop/mnt/host/c/work"):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, "Windows.*unresolved|unsafe"):
                readmission._assert_no_live_consumers(
                    [{"Id": "9" * 64, "Mounts": [{"Type": "bind", "Source": source,
                        "Destination": "/data", "RW": True}]}],
                    state_paths=["/storage/fullmag"], control_volume="control-vol",
                    ledger_mounts={("volume", "ledger-vol")}, allowed_ids=set(),
                )

    def test_foreign_wsl_alias_requires_readonly_canonical_mapping(self):
        alias = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Other/hash/state"
        container = {"Id": "9" * 64, "Mounts": [
            {"Type": "bind", "Source": alias, "Destination": "/state"},
        ]}
        kwargs = dict(state_paths=["/storage/fullmag"], control_volume="control-vol",
                      ledger_mounts={("volume", "ledger-vol")}, allowed_ids=set())
        with self.assertRaisesRegex(ValueError, "unresolved storage identity"):
            readmission._assert_no_live_consumers([container], **kwargs)
        readmission._assert_no_live_consumers(
            [container], **kwargs,
            canonicalize_foreign=lambda _item: {alias: "/srv/other-project/state"},
        )
        with self.assertRaisesRegex(ValueError, "retained Linux state"):
            readmission._assert_no_live_consumers(
                [container], **kwargs,
                canonicalize_foreign=lambda _item: {alias: "/storage/fullmag/other"},
            )

    def test_unknown_alias_needs_exact_typed_kernel_proof_but_canonical_overlap_wins(self):
        alias = "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Other/hash/state"
        container = {"Id": "9" * 64, "Mounts": [
            {"Type": "bind", "Source": alias, "Destination": "/data"},
        ]}
        kwargs = dict(state_paths=["/storage/fullmag"], control_volume="control-vol",
                      ledger_mounts={("volume", "ledger-vol")}, allowed_ids=set(),
                      canonicalize_foreign=lambda _item: {})
        calls = []
        proof = _foreign_alias_proof(alias, container["Id"])
        readmission._assert_no_live_consumers(
            [container], **kwargs,
            prove_foreign_disjoint=lambda item, source: calls.append((item, source)) or proof,
        )
        self.assertEqual(calls, [(container, alias)])

        bad_alias_proof = dict(proof, candidate_alias_sha256="0" * 64)
        bad_kernel = dict(proof, kernel_proof={**proof["kernel_proof"],
                                               "candidate_alias_sha256": "0" * 64})
        for bad_proof in (None, {**proof, "decision": "overlap"}, bad_alias_proof,
                          {**proof, "container_id": "8" * 64}, bad_kernel):
            with self.subTest(proof=bad_proof), self.assertRaisesRegex(ValueError, "disjoint proof"):
                readmission._assert_no_live_consumers(
                    [container], **kwargs,
                    prove_foreign_disjoint=lambda _item, _source: bad_proof,
                )
        for canonical_source in ("/storage", "/storage/fullmag", "/storage/fullmag/runs/other"):
            with self.subTest(canonical_source=canonical_source), self.assertRaisesRegex(
                    ValueError, "retained Linux state"):
                readmission._assert_no_live_consumers(
                    [container], **{**kwargs,
                        "canonicalize_foreign": lambda _item, path=canonical_source: {alias: path}},
                    prove_foreign_disjoint=lambda *_args: self.fail(
                        "canonical overlap must not fall back"),
                )

    def test_missing_engine_or_filesystem_uuid_observation_fails_closed(self):
        with patch.object(
                readmission, "docker_capture",
                return_value=SimpleNamespace(stdout=b"", stderr=b"")):
            with self.assertRaisesRegex(ValueError, "engine ID"):
                readmission._engine_id()
        with patch.object(
                readmission.subprocess, "run",
                return_value=SimpleNamespace(returncode=0, stdout=b'{"filesystems":[{}]}')):
            with self.assertRaisesRegex(ValueError, "UUID"):
                readmission._filesystem_uuid(Path("/state"))

    def test_first_execute_rejects_a_non_old_pair_before_prepare(self):
        control = FakeControl()
        observation = _snapshot()
        observation["pair"] = "new/old"
        with self.assertRaisesRegex(ValueError, "old/old"):
            readmission.run_transaction(
                control, REQUEST, observation["raw"]["request"], observation,
                execute=True, reobserve=lambda _plan, _allowed: observation,
            )
        self.assertEqual(control.prepared, 0)
        self.assertEqual(control.writes, {})


    def test_raw_runtime_records_must_match_all_operator_hash_pins(self):
        raw = b'{"retained":true}'
        digest = hashlib.sha256(raw).hexdigest()
        request = dict(REQUEST)
        for key in ("runtime_owner_sha256", "process_receipt_sha256",
                    "runtime_config_sha256", "launch_sha256"):
            request[key] = digest
        class Records:
            def __init__(self, item):
                self.item = item
            def read_bytes(self, _relative, **_kwargs):
                return self.item
        self.assertEqual(
            readmission._read_runtime_records(Records(raw), request),
            {name: raw for name in readmission._RUNTIME_RECORDS},
        )
        with self.assertRaisesRegex(ValueError, "raw record SHA"):
            readmission._read_runtime_records(Records(raw + b" "), request)

    def test_dry_run_does_not_prepare_or_write_control_or_native_evidence(self):
        control = FakeControl()
        observation = _snapshot()
        result = readmission.run_transaction(
            control, REQUEST, observation["raw"]["request"], observation,
            execute=False, reobserve=lambda _plan: self.fail("dry-run must not acquire execution locks"),
        )
        self.assertEqual(result["state"], "validated-read-only")
        self.assertEqual(control.prepared, 0)
        self.assertEqual(control.writes, {})

    def test_archives_are_complete_before_publication_and_locks_cover_revalidation_and_writes(self):
        control = FakeControl()
        observation = _snapshot()
        pair = ["old/old"]
        flags = {"owner": False, "writer": False}
        published = []
        new_raw = b'{"host_device":18}'

        def reobserve(plan, _allowed):
            self.assertTrue(flags["owner"] and flags["writer"])
            self.assertEqual(plan, observation["plan"])
            return observation

        def classify(_plan):
            self.assertTrue(flags["owner"] and flags["writer"])
            return pair[0]

        def publish(path, data):
            published.append(path.name)
            self.assertTrue(flags["owner"] and flags["writer"])
            root = control.operation_attempts[0]["root"]
            self.assertIn(root + "/prepared.json", control.writes)
            for name in ("request", "terminal", "compose", "certificate", "owner_marker",
                         "sentinel", "restart", "probe", "runtime_owner", "process_receipt",
                         "runtime_config", "launch"):
                self.assertIn(root + "/archive/" + name + ".bin", control.writes)
            if path.name == "linux-native-host.json":
                pair[0] = "new/old"
            elif path.name == ".fullmag-linux-native-owner.json":
                pair[0] = "new/new"
            self.assertEqual(data, new_raw)

        result = readmission.run_transaction(
            control, REQUEST, observation["raw"]["request"], observation,
            execute=True, reobserve=reobserve,
            owner_lock=lambda _control: _tracking_lock(flags, "owner"),
            writer_lock=lambda _state: _tracking_lock(flags, "writer"),
            classify=classify, revalidate=lambda _plan: self.assertTrue(flags["owner"] and flags["writer"]),
            publish=publish,
        )
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual([name for name, value in flags.items() if value], [])
        self.assertEqual(control.prepared, 1)
        self.assertEqual(pair[0], "new/new")
        self.assertEqual(published, ["linux-native-host.json", ".fullmag-linux-native-owner.json"])

    def test_partial_publication_can_resume_exact_manifest_but_rejects_third_bytes(self):
        control = FakeControl()
        observation = _snapshot()
        pair = ["old/old"]
        new_raw = b'{"host_device":18}'
        calls = []

        def classify(_plan):
            if pair[0] == "third":
                raise ValueError("unknown certificate/owner bytes")
            return pair[0]

        def publish(path, _data):
            calls.append(path.name)
            if path.name == "linux-native-host.json":
                pair[0] = "new/old"
                raise OSError("simulated interruption after certificate publication")
            pair[0] = "new/new"

        with self.assertRaises(OSError):
            readmission.run_transaction(
                control, REQUEST, observation["raw"]["request"], observation,
                execute=True, reobserve=lambda _plan, _allowed: observation,
                owner_lock=lambda _control: _tracking_lock({}, "owner"),
                writer_lock=lambda _state: _tracking_lock({}, "writer"),
                classify=classify, revalidate=lambda _plan: None, publish=publish,
            )
        first_root = control.operation_attempts[0]["root"]
        manifest_raw = control.writes[first_root + "/prepared.json"]
        prepared_sha = hashlib.sha256(manifest_raw).hexdigest()
        self.assertEqual(pair[0], "new/old")
        self.assertEqual(calls, ["linux-native-host.json"])

        pair[0] = "third"
        changed = {**observation, "raw": dict(observation["raw"])}
        changed["raw"]["certificate"] = b"unrecognized bytes"
        changed["pair"] = "third"
        with self.assertRaises(ValueError):
            readmission.run_transaction(
                control, REQUEST, observation["raw"]["request"], changed,
                execute=True, resume_attempt="e" * 32, prepared_sha256=prepared_sha,
                reobserve=lambda _plan, _allowed: changed,
                owner_lock=lambda _control: _tracking_lock({}, "owner"),
                writer_lock=lambda _state: _tracking_lock({}, "writer"),
                classify=classify, revalidate=lambda _plan: None, publish=publish,
            )
        self.assertEqual(control.writes[first_root + "/prepared.json"], manifest_raw)
        self.assertEqual(calls, ["linux-native-host.json"])

    def test_resume_does_not_rewrite_archived_manifest_or_native_records(self):
        control = FakeControl()
        observation = _snapshot()
        pair = ["old/old"]
        initial = b'{"host_device":18}'

        def classify(_plan):
            return pair[0]

        def publish(path, _data):
            pair[0] = "new/old" if path.name == "linux-native-host.json" else "new/new"

        def fail_after_certificate(path, data):
            publish(path, data)
            if path.name == "linux-native-host.json":
                raise OSError("partial publication")

        with self.assertRaises(OSError):
            readmission.run_transaction(
                control, REQUEST, observation["raw"]["request"], observation,
                execute=True, reobserve=lambda _plan, _allowed: observation,
                owner_lock=lambda _control: _tracking_lock({}, "owner"),
                writer_lock=lambda _state: _tracking_lock({}, "writer"),
                classify=classify, revalidate=lambda _plan: None, publish=fail_after_certificate,
            )
        first_root = control.operation_attempts[0]["root"]
        manifest_path = first_root + "/prepared.json"
        manifest_raw = control.writes[manifest_path]
        prepared_sha = hashlib.sha256(manifest_raw).hexdigest()
        calls = []

        def finish_publish(path, data):
            calls.append(path.name)
            self.assertEqual(data, initial)
            pair[0] = "new/new"

        result = readmission.run_transaction(
            control, REQUEST, observation["raw"]["request"], observation,
            execute=True, resume_attempt="e" * 32, prepared_sha256=prepared_sha,
            reobserve=lambda _plan, _allowed: observation,
            owner_lock=lambda _control: _tracking_lock({}, "owner"),
            writer_lock=lambda _state: _tracking_lock({}, "writer"),
            classify=classify, revalidate=lambda _plan: self.fail("resume partial pair needs classification only"),
            publish=finish_publish,
        )
        self.assertEqual(result["state"], "succeeded")
        self.assertEqual(calls, [".fullmag-linux-native-owner.json"])
        self.assertEqual(control.writes[manifest_path], manifest_raw)
        self.assertEqual(control.operation_attempts[1]["receipt"]["inputs"]["resume_attempt"], "e" * 32)

    def test_resume_rechecks_planned_publication_bytes_after_acquiring_lease(self):
        control = FakeControl()
        observation = _snapshot()
        pair = ["old/old"]

        def classify(_plan):
            return pair[0]

        def interrupt_after_certificate(path, _data):
            self.assertEqual(path.name, "linux-native-host.json")
            pair[0] = "new/old"
            raise OSError("simulated interruption after certificate publication")

        with self.assertRaises(OSError):
            readmission.run_transaction(
                control, REQUEST, observation["raw"]["request"], observation,
                execute=True, reobserve=lambda _plan, _allowed: observation,
                owner_lock=lambda _control: _tracking_lock({}, "owner"),
                writer_lock=lambda _state: _tracking_lock({}, "writer"),
                classify=classify, revalidate=lambda _plan: None,
                publish=interrupt_after_certificate,
            )
        root = control.operation_attempts[0]["root"]
        manifest_raw = control.writes[root + "/prepared.json"]
        prepared_sha = hashlib.sha256(manifest_raw).hexdigest()
        publish_calls = []

        @contextmanager
        def mutate_planned_file_after_resume_preflight(_control):
            # _read_resume has already read the original bytes; mutate only
            # after the new operation and lock acquisition begin.
            control.reads[root + "/planned/owner.json"] = b"third bytes"
            yield "8" * 64

        def publish(path, _data):
            publish_calls.append(path.name)

        with self.assertRaisesRegex(ValueError, "planned publication bytes changed"):
            readmission.run_transaction(
                control, REQUEST, observation["raw"]["request"], observation,
                execute=True, resume_attempt="e" * 32, prepared_sha256=prepared_sha,
                reobserve=lambda _plan, _allowed: observation,
                owner_lock=mutate_planned_file_after_resume_preflight,
                writer_lock=lambda _state: _tracking_lock({}, "writer"),
                classify=classify, revalidate=lambda _plan: None, publish=publish,
            )
        self.assertEqual(publish_calls, [])
        self.assertEqual(control.writes[root + "/prepared.json"], manifest_raw)

    def test_owner_lock_reads_buffered_release_from_helper_that_already_exited(self):
        control = SimpleNamespace(
            path=lambda _relative: "/control/runtime-control/runtime-services/OWNER.lock",
            helper_args=lambda _script, **_kwargs: ["managed-docker-probe"],
        )
        process = FinishedLockHelper(b"READY\nRELEASED\n")
        with patch.object(readmission.subprocess, "Popen", return_value=process), \
                patch.object(readmission, "_authenticate_owner_helper", return_value="8" * 64):
            with readmission._owner_lock(control) as helper_id:
                self.assertEqual(helper_id, "8" * 64)
        process.stdout.close()

    def test_owner_lock_missing_or_invalid_release_is_unknown(self):
        control = SimpleNamespace(
            path=lambda _relative: "/control/runtime-control/runtime-services/OWNER.lock",
            helper_args=lambda _script, **_kwargs: ["managed-docker-probe"],
        )
        for output in (b"READY\n", b"READY\nNOT-RELEASED\n"):
            with self.subTest(output=output):
                process = FinishedLockHelper(output)
                with patch.object(readmission.subprocess, "Popen", return_value=process), \
                        patch.object(readmission, "_authenticate_owner_helper", return_value="8" * 64):
                    with self.assertRaises(ControlOutcomeUnknown):
                        with readmission._owner_lock(control):
                            pass
                process.stdout.close()

    def test_owner_lock_wait_timeout_is_unknown_even_after_release_token(self):
        control = SimpleNamespace(
            path=lambda _relative: "/control/runtime-control/runtime-services/OWNER.lock",
            helper_args=lambda _script, **_kwargs: ["managed-docker-probe"],
        )
        process = TimedOutLockHelper(b"READY\nRELEASED\n")
        with patch.object(readmission.subprocess, "Popen", return_value=process), \
                patch.object(readmission, "_authenticate_owner_helper", return_value="8" * 64):
            with self.assertRaises(ControlOutcomeUnknown):
                with readmission._owner_lock(control):
                    pass
        process.stdout.close()

    def test_unknown_owner_release_preserves_build_control_lifecycle_fence(self):
        control = object.__new__(BuildControl)
        control.project = "fullmag-master"
        control.volume = "control-vol"
        control.identity = {"project_id": "project", "worktree_id": "master",
                            "checkout_kind": "root"}
        control.labels = {}
        control.namespace = ""
        control.namespace_registry = None
        control.namespace_registry_sha256 = None
        control._active_operation = None
        control.path = lambda relative: "/control/" + relative
        control.helper_args = lambda _script, **_kwargs: ["managed-docker-probe"]
        control.space = lambda: {"available_bytes": 10**12}
        control._pin_operation_helper = lambda _operation: "9" * 64
        written_receipts = []
        written_paths = []

        def write(relative, value):
            written_paths.append(relative)
            if relative.endswith("/receipt.json"):
                written_receipts.append(dict(value))

        control.write = write
        logger = SimpleNamespace(stdin=io.BytesIO(), stdout=None)
        owner_helper = FinishedLockHelper(b"READY\n")
        with patch.object(readmission.subprocess, "Popen", side_effect=[logger, owner_helper]), \
                patch.object(control, "_line", return_value="READY"), \
                patch.object(readmission, "_authenticate_owner_helper", return_value="8" * 64):
            with self.assertRaises(ControlOutcomeUnknown):
                with control.operation("linux-host-readmission", {}):
                    with readmission._owner_lock(control):
                        pass

        self.assertTrue(written_receipts)
        self.assertEqual(written_receipts[-1]["state"], "outcome-unknown-resources-retained")
        self.assertFalse(any(path.endswith("/terminal.json") for path in written_paths))
        owner_helper.stdout.close()


if __name__ == "__main__":
    unittest.main()
