"""Geometry regression fixtures, not native or scientific qualification."""
import math
import struct
import unittest

from smoke_antenna_artifact_fields import verify_external_positions, SmokeError


def topology(points):
    header = bytearray(64)
    header[:8] = b"FMMT\x02\x01\x00\x00"
    struct.pack_into("<I", header, 8, len(points))
    struct.pack_into("<I", header, 36, 64)
    return bytes(header) + b"".join(struct.pack("<3d", *point) for point in points)


class ExternalPositionsTests(unittest.TestCase):
    def setUp(self):
        self.points = [(0., 1e-9, -2e-9), (3e-9, -4e-9, 5e-9)]
        self.mesh = topology(self.points)
        self.raw = self.mesh[64:]

    def test_preserves_world_coordinates_and_order(self):
        from hashlib import sha256
        self.assertEqual(verify_external_positions(self.mesh, self.raw, 2),
                         {"positions_sha256": sha256(self.raw).hexdigest()})

    def test_same_cardinality_does_not_hide_permuted_samples(self):
        with self.assertRaises(SmokeError):
            verify_external_positions(topology(self.points[::-1]), self.raw, 2)

    def test_same_cardinality_does_not_hide_changed_coordinate(self):
        changed = [(0., 1e-9, -2.1e-9), self.points[1]]
        with self.assertRaises(SmokeError):
            verify_external_positions(topology(changed), self.raw, 2)

    def test_rejects_count_and_truncation(self):
        for mesh, raw, count in ((self.mesh, self.raw, 3),
                                 (self.mesh, self.raw[:-8], 2),
                                 (self.mesh[:-8], self.raw, 2),
                                 (self.mesh, self.raw, 0),
                                 (self.mesh, self.raw, True)):
            with self.subTest(count=count, sizes=(len(mesh), len(raw))):
                with self.assertRaises(SmokeError):
                    verify_external_positions(mesh, raw, count)

    def test_rejects_nonfinite_coordinates_even_when_bytes_match(self):
        for bad in (math.inf, -math.inf, math.nan):
            mesh = topology([(bad, 0., 0.)])
            with self.assertRaises(SmokeError):
                verify_external_positions(mesh, mesh[64:], 1)

    def test_rejects_wrong_framing(self):
        with self.assertRaises(SmokeError):
            verify_external_positions(b"WRONGHDR" + self.mesh[8:], self.raw, 2)

    def test_rejects_wrong_header_length_and_reserved_flags(self):
        for offset in (36, 48):
            altered = bytearray(self.mesh)
            struct.pack_into("<I", altered, offset, 72)
            with self.assertRaises(SmokeError):
                verify_external_positions(bytes(altered), self.raw, 2)

    def test_accepts_coordinates_beyond_small_native_fixture_limit(self):
        count = 100000
        raw = struct.pack("<3d", 1e-9, 2e-9, 3e-9) * count
        header = bytearray(self.mesh[:64])
        struct.pack_into("<I", header, 8, count)
        self.assertGreater(len(raw), 2 << 20)
        self.assertIn("positions_sha256",
                      verify_external_positions(bytes(header) + raw, raw, count))


if __name__ == "__main__":
    unittest.main()
