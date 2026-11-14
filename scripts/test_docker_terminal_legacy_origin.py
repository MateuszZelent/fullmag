"""Pure legacy origin qualification; no Docker, files, or solver side effects."""
import copy
import json
import ast
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock
from docker_build_control import BuildControlError

import docker_activation_history_policy as history
import docker_terminal_legacy_origin as legacy
from test_docker_activation_history_policy import (
    PROJECT, REQUEST, RUN, SESSION, SOURCE, TOKEN, VOLUME, fixture, raw,
)


def inputs():
    files, catalog, startup = fixture()
    provenance = json.loads(files["startup-provenance.json"])
    provenance.update(container_source_root="/opt/fullmag/source",
                      container_script_path="/opt/fullmag/source/examples/sp4.py",
                      source_size_bytes=123)
    files["authorization.json"] = raw(provenance)
    files["startup-provenance.json"] = json.dumps(provenance, indent=2).encode() + b"\n"
    receipt = json.loads(files["receipt.json"])
    receipt["provenance_sha256"] = receipt["inputs"]["provenance_sha256"] = history.digest(files["startup-provenance.json"])
    files["receipt.json"] = files["terminal.json"] = raw(receipt)
    startup["definition_object_ref"] = "d" * 64
    startup["specification"].update(
        run_id=RUN, snapshot={"project_id": "project-test", "definition_sha256": "d" * 64,
                              "definition_revision": 1})
    live = startup["specification"]["parameters"]["live_workspace"]
    live.update(session_epoch=2, api_instance_id="api-old", scene_revision=1,
                request_idempotency_key=REQUEST, command_id=REQUEST,
                startup_source_sha256=SOURCE,
                command={"kind": "startup_script", "request_id": REQUEST, "source_sha256": SOURCE},
                execution_input={"schema_version": "fullmag.scene_execution_input.v1", "sha256": "e" * 64})
    restored = copy.deepcopy(startup)
    restored["run_id"] = restored["specification"]["run_id"] = "run-restored"
    restored_live = restored["specification"]["parameters"]["live_workspace"]
    restored_live.update(api_instance_id="api-current", startup_source_sha256=None,
                         command={"kind": "relax"})
    return dict(
        activation_attempt=TOKEN, activation_receipt_sha256=history.digest(files["receipt.json"]),
        activation_files=files, startup_catalog_raw=raw(catalog), startup_intent_raw=raw(startup),
        startup_lease_records={}, restored_intent_raw=raw(restored),
        preflight={"schema": "fullmag.docker-terminal-session-drain-preflight.v1",
                   "run": {"run_id": "run-restored", "session_id": SESSION, "status": "completed"},
                   "session_id": SESSION, "session_epoch": SESSION + "@1700000000000",
                   "api_instance_id": "api-current", "request_scope_epoch": "api-current:2",
                   "scene_revision": 1},
        source_origin={"schema": "fullmag.selected-script-origin.v1",
                       "source_relative": "examples/sp4.py", "source_sha256": SOURCE,
                       "source_size_bytes": 123},
        project=PROJECT, volume=VOLUME, source_root="/source")


def change_intent(args, name, update):
    value = json.loads(args[name])
    update(value)
    args[name] = raw(value)


