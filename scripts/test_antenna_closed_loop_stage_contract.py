"""Interpreted stage/identity admission checks; these do not qualify native execution."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
codec_path = ROOT / "packages/fullmag-py/src/fullmag/runtime/transport_identity.py"
spec = importlib.util.spec_from_file_location("transport_identity", codec_path)
codec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codec)


def stage(stage_id="solve", port="port", output="inspection", revision="sha256:" + "00" * 32):
    digest = codec.tagged_json_digest({"schema": "antenna_closed_loop_stage_identity.v2",
        "stage_id": stage_id, "port_mode_id": port, "output_id": output, "source_revision": revision})
    return int(digest.removeprefix("sha256:")[:16], 16)


class StageContract(unittest.TestCase):
    def test_independent_stage_vector(self):
        self.assertEqual(stage(), 5243294557232993637)

    def test_every_owner_changes_stage_identity(self):
        for kwargs in [dict(stage_id="other"), dict(port="other"), dict(output="other"),
                       dict(revision="sha256:" + "01" * 32)]:
            with self.subTest(kwargs=kwargs):
                self.assertNotEqual(stage(**kwargs), stage())

    def test_full_u64_json_is_decimal_string(self):
        value = 18446744073709551615
        self.assertEqual(json.loads(json.dumps({"stage_identity": str(value)}))["stage_identity"], str(value))

    def test_terminal_record_commits_inside_error_boundary(self):
        source = (ROOT / "crates/fullmag-cli/src/orchestrator/antenna_closed_loop_inspection.rs").read_text(encoding="utf-8")
        closure = source[source.index("let publication ="):source.index("match publication")]
        self.assertIn("write_record(stage_dir, &payload, interrupt)?;", closure)
        self.assertLess(closure.index("publish_antenna_artifacts_atomically"), closure.index("write_record(stage_dir, &payload"))
        self.assertNotIn("write_synthetic_stage_record", source)
        tail = source[source.index("match publication"):]
        self.assertIn('"outputs": []', tail)
        self.assertIn("without a stage handoff", tail)

    def test_record_link_is_no_replace_commit(self):
        source = (ROOT / "crates/fullmag-cli/src/orchestrator/antenna_closed_loop_inspection.rs").read_text(encoding="utf-8")
        writer = source[source.index("fn write_record"):source.index("pub(super) fn execute")]
        self.assertLess(writer.index("file.sync_all()"), writer.index("fs::hard_link"))
        self.assertIn("synthetic_interrupt_requested(interrupt)", writer[writer.index("file.sync_all()"):writer.index("fs::hard_link")])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            temporary, final = root / "temporary", root / "record"
            temporary.write_bytes(b"complete")
            final.hardlink_to(temporary)
            other = root / "other"
            other.write_bytes(b"foreign")
            with self.assertRaises(FileExistsError):
                final.hardlink_to(other)
            self.assertEqual(final.read_bytes(), b"complete")

    def test_cold_identity_rechecks_manifest_owners(self):
        source = (ROOT / "crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs").read_text(encoding="utf-8")
        self.assertIn("prepared_stage_identity(stage_id, port_mode_id, solution_id", source)
        self.assertIn("static_envelope_digest(current_transport_id", source)
        self.assertIn("time.to_bits() == 0.0_f64.to_bits()", source)
        self.assertIn("multiplier.to_bits() == 1.0_f64.to_bits()", source)
        self.assertIn("authored_input_json", source)
        writer = (ROOT / "crates/fullmag-runner/src/antenna_field_solution/closed_loop_v2.rs").read_text(encoding="utf-8")
        for owner in ("input", "m"):
            for key in ("stage_id", "port_mode_id", "solution_id"):
                self.assertIn(f"&{owner}.{key},", writer)


if __name__ == "__main__":
    unittest.main()
