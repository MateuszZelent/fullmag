"""Public canonical u32 markers must survive authoring, topology and storage."""
from __future__ import annotations
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
import numpy as np
from fullmag.meshing._gmsh_types import MeshData
from fullmag.meshing._gmsh_extraction import _derive_facet_roles, _meshio_cell_markers
from fullmag.meshing.persistence import _serialize_mesh, _deserialize_mesh, _remap_mesh_markers
from fullmag.model.current_transport import TerminalLeadExtension

class FemU32MarkerRoundTripTests(unittest.TestCase):
    @staticmethod
    def mesh(marker=2**32-1, boundary=(0,1,2**31,2**32-1)):
        return MeshData.from_legacy_tet4(nodes=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]],
            elements=[[0,1,2,3]],element_markers=np.array([marker],dtype=np.uint32),
            boundary_faces=[[0,2,1],[0,1,3],[0,3,2],[1,2,3]],
            boundary_markers=np.array(boundary,dtype=np.uint32))

    def test_high_markers_survive_ir_and_persistence(self):
        mesh=self.mesh();ir=mesh.to_ir('domain')
        self.assertEqual(ir['element_markers'],[2**32-1])
        self.assertEqual(ir['boundary_markers'],[0,1,2**31,2**32-1])
        restored=_deserialize_mesh(_serialize_mesh(mesh))
        self.assertEqual(restored.element_markers.tolist(),[2**32-1])
        self.assertEqual(restored.boundary_markers.tolist(),[0,1,2**31,2**32-1])
        self.assertEqual(restored.topology_fingerprint_v2(),mesh.topology_fingerprint_v2())
        self.assertEqual(restored.topology_fingerprint_v3(),mesh.topology_fingerprint_v3())

    def test_legacy_nonnegative_int32_assets_keep_semantic_fingerprints(self):
        mesh=self.mesh(7,(0,1,2,3));payload=_serialize_mesh(mesh)
        with np.load(BytesIO(payload),allow_pickle=False) as data: arrays={key:data[key] for key in data.files}
        for name in ('element_markers','boundary_markers'): arrays[name]=arrays[name].astype(np.int32)
        old=BytesIO();np.savez_compressed(old,**arrays)
        before=old.getvalue();restored=_deserialize_mesh(before)
        self.assertEqual(old.getvalue(),before)
        self.assertEqual(restored.topology_fingerprint_v2(),mesh.topology_fingerprint_v2())
        self.assertEqual(restored.topology_fingerprint_v3(),mesh.topology_fingerprint_v3())

    def test_invalid_marker_arrays_fail_before_unsigned_conversion(self):
        for values in ([-1],[2**32],[1.5],[True],[True,1]):
            mesh=self.mesh(7,(1,1,1,1))
            inputs={name:getattr(mesh,name) for name in ('nodes','cell_types','cell_offsets','cell_nodes','element_markers',
                'facet_types','facet_roles','facet_offsets','facet_nodes','boundary_markers','cell_global_ordinals','facet_global_ordinals')}
            inputs['element_markers']=values
            with self.subTest(values=values),self.assertRaises(ValueError): MeshData(**inputs)

    def test_high_marker_facet_incidence_preserves_interface_and_periodic_roles(self):
        # One shared triangle and the six exterior faces of two tets.
        facets=[[0,1,2],[0,1,3],[0,2,3],[1,2,3],[0,1,4],[0,2,4],[1,2,4]]
        roles=_derive_facet_roles(['tet4','tet4'],[0,4,8],[0,1,2,3,0,2,1,4],
            np.array([2**31,2**32-1],dtype=np.uint32),list(range(0,22,3)),[i for f in facets for i in f],
            np.array([10,2**32-1,1,1,1,1,1],dtype=np.uint32),periodic_markers={2**32-1})
        self.assertEqual(roles,['material_interface','periodic_seam']+['exterior']*5)

    def test_meshio_and_interchange_remap_keep_full_u32(self):
        raw=SimpleNamespace(cells=[SimpleNamespace(type='tetra',data=np.array([[0,1,2,3]]))],
            cell_data={'gmsh:physical':[np.array([2**32-1],dtype=np.uint32)]},field_data={})
        self.assertEqual(_meshio_cell_markers(raw,cell_type='tetra').tolist(),[2**32-1])
        raw.field_data={'airbox':np.array([2**32-1,3])}
        self.assertEqual(_meshio_cell_markers(raw,cell_type='tetra',preserve_physical_tags=True).tolist(),[2**32-1])
        low=self.mesh(7,(1,1,1,1));mapped=_remap_mesh_markers(low,{7:2**32-1},{1:2**31})
        self.assertEqual(mapped.element_markers.tolist(),[2**32-1])
        self.assertEqual(mapped.boundary_markers.tolist(),[2**31]*4)

    def test_gmsh_comsol_and_native_artifacts_roundtrip_high_markers(self):
        from fullmag.meshing.persistence import (save_mesh_artifact, load_mesh_artifact,
            export_gmsh_mesh, import_gmsh_mesh, export_comsol_mesh, import_comsol_mesh)
        mesh=MeshData.from_legacy_tet4(
            nodes=[[0,0,0],[1,0,0],[0,1,0],[0,0,1],[3,0,0],[4,0,0],[3,1,0],[3,0,1]],
            elements=[[0,1,2,3],[4,5,6,7]],element_markers=np.array([2**32-1,0],dtype=np.uint32),
            boundary_faces=[[0,2,1],[0,1,3],[0,3,2],[1,2,3],[4,6,5],[4,5,7],[4,7,6],[5,6,7]],
            boundary_markers=np.array([2**31]*4+[2**32-1]*4,dtype=np.uint32))
        with TemporaryDirectory() as tmp:
            root=Path(tmp);native=root/'high.fullmag-mesh'
            save_mesh_artifact(native,mesh=mesh,mesh_name='domain',authoring_document={},
                region_markers=[{'geometry_name':'airbox','marker':2**32-1}],
                boundary_map={'left':2**31,'right':2**32-1})
            artifact=load_mesh_artifact(native)
            for filename,exporter,importer in (
                ('high.msh',export_gmsh_mesh,import_gmsh_mesh),
                ('high.mphtxt',export_comsol_mesh,import_comsol_mesh)):
                with self.subTest(format=filename):
                    path=root/filename;exporter(artifact,path);restored=importer(path,coordinate_unit='m')
                    self.assertEqual(restored.region_markers,artifact.region_markers)
                    self.assertEqual(restored.boundary_map,artifact.boundary_map)
                    self.assertEqual(sorted(restored.mesh.element_markers.tolist()),[0,2**32-1])
                    self.assertEqual(sorted(restored.mesh.boundary_markers.tolist()),[2**31]*4+[2**32-1]*4)

    def test_terminal_extension_keeps_high_selectors_and_refuses_invalid(self):
        kwargs=dict(id='left',observation_id='obs',object_id='body',length_m=1e-6,
                    outward_direction_xyz=(-1.,0.,0.),conductivity_spm=4e7)
        extension=TerminalLeadExtension(boundary_markers=(2**31,2**32-1),**kwargs)
        self.assertEqual(extension.boundary_markers,(2**31,2**32-1))
        for markers in ((0,),(-1,),(2**32,),(True,)):
            with self.subTest(markers=markers),self.assertRaises(ValueError):TerminalLeadExtension(boundary_markers=markers,**kwargs)

if __name__=='__main__':unittest.main()
