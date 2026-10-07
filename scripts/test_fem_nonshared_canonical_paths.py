"""Reject normalized aliases before resolving exact nonshared sidecar paths."""
from pathlib import Path
import tempfile
import unittest

from fem_nonshared_operator_replay import NonSharedReplayError, _safe_relative_path


class NonsharedCanonicalPathTests(unittest.TestCase):
    def test_canonical_sample_path_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            relative = "eigen/metadata/sample_0003/nonshared_source/source_mesh.json"
            resolved, spelling = _safe_relative_path(root, relative, "mesh")
            self.assertEqual(spelling, relative)
            self.assertEqual(resolved, (root / relative).resolve())

    def test_normalized_aliases_are_rejected_before_path_construction(self):
        for relative in (
            "eigen/metadata/sample_0003/./nonshared_source/source_mesh.json",
            "eigen/metadata/sample_0003//nonshared_source/source_mesh.json",
            "eigen/metadata/sample_0003/nonshared_source/source_mesh.json/",
            "./eigen/metadata/sample_0003/nonshared_source/source_mesh.json",
            "eigen/metadata/sample_0003/../sample_0003/source_mesh.json",
        ):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(NonSharedReplayError, "noncanonical"):
                    _safe_relative_path(Path(directory), relative, "mesh")


if __name__ == "__main__":
    unittest.main()
