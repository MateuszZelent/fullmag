"""SI conversion and immutable publication of the case mesh artifact."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_mesh as preparation


MSH = '''$MeshFormat
2.2 0 8
$EndMeshFormat
$PhysicalNames
2
3 1 "buckyball"
2 1 "outer"
$EndPhysicalNames
$Nodes
4
1 0 0 0
2 1 0 0
3 0 1 0
4 0 0 1
$EndNodes
$Elements
5
1 2 2 1 1 1 3 2
2 2 2 1 1 1 2 4
3 2 2 1 1 1 4 3
4 2 2 1 1 2 3 4
5 4 2 1 1 1 2 3 4
$EndElements
'''


class PreparationTests(unittest.TestCase):
    def test_conversion_uses_si_and_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'unit.msh';source.write_text(MSH)
            target=Path(directory)/'unit.mesh.json'
            with contextlib.redirect_stdout(io.StringIO()):
                preparation.prepare_mesh(source,target)
            mesh=json.loads(target.read_text())
            self.assertAlmostEqual(max(max(point) for point in mesh['nodes']),1e-6)
            original=target.read_bytes()
            with self.assertRaises(FileExistsError):
                preparation.prepare_mesh(source,target)
            self.assertEqual(target.read_bytes(),original)

    def test_concurrent_publication_is_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'unit.msh';source.write_text(MSH)
            target=Path(directory)/'unit.mesh.json'
            original_import=preparation.import_gmsh_mesh
            def concurrent_writer(*args,**kwargs):
                artifact=original_import(*args,**kwargs)
                target.write_bytes(b'previously prepared by another owner')
                return artifact
            with patch.object(preparation,'import_gmsh_mesh',side_effect=concurrent_writer):
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(FileExistsError):
                        preparation.prepare_mesh(source,target)
            self.assertEqual(target.read_bytes(),b'previously prepared by another owner')


if __name__=='__main__':
    unittest.main()
