from __future__ import annotations

import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("compare_fdm_sp5_mumax_fields.py")


def load_module():
    spec = importlib.util.spec_from_file_location("compare_fdm_sp5_mumax_fields", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load SP5 field comparator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_ovf(path: Path, values: list[tuple[float, float, float]]) -> None:
    header = (
        "# OOMMF OVF 2.0\n"
        "# Begin: Segment\n"
        "# Begin: Header\n"
        f"# xnodes: {len(values)}\n"
        "# ynodes: 1\n"
        "# znodes: 1\n"
        "# valuedim: 3\n"
        "# End: Header\n"
        "# Begin: Data Binary 4\n"
    ).encode("ascii")
    flat = [component for vector in values for component in vector]
    path.write_bytes(header + struct.pack(f"<{1 + len(flat)}f", 1234567.0, *flat))


class CompareFdmSp5MumaxFieldsTests(unittest.TestCase):
    def test_binary4_reader_and_vector_metrics(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "field.ovf"
            write_ovf(source, [(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)])
            field = module.read_ovf2_binary4(source)

        self.assertEqual(field.shape, (2, 1, 1))
        self.assertEqual(field.values[1], (0.0, 1.0, 0.0))
        metrics = module.vector_metrics(
            [(1.0, 0.0, 0.0), (0.0, 1.5, 0.0)], field.values
        )
        self.assertAlmostEqual(metrics["rms_component_error"], (0.25 / 6.0) ** 0.5)
        self.assertEqual(metrics["max_abs_component_error"], 0.5)

    def test_current_induced_delta_is_compared_after_zero_current_subtraction(self) -> None:
        module = load_module()
        report = module.compare_fields(
            relaxed_reference=[(1.0, 0.0, 0.0)],
            fullmag_initial=[(1.0, 0.0, 0.0)],
            mumax_current=[(0.8, 0.2, 0.0)],
            mumax_zero=[(1.0, 0.0, 0.0)],
            fullmag_current=[(0.7, 0.3, 0.0)],
            fullmag_zero=[(0.9, 0.1, 0.0)],
        )

        for component in report["current_induced_delta"]["component_mean_error"]:
            self.assertAlmostEqual(component, 0.0)
        self.assertEqual(report["relaxed_state"]["max_abs_component_error"], 0.0)

    def test_length_mismatch_fails_closed(self) -> None:
        module = load_module()
        with self.assertRaisesRegex(ValueError, "field length mismatch"):
            module.vector_metrics([(1.0, 0.0, 0.0)], [])


if __name__ == "__main__":
    unittest.main()
