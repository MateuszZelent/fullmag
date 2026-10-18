"""Actual Gmsh bridge regressions; geometry only, no field qualification."""
import struct
import unittest
from unittest.mock import patch
import fullmag.model.problem as problem_model
import gmsh
import fullmag as fm
from fullmag.meshing._gmsh_waveguides import add_antenna_layout_parts_to_occ
from test_antenna_coincident_cut import loop_geometry


class BridgeIdentityAffineTests(unittest.TestCase):
    def setUp(self):
        gmsh.initialize()
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.NumThreads", 1)
        gmsh.model.add("bridge_identity")

    def tearDown(self):
        gmsh.finalize()

    def build(self, transform=None, scale=1e6):
        geometry = loop_geometry(**({"transform": transform} if transform else {}))
        with patch.object(gmsh.model.occ, "affineTransform",
                          wraps=gmsh.model.occ.affineTransform) as spy:
            parts = add_antenna_layout_parts_to_occ(gmsh, geometry, scale=scale,
                                                    source_cut_offset_m=-0.3e-6)
        gmsh.model.occ.synchronize()
        return parts, spy.call_args_list

    def test_exact_identity_skips_three_calls(self):
        parts, calls = self.build()
        self.assertEqual(calls, [])
        self.assertEqual({key: len(value) for key, value in parts.items()},
                         {"signal": 1, "return": 1, "inlet": 2, "outlet": 1})

    def test_cut_plane_and_authored_node_bits(self):
        parts, _ = self.build()
        faces = [set(abs(t) for d, t in gmsh.model.getBoundary([v], oriented=False)
                     if d == 2) for v in parts["inlet"]]
        shared = faces[0] & faces[1]
        self.assertEqual(len(shared), 1)
        surface = shared.pop()
        self.assertEqual(gmsh.model.getType(2, surface), "Plane")
        gmsh.option.setNumber("Mesh.MeshSizeMin", .15)
        gmsh.option.setNumber("Mesh.MeshSizeMax", .15)
        gmsh.model.mesh.generate(2)
        tags, xyz, _ = gmsh.model.mesh.getNodes(2, surface, includeBoundary=True)
        self.assertGreater(len(tags), 0)
        self.assertTrue(all(struct.pack("<d", float(z)/1e6) == struct.pack("<d", -0.3e-6)
                            for z in xyz[2::3]))

    def test_rotation_translation_passed_bit_exact(self):
        transform = fm.RigidTransform(rotation_matrix=((0., -1., 0.),
            (1., 0., 0.), (0., 0., 1.)), translation_m=(3e-6, -2e-6, 1e-6))
        self.check_transform(transform)

    def test_tiny_translation_is_not_skipped(self):
        self.check_transform(fm.RigidTransform(translation_m=(1e-30, 0., 0.)))

    def test_nonidentity_other_scale_matrix_is_passed_bit_exact(self):
        self.check_transform(fm.RigidTransform(translation_m=(3e-6, -2e-6, 1e-6)), scale=2e6)

    def check_transform(self, transform, scale=1e6):
        _, calls = self.build(transform, scale)
        self.assertEqual(len(calls), 3)
        matrix = [value for row in range(3) for value in
                  (*transform.rotation_matrix[row], transform.translation_m[row]*scale)]
        matrix += [0, 0, 0, 1]
        for call in calls:
            self.assertEqual(call.args[0][0][0], 3)
            self.assertEqual(struct.pack("<16d", *call.args[1]), struct.pack("<16d", *matrix))


class BridgeCacheIdentityTests(unittest.TestCase):
    def test_old_recipe_is_not_a_warm_per_object_hit(self):
        geometry = loop_geometry()
        hints = fm.FEM(order=1, hmax=0.15e-6)
        identity = problem_model._fem_cache_contract_identity()
        self.assertEqual(identity["antenna_bridge_realization"], "exact_identity_noop.v1")
        old_identity = dict(identity)
        del old_identity["antenna_bridge_realization"]
        new_key = problem_model._fem_mesh_cache_key(geometry, hints)
        with patch.object(problem_model, "_fem_cache_contract_identity", return_value=old_identity):
            old_key = problem_model._fem_mesh_cache_key(geometry, hints)
        self.assertNotEqual(new_key, old_key)
        shared_kwargs = dict(study_universe=None, mesh_workflow=None,
                             per_object_recipes=None, object_regions=None)
        new_shared, _ = problem_model._fem_shared_domain_cache_document(
            [geometry], hints, cache_identity=identity, **shared_kwargs)
        old_shared, _ = problem_model._fem_shared_domain_cache_document(
            [geometry], hints, cache_identity=old_identity, **shared_kwargs)
        self.assertNotEqual(new_shared, old_shared)


if __name__ == "__main__":
    unittest.main()
