"""Interpreted camera proof checks; no renderer, native process, or compiler."""
from copy import deepcopy
import unittest

from windows import verify_workspace_browser as proof


def camera():
    return {"projection": "orthographic", "position": [2e-6, 1.4e-6, 2e-6],
            "target": [0, 0, 0], "up": [0, 0, 1], "fov_degrees": 45,
            "orthographic_scale": None}


class CameraProofChecks(unittest.TestCase):
    def test_preserved_camera_is_detached_and_keeps_null_scale(self):
        before = camera()
        result = proof.validate_camera_preservation(before, deepcopy(before))
        self.assertTrue(result["preserved"])
        self.assertIsNone(result["after"]["orthographic_scale"])
        result["before"]["position"][0] = 0
        self.assertEqual(before["position"][0], 2e-6)

    def test_every_camera_component_is_required_to_survive_restart(self):
        for key, value in (("projection", "perspective"), ("position", [3e-6, 1.4e-6, 2e-6]),
                           ("target", [1e-6, 0, 0]), ("up", [0, 1, 0]),
                           ("fov_degrees", 42), ("orthographic_scale", 1e-6)):
            with self.subTest(key=key), self.assertRaisesRegex(proof.storage.StorageError, key):
                proof.validate_camera_preservation(camera(), {**camera(), key: value})

    def test_invalid_or_missing_camera_never_counts_as_preserved(self):
        invalid = [None, {}, {**camera(), "extra": True}]
        for key, value in (("position", [float("nan"), 0, 0]), ("up", [0, 1]),
                           ("position", [0, 0, 0]), ("up", [0, 0, 0]),
                           ("target", [False, 0, 0]), ("projection", "default"),
                           ("fov_degrees", float("inf")), ("fov_degrees", 180),
                           ("fov_degrees", 0.5), ("fov_degrees", 179.5),
                           ("orthographic_scale", -1)):
            invalid.append({**camera(), key: value})
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(proof.storage.StorageError):
                proof.validate_camera_preservation(value, value)


if __name__ == "__main__":
    unittest.main()
