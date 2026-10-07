import unittest
from dataclasses import replace
from pathlib import Path

import numpy as np

from compare_de_bv_mode_profiles import (
    bind_mesh, contained, consistent_inner_product, normalized_overlap,
    pack_single_film_mesh, tetra_volumes, validate_record_parameters, load_record,
)
from fullmag.meshing._gmsh_types import MeshData


class ProfileMetricTests(unittest.TestCase):
    def setUp(self):
        self.nodes = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])
        self.tetra = np.array([[0, 1, 2, 3]])
        self.volumes = tetra_volumes(self.nodes, self.tetra)

    def test_exact_p1_basis_mass_differs_from_lumping(self):
        basis = np.zeros((4, 3), dtype=complex)
        basis[0, 0] = 1
        other = np.zeros_like(basis)
        other[1, 0] = 1
        self.assertAlmostEqual(consistent_inner_product(self.tetra, self.volumes, basis, basis).real, 1/60)
        self.assertAlmostEqual(consistent_inner_product(self.tetra, self.volumes, basis, other).real, 1/120)

    def test_constant_integrates_exactly_and_global_phase_scale_cancel(self):
        a = np.tile([1+2j, -3j, 0], (4, 1))
        self.assertAlmostEqual(consistent_inner_product(self.tetra, self.volumes, a, a).real, 14/6)
        self.assertAlmostEqual(normalized_overlap(self.tetra, self.volumes, a, a*(2-5j)), 1)

    def test_orthogonal_components_and_hermitian_product(self):
        a = np.tile([1j, 0, 0], (4, 1)); b = np.tile([0, 1, 0], (4, 1))
        self.assertEqual(normalized_overlap(self.tetra, self.volumes, a, b), 0)
        b = a.copy(); b[0] *= 2-1j
        self.assertEqual(consistent_inner_product(self.tetra, self.volumes, a, b),
                         consistent_inner_product(self.tetra, self.volumes, b, a).conjugate())

    def test_zero_norm_nonfinite_and_degenerate_geometry_rejected(self):
        a = np.ones((4, 3), complex)
        with self.assertRaises(ValueError):
            normalized_overlap(self.tetra, self.volumes, np.zeros_like(a), a)
        a[0, 0] = np.nan
        with self.assertRaises(ValueError):
            consistent_inner_product(self.tetra, self.volumes, a, a)
        with self.assertRaises(ValueError):
            tetra_volumes(np.zeros((4, 3)), self.tetra)

    def fixture(self):
        nodes = np.array([[2.,0,0],[3.,0,0],[2.,1,0],[2.,0,1],
                          [0.,0,0],[1.,0,0],[0.,1,0],[0.,0,1]])
        return MeshData.from_legacy_tet4(nodes=nodes, elements=[[0,1,2,3],[4,5,6,7]],
            element_markers=[0,1], boundary_faces=[[0,1,2],[4,5,6]], boundary_markers=[99,10],
            periodic_node_pairs=[{"pair_id":"x", "node_a":0,"node_b":4}])

    def test_packing_updates_all_indices_and_immutable_ordinals(self):
        packed = pack_single_film_mesh(self.fixture())
        np.testing.assert_array_equal(packed.nodes[:4], self.nodes)
        np.testing.assert_array_equal(packed.elements, [[0,1,2,3],[4,5,6,7]])
        np.testing.assert_array_equal(packed.cell_global_ordinals, [1,0])
        np.testing.assert_array_equal(packed.facet_global_ordinals, [1,0])
        self.assertEqual(packed.periodic_node_pairs[0], {"pair_id":"x","node_a":4,"node_b":0})

    def test_wrong_topology_and_multimaterial_rejected(self):
        mesh = self.fixture()
        with self.assertRaises(ValueError):
            bind_mesh(mesh, "sha256:"+"0"*64)
        fp = pack_single_film_mesh(mesh).topology_fingerprint_v3()
        self.assertEqual(bind_mesh(mesh, fp).topology_fingerprint_v3(), fp)
        with self.assertRaises(ValueError):
            pack_single_film_mesh(replace(mesh, element_markers=np.array([2,1])))

    def test_comparison_material_and_geometry_are_bound_to_actual_metadata(self):
        import copy
        model = {"schema": "fullmag.de-smoke.v1", "orientation": "M0=x,k=y,normal=z",
                 "outer_boundary_kind": "poisson_dirichlet", "dispersion_geometry": "damon_eshbach",
                 "film_thickness_m": 1e-8, "exchange_stiffness_j_per_m": 13e-12,
                 "saturation_magnetization_a_per_m": 800000., "gamma0_m_per_a_s": 221100.,
                 "external_induction_t": .1, "mu0_t_m_a": 4*np.pi*1e-7}
        metadata = {"problem_meta": {"runtime_metadata": {"de_smoke": model}}}
        record = {"geometry": "damon_eshbach", "parameters": {
            "film_thickness_m": 1e-8, "exchange_stiffness_j_per_m": 13e-12,
            "saturation_magnetisation_a_per_m": 800000., "gamma0_rad_s_per_a_m": 221100.,
            "bias_field_a_per_m": .1/(4*np.pi*1e-7)}}
        validate_record_parameters(record, metadata)
        for key in record["parameters"]:
            for bad in (0, True, float("nan"), record["parameters"][key]*1.001):
                with self.subTest(key=key, bad=bad):
                    changed = copy.deepcopy(record); changed["parameters"][key] = bad
                    with self.assertRaises(ValueError): validate_record_parameters(changed, metadata)
        for key, value in (("orientation", "M0=x,k=x,normal=z"),
                           ("outer_boundary_kind", "robin"), ("dispersion_geometry", "backward_volume")):
            with self.subTest(key=key):
                changed = copy.deepcopy(metadata); changed["problem_meta"]["runtime_metadata"]["de_smoke"][key] = value
                with self.assertRaises(ValueError): validate_record_parameters(record, changed)
        with self.assertRaises(ValueError): validate_record_parameters(record, {})
        record["geometry"] = "backward_volume"
        model.update(orientation="M0=x,k=x,normal=z", dispersion_geometry="backward_volume")
        validate_record_parameters(record, metadata)

    def test_record_loader_requires_unique_hash_binding_of_metadata_bytes(self):
        import hashlib
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); case = root / "pilot"; case.mkdir()
            metadata = case / "metadata.json"; metadata.write_bytes(b"{}")
            digest = hashlib.sha256(b"{}").hexdigest()
            record = {"run_path": str(root), "pilot": "pilot", "artifact_sha256": {}}
            with self.assertRaisesRegex(ValueError, "exactly one actual run metadata"):
                load_record(record)
            record["artifact_sha256"] = {"pilot/metadata.json": digest, "pilot/./metadata.json": digest}
            with self.assertRaisesRegex(ValueError, "exactly one actual run metadata"):
                load_record(record)
            record["artifact_sha256"] = {"pilot/metadata.json": "a"*64}
            # Model mutation between the first hash check and parser read is rejected.
            with patch("compare_de_bv_mode_profiles.sha256", return_value="a"*64):
                with self.assertRaisesRegex(ValueError, "metadata changed"):
                    load_record(record)

    def test_artifact_path_cannot_leave_case(self):
        root = Path.cwd()
        with self.assertRaises(ValueError):
            contained(root, "../other-case/vector.bin")


if __name__ == "__main__":
    unittest.main()
