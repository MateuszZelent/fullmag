"""Analytic cavity check for the case-specific buckyball mesher."""
import unittest

import gmsh
import numpy as np

from build_hollow_mesh import add_box_shell, add_nested_volumes


class HollowMeshTests(unittest.TestCase):
    def test_cavity_is_air_and_partition_is_conforming(self):
        gmsh.initialize()
        try:
            gmsh.option.setNumber("General.Terminal", 0)
            gmsh.model.add("hollow_cube")
            outer, _ = add_box_shell(gmsh, 1.0, 0.35)
            inner, _ = add_box_shell(gmsh, 0.5, 0.35)
            universe, _ = add_box_shell(gmsh, 2.0, 0.35)
            volumes = add_nested_volumes(gmsh, outer, inner, universe)
            gmsh.model.geo.synchronize()
            gmsh.model.mesh.generate(3)
            tags, coords, _ = gmsh.model.mesh.getNodes()
            xyz = np.asarray(coords).reshape(-1, 3)
            lookup = {int(tag): i for i, tag in enumerate(tags)}
            measured = {}
            faces = {}
            for name, volume in volumes.items():
                etypes, _, blocks = gmsh.model.mesh.getElements(3, volume)
                self.assertEqual(list(etypes), [4])
                cells = np.array([lookup[int(n)] for n in blocks[0]]).reshape(-1, 4)
                pts = xyz[cells]
                det = np.linalg.det(pts[:, 1:] - pts[:, :1]) / 6
                self.assertTrue(np.all(det > 0))
                measured[name] = float(det.sum())
                center = pts.mean(axis=1)
                if name == "magnetic":
                    self.assertTrue(np.all(np.max(np.abs(center), axis=1) > 0.5))
                for cell in cells:
                    for face in ((0,1,2),(0,1,3),(0,2,3),(1,2,3)):
                        key = tuple(sorted(int(cell[i]) for i in face))
                        faces[key] = faces.get(key, 0) + 1
            self.assertAlmostEqual(measured['magnetic'], 7.0, places=8)
            self.assertAlmostEqual(measured['internal_air'], 1.0, places=8)
            self.assertAlmostEqual(measured['external_air'], 56.0, places=8)
            self.assertTrue(all(n in (1, 2) for n in faces.values()))
            for face, count in faces.items():
                if count == 1:
                    pts = xyz[list(face)]
                    self.assertTrue(any(np.all(np.isclose(pts[:, axis], sign*2))
                                        for axis in range(3) for sign in (-1,1)))
        finally:
            gmsh.finalize()


if __name__ == '__main__':
    unittest.main()