class LegacyOriginTests(unittest.TestCase):
    def test_shared_rust_fixture_binds_the_same_qualified_source_and_raw_pins(self):
        fixture_path = (Path(__file__).resolve().parents[1] / "crates/fullmag-api/tests/fixtures/"
                        "terminal-legacy-source-activation.v1.json")
        shared = json.loads(fixture_path.read_bytes())
        args = inputs()
        result = legacy.qualify_legacy_source_origin(**args)
        self.assertEqual(result["source_origin"], shared["origin"])
        self.assertEqual(result["source_origin_legacy_activation"], shared["binding"])
        for key, filename in (("receipt", "receipt.json"), ("provenance", "startup-provenance.json"),
                              ("authorization", "authorization.json"), ("result", "result.json")):
            self.assertEqual(json.loads(args["activation_files"][filename]), shared[key])
        self.assertEqual(history.digest(args["activation_files"]["startup-provenance.json"]),
                         shared["provenance_sha256"])

    def test_restored_intent_historical_api_is_not_current_capture_authority(self):
        args = inputs()
        change_intent(args, "restored_intent_raw", lambda d: d["specification"]["parameters"]["live_workspace"].update(api_instance_id="historical-api"))
        legacy.qualify_legacy_source_origin(**args)
        args["preflight"]["request_scope_epoch"] = "historical-api:2"
        with self.assertRaises(ValueError):
            legacy.qualify_legacy_source_origin(**args)

    def test_snapshot_binding_requires_the_same_complete_snapshot(self):
        args = inputs()
        change_intent(args, "restored_intent_raw", lambda d: d["specification"]["snapshot"].update(observation_label="restored"))
        with self.assertRaises(ValueError):
            legacy.qualify_legacy_source_origin(**args)

    def test_valid_qualification_preserves_inputs_and_raw_byte_pins(self):
        args = inputs()
        before = copy.deepcopy(args)
        result = legacy.qualify_legacy_source_origin(**args)
        self.assertEqual(args, before)
        self.assertEqual(result["source_origin"], args["source_origin"])
        self.assertEqual(result["source_origin_legacy_activation"], {
            "schema": "fullmag.terminal-legacy-source-activation.v1",
            "activation_attempt": TOKEN,
            "activation_receipt_sha256": args["activation_receipt_sha256"],
            "startup_run_id": RUN,
            "startup_intent_sha256": history.digest(args["startup_intent_raw"]),
            "restored_run_id": "run-restored",
            "restored_intent_sha256": history.digest(args["restored_intent_raw"]),
        })
        self.assertIsNot(result["source_origin"], args["source_origin"])

    def test_explicit_valid_pins_and_source_are_required(self):
        for key, values in {
            "activation_attempt": [None, "../other", "A" * 32],
            "activation_receipt_sha256": [None, "f" * 64, "F" * 64],
            "source_origin": [None, {}, {"unexpected": True}],
            "source_root": [None, "relative", "/other", "/source/../source"],
            "project": ["other", None], "volume": ["other", None], "namespace": ["foreign"],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    args = inputs(); args[key] = value
                    with self.assertRaises(ValueError):
                        legacy.qualify_legacy_source_origin(**args)

    def test_raw_intent_hashes_are_not_canonicalized(self):
        args = inputs()
        for name in ("startup_intent_raw", "restored_intent_raw"):
            args[name] = json.dumps(json.loads(args[name]), indent=2).encode() + b"\n"
        result = legacy.qualify_legacy_source_origin(**args)["source_origin_legacy_activation"]
        for name in ("startup", "restored"):
            original = args[name + "_intent_raw"]
            self.assertEqual(result[name + "_intent_sha256"], history.digest(original))
            self.assertNotEqual(history.digest(original), history.digest(raw(json.loads(original))))

    def test_foreign_preflight_and_epoch_are_rejected(self):
        mutations = [
            lambda p: p.update(schema="other"),
            lambda p: p["run"].update(run_id="other"),
            lambda p: p["run"].update(session_id="other"),
            lambda p: p["run"].update(status="running"),
            lambda p: p["run"].update(status=[]),
            lambda p: p.update(session_id="other"),
            lambda p: p.update(api_instance_id="other"),
            lambda p: p.update(request_scope_epoch="api-current:1700000000000"),
            lambda p: p.update(request_scope_epoch="api-current:02"),
            lambda p: p.update(scene_revision=2),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                args = inputs(); mutate(args["preflight"])
                with self.assertRaises(ValueError): legacy.qualify_legacy_source_origin(**args)

    def test_intent_identity_definition_execution_input_and_startup_binding(self):
        changes = [
            lambda d: d.update(schema_version="other"),
            lambda d: d.update(run_id="other"),
            lambda d: d["specification"].update(run_id="other"),
            lambda d: d.update(definition_object_ref=""),
            lambda d: d.update(definition_object_ref="f" * 64),
            lambda d: d["specification"]["snapshot"].update(project_id="other"),
            lambda d: d["specification"]["snapshot"].update(definition_revision=True),
            lambda d: d["specification"]["snapshot"].update(definition_revision=2),
            lambda d: d["specification"]["snapshot"].update(definition_sha256="f" * 64),
            lambda d: d["specification"]["parameters"]["live_workspace"].update(session_epoch=True),
            lambda d: d["specification"]["parameters"]["live_workspace"].update(session_epoch=0),
            lambda d: d["specification"]["parameters"]["live_workspace"].update(session_epoch=1 << 64),
            lambda d: d["specification"]["parameters"]["live_workspace"].update(session_epoch=3),
            lambda d: d["specification"]["parameters"]["live_workspace"].update(session_id="foreign"),
            lambda d: d["specification"]["parameters"]["live_workspace"].update(execution_input=None),
            lambda d: d["specification"]["parameters"]["live_workspace"].update(execution_input={}),
            lambda d: d["specification"]["parameters"]["live_workspace"]["execution_input"].update(sha256="f" * 64),
            lambda d: d["specification"]["parameters"]["live_workspace"]["execution_input"].update(sha256="E" * 64),
            lambda d: d["specification"]["parameters"]["live_workspace"]["execution_input"].update(schema_version="other"),
            lambda d: d["specification"]["parameters"]["live_workspace"].pop("execution_input"),
        ]
        for name in ("startup_intent_raw", "restored_intent_raw"):
            for mutate in changes:
                with self.subTest(intent=name, mutation=mutate):
                    args = inputs(); change_intent(args, name, mutate)
                    with self.assertRaises(ValueError): legacy.qualify_legacy_source_origin(**args)
        for key, value in [("startup_source_sha256", "f" * 64), ("command_id", "other"),
                           ("request_idempotency_key", "other"), ("command", {"kind": "relax"})]:
            args = inputs()
            change_intent(args, "startup_intent_raw", lambda d: d["specification"]["parameters"]["live_workspace"].update({key: value}))
            with self.subTest(startup_key=key), self.assertRaises(ValueError):
                legacy.qualify_legacy_source_origin(**args)
        args = inputs()
        change_intent(args, "startup_intent_raw", lambda d: d.update(idempotency_key="foreign"))
        with self.assertRaises(ValueError): legacy.qualify_legacy_source_origin(**args)

    def test_source_origin_and_provenance_must_agree(self):
        for key, value in [("source_relative", "other.py"), ("source_sha256", "f" * 64),
                           ("source_size_bytes", 124), ("source_size_bytes", True)]:
            args = inputs(); args["source_origin"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                legacy.qualify_legacy_source_origin(**args)
        for key, value in [("container_source_root", "/foreign"),
                           ("container_script_path", "/opt/fullmag/source/other.py"),
                           ("source_size_bytes", True)]:
            args = inputs(); files = args["activation_files"]
            if key == "source_size_bytes":
                # bool compares equal to 1; provenance must retain integer typing.
                args["source_origin"]["source_size_bytes"] = 1
            provenance = json.loads(files["authorization.json"]); provenance[key] = value
            files["authorization.json"] = files["startup-provenance.json"] = raw(provenance)
            receipt = json.loads(files["receipt.json"])
            receipt["provenance_sha256"] = receipt["inputs"]["provenance_sha256"] = history.digest(files["startup-provenance.json"])
            files["receipt.json"] = files["terminal.json"] = raw(receipt)
            args["activation_receipt_sha256"] = history.digest(files["receipt.json"])
            with self.subTest(provenance_key=key), self.assertRaises(ValueError):
                legacy.qualify_legacy_source_origin(**args)

    def test_missing_malformed_records_and_incomplete_lease_content_refuse(self):
        for name in history.REQUIRED:
            args = inputs(); del args["activation_files"][name]
            with self.subTest(missing=name), self.assertRaises(ValueError):
                legacy.qualify_legacy_source_origin(**args)
        for name in ("startup_catalog_raw", "startup_intent_raw", "restored_intent_raw"):
            for value in (b"{}", b"{", b'{"schema_version":1,"schema_version":2}'):
                args = inputs(); args[name] = value
                with self.subTest(name=name, raw=value), self.assertRaises(ValueError):
                    legacy.qualify_legacy_source_origin(**args)

    def test_actual_lease_contents_must_be_released_in_each_family(self):
        for family, schema in [("resource_leases", "resource_lease.v1"),
                               ("preparation_resource_leases", "preparation_resource_lease.v1")]:
            path = "runs/" + RUN + "/" + family + "/cpu/token.json"
            lease = {"schema_version": schema, "run_id": RUN, "resource_id": "cpu",
                     "lease_token": "token", "state": "released"}
            args = inputs(); args["startup_lease_records"] = {path: raw(lease)}
            legacy.qualify_legacy_source_origin(**args)
            for key, value in [("state", "active"), ("state", "unknown"), ("run_id", "other")]:
                args = inputs(); args["startup_lease_records"] = {path: raw({**lease, key: value})}
                with self.subTest(family=family, key=key), self.assertRaises(ValueError):
                    legacy.qualify_legacy_source_origin(**args)
        for leases in (None, {"runs/foreign/resource_leases/cpu/token.json": b"{}"},
                       {"runs/" + RUN + "/resource_leases/cpu/token.json": b"{}"}):
            args = inputs(); args["startup_lease_records"] = leases
            with self.subTest(leases=leases), self.assertRaises(ValueError):
                legacy.qualify_legacy_source_origin(**args)

    def test_preexisting_direct_or_legacy_origin_is_never_overwritten(self):
        for key in ("source_origin", "source_origin_legacy_activation"):
            for value in (None, {}, inputs()["source_origin"]):
                args = inputs(); args["preflight"][key] = value
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    legacy.qualify_legacy_source_origin(**args)


class LegacyOptionsTests(unittest.TestCase):
    def test_cli_and_exact_mode_pairing(self):
        from docker_dev import _parser
        args = _parser().parse_args([
            "restart-idle-volume", "--attempt", TOKEN, "--config-sha256", "a" * 64,
            "--source-root", "/source", "--port", "3197", "--stop-only",
            "--capture-terminal-observation", "--terminal-source-activation", TOKEN,
            "--terminal-source-activation-sha256", "b" * 64,
        ])
        mode = dict(restart_idle_service=True, stop_after_drain=True)
        self.assertEqual(legacy.validate_options(args, **mode), (TOKEN, "b" * 64))
        for key in ("terminal_source_activation", "terminal_source_activation_sha256"):
            altered = copy.copy(args); setattr(altered, key, None)
            with self.subTest(missing=key), self.assertRaises(ValueError):
                legacy.validate_options(altered, **mode)
        for key, value in [("restart_idle_service", False), ("stop_after_drain", False),
                           ("recreate_services", True), ("resume_recreation_id", TOKEN),
                           ("refresh_frontend_service", True), ("retire_only", True)]:
            with self.subTest(mode=key), self.assertRaises(ValueError):
                legacy.validate_options(args, **{**mode, key: value})
        for name in ("quiesce_api", "capture_native_terminal", "capture_prelaunch_failure",
                     "saved_authoring_checkpoint", "saved_authoring_checkpoint_sha256"):
            altered = copy.copy(args); setattr(altered, name, True)
            with self.subTest(flag=name), self.assertRaises(ValueError):
                legacy.validate_options(altered, **mode)
        args.capture_terminal_observation = False
        with self.assertRaises(ValueError): legacy.validate_options(args, **mode)
        self.assertIsNone(legacy.validate_options(SimpleNamespace(), **mode))


class ManagedAdapterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.source = root / "source"; self.store = root / "store"
        script = self.source / "examples" / "sp4.py"
        script.parent.mkdir(parents=True); script.write_bytes(b"print('fixture')\n")
        self.script = script
        digest = history.digest(script.read_bytes())
        session = "docker-startup-" + history.digest((REQUEST + "\0" + digest).encode())
        self.args = inputs()

        def replace(value):
            if isinstance(value, dict): return {k: replace(v) for k, v in value.items()}
            if isinstance(value, list): return [replace(v) for v in value]
            if isinstance(value, str):
                return value.replace(SOURCE, digest).replace(SESSION, session).replace("/source", str(self.source)) if not value.startswith("/opt/") else value
            return value

        for key in ("startup_catalog_raw", "startup_intent_raw", "restored_intent_raw"):
            self.args[key] = raw(replace(json.loads(self.args[key])))
        self.args["preflight"] = replace(self.args["preflight"])
        files = self.args["activation_files"]
        for name in files:
            if name != "build.log": files[name] = raw(replace(json.loads(files[name])))
        provenance = json.loads(files["startup-provenance.json"])
        provenance["source_size_bytes"] = script.stat().st_size
        files["startup-provenance.json"] = files["authorization.json"] = raw(provenance)
        receipt = json.loads(files["receipt.json"])
        receipt["provenance_sha256"] = receipt["inputs"]["provenance_sha256"] = history.digest(files["startup-provenance.json"])
        files["receipt.json"] = files["terminal.json"] = raw(receipt)
        self.pins = TOKEN, history.digest(files["receipt.json"])
        self.control = SimpleNamespace(read_raw=lambda relative, **kwargs: files[relative.rsplit("/", 1)[1]])
        for relative, content in [
            (f"runs/{RUN}/run_catalog.json", self.args["startup_catalog_raw"]),
            (f"runs/{RUN}/run_intent.json", self.args["startup_intent_raw"]),
            ("runs/run-restored/run_intent.json", self.args["restored_intent_raw"]),
        ]:
            path = self.store / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(content)

    def augment(self):
        return legacy.augment_preflight(
            self.args["preflight"], pins=self.pins, control=self.control,
            store_root=self.store, source_root=self.source, project=PROJECT, volume=VOLUME)

    def lease(self, family, state="released"):
        path = self.store / f"runs/{RUN}/{family}/cpu/token.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        schema = "resource_lease.v1" if family == "resource_leases" else "preparation_resource_lease.v1"
        path.write_bytes(raw(dict(schema_version=schema, run_id=RUN, resource_id="cpu", lease_token="token", state=state)))
        return path

    def test_actual_source_and_both_lease_families_are_read_without_mutation(self):
        for family in ("resource_leases", "preparation_resource_leases"): self.lease(family)
        before = {str(p): p.read_bytes() for p in Path(self.temporary.name).rglob("*") if p.is_file()}
        first = self.augment()
        self.assertEqual(first, self.augment())
        self.assertEqual(set(first) - set(self.args["preflight"]), {"source_origin", "source_origin_legacy_activation"})
        self.assertEqual(first["source_origin"]["source_sha256"], history.digest(self.script.read_bytes()))
        self.assertEqual(before, {str(p): p.read_bytes() for p in Path(self.temporary.name).rglob("*") if p.is_file()})
        self.assertNotIn("source_origin", self.args["preflight"])

    def test_final_requalification_rejects_changed_raw_evidence_and_source(self):
        self.augment()
        self.args["activation_files"]["receipt.json"] += b" "
        with self.assertRaises(ValueError): self.augment()
        self.args["activation_files"]["receipt.json"] = self.args["activation_files"]["terminal.json"]
        self.script.write_bytes(b"changed\n")
        with self.assertRaises(ValueError): self.augment()

    def test_released_lease_becoming_active_or_malformed_is_not_omitted(self):
        for family in ("resource_leases", "preparation_resource_leases"):
            path = self.lease(family)
            self.augment()
            self.lease(family, "active")
            with self.subTest(family=family), self.assertRaises(ValueError): self.augment()
            path.write_bytes(b"{}")
            with self.assertRaises(ValueError): self.augment()
            path.unlink()

    def test_no_follow_lease_and_source_paths(self):
        path = self.lease("resource_leases")
        content = path.read_bytes(); outside = Path(self.temporary.name) / "outside.json"
        outside.write_bytes(content); path.unlink(); path.symlink_to(outside)
        with self.assertRaises((ValueError, OSError, BuildControlError)): self.augment()
        path.unlink(); path.write_bytes(content)
        original = self.script.read_bytes(); outside.write_bytes(original)
        self.script.unlink(); self.script.symlink_to(outside)
        with self.assertRaises((ValueError, OSError, BuildControlError)): self.augment()

    def test_lease_root_replacement_during_inventory_refuses(self):
        import docker_volume_accepted_reattach as reader
        self.lease("resource_leases")
        original_reader = reader._read_store_regular

        def replace_store(root, relative, label, **kwargs):
            retired = self.store.with_name("retired")
            self.store.rename(retired)
            path = self.store / relative
            path.parent.mkdir(parents=True)
            path.write_bytes((retired / relative).read_bytes())
            return original_reader(root, relative, label, **kwargs)

        with mock.patch.object(reader, "_read_store_regular", side_effect=replace_store):
            with self.assertRaises(ValueError):
                legacy._lease_inventory(self.store, RUN)

    def test_managed_wrapper_and_capture_reprobe_are_wired(self):
        import docker_volume_dev as dev
        state = Path(self.temporary.name) / "state"
        with mock.patch.object(legacy, "augment_preflight", return_value={"qualified": True}) as adapter, \
             mock.patch.object(dev.storage, "validate_path", return_value=self.store):
            control = SimpleNamespace(project=PROJECT, volume=VOLUME, namespace="")
            self.assertEqual(dev._terminal_legacy_source_preflight(
                {}, pins=self.pins, control=control, selected=self.source, state=state), {"qualified": True})
            self.assertEqual(adapter.call_args.kwargs["source_root"], self.source)
            self.assertIs(adapter.call_args.kwargs["control"], control)
        # Source contract: both probes use the adapter; the first precedes the
        # immutable preflight publication and the second precedes comparison.
        tree = ast.parse(Path(dev.__file__).read_text())
        node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_retained_operation")
        calls = sorted(n.lineno for n in ast.walk(node) if isinstance(n, ast.Call)
                       and isinstance(n.func, ast.Name) and n.func.id == "_terminal_legacy_source_preflight")
        self.assertEqual(len(calls), 2)
        source = ast.get_source_segment(Path(dev.__file__).read_text(), node)
        self.assertLess(source.index("terminal_session = _terminal_legacy_source_preflight"), source.index('"/terminal-session-preflight.json"'))
        self.assertLess(source.index("fresh_terminal_session = _terminal_legacy_source_preflight"), source.index("if fresh_terminal_session != terminal_session"))
        self.assertIn('"terminal_source_activation_sha256": legacy_source_pins[1]', source)


if __name__ == "__main__":
    unittest.main()
