"""Frozen-input admission regressions; no Docker or native compilation."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import docker_dev
import test_docker_backend_inputs as source_checks


class FrozenInputChecks(unittest.TestCase):
    def setUp(self):
        self.fixture = source_checks.DirectBackendSourceChecks()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        bundle = self.fixture._build()
        self.manifest = Path(bundle["manifest_path"])
        self.value = json.loads(self.manifest.read_text())
        self.value["source_root"] = str(self.fixture.tree)
        self.layout = {"build_storage_root": str(self.fixture.root)}

    def admit(self, raw=None):
        content = raw if raw is not None else json.dumps(self.value).encode()
        with patch("windows_folder_host.read_owned_regular", return_value=content):
            return docker_dev._frozen_source_bundle(self.manifest, self.layout, self.fixture.tree)

    def test_accepts_explicit_frozen_inputs_without_reading_live_edits(self):
        (self.fixture.tree / "src/main.rs").write_text("later live edit")
        result = self.admit()
        self.assertEqual(result["archive_sha256"], self.value["archive_sha256"])

    def test_rejects_inconsistent_top_level_identity(self):
        for key, value in (("source_mode", "snapshot"), ("backend_source_sha256", "0" * 64),
                           ("source_snapshot_sha256", "0" * 64)):
            with self.subTest(key=key):
                changed = {**self.value, key: value}
                with self.assertRaises(docker_dev.DirectDockerError):
                    self.admit(json.dumps(changed).encode())

    def test_rejects_duplicate_manifest_keys(self):
        raw = json.dumps(self.value)
        with self.assertRaises(docker_dev.DirectDockerError):
            self.admit((raw[:-1] + ', "schema": "duplicate"}').encode())

    def test_rejects_tampered_archive(self):
        archive = self.manifest.parent / "backend-source.tar"
        archive.chmod(0o600)
        with archive.open("ab") as stream:
            stream.write(b"tampered")
        with self.assertRaises(docker_dev.DirectDockerError):
            self.admit()
