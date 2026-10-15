"""Interpreted publication failure regressions for Docker Windows attestations."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import windows_folder_host as host


class WindowsFolderEvidence(unittest.TestCase):
    def test_flush_failure_retains_the_previously_published_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            with patch.object(host.os, "fsync", side_effect=OSError("flush failed")), \
                    patch.object(host, "_replace_write_through") as replace:
                with self.assertRaisesRegex(OSError, "flush failed"):
                    host.publish_evidence(target, {"owner": "new"})
                replace.assert_not_called()
            self.assertEqual(json.loads(target.read_text()), {"owner": "original"})
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_replacement_failure_retains_the_previously_published_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            with patch.object(host, "_replace_write_through", side_effect=OSError("publish failed")):
                with self.assertRaisesRegex(OSError, "publish failed"):
                    host.publish_evidence(target, {"owner": "new"})
            self.assertEqual(json.loads(target.read_text()), {"owner": "original"})
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_successfully_published_evidence_is_complete_and_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "host.json"
            target.write_text('{"owner": "original"}')
            value = {"owner": "new", "checks": {"restart": True}}
            host.publish_evidence(target, value)
            self.assertEqual(json.loads(target.read_text()), value)
            self.assertEqual(list(Path(directory).iterdir()), [target])


if __name__ == "__main__":
    unittest.main()
