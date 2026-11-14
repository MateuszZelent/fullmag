"""Read-only source pinning for a failed held-UI retry."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch

import docker_volume_held_ui_retry_source as source


PIN = {
    "commit": "a" * 40,
    "source_digest": "b" * 64,
    "source_snapshot_sha256": "c" * 64,
}
MANIFEST = {"resolved_commit": PIN["commit"], "source_digest": PIN["source_digest"]}
IDENTITY = {"head_commit_full": PIN["commit"], "source_snapshot_sha256": PIN["source_snapshot_sha256"]}


class HeldUiRetrySourceTests(unittest.TestCase):
    def test_capture_pins_compact_manifest_and_bound_native_identity_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with patch.object(source, "native_identity", side_effect=[IDENTITY, IDENTITY]) as native, \
                 patch.object(source, "_compact_live_source_manifest",
                              return_value=(MANIFEST, {}, root / ".git")) as compact, \
                 patch.object(source, "bind_identity", return_value=IDENTITY) as bind:
                self.assertEqual(source.capture(root), PIN)
        self.assertEqual(native.call_args_list, [call(root, "snapshot"), call(root, "snapshot")])
        compact.assert_called_once_with(root, include_untracked=())
        bind.assert_called_once_with(IDENTITY, MANIFEST)

    def test_capture_refuses_source_change_during_readonly_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with patch.object(source, "native_identity", side_effect=[IDENTITY, {**IDENTITY, "dirty": True}]), \
                 patch.object(source, "_compact_live_source_manifest", return_value=(MANIFEST, {}, root / ".git")):
                with self.assertRaises(source.HeldUiRetrySourceError):
                    source.capture(root)

    def test_validate_recaptures_exact_commit_capsule_and_native_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with patch.object(source, "capture", return_value=PIN) as capture:
                self.assertEqual(source.validate(root, PIN), PIN)
            capture.assert_called_once_with(root)
            for key in PIN:
                drifted = dict(PIN, **{key: "f" * len(PIN[key])})
                with patch.object(source, "capture", return_value=PIN):
                    with self.subTest(key=key), self.assertRaises(source.HeldUiRetrySourceError):
                        source.validate(root, drifted)

    def test_environment_emits_only_three_validated_private_source_pins(self):
        self.assertEqual(source.environment(PIN), {
            "FULLMAG_HELD_UI_RETRY_SOURCE_COMMIT": PIN["commit"],
            "FULLMAG_HELD_UI_RETRY_SOURCE_SHA256": PIN["source_digest"],
            "FULLMAG_HELD_UI_RETRY_SOURCE_SNAPSHOT_SHA256": PIN["source_snapshot_sha256"],
        })
        malformed = dict(PIN, extra="unexpected")
        with self.assertRaises(source.HeldUiRetrySourceError):
            source.environment(malformed)


if __name__ == "__main__":
    unittest.main()
