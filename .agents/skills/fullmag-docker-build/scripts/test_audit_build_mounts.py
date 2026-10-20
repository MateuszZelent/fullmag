"""Portable regression checks for the partial, read-only Compose auditor."""
import copy
import unittest
from audit_build_mounts import audit


def configuration():
    source = {"type": "bind", "source": "C:/repo/worktree", "target": "/opt/fullmag/source", "read_only": True}
    return {"name": "fullmag-master", "volumes": {name: {} for name in ("build", "package", "frontend")}, "services": {
        "backend": {"read_only": True,
            "environment": {"FULLMAG_PACKAGE_PROVENANCE": "/build/control/provenance.json"},
            "volumes": [copy.deepcopy(source),
            {"type": "volume", "source": "build", "target": "/build"},
            {"type": "volume", "source": "package", "target": "/opt/fullmag/package"},
            {"type": "bind", "source": "C:/results", "target": "/state"},
            {"type": "bind", "source": "C:/settings", "target": "/user-data"}]},
        "frontend": {"read_only": True, "volumes": [copy.deepcopy(source),
            {"type": "volume", "source": "frontend", "target": "/state/development"},
            {"type": "bind", "source": "C:/repo/worktree/apps/control-room/app",
             "target": "/state/development/workspace/apps/control-room/app", "read_only": True}]},
    }}


class BuildMountTests(unittest.TestCase):
    def test_named_build_volumes_with_windows_runtime_and_live_readonly_source(self):
        result = audit(configuration(), "fullmag-master")
        self.assertEqual(result["status"], "PASS", result)

    def test_file_bind_overrides_parent_control_volume(self):
        config = configuration()
        config["services"]["backend"]["volumes"].append({
            "type": "bind", "source": "C:/storage/provenance.json",
            "target": "/build/control/provenance.json"})
        result = audit(config, "fullmag-master")
        self.assertEqual(result["status"], "FAIL")
        self.assertTrue(any("provenance.json" in problem for problem in result["problems"]))

    def test_frontend_windows_working_tree_is_rejected(self):
        config = configuration()
        config["services"]["frontend"]["volumes"][1] = {
            "type": "bind", "source": "C:/storage/development", "target": "/state/development"}
        self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")

    def test_descendant_tmpfs_cannot_hide_inside_persistent_build_root(self):
        config = configuration()
        config["services"]["backend"]["volumes"].append({
            "type": "tmpfs", "target": "/build/workspace/.fullmag-build"})
        self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")

    def test_different_source_or_project_is_rejected(self):
        config = configuration()
        config["services"]["frontend"]["volumes"][0]["source"] = "C:/other/repo"
        self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")
        self.assertEqual(audit(configuration(), "fullmag-worktree-other")["status"], "FAIL")

    def test_named_volume_with_host_bind_driver_options_is_rejected(self):
        config = configuration()
        config["volumes"]["build"] = {"driver": "local", "driver_opts": {
            "type": "none", "o": "bind", "device": "/host/storage/build"}}
        self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")

    def test_parent_traversal_and_unrendered_mounts_are_not_admitted(self):
        for mount in ["build:/build", {"type": "volume", "source": "build", "target": "/build/../state"}]:
            config = configuration()
            config["services"]["backend"]["volumes"].append(mount)
            with self.assertRaises(ValueError):
                audit(config, "fullmag-master")

    def test_service_tmpfs_cannot_overlay_build_or_provenance(self):
        for target in ("/build", "/build/control", "/build/control/provenance.json"):
            config = configuration()
            config["services"]["backend"]["tmpfs"] = [target + ":size=64m"]
            self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL", target)

    def test_small_unrelated_temporary_mount_does_not_hide_build_volume(self):
        config = configuration()
        config["services"]["backend"]["tmpfs"] = ["/tmp:rw,size=64m"]
        self.assertEqual(audit(config, "fullmag-master")["status"], "PASS")

    def test_duplicate_mount_target_is_ambiguous_in_both_orders(self):
        for reverse in (False, True):
            config = configuration()
            mounts = config["services"]["backend"]["volumes"]
            mounts.append({"type": "bind", "source": "C:/host/build", "target": "/build", "read_only": True})
            if reverse:
                mounts.reverse()
            self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")

    def test_cache_environment_cannot_use_allowed_runtime_bind(self):
        config = configuration()
        config["services"]["backend"]["environment"]["CARGO_TARGET_DIR"] = "/state/target"
        self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")
        config["services"]["backend"]["environment"]["CARGO_TARGET_DIR"] = "/build/target"
        self.assertEqual(audit(config, "fullmag-master")["status"], "PASS")

    def test_other_technical_environment_cannot_write_runtime_storage(self):
        for name in ("TMPDIR", "TEMP", "TMP", "RUSTUP_HOME", "npm_config_cache",
                     "NPM_CONFIG_CACHE", "npm_config_store_dir", "FULLMAG_BUILD_ROOT",
                     "FULLMAG_BACKEND_BUILD_STATE_ROOT", "FULLMAG_RUNNER_WORKSPACE"):
            config = configuration()
            config["services"]["backend"]["environment"][name] = "/state/technical"
            self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL", name)

    def test_temporary_env_may_use_tmpfs_and_rustup_pinned_readonly_image(self):
        config = configuration()
        backend = config["services"]["backend"]
        backend["tmpfs"] = ["/tmp:size=64m"]
        backend["environment"].update(TMPDIR="/tmp", RUSTUP_HOME="/root/.rustup")
        self.assertEqual(audit(config, "fullmag-master")["status"], "PASS")

    def test_nested_volume_cannot_escape_root_volume_retention(self):
        config = configuration()
        config["volumes"]["foreign"] = {"name": "another-project-cache", "external": True}
        config["services"]["backend"]["volumes"].append({
            "type": "volume", "source": "foreign", "target": "/build/workspace/cache"})
        self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")

    def test_readonly_frontend_input_requires_allowlisted_selected_checkout(self):
        for source, target in [("C:/secrets", "/state/development/.npmrc"),
                               ("C:/other/app", "/state/development/workspace/apps/control-room/app")]:
            config = configuration()
            config["services"]["frontend"]["volumes"][2].update(source=source, target=target)
            self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")

    def test_mount_pass_does_not_certify_build_data_or_external_ownership(self):
        config = configuration()
        config["volumes"]["build"] = {"name": "external-cache", "external": True}
        result = audit(config, "fullmag-master")
        self.assertEqual(result["build_data_qualification"], "NOT VERIFIED")

    def test_unbounded_tmpfs_is_rejected_in_both_compose_forms(self):
        for long_form in (False, True):
            config = configuration()
            backend = config["services"]["backend"]
            if long_form:
                backend["volumes"].append({"type": "tmpfs", "target": "/tmp"})
            else:
                backend["tmpfs"] = ["/tmp:rw"]
            self.assertEqual(audit(config, "fullmag-master")["status"], "FAIL")


if __name__ == "__main__":
    unittest.main()
