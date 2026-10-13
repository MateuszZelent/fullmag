"""GHA-only regressions for metadata-only pnpm workspace preparation."""
import json
import unittest

from prepare_eigensolve_ui_workspace import (
    WorkspacePreparationError,
    _check_workspace_dependencies,
    _workspace_packages,
)


class WorkspaceManifestAdmissionTests(unittest.TestCase):
    def test_yaml_manifests_are_preserved_without_json_dependency_parsing(self):
        manifests = [
            ("package.json", json.dumps({"name": "root", "devDependencies": {"app": "workspace:*"}}).encode()),
            ("pnpm-lock.yaml", b"lockfileVersion: '9.0'\n"),
            ("pnpm-workspace.yaml", b"packages:\n  - 'apps/*'\n"),
            ("apps/control-room/package.json", b'{"name": "app"}'),
        ]
        _check_workspace_dependencies(manifests)
        self.assertEqual(_workspace_packages(manifests[2][1]), ("apps/*",))

    def test_unstaged_workspace_dependency_remains_rejected(self):
        with self.assertRaisesRegex(WorkspacePreparationError, "outside staged"):
            _check_workspace_dependencies([
                ("package.json", b'{"dependencies":{"missing":"workspace:*"}}'),
                ("apps/control-room/package.json", b'{"name":"app"}'),
            ])

    def test_invalid_package_json_remains_rejected(self):
        with self.assertRaisesRegex(WorkspacePreparationError, "Invalid JSON"):
            _check_workspace_dependencies([("package.json", b"not JSON")])

    def test_duplicate_package_identity_remains_rejected(self):
        with self.assertRaisesRegex(WorkspacePreparationError, "Duplicate workspace"):
            _check_workspace_dependencies([
                ("apps/a/package.json", b'{"name":"same"}'),
                ("apps/b/package.json", b'{"name":"same"}'),
            ])

    def test_unsupported_workspace_glob_remains_rejected(self):
        with self.assertRaisesRegex(WorkspacePreparationError, "outside apps"):
            _workspace_packages(b"packages:\n  - 'packages/*'\n")


if __name__ == "__main__":
    unittest.main()
