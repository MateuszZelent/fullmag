import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
HARNESS = ROOT / "backends/fdm/tests/gpu_m1_charge_scalability_v1_contract.cpp"
JUSTFILE = ROOT / "justfile"


class FdmGpuM1ChargeScalabilityContractTest(unittest.TestCase):
    def test_harness_records_auditable_identity_and_physics(self) -> None:
        source = HARNESS.read_text()
        for token in (
            "fullmag.fdm.gpu.m1.charge.scalability.v1",
            '"device_name"',
            '"device_uuid"',
            '"compute_major"',
            '"compute_minor"',
            '"cuda_driver"',
            '"cuda_runtime"',
            '"cxx_compiler"',
            '"cuda_compiler"',
            '"fma_policy"',
            '"build_digest"',
            '"source_digest_sha256"',
            '"git_commit"',
            '"formula_id"',
            '"operator_id"',
            '"engine_id"',
            '"residual_id"',
            '"hierarchy_digest_sha256"',
            '"physical_residual"',
            '"readback_boundary_balance"',
        ):
            self.assertIn(token.replace('"', r'\"'), source)

    def test_harness_has_independent_size_material_interface_and_face_series(self) -> None:
        source = HARNESS.read_text()
        for token in (
            '"size_index"',
            '"material_count"',
            '"finite_g_interface_count"',
            '"grid"',
            '"inactive_cells"',
            '"series_id"',
            '"slopes"',
            '"hierarchy_cache_hit_count"',
        ):
            self.assertIn(token.replace('"', r'\"'), source)

    def test_just_recipe_publishes_durable_json_and_sha(self) -> None:
        source = JUSTFILE.read_text()
        self.assertIn("/zfn2/mateuszz/git/fullmag/reports:/zfn2-reports", source)
        self.assertIn("durable_dir=/zfn2-reports/fdm-gpu-m1-charge", source)
        self.assertIn("sha256sum", source)
        self.assertIn('sha256sum "$durable" > "$durable.sha256"', source)


if __name__ == "__main__":
    unittest.main()
