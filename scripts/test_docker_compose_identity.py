"""Source-only regressions for per-checkout Compose identity and port admission."""
from __future__ import annotations

import json
from pathlib import Path, PosixPath
import unittest
from unittest.mock import patch

import docker_compose_identity as identity
import docker_dev
import fullmag_docker_runtime as runtime
import fullmag_storage as storage


def _guard_identity(project):
    return {"project_name": project, "network_name": identity.compose_network_name(project),
            "project_id": "fullmag-test", "worktree_id": "wt", "checkout_kind": "worktree"}


class ComposeProjectIdentityTests(unittest.TestCase):
    def _layout(self, repo: str, worktree_id: str = "worktree-abc.def-1234") -> dict[str, object]:
        return {
            "repo_root": repo,
            "worktree_id": worktree_id,
            "env": {"FULLMAG_PROJECT_ID": "fullmag-main-0123456789abcdef"},
        }

    def test_main_checkout_uses_stable_project_without_branch_claim(self):
        layout = self._layout("/checkout/fullmag")
        with patch.object(storage, "worktree_records",
                          return_value=[{"worktree": "/checkout/fullmag"}]):
            result = identity.compose_project_identity(layout)
        self.assertEqual(result["project_name"], "fullmag-master")
        self.assertEqual(result["network_name"], "fullmag-master_fullmag")
        self.assertEqual(result["checkout_kind"], "main-checkout")

    def test_registered_worktree_gets_distinct_compose_project_without_new_registry(self):
        layout = self._layout("/checkout/worktrees/feature-a")
        with patch.object(storage, "worktree_records",
                          return_value=[{"worktree": "/checkout/fullmag"},
                                        {"worktree": "/checkout/worktrees/feature-a"}]):
            result = identity.compose_project_identity(layout)
        self.assertEqual(result["project_name"], "fullmag-worktree-worktree-abc-def-1234")
        self.assertEqual(result["registered_name"], "worktree-abc.def-1234")
        self.assertEqual(identity.source_labels(result)["org.fullmag.source.worktree-id"],
                         "worktree-abc.def-1234")

    def test_long_worktree_identity_keeps_readable_project_and_safe_network(self):
        worktree_id = "docker-all-windows-20261014-" + "a" * 16
        layout = self._layout("/checkout/worktrees/feature-a", worktree_id)
        with patch.object(storage, "worktree_records",
                          return_value=[{"worktree": "/checkout/fullmag"},
                                        {"worktree": "/checkout/worktrees/feature-a"}]):
            result = identity.compose_project_identity(layout)
        self.assertLessEqual(len(result["network_name"]), 63)
        self.assertEqual(result["project_name"], "fullmag-worktree-" + worktree_id)
        self.assertTrue(result["network_name"].startswith("fullmag-net-"))
        self.assertNotEqual(result["project_name"], result["network_name"])
        self.assertEqual(result["worktree_id"], worktree_id)

    def test_legacy_reuse_preserves_project_source_labels_and_pins(self):
        source = {
            "project_name": "fullmag-worktree-worktree-abc-def-1234",
            "network_name": "fullmag-worktree-worktree-abc-def-1234_fullmag",
            "project_id": "fullmag-main-0123456789abcdef",
            "worktree_id": "worktree-abc.def-1234",
            "checkout_kind": "worktree",
        }
        pins = {
            "image_id": "sha256:" + "1" * 64,
            "assembly_receipt_sha256": "a" * 64,
        }
        reuse = {
            "project": "fullmag",
            "receipt": {
                **pins,
                "source_project_id": source["project_id"],
                "source_worktree_id": source["worktree_id"],
                "source_checkout_kind": "master",
            },
        }

        project, adapted, compatibility = runtime._select_reuse_compose_identity(
            source, source["project_name"], reuse
        )

        self.assertEqual(project, "fullmag")
        self.assertEqual(compatibility, "legacy-compose-project")
        self.assertEqual(adapted["project_name"], "fullmag")
        self.assertEqual(adapted["network_name"], "fullmag_fullmag")
        self.assertEqual(adapted["checkout_kind"], "master")
        self.assertEqual(reuse["receipt"]["image_id"], pins["image_id"])
        self.assertEqual(reuse["receipt"]["assembly_receipt_sha256"], pins["assembly_receipt_sha256"])

    def test_fresh_start_keeps_checkout_derived_project_name(self):
        source = {
            "project_name": "fullmag-worktree-worktree-abc-def-1234",
            "network_name": "fullmag-worktree-worktree-abc-def-1234_fullmag",
            "project_id": "fullmag-main-0123456789abcdef",
            "worktree_id": "worktree-abc.def-1234",
            "checkout_kind": "worktree",
        }
        project, selected, compatibility = runtime._select_reuse_compose_identity(
            source, source["project_name"], None
        )
        self.assertEqual(project, "fullmag-worktree-worktree-abc-def-1234")
        self.assertIs(selected, source)
        self.assertIsNone(compatibility)

    def test_legacy_reuse_without_old_identity_fields_binds_selected_checkout(self):
        source = {
            "project_name": "fullmag-master",
            "network_name": "fullmag-master_fullmag",
            "project_id": "fullmag-main-0123456789abcdef",
            "worktree_id": "main-checkout-1234",
            "checkout_kind": "main-checkout",
        }
        project, adapted, compatibility = runtime._select_reuse_compose_identity(
            source,
            source["project_name"],
            {"project": "fullmag", "receipt": {"image_id": "sha256:" + "2" * 64}},
        )
        self.assertEqual(project, "fullmag")
        self.assertEqual(compatibility, "legacy-compose-project")
        self.assertEqual(adapted["project_id"], source["project_id"])
        self.assertEqual(adapted["worktree_id"], source["worktree_id"])
        self.assertEqual(adapted["checkout_kind"], source["checkout_kind"])

    def test_explicit_migration_promotes_project_without_moving_pins(self):
        source = {
            "project_name": "fullmag-worktree-worktree-abc-def-1234",
            "network_name": "fullmag-worktree-worktree-abc-def-1234_fullmag",
            "project_id": "fullmag-main-0123456789abcdef",
            "worktree_id": "worktree-abc.def-1234",
            "checkout_kind": "worktree",
        }
        pins = {
            "image_id": "sha256:" + "3" * 64,
            "assembly_receipt_sha256": "b" * 64,
            "previous_config_sha256": "c" * 64,
        }
        reuse = {
            "project": "fullmag",
            "root": "/storage/runs/docker-all/" + "d" * 32,
            "state": "/storage/runs/docker-all/" + "d" * 32 + "/state",
            "receipt": {
                **pins,
                "source_project_id": source["project_id"],
                "source_worktree_id": source["worktree_id"],
                "source_checkout_kind": "worktree",
            },
        }
        project, adapted, compatibility = runtime._select_migration_compose_identity(
            source, source["project_name"], reuse
        )
        self.assertEqual(project, source["project_name"])
        self.assertEqual(adapted["project_name"], source["project_name"])
        self.assertEqual(adapted["network_name"], source["network_name"])
        self.assertEqual(adapted["project_id"], source["project_id"])
        self.assertEqual(adapted["worktree_id"], source["worktree_id"])
        self.assertEqual(compatibility, "legacy-compose-project-migrated")
        self.assertEqual(reuse["root"], "/storage/runs/docker-all/" + "d" * 32)
        for name, value in pins.items():
            self.assertEqual(reuse["receipt"][name], value)

    def test_migration_rejects_foreign_reuse_project(self):
        source = {
            "project_name": "fullmag-master",
            "network_name": "fullmag-master_fullmag",
            "project_id": "fullmag-main-0123456789abcdef",
            "worktree_id": "main-checkout-1234",
            "checkout_kind": "main-checkout",
        }
        with self.assertRaisesRegex(ValueError, "validated legacy fullmag"):
            runtime._select_migration_compose_identity(
                source,
                source["project_name"],
                {"project": "foreign-project", "receipt": {}},
            )

    def test_migration_target_guard_rejects_stopped_target_container(self):
        target = "fullmag-worktree-target"
        document = {
            "Name": "/fullmag-target-backend",
            "Config": {"Labels": {"com.docker.compose.project": target}},
        }

        def capture(*args, **kwargs):
            if args[:2] == ("ps", "--all"):
                return "target-id\n" if "com.docker.compose.project" in args[-1] else ""
            if args[:1] == ("inspect",):
                return json.dumps([document])
            raise AssertionError(args)

        with patch.object(docker_dev, "_docker_capture", side_effect=capture):
            with self.assertRaisesRegex(docker_dev.DirectDockerError, "running or stopped"):
                runtime._assert_compose_project_absent(target, _guard_identity(target))

    def test_reuse_rejects_unrecognized_noncanonical_project(self):
        source = {
            "project_name": "fullmag-worktree-worktree-abc-def-1234",
            "network_name": "fullmag-worktree-worktree-abc-def-1234_fullmag",
            "project_id": "fullmag-main-0123456789abcdef",
            "worktree_id": "worktree-abc.def-1234",
            "checkout_kind": "worktree",
        }
        with self.assertRaisesRegex(ValueError, "does not match"):
            runtime._select_reuse_compose_identity(
                source,
                source["project_name"],
                {"project": "foreign-project", "receipt": {}},
            )

    def test_running_service_labels_are_part_of_runtime_attestation(self):
        layout = self._layout("/checkout/fullmag")
        with patch.object(storage, "worktree_records",
                          return_value=[{"worktree": "/checkout/fullmag"}]):
            source = identity.compose_project_identity(layout)
        labels = identity.source_labels(source)
        document = {"Config": {"Labels": labels}}
        identity.validate_source_labels(document, source)
        with self.assertRaisesRegex(ValueError, "source labels"):
            identity.validate_source_labels(
                {"Config": {"Labels": {**labels, "org.fullmag.source.worktree-id": "other"}}},
                source,
            )

    def test_port_preflight_rejects_loopback_and_wildcard_bindings(self):
        document = {
            "Name": "/fullmag-frontend",
            "Config": {"Labels": {"com.docker.compose.project": "fullmag-worktree-wt"}},
            "HostConfig": {"PortBindings": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3197"}]}},
        }

        def fake_docker(*args, **kwargs):
            if args[:2] == ("ps", "--quiet"):
                return "container-id\n"
            if args[:1] == ("inspect",):
                return json.dumps([document])
            raise AssertionError(args)

        with patch.object(runtime, "docker", side_effect=fake_docker):
            with self.assertRaisesRegex(ValueError, "port 3197"):
                runtime.assert_loopback_port_available(3197, "fullmag-master")

        document["HostConfig"]["PortBindings"]["8080/tcp"][0]["HostIp"] = "0.0.0.0"
        with patch.object(runtime, "docker", side_effect=fake_docker):
            with self.assertRaisesRegex(ValueError, "port 3197"):
                runtime.assert_loopback_port_available(3197, "fullmag-master")

    def test_native_windows_listener_blocks_port_before_docker_inspection(self):
        listener = {
            "LocalAddress": "127.0.0.1",
            "LocalPort": 3197,
            "OwningProcess": 4242,
            "State": "Listen",
        }
        result = type("Completed", (), {"returncode": 0, "stdout": json.dumps(listener), "stderr": ""})()
        with patch.dict(runtime.os.environ, {"SystemRoot": "/windows"}), \
                patch.object(runtime, "Path", PosixPath), \
                patch.object(runtime.os, "name", "nt"), \
                patch.object(runtime.subprocess, "run", return_value=result) as probe, \
                patch.object(runtime, "docker") as docker:
            with self.assertRaisesRegex(ValueError, "native Windows"):
                runtime.assert_loopback_port_available(3197, "fullmag-master")
        probe.assert_called_once()
        self.assertIn("Get-NetTCPConnection", probe.call_args.args[0][-1])
        docker.assert_not_called()

    def test_native_windows_probe_failure_is_fail_closed(self):
        result = type("Completed", (), {"returncode": 1, "stdout": "", "stderr": "probe unavailable"})()
        with patch.dict(runtime.os.environ, {"SystemRoot": "/windows"}), \
                patch.object(runtime, "Path", PosixPath), \
                patch.object(runtime.os, "name", "nt"), \
                patch.object(runtime.subprocess, "run", return_value=result), \
                patch.object(runtime, "docker") as docker:
            with self.assertRaisesRegex(ValueError, "Could not inspect native Windows"):
                runtime.assert_loopback_port_available(3197, "fullmag-master")
        docker.assert_not_called()

    def test_unpublished_container_does_not_block_port(self):
        document = {"Config": {"Labels": {}}, "HostConfig": {"PortBindings": None}}

        def fake_docker(*args, **kwargs):
            if args[:2] == ("ps", "--quiet"):
                return "container-id\n"
            if args[:1] == ("inspect",):
                return json.dumps([document])
            raise AssertionError(args)

        with patch.object(runtime, "docker", side_effect=fake_docker):
            runtime.assert_loopback_port_available(3197, "fullmag-master")

    def test_launcher_uses_explicit_project_for_compose_and_scoped_empty_guard(self):
        prefix = docker_dev._compose_prefix(Path("/repo"), [Path("/repo/compose.dev.yaml")],
                                            "fullmag-worktree-wt")
        self.assertEqual(prefix[1:3], ["--project-name", "fullmag-worktree-wt"])

        def empty_capture(*args, **kwargs):
            if args[:2] == ("ps", "--all") or args[:2] == ("network", "ls"):
                return ""
            raise AssertionError(args)

        with patch.object(docker_dev, "_docker_capture", side_effect=empty_capture) as capture:
            docker_dev._assert_no_running_fullmag("fullmag-worktree-wt", _guard_identity("fullmag-worktree-wt"))
        calls = [call.args for call in capture.call_args_list]
        self.assertIn(
            ("ps", "--all", "--quiet", "--filter",
             "label=com.docker.compose.project=fullmag-worktree-wt"),
            calls,
        )

    def test_guard_rejects_stopped_project_container(self):
        document = {
            "Name": "/old-fullmag-backend",
            "Config": {"Labels": {"com.docker.compose.project": "fullmag-worktree-wt"}},
        }

        def capture(*args, **kwargs):
            if args[:2] == ("ps", "--all"):
                return "stopped-id\n" if "com.docker.compose.project" in args[-1] else ""
            if args[:1] == ("inspect",):
                return json.dumps([document])
            raise AssertionError(args)

        with patch.object(docker_dev, "_docker_capture", side_effect=capture):
            with self.assertRaisesRegex(docker_dev.DirectDockerError, "running or stopped"):
                docker_dev._assert_no_running_fullmag("fullmag-worktree-wt", _guard_identity("fullmag-worktree-wt"))

    def test_guard_rejects_orphaned_project_network_identity(self):
        network = {
            "Name": "fullmag-worktree-wt_fullmag",
            "Id": "network-id", "Driver": "bridge", "Scope": "local", "Containers": {},
            "Labels": {"org.fullmag.compose.project": "fullmag-worktree-wt"},
        }

        def capture(*args, **kwargs):
            if args[:2] == ("ps", "--all"):
                return ""
            if args[:2] == ("network", "ls"):
                return "network-id\n" if "org.fullmag.compose.project" in args[-1] else ""
            if args[:2] == ("network", "inspect"):
                return json.dumps([network])
            raise AssertionError(args)

        with patch.object(docker_dev, "_docker_capture", side_effect=capture):
            with self.assertRaisesRegex(docker_dev.DirectDockerError, "source labels"):
                docker_dev._assert_no_running_fullmag("fullmag-worktree-wt", _guard_identity("fullmag-worktree-wt"))

    def test_guard_rejects_deterministic_network_name_without_labels(self):
        network = {
            "Name": "fullmag-worktree-wt_fullmag",
            "Id": "network-id", "Driver": "bridge", "Scope": "local", "Containers": {},
            "Labels": {},
        }

        def capture(*args, **kwargs):
            if args[:2] == ("ps", "--all"):
                return ""
            if args[:2] == ("network", "ls"):
                return "network-id\n" if "name=^fullmag-worktree-wt_fullmag$" in args[-1] else ""
            if args[:2] == ("network", "inspect"):
                return json.dumps([network])
            raise AssertionError(args)

        with patch.object(docker_dev, "_docker_capture", side_effect=capture):
            with self.assertRaisesRegex(docker_dev.DirectDockerError, "source labels"):
                docker_dev._assert_no_running_fullmag("fullmag-worktree-wt", _guard_identity("fullmag-worktree-wt"))

    def test_compose_templates_keep_identity_labels_and_automatic_ipam(self):
        root = Path(__file__).resolve().parents[1]
        for filename in ("compose.dev.yaml", "compose.static.yaml"):
            text = (root / filename).read_text(encoding="utf-8")
            self.assertIn("x-fullmag-source-labels", text)
            self.assertIn("org.fullmag.source.worktree-id", text)
            self.assertIn("ipam:", text)
            self.assertIn("driver: default", text)
            # Managed cache volumes are external; the isolated bridge is not.
            networks = text.split("\nnetworks:\n", 1)[1].split("\nvolumes:\n", 1)[0]
            self.assertNotIn("external: true", networks)


if __name__ == "__main__":
    unittest.main()
