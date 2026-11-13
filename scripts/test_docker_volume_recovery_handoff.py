"""Metadata-only regressions for retained native recovery handoff."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_dev_up
import docker_volume_dev as dev
from docker_build_control import BuildControlError, canonical


PARENT = "a" * 32
CHILD = "b" * 32
BACKEND = "c" * 64
FRONTEND = "d" * 64
CHILD_FRONTEND = "e" * 64
IMAGE = "sha256:" + "f" * 64
AUTH_ENV = "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION"
AUTH_SHA_ENV = "FULLMAG_CONTAINER_RECOVERY_AUTHORIZATION_SHA256"
AUTH_SHA = "1" * 64
REQUEST_SHA = "2" * 64
CONTROL_VOLUME = "fullmag-build-control-own-group"


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class MemoryControl:
    project = "fullmag-own-group"
    volume = CONTROL_VOLUME
    namespace = ""

    def __init__(self):
        self.records: dict[str, bytes] = {}
        self.events: list[str] = []

    def put(self, relative: str, value: dict) -> bytes:
        raw = canonical(value) + b"\n"
        self.records[relative] = raw
        return raw

    def read_bytes(self, relative: str, *, optional=False, maximum=None):
        raw = self.records.get(relative)
        if raw is None and not optional:
            raise BuildControlError("missing fixture record: " + relative)
        return raw

    def read(self, relative: str, *, optional=False):
        raw = self.read_bytes(relative, optional=optional)
        return None if raw is None else json.loads(raw)

    def operation(self, *args, **kwargs):
        self.events.append("operation")
        raise AssertionError("invalid preflight reached operation")


def fixture():
    control = MemoryControl()
    source = "/repo/worktrees/own"
    state_root = "/storage/runtimes/own/session"
    started = "2026-11-13T00:48:26.626490875Z"
    volumes = {"build": CONTROL_VOLUME, "control": CONTROL_VOLUME,
               "package": "fullmag-shared-packages-own"}
    auth_path = ("/opt/fullmag/control/runtime-control/runtime-services/"
                 "container-recovery/" + REQUEST_SHA + "/authorization.json")
    parent_metadata = {
        "schema": "fullmag.container-recovery.v1",
        "request_id": "request-1",
        "request_sha256": REQUEST_SHA,
        "attestation_sha256": "3" * 64,
        "manifest_sha256": "4" * 64,
        "authorization_sha256": AUTH_SHA,
        "stop_journal_sha256": "5" * 64,
        "removed_container_ids": ["6" * 64, "7" * 64],
    }
    parent_backend = {
        "image": IMAGE,
        "environment": {
            AUTH_ENV: auth_path,
            AUTH_SHA_ENV: AUTH_SHA,
            "FULLMAG_SOURCE_ROOT": source,
        },
        "volumes": [{"type": "volume", "source": "build-control",
                     "target": "/opt/fullmag/control", "read_only": True}],
    }
    parent_doc = {
        "name": control.project,
        "services": {
            "backend": copy.deepcopy(parent_backend),
            "frontend": {"image": IMAGE, "environment": {"FULLMAG_FRONTEND_HOST_PORT": "3243"}},
        },
        "volumes": {"build-control": {"name": CONTROL_VOLUME, "external": True}},
    }
    parent_config = sha(canonical(parent_doc))
    parent = {
        "schema": "fullmag.docker-build-operation.v1", "phase": "development",
        "state": "failed-confirmed", "error": "DEV service exited before readiness: frontend",
        "attempt": PARENT, "config_sha256": parent_config,
        "compose_project": control.project, "control_volume": CONTROL_VOLUME,
        "state_root": state_root, "backend_container": BACKEND,
        "backend_started_at": started, "backend_volumes": volumes,
        "inputs": {"source_root": source, "image_id": IMAGE},
        "container_recovery": parent_metadata,
        "container_recovery_environment": [AUTH_ENV, AUTH_SHA_ENV],
    }
    parent_raw = control.put("development/attempts/" + PARENT + "/terminal.json", parent)
    control.put("development/attempts/" + PARENT + "/compose.json", parent_doc)

    child_doc = copy.deepcopy(parent_doc)
    child_doc["services"]["frontend"]["environment"]["FULLMAG_FRONTEND_HOST_PORT"] = "3244"
    child_config = sha(canonical(child_doc))
    seed_marker = {
        "schema": "fullmag.docker-frontend-failed-seed-recovery.v1",
        "failed_attempt": PARENT, "failed_config_sha256": parent_config,
        "source_pins": {"controller_commit": "8" * 40},
        "prior_terminal_sha256": sha(parent_raw),
        "prior_input_manifest_sha256": "9" * 64,
    }
    child = {
        "schema": "fullmag.docker-build-operation.v1", "phase": "development",
        "state": "succeeded", "attempt": CHILD, "config_sha256": child_config,
        "compose_project": control.project, "control_volume": CONTROL_VOLUME,
        "state_root": state_root, "backend_container": BACKEND,
        "backend_started_at": started, "backend_volumes": volumes,
        "previous_development_attempt": PARENT,
        "previous_config_sha256": parent_config,
        "inputs": {
            "source_root": source, "image_id": IMAGE,
            "frontend_refresh_from_attempt": PARENT,
            "frontend_refresh_from_config_sha256": parent_config,
            "failed_seed_new_generation": seed_marker,
            # This abbreviated original request is deliberately not the runtime capability.
            "container_recovery": {"authorization_sha256": "a" * 64, "old_container_ids": ["x", "y"]},
        },
    }
    child_raw = control.put("development/attempts/" + CHILD + "/terminal.json", child)
    control.put("development/attempts/" + CHILD + "/compose.json", child_doc)
    control.put("development/current.json", child)
    actual = {
        "backend": {"Id": BACKEND, "Image": IMAGE,
                    "State": {"Running": False, "Status": "exited", "Pid": 0,
                              "ExitCode": 0, "StartedAt": started},
                    "Config": {"Env": [AUTH_ENV + "=" + auth_path, AUTH_SHA_ENV + "=" + AUTH_SHA]}},
        "frontend": {"Id": CHILD_FRONTEND, "Image": IMAGE,
                     "State": {"Running": False, "Status": "exited", "Pid": 0}},
    }
    return control, parent, parent_doc, child, child_doc, actual, parent_metadata


class RetainedRecoveryLineageTests(unittest.TestCase):
    def setUp(self):
        from docker_volume_stop_unadmitted import _control_bytes
        self.control_bytes_patch = patch(
            "docker_volume_stop_unadmitted._control_bytes",
            side_effect=lambda control, relative, *, optional=False, maximum=None:
                control.read_bytes(relative, optional=optional, maximum=maximum),
        )
        self.control_bytes_patch.start()
        self.addCleanup(self.control_bytes_patch.stop)

    def _read_canonical(self, control, relative, label):
        raw = control.read_bytes(relative)
        value = json.loads(raw)
        if canonical(value) + b"\n" != raw:
            raise BuildControlError(label + " is not canonical")
        return raw, dict(value)

    def test_missing_capability_pair_resolves_only_from_exact_seed_refresh_parent_without_mutation(self):
        control, parent, parent_doc, child, child_doc, actual, metadata = fixture()
        before_parent = copy.deepcopy(parent)
        before_child = copy.deepcopy(child)
        before_records = dict(control.records)

        with patch.object(dev, "_read_canonical_control_record", side_effect=self._read_canonical), \
             patch.object(dev, "_retained_recovery_context",
                          return_value={"recovery_environment": {
                                            key: value for key, value in parent_doc["services"]["backend"]["environment"].items()
                                            if key.startswith("FULLMAG_CONTAINER_RECOVERY_")},
                                        "recovery_metadata": metadata}) as validator:
            handoff = dev._frontend_refresh_recovery_handoff(
                control, child, child_doc, actual, backend_id=BACKEND)

        passed_previous = validator.call_args.args[1]
        self.assertEqual(passed_previous["container_recovery"], metadata)
        self.assertEqual(passed_previous["container_recovery_environment"], [AUTH_ENV, AUTH_SHA_ENV])
        self.assertEqual(parent, before_parent)
        self.assertEqual(child, before_child)
        self.assertEqual(control.records, before_records)
        self.assertEqual(handoff["receipt"]["container_recovery"], metadata)
        self.assertEqual(handoff["receipt"]["container_recovery_environment"], [AUTH_ENV, AUTH_SHA_ENV])
        self.assertNotEqual(child["inputs"]["container_recovery"]["authorization_sha256"],
                            handoff["receipt"]["container_recovery"]["authorization_sha256"])

    def test_generic_previous_links_without_frontend_markers_do_not_trigger_parent_repair(self):
        control, _, _, child, child_doc, actual, _ = fixture()
        ordinary = copy.deepcopy(child)
        ordinary["inputs"].pop("frontend_refresh_from_attempt")
        ordinary["inputs"].pop("frontend_refresh_from_config_sha256")
        ordinary["inputs"].pop("failed_seed_new_generation")
        ordinary_doc = copy.deepcopy(child_doc)
        environment = ordinary_doc["services"]["backend"]["environment"]
        environment.pop(AUTH_ENV)
        environment.pop(AUTH_SHA_ENV)
        before_records = dict(control.records)

        with (
            patch.object(dev, "_read_canonical_control_record", side_effect=self._read_canonical),
            patch.object(dev, "_retained_recovery_context", return_value={}) as validator,
        ):
            result = dev._frontend_refresh_recovery_handoff(
                control, ordinary, ordinary_doc, actual, backend_id=BACKEND)

        validator.assert_called_once()
        self.assertEqual(validator.call_args.args[1], ordinary)
        self.assertEqual(result, {"receipt": {}, "inputs": {}})
        self.assertEqual(control.records, before_records)

    def test_explicit_refresh_cannot_drop_parent_capability_environment(self):
        control, _, _, child, child_doc, _, _ = fixture()
        changed_doc = copy.deepcopy(child_doc)
        environment = changed_doc["services"]["backend"]["environment"]
        environment.pop(AUTH_ENV)
        environment.pop(AUTH_SHA_ENV)
        changed = copy.deepcopy(child)
        changed["config_sha256"] = sha(canonical(changed_doc))
        control.put("development/attempts/" + CHILD + "/terminal.json", changed)
        control.put("development/attempts/" + CHILD + "/compose.json", changed_doc)
        control.put("development/current.json", changed)

        with (
            patch.object(dev, "_read_canonical_control_record", side_effect=self._read_canonical),
            patch.object(dev, "_retained_recovery_context") as validator,
        ):
            with self.assertRaises(BuildControlError):
                dev._frontend_refresh_recovery_handoff(
                    control, changed, changed_doc, {}, backend_id=BACKEND)
        validator.assert_not_called()

    def test_partial_or_present_malformed_current_pair_never_falls_back_to_parent(self):
        control, _, _, child, child_doc, actual, _ = fixture()
        variants = [
            {"container_recovery": {"broken": True}},
            {"container_recovery_environment": [AUTH_ENV]},
            {"container_recovery": {"broken": True}, "container_recovery_environment": [AUTH_ENV, AUTH_SHA_ENV]},
        ]
        for fields in variants:
            current = {**copy.deepcopy(child), **copy.deepcopy(fields)}
            with self.subTest(fields=sorted(fields)), \
                 patch.object(dev, "_read_canonical_control_record", side_effect=self._read_canonical), \
                 patch.object(dev, "_retained_recovery_context",
                              side_effect=BuildControlError("existing capability validator refused")) as validator:
                with self.assertRaises(BuildControlError):
                    dev._frontend_refresh_recovery_handoff(
                        control, current, child_doc, actual, backend_id=BACKEND)
                if len(fields) == 1:
                    self.assertTrue(validator.called)
                    passed_previous = validator.call_args.args[1]
                    self.assertEqual(passed_previous, current)
                else:
                    validator.assert_not_called()

    def test_present_null_or_malformed_pair_is_not_treated_as_no_capability(self):
        control, _, _, _, child_doc, _, _ = fixture()
        variants = [
            {"container_recovery": None, "container_recovery_environment": []},
            {"container_recovery": {}, "container_recovery_environment": []},
        ]
        for fields in variants:
            with self.subTest(fields=fields), self.assertRaises(BuildControlError):
                dev._retained_container_recovery_capability(
                    control, fields, child_doc, fresh_state=False)

    def test_foreign_parent_changed_bindings_or_seed_terminal_hash_refuse(self):
        control, _, _, child, child_doc, _, _ = fixture()
        mutations = [
            ("parent-id", lambda c: c.update(previous_development_attempt="z" * 32)),
            ("refresh-parent", lambda c: c["inputs"].update(frontend_refresh_from_attempt="z" * 32)),
            ("config", lambda c: c["inputs"].update(frontend_refresh_from_config_sha256="0" * 64)),
            ("source", lambda c: c["inputs"].update(source_root="/other")),
            ("state-root", lambda c: c.update(state_root="/other")),
            ("backend-id", lambda c: c.update(backend_container="0" * 64)),
            ("started-at", lambda c: c.update(backend_started_at="2026-11-12T00:00:00Z")),
            ("volumes", lambda c: c.update(backend_volumes={"control": "other"})),
            ("seed-terminal", lambda c: c["inputs"]["failed_seed_new_generation"].update(prior_terminal_sha256="0" * 64)),
        ]
        for label, mutate in mutations:
            current = copy.deepcopy(child)
            mutate(current)
            with self.subTest(label=label), \
                 patch.object(dev, "_read_canonical_control_record", side_effect=self._read_canonical), \
                 patch.object(dev, "_retained_recovery_context") as validator:
                with self.assertRaises(BuildControlError):
                    dev._frontend_refresh_recovery_handoff(
                        control, current, child_doc, {}, backend_id=BACKEND)
                validator.assert_not_called()

        changed_doc = copy.deepcopy(child_doc)
        changed_doc["services"]["backend"]["environment"]["FULLMAG_SOURCE_ROOT"] = "/other"
        with patch.object(dev, "_read_canonical_control_record", side_effect=self._read_canonical), \
             patch.object(dev, "_retained_recovery_context") as validator:
            with self.assertRaises(BuildControlError):
                dev._frontend_refresh_recovery_handoff(
                    control, child, changed_doc, {}, backend_id=BACKEND)
            validator.assert_not_called()

    def test_bad_parent_terminal_or_parent_compose_cas_refuses(self):
        control, _, _, child, child_doc, _, _ = fixture()
        parent_path = "development/attempts/" + PARENT + "/terminal.json"
        parent = copy.deepcopy(control.read(parent_path))
        parent["error"] = "different failure"
        control.put(parent_path, parent)
        with patch.object(dev, "_read_canonical_control_record", side_effect=self._read_canonical), \
             patch.object(dev, "_retained_recovery_context") as validator:
            with self.assertRaises(BuildControlError):
                dev._frontend_refresh_recovery_handoff(control, child, child_doc, {}, backend_id=BACKEND)
            validator.assert_not_called()


class RetainedRecoveryPreflightTests(unittest.TestCase):
    def test_live_backend_requires_exact_recovery_environment_pair(self):
        control, _, _, previous, document, actual, metadata = fixture()
        environment = document["services"]["backend"]["environment"]
        expected = {AUTH_ENV: environment[AUTH_ENV], AUTH_SHA_ENV: environment[AUTH_SHA_ENV]}
        previous = {**previous, "container_recovery": metadata,
                    "container_recovery_environment": [AUTH_ENV, AUTH_SHA_ENV]}
        capability = {"recovery_environment": expected, "recovery_metadata": metadata}

        with patch.object(dev, "_resolve_frontend_refresh_recovery_lineage", return_value=previous), \
             patch.object(dev, "_retained_container_recovery_present", return_value=True), \
             patch.object(dev, "_retained_container_recovery_capability", return_value=capability):
            result = dev.preflight_retained_recovery_handoff(
                control, previous, document, actual, backend_id=BACKEND)
        self.assertEqual(result["container_recovery"], metadata)

        for extra_rows in (
            [AUTH_ENV + "=" + expected[AUTH_ENV], AUTH_SHA_ENV + "=" + expected[AUTH_SHA_ENV],
             "FULLMAG_CONTAINER_RECOVERY_UNEXPECTED=value"],
            [AUTH_ENV + "=" + expected[AUTH_ENV], AUTH_ENV + "=" + expected[AUTH_ENV],
             AUTH_SHA_ENV + "=" + expected[AUTH_SHA_ENV]],
            [AUTH_ENV + "=changed", AUTH_SHA_ENV + "=" + expected[AUTH_SHA_ENV]],
        ):
            with self.subTest(rows=extra_rows):
                bad_actual = copy.deepcopy(actual)
                bad_actual["backend"]["Config"]["Env"] = extra_rows
                with patch.object(dev, "_resolve_frontend_refresh_recovery_lineage", return_value=previous), \
                     patch.object(dev, "_retained_container_recovery_present", return_value=True), \
                     patch.object(dev, "_retained_container_recovery_capability", return_value=capability), \
                     self.assertRaises(BuildControlError):
                    dev.preflight_retained_recovery_handoff(
                        control, previous, document, bad_actual, backend_id=BACKEND)


class RecoveryContextSerializationTests(unittest.TestCase):
    def test_supported_specialized_recovery_contexts_keep_their_existing_receipt_roles(self):
        from docker_volume_cold_budget_restore import ColdBudgetRestoreContext
        from docker_volume_drained_successor import DrainedSuccessorContext
        from docker_volume_native_init_successor import NativeInitSuccessorContext
        from docker_volume_pre_api_stop import PreApiContext
        from docker_volume_startup_diagnostic_restart import (
            SCHEMA as STARTUP_SCHEMA,
            StartupDiagnosticStopContext,
        )

        native_metadata = {"schema": "fullmag.docker-native-failed-stop-recreate.v1"}
        startup = {
            "schema": STARTUP_SCHEMA,
            "stop_journal_relative": "verification/stop-startup-diagnostic-" + BACKEND + ".json",
            "stop_journal_sha256": "1" * 64,
            "backend_container_id": BACKEND,
            "frontend_container_id": FRONTEND,
            "runtime_config_sha256": "2" * 64,
            "development_attempt": PARENT,
        }
        cold = ColdBudgetRestoreContext(
            previous_config_sha256="3" * 64,
            cold_budget_restore={"journal_relative": "cold/journal.json", "journal_sha256": "4" * 64},
        )
        pre_api = PreApiContext(
            previous_config_sha256="5" * 64,
            native_restart_metadata=native_metadata,
        )
        diagnostic = StartupDiagnosticStopContext(
            previous_config_sha256="2" * 64,
            startup_diagnostic_restart=startup,
        )
        native_init = NativeInitSuccessorContext(
            {"previous_config_sha256": "5" * 64, "native_restart_metadata": native_metadata},
            {"schema": "fullmag.native-init-successor-witness.v1"},
        )
        drained = DrainedSuccessorContext({"schema": "fullmag.drained-successor-witness.v1"})
        cases = (
            (cold, {
                "receipt": {"cold_budget_restore": cold["cold_budget_restore"]},
                "inputs": {"cold_budget_restore": cold["cold_budget_restore"],
                           "previous_config_sha256": cold["previous_config_sha256"]},
            }),
            (pre_api, {
                "receipt": {},
                "inputs": {"native_failed_restart": native_metadata,
                           "previous_config_sha256": pre_api["previous_config_sha256"]},
            }),
            (diagnostic, {
                "receipt": {"startup_diagnostic_restart": startup},
                "inputs": {"startup_diagnostic_restart": startup,
                           "previous_config_sha256": diagnostic["previous_config_sha256"]},
            }),
            (native_init, {
                "receipt": {"native_init_successor": native_init.witness},
                "inputs": {"native_failed_restart": native_metadata,
                           "previous_config_sha256": native_init["previous_config_sha256"]},
            }),
            (drained, {
                "receipt": {"drained_successor": drained.witness},
                "inputs": {},
            }),
        )
        for context, expected in cases:
            with self.subTest(context=type(context).__name__):
                self.assertEqual(dev._serialize_frontend_refresh_recovery_context(context), expected)

        unsupported = {"unreviewed": {"authority": "must not copy"}}
        with self.assertRaises(BuildControlError):
            dev._serialize_frontend_refresh_recovery_context(unsupported)


class FrontendRefreshChildComposeTests(unittest.TestCase):
    def setUp(self):
        from docker_volume_stop_unadmitted import _control_bytes
        self.control_bytes_patch = patch(
            "docker_volume_stop_unadmitted._control_bytes",
            side_effect=lambda control, relative, *, optional=False, maximum=None:
                control.read_bytes(relative, optional=optional, maximum=maximum),
        )
        self.control_bytes_patch.start()
        self.addCleanup(self.control_bytes_patch.stop)

    def _read_canonical(self, control, relative, label):
        raw = control.read_bytes(relative)
        value = json.loads(raw)
        if canonical(value) + b"\n" != raw:
            raise BuildControlError(label + " is not canonical")
        return raw, dict(value)

    def _install_completed_child_compose(self, control, child, child_doc):
        import docker_volume_frontend_refresh_reconcile as completion

        root = "development/attempts/" + CHILD
        original_doc = copy.deepcopy(child_doc)
        original_doc["services"]["frontend"]["environment"]["FULLMAG_FRONTEND_HOST_PORT"] = "3243"
        original_compose = canonical(original_doc) + b"\n"
        unknown_receipt = canonical({"state": "outcome-unknown-resources-retained", "attempt": CHILD}) + b"\n"
        derived_compose = canonical(child_doc)
        seed_evidence = {"backend_app_commit": "a" * 40, "frontend_input_commit": "b" * 40}
        evidence = {
            "documents": {
                root + "/compose.json": sha(original_compose),
                root + "/receipt.json": sha(unknown_receipt),
            },
            "derived_compose_sha256": sha(derived_compose),
            "seed_completion": seed_evidence,
        }
        request = {
            "schema": completion.SCHEMA,
            "attempt": CHILD,
            "base_attempt": PARENT,
            "source_root": child["inputs"]["source_root"],
            "source_commit": "a" * 40,
            "compose_project": control.project,
            "control_volume": control.volume,
            "port": 3244,
            "controller_sha256": "c" * 64,
            "helper_source": {"root": "/repo/helper", "commit": "d" * 40, "modules": {}},
            "evidence": evidence,
        }
        request_raw = canonical(request)
        request_sha = sha(request_raw)
        completion_root = "verification/frontend-refresh-completion/" + request_sha
        journal = root + "/completion/" + request_sha
        request_relative = completion_root + "/request.json"
        control.records[request_relative] = request_raw
        control.records[journal + "/original-compose.json"] = original_compose
        control.records[root + "/unknown-receipt.json"] = unknown_receipt
        marker = {
            "schema": completion.SCHEMA,
            "request": request_relative,
            "request_sha256": request_sha,
            "services_mutated": False,
            "original_compose": journal + "/original-compose.json",
            "seed_completion": seed_evidence,
        }
        child["frontend_refresh_completion"] = marker
        child["source_commit"] = "a" * 40
        terminal_raw = control.put(root + "/terminal.json", child)
        control.put("development/current.json", child)
        control.put("development/verified.json", child)
        control.put(root + "/receipt.json", child)
        control.records[journal + "/result.json"] = terminal_raw
        control.records[root + "/compose.json"] = derived_compose
        return request, request_sha

    def _resolve(self, control, child, child_doc, actual):
        with patch.object(dev, "_read_canonical_control_record", side_effect=self._read_canonical):
            return dev._resolve_frontend_refresh_recovery_lineage(
                control, child, child_doc, actual=actual)

    def test_completion_pinned_child_compose_accepts_canonical_bytes_without_newline(self):
        control, _, _, child, child_doc, actual, _ = fixture()
        self._install_completed_child_compose(control, child, child_doc)
        import docker_volume_frontend_refresh_reconcile as completion

        with patch.object(completion, "read_raw",
                           side_effect=lambda ctl, relative, optional=False:
                               ctl.read_bytes(relative, optional=optional)):
            resolved = self._resolve(control, child, child_doc, actual)
        self.assertEqual(resolved["container_recovery_environment"], [AUTH_ENV, AUTH_SHA_ENV])
        self.assertEqual(control.read_bytes("development/attempts/" + CHILD + "/compose.json"),
                         canonical(child_doc))

    def test_ordinary_canonical_child_compose_with_newline_remains_accepted(self):
        control, _, _, child, child_doc, actual, _ = fixture()
        resolved = self._resolve(control, child, child_doc, actual)
        self.assertEqual(resolved["container_recovery_environment"], [AUTH_ENV, AUTH_SHA_ENV])

    def test_canonical_child_compose_without_newline_requires_completion_marker(self):
        control, _, _, child, child_doc, actual, _ = fixture()
        root = "development/attempts/" + CHILD
        control.records[root + "/compose.json"] = canonical(child_doc)
        with self.assertRaisesRegex(BuildControlError, "completion marker"):
            self._resolve(control, child, child_doc, actual)

    def test_completion_marker_does_not_authorize_extra_compose_whitespace(self):
        control, _, _, child, child_doc, actual, _ = fixture()
        self._install_completed_child_compose(control, child, child_doc)
        root = "development/attempts/" + CHILD
        control.records[root + "/compose.json"] = canonical(child_doc) + b" \n"
        import docker_volume_frontend_refresh_reconcile as completion

        with patch.object(completion, "read_raw",
                           side_effect=lambda ctl, relative, optional=False:
                               ctl.read_bytes(relative, optional=optional)):
            with self.assertRaisesRegex(BuildControlError, "not canonical"):
                self._resolve(control, child, child_doc, actual)


class RecoveryNamespaceBindingTests(unittest.TestCase):
    def setUp(self):
        from docker_volume_stop_unadmitted import _control_bytes
        self.control_bytes_patch = patch(
            "docker_volume_stop_unadmitted._control_bytes",
            side_effect=lambda control, relative, *, optional=False, maximum=None:
                control.read_bytes(relative, optional=optional, maximum=maximum),
        )
        self.control_bytes_patch.start()
        self.addCleanup(self.control_bytes_patch.stop)

    def _namespaced_fixture(self):
        control, parent, parent_doc, child, child_doc, actual, _ = fixture()
        namespace = "namespaces/" + "a" * 32
        registry_sha = "9" * 64
        control.namespace = namespace
        control.namespace_registry_sha256 = registry_sha
        parent["control_namespace"] = namespace
        parent["namespace_registry_sha256"] = registry_sha
        parent["config_sha256"] = sha(canonical(parent_doc))
        parent_raw = control.put("development/attempts/" + PARENT + "/terminal.json", parent)
        child["control_namespace"] = namespace
        child["namespace_registry_sha256"] = registry_sha
        child["inputs"]["failed_seed_new_generation"]["failed_config_sha256"] = parent["config_sha256"]
        child["inputs"]["failed_seed_new_generation"]["prior_terminal_sha256"] = sha(parent_raw)
        child["previous_config_sha256"] = parent["config_sha256"]
        child["inputs"]["frontend_refresh_from_config_sha256"] = parent["config_sha256"]
        child["config_sha256"] = sha(canonical(child_doc))
        control.put("development/attempts/" + PARENT + "/compose.json", parent_doc)
        control.put("development/attempts/" + CHILD + "/terminal.json", child)
        control.put("development/attempts/" + CHILD + "/compose.json", child_doc)
        control.put("development/current.json", child)
        return control, child, child_doc, actual, namespace, registry_sha

    def _resolve(self, control, child, child_doc, actual):
        def read_canonical(control, relative, label):
            raw = control.read_bytes(relative)
            value = json.loads(raw)
            if canonical(value) + b"\n" != raw:
                raise BuildControlError(label + " is not canonical")
            return raw, dict(value)

        with patch.object(dev, "_read_canonical_control_record", side_effect=read_canonical):
            return dev._resolve_frontend_refresh_recovery_lineage(
                control, child, child_doc, actual=actual)

    def test_namespaced_parent_and_child_must_match_active_namespace_registry(self):
        control, child, child_doc, actual, namespace, registry_sha = self._namespaced_fixture()
        resolved = self._resolve(control, child, child_doc, actual)
        self.assertEqual(resolved["control_namespace"], namespace)
        self.assertEqual(resolved["namespace_registry_sha256"], registry_sha)

        foreign, foreign_child, foreign_doc, foreign_actual, _, _ = self._namespaced_fixture()
        foreign.namespace = "namespaces/" + "b" * 32
        with self.assertRaisesRegex(BuildControlError, "namespace"):
            self._resolve(foreign, foreign_child, foreign_doc, foreign_actual)

        drifted, drifted_child, drifted_doc, drifted_actual, _, _ = self._namespaced_fixture()
        drifted.namespace_registry_sha256 = "0" * 64
        with self.assertRaisesRegex(BuildControlError, "namespace"):
            self._resolve(drifted, drifted_child, drifted_doc, drifted_actual)

    def test_unnamespaced_recovery_rejects_namespace_markers_even_when_receipts_agree(self):
        control, parent, _, child, child_doc, actual, _ = fixture()
        namespace = "namespaces/" + "a" * 32
        registry_sha = "9" * 64
        parent["control_namespace"] = namespace
        parent["namespace_registry_sha256"] = registry_sha
        parent_raw = control.put("development/attempts/" + PARENT + "/terminal.json", parent)
        child["control_namespace"] = namespace
        child["namespace_registry_sha256"] = registry_sha
        child["inputs"]["failed_seed_new_generation"]["prior_terminal_sha256"] = sha(parent_raw)
        control.put("development/attempts/" + CHILD + "/terminal.json", child)
        control.put("development/current.json", child)

        def read_canonical(control, relative, label):
            raw = control.read_bytes(relative)
            value = json.loads(raw)
            if canonical(value) + b"\n" != raw:
                raise BuildControlError(label + " is not canonical")
            return raw, dict(value)

        with patch.object(dev, "_read_canonical_control_record", side_effect=read_canonical):
            with self.assertRaisesRegex(BuildControlError, "namespace"):
                dev._resolve_frontend_refresh_recovery_lineage(control, child, child_doc, actual=actual)


class SpecializedRecoveryCapabilityFenceTests(unittest.TestCase):
    def setUp(self):
        from docker_volume_stop_unadmitted import _control_bytes
        self.control_bytes_patch = patch(
            "docker_volume_stop_unadmitted._control_bytes",
            side_effect=lambda control, relative, *, optional=False, maximum=None:
                control.read_bytes(relative, optional=optional, maximum=maximum),
        )
        self.control_bytes_patch.start()
        self.addCleanup(self.control_bytes_patch.stop)

    def test_partial_or_mismatched_capability_cannot_bypass_cold_or_drained_context(self):
        control, _, _, child, child_doc, _, _ = fixture()
        cases = (
            {"container_recovery": {"schema": "broken"}},
            {"container_recovery": {"schema": "broken"},
             "container_recovery_environment": [AUTH_ENV, AUTH_SHA_ENV]},
        )
        for fields in cases:
            previous = {**copy.deepcopy(child), **copy.deepcopy(fields),
                        "cold_budget_restore": {"journal_relative": "cold/journal.json",
                                                 "journal_sha256": "a" * 64}}
            with self.subTest(fields=fields), \
                 patch("docker_volume_cold_budget_restore.retained_context",
                       return_value={"cold_budget_restore": previous["cold_budget_restore"]}) as cold, \
                 patch("docker_volume_drained_successor.retained_context",
                       return_value={"drained_successor": {"schema": "fullmag.drained-successor-witness.v1"}}) as drained:
                with self.assertRaises(BuildControlError):
                    dev._retained_native_recovery_context(
                        control, previous, child_doc, fresh_state=False,
                        drained_successor=(object(),),
                    )
                cold.assert_not_called()
                drained.assert_not_called()


class RefreshPreflightOrderingTests(unittest.TestCase):
    def test_invalid_capability_refuses_before_operation_seed_stop_or_compose(self):
        control, _, _, child, child_doc, actual, _ = fixture()
        partial = {**child, "container_recovery": {"broken": True}}
        events = []

        with patch.object(dev, "_retained_recovery_context",
                          side_effect=BuildControlError("capability refused")), \
             patch.object(dev, "docker_capture", side_effect=lambda *a, **k: events.append("stop")), \
             patch.object(dev, "compose_capture", side_effect=lambda *a, **k: events.append("compose")), \
             patch.object(dev, "_frontend", side_effect=lambda *a, **k: events.append("seed")), \
             patch.object(dev.storage, "validate_path",
                          side_effect=AssertionError("refresh passed preflight without authenticating capability")):
            with self.assertRaisesRegex(BuildControlError, "capability refused"):
                dev._refresh_frontend_services(
                    control, SimpleNamespace(port=3244, attempt=CHILD, config_sha256=child["config_sha256"]),
                    "development/attempts/" + CHILD, partial, child_doc, Path("/repo"),
                    {"runtime_root": "/runtime"}, actual,
                    {"backend": BACKEND, "frontend": CHILD_FRONTEND}, IMAGE, {},
                )
        self.assertEqual(control.events, [])
        self.assertEqual(events, [])

    def test_running_up_recovery_preflight_happens_before_any_controlled_stop(self):
        group = SimpleNamespace(
            repo_root=Path("/repo"), source_root=Path("/repo"), layout={},
            identity={"project_id": "p", "worktree_id": "w", "checkout_kind": "worktree"},
            control=SimpleNamespace(), attempt=CHILD, config_sha256="a" * 64, port=3244,
            document={"networks": {}}, terminal={}, backend_id=BACKEND,
            frontend_id=FRONTEND, backend={"State": {"Running": True}},
            frontend={"State": {"Running": True}},
        )
        args = SimpleNamespace(repo_root="/repo", source_root="/repo", attempt=CHILD,
                               config_sha256="a" * 64, port=3244, script=None,
                               network_subnet=None, headless=False)
        events = []
        with patch("docker_volume_dev.preflight_retained_recovery_handoff",
                   side_effect=lambda *a, **k: events.append("preflight")), \
             patch("docker_volume_dev.stop_idle", side_effect=lambda *a, **k: events.append("stop")), \
             patch("docker_volume_dev.recreate", side_effect=lambda *a, **k: events.append("recreate")), \
             patch.object(docker_dev_up, "_discover_group", return_value=group), \
             patch.object(docker_dev_up, "_service_mode", return_value="running-healthy"), \
             patch.object(docker_dev_up, "_qualify_running_runtime"), \
             patch.object(docker_dev_up, "_activate_if_requested"):
            docker_dev_up._recreate_after_drift(group, args, drain=True)
        self.assertEqual(events, ["preflight", "stop", "recreate"])

    def test_failed_seed_refresh_orders_handoff_guards_stage_cas_publish_and_compose(self):
        from contextlib import ExitStack, contextmanager
        import docker_dev_codegen as codegen
        import docker_development_inputs as development_inputs
        import docker_volume_container_recovery as recovery
        import docker_volume_frontend_seed_completion as completion
        import docker_volume_frontend_seed_recovery as seed_recovery
        import docker_volume_reconcile as reconcile

        control, _, _, previous, document, actual, recovery_metadata = fixture()
        document["services"]["frontend"]["mem_limit"] = "1024"
        previous["frontend_volume"] = "fullmag-frontend-cache-own"
        backend = copy.deepcopy(actual["backend"])
        backend["State"].update(Running=True, Status="running", Pid=1234,
                                Health={"Status": "healthy"})
        old_frontend = copy.deepcopy(actual["frontend"])
        old_frontend["State"].update(Running=False, Status="exited", Pid=0,
                                     ExitCode=1, StartedAt="2026-11-13T00:49:00Z",
                                     FinishedAt="2026-11-13T00:50:00Z")
        new_frontend_id = "8" * 64
        new_frontend = copy.deepcopy(old_frontend)
        new_frontend["Id"] = new_frontend_id
        new_frontend["State"].update(Running=True, Status="running", Pid=3456,
                                     StartedAt="2026-11-13T01:00:00Z",
                                     Health={"Status": "healthy"})
        new_frontend["HostConfig"] = {"Memory": 1024}
        actual["backend"] = backend
        actual["frontend"] = old_frontend
        desired_files = [{"path": "apps/control-room/next-env.d.ts", "sha256": "7" * 64}]
        seeded = {"files": desired_files, "source_commit": "a" * 40}
        source_pins = {"controller_commit": "b" * 40}
        failed_context = {
            "schema": "fullmag.docker-frontend-failed-seed-recovery.v1",
            "attempt": PARENT, "config_sha256": previous["config_sha256"],
            "terminal_sha256": sha(control.read_bytes("development/attempts/" + PARENT + "/terminal.json")),
            "current_sha256": "c" * 64, "verified_sha256": "d" * 64,
            "compose_sha256": previous["config_sha256"], "input_manifest_sha256": "e" * 64,
            "source_pins": source_pins, "controller_source_sha256": "f" * 64,
            "current_inputs": {"files": desired_files, "source_commit": "a" * 40},
            "active_generation": {"generation_id": "1" * 32},
            "failure_identity": {"old_seed_sha256": "2" * 64},
        }
        handoff = {
            "receipt": {
                "container_recovery": recovery_metadata,
                "container_recovery_environment": [AUTH_ENV, AUTH_SHA_ENV],
            },
            "inputs": {"native_failed_restart": {"schema": "handoff-test"}},
        }
        events = []
        handoff_calls = 0
        operation_attempt = "9" * 32
        certificate_raw = canonical({"owner": "same"})
        package = {"package": "verified"}
        provenance = {"provenance": "verified"}
        binary_provenance = {"binary": "verified"}
        package_sha = "3" * 64
        source_record = {"commit": "4" * 40, "source_digest": "5" * 64, "snapshot": "6" * 64}
        live_source_pins = ("7" * 64, "8" * 64)

        def handoff_reader(*args, expected=None, **kwargs):
            nonlocal handoff_calls
            handoff_calls += 1
            events.append("preflight" if expected is None else (
                "revalidate" if handoff_calls == 2 else "cas-revalidate"))
            if expected is not None and expected != handoff:
                raise AssertionError("handoff expectation changed")
            return copy.deepcopy(handoff)

        @contextmanager
        def operation(phase, inputs):
            events.append("lease")
            yield {
                "receipt": {"attempt": operation_attempt, "inputs": inputs},
                "root": "development/attempts/" + operation_attempt,
                "daemon_pending": False,
            }

        control.operation = operation
        control.write = lambda relative, value: None
        control.read = lambda relative, optional=False: {"files": desired_files}

        def inspect_text(*args):
            if args[0] == "inspect":
                identifier = args[1]
                row = backend if identifier == BACKEND else (
                    old_frontend if identifier == CHILD_FRONTEND else new_frontend)
                return json.dumps([row])
            if args[:2] == ("image", "inspect"):
                return json.dumps([{"Config": {}}])
            raise AssertionError("unexpected docker_text call: " + repr(args))

        def compose(*args, **kwargs):
            command = args[1]
            if command == "ps":
                return new_frontend_id.encode()
            events.append("compose")
            return b""

        def stage_and_publish(control, operation, *, guard_prior_consumers, stage_generation,
                              guard_consumers, revalidate_prior, compose_apply, **kwargs):
            guard_prior_consumers()
            staged = stage_generation()
            guard_consumers(staged)
            events.append("cas")
            revalidate_prior(staged)
            events.append("publish")
            compose_apply(staged["compose"])
            return staged

        original_assert_consumers = seed_recovery.assert_group_local_consumers
        guard_count = 0

        def guard_consumers(*args, **kwargs):
            nonlocal guard_count
            guard_count += 1
            events.append("pre-stage-guard" if guard_count == 1 else "post-stage-guard")

        def seed_frontend(*args, **kwargs):
            events.append("stage")
            operation = args[1]
            operation["receipt"].update(
                frontend_generation_probe={"schema": "test-probe"},
                frontend_generation_id=operation_attempt,
                frontend_generation_subpath="private/frontend/generations/" + operation_attempt + "/workspace",
            )
            return copy.deepcopy(seeded), "private-frontend-volume"

        backend_documents = (package, provenance, package_sha, binary_provenance)
        image_id = document["services"]["frontend"]["image"]
        host = SimpleNamespace(OWNER_NAME="owner.json",
                               read_owned_regular=lambda path: certificate_raw)
        state = Path("/tmp/frontend-refresh-state")
        refreshed_document = copy.deepcopy(document)
        refreshed_document["services"]["frontend"]["volumes"] = []

        with ExitStack() as stack:
            stack.enter_context(patch.object(dev.storage, "validate_path", return_value=state))
            stack.enter_context(patch.object(dev, "_session_host", return_value=host))
            stack.enter_context(patch.object(dev, "_certificate_path", return_value=state / "certificate.json"))
            stack.enter_context(patch.object(dev, "_retained_startup_enabled", return_value=False))
            stack.enter_context(patch.object(dev, "docker_text", side_effect=inspect_text))
            stack.enter_context(patch.object(dev, "compose_capture", side_effect=compose))
            stack.enter_context(patch.object(dev, "docker_capture", side_effect=lambda *a, **k: b""))
            stack.enter_context(patch.object(dev, "_assert_private_restart_network"))
            stack.enter_context(patch.object(dev, "_pin_private_group_storage"))
            stack.enter_context(patch.object(dev, "_frontend_refresh_carry_documents", return_value={}))
            stack.enter_context(patch.object(dev, "_frontend_refresh_bind_reconciler", return_value={}))
            stack.enter_context(patch.object(dev, "_frontend_refresh_document", return_value=refreshed_document))
            stack.enter_context(patch.object(dev, "_repin_frontend_daemon_binds",
                                              side_effect=lambda compose, *a, **k: (compose, None)))
            stack.enter_context(patch.object(dev, "_validate_retained_service"))
            stack.enter_context(patch.object(dev, "_frontend_recovery_backend_observation",
                                              return_value={"active_session": False, "active_reservations": 0}))
            stack.enter_context(patch.object(dev, "_frontend", side_effect=seed_frontend))
            stack.enter_context(patch.object(dev, "_frontend_refresh_recovery_handoff", side_effect=handoff_reader))
            stack.enter_context(patch.object(dev, "_frontend_recovery_backend_observation",
                                              return_value={"active_session": False, "active_reservations": 0}))
            stack.enter_context(patch.object(recovery, "validate_runtime_authorization",
                                              return_value={"native_request_sha256": "1" * 64}))
            stack.enter_context(patch.object(seed_recovery, "backend_anchor", return_value={"anchor": "fixed"}))
            stack.enter_context(patch.object(seed_recovery, "validate_backend_anchor"))
            stack.enter_context(patch.object(seed_recovery, "revalidate_context"))
            stack.enter_context(patch.object(seed_recovery, "validate_live_backend_pins"))
            stack.enter_context(patch.object(seed_recovery, "validate_generation_probe"))
            stack.enter_context(patch.object(seed_recovery, "assert_group_local_consumers",
                                              side_effect=guard_consumers))
            stack.enter_context(patch.object(seed_recovery, "stage_and_publish_generation",
                                              side_effect=stage_and_publish))
            stack.enter_context(patch.object(completion, "capture_baseline", return_value={"baseline": True}))
            stack.enter_context(patch.object(completion, "baseline_record", return_value={"record": True}))
            stack.enter_context(patch.object(reconcile, "write_immutable"))
            stack.enter_context(patch.object(development_inputs, "describe",
                                              return_value={"files": desired_files, "source_commit": seeded["source_commit"]}))
            stack.enter_context(patch.object(development_inputs, "frontend_view", return_value={"view": True}))
            stack.enter_context(patch.object(reconcile, "fingerprint", side_effect=lambda row: row["Id"]))
            stack.enter_context(patch.object(codegen, "_backend_documents", return_value=backend_documents))
            stack.enter_context(patch.object(codegen, "_validate_backend",
                                              return_value=(source_record, "9" * 64, "a" * 64)))
            dev._refresh_frontend_services(
                control, SimpleNamespace(port=3244, attempt=CHILD,
                    config_sha256=previous["config_sha256"]),
                "development/attempts/" + CHILD, previous, document, Path("/repo"),
                {"runtime_root": Path("/runtime")}, actual,
                {"backend": BACKEND, "frontend": CHILD_FRONTEND}, image_id, {},
                failed_seed_context=failed_context,
            )

        self.assertEqual(handoff_calls, 3)
        order = ["preflight", "lease", "revalidate", "pre-stage-guard", "stage",
                 "post-stage-guard", "cas", "cas-revalidate", "publish", "compose"]
        positions = [events.index(label) for label in order]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(guard_count, 2)

    def test_running_up_preflight_refusal_keeps_group_unstopped(self):
        group = SimpleNamespace(
            repo_root=Path("/repo"), source_root=Path("/repo"), layout={},
            identity={"project_id": "p", "worktree_id": "w", "checkout_kind": "worktree"},
            control=SimpleNamespace(), attempt=CHILD, config_sha256="a" * 64, port=3244,
            document={"networks": {}}, terminal={}, backend_id=BACKEND,
            frontend_id=FRONTEND, backend={"State": {"Running": True}},
            frontend={"State": {"Running": True}},
        )
        args = SimpleNamespace(repo_root="/repo", source_root="/repo", attempt=CHILD,
                               config_sha256="a" * 64, port=3244, script=None,
                               network_subnet=None, headless=False)
        with patch("docker_volume_dev.preflight_retained_recovery_handoff",
                   side_effect=BuildControlError("capability refused")), \
             patch("docker_volume_dev.stop_idle") as stop_idle, \
             patch("docker_volume_dev.recreate") as recreate:
            with self.assertRaisesRegex(BuildControlError, "capability refused"):
                docker_dev_up._recreate_after_drift(group, args, drain=True)
        stop_idle.assert_not_called()
        recreate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
