"""Interpreted alias/preflight contract model; does not execute native C++."""
from pathlib import Path
import unittest

MAX_ADDRESS = (1 << 64) - 1

def overlap(first, first_size, second, second_size):
    if not first or not second or first_size > MAX_ADDRESS-first or second_size > MAX_ADDRESS-second:
        raise ValueError("invalid address range")
    return first < second+second_size and second < first+first_size

def preflight_then_write(cells, reactions, outputs, storage):
    if overlap(*cells, *reactions):
        raise ValueError("source buffers overlap")
    for pointer, size in outputs:
        if overlap(*cells, pointer, size) or overlap(*reactions, pointer, size):
            raise ValueError("output overlaps source")
    storage[:] = b"accepted"

class ClosedLoopAliasContract(unittest.TestCase):
    def test_exact_base_and_partial_overlap_refuse_before_payload_write(self):
        for carrier in ("charge", "H", "canonical_faces", "header"):
            for source in ((4096, 280), (8192, 32)):
                for pointer in (source[0], source[0]+source[1]-1, source[0]-1):
                    with self.subTest(carrier=carrier, source=source, pointer=pointer):
                        storage=bytearray(b"sentinel")
                        with self.assertRaises(ValueError):
                            preflight_then_write((4096,280),(8192,32),[(pointer,16)],storage)
                        self.assertEqual(storage,b"sentinel")
    def test_source_buffers_overlap_refuses_before_payload_write(self):
        for reaction in ((4096,32),(4375,32),(4080,32)):
            storage=bytearray(b"sentinel")
            with self.assertRaises(ValueError):
                preflight_then_write((4096,280),reaction,[],storage)
            self.assertEqual(storage,b"sentinel")
    def test_adjacent_disjoint_outputs_are_accepted(self):
        storage=bytearray(b"sentinel")
        preflight_then_write((4096,280),(8192,32),[(4376,16),(8224,16)],storage)
        self.assertEqual(storage,b"accepted")
    def test_native_source_keeps_all_checks_before_import_and_export(self):
        source=(Path(__file__).resolve().parents[1]/"backends/fem/cpu/mfem/transport/steady_transport_c_api.cpp").read_text(encoding="utf-8")
        start=source.index("const auto reaction_bytes = source_snapshot->paired_weak_reactions_capacity")
        end=source.index("auto device_mesh = import_mesh",start)
        preflight=source[start:end]
        self.assertNotIn("pointer != source_snapshot->paired_weak_reactions",preflight)
        self.assertIn("source_snapshot->paired_weak_reactions, reaction_bytes, pointer, count * stride",preflight)
        self.assertIn("source_snapshot->cells, bytes, pointer, count * stride",preflight)
        for output in ("charge_snapshot->electric_potential_v", "oersted_result->h_xyz_apm", "result.canonical_face_records", "disjoint(source_snapshot, 1"):
            self.assertIn(output,preflight)
        self.assertLess(end,source.index("export_closed_loop_source_snapshot",end))
        self.assertNotIn("std::copy",preflight)

if __name__ == "__main__":
    unittest.main()
