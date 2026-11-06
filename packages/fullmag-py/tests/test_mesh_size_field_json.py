"""JSON-array lowering for mesh size fields; no mesh generation."""
import json
from pathlib import Path
import tempfile
import unittest
import fullmag as fm
from fullmag.runtime.script_builder import render_loaded_problem_as_script
from fullmag.runtime.transport_identity import tagged_json_digest

BASE = """import fullmag as fm
study = fm.study('json-field')
study.engine('fem')
study.device('cpu', precision='double')
study.mode('strict')
study.objects.mesh.defaults(maximum_element_size=75e-9, minimum_element_size=50e-9, order=1)
study.antenna_object(fm.Box(1e-6, 1e-6, 90e-9), name='source', object_id='antenna')
study.objects.mesh.by_id('antenna').size_field(
    'AxisAlignedBoxDistanceThreshold',
    BoundsMin={minimum}, BoundsMax={maximum},
    SizeMin=50e-9, SizeMax=75e-9, DistMin=0.0, DistMax=200e-9)
"""

class MeshSizeFieldJsonTests(unittest.TestCase):
    def setUp(self):
        self.context=fm.execution_context()
        self.context.__enter__()
        self.addCleanup(self.context.__exit__,None,None,None)
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root=Path(self.directory.name)

    def load(self, minimum, maximum, name='input.py'):
        source=self.root/name
        source.write_text(BASE.format(minimum=repr(minimum),maximum=repr(maximum)))
        return fm.load_problem_from_script(source,lightweight_assets=True)

    @staticmethod
    def workflow(loaded):
        return loaded.problem.runtime_metadata['mesh_workflow']

    def test_vector_parameters_are_plain_json_and_keep_wire_identity(self):
        for container in (tuple,list):
            with self.subTest(container=container.__name__):
                minimum=container((-550e-9,-12e-6,30e-9))
                maximum=container((550e-9,-9.8e-6,120e-9))
                value=self.workflow(self.load(minimum,maximum))
                wire=json.loads(json.dumps(value,allow_nan=False))
                self.assertEqual(value,wire)
                params=value['per_geometry'][0]['size_fields'][0]['params']
                self.assertIs(type(params['BoundsMin']),list)
                self.assertEqual(params['BoundsMin'],list(minimum))
                self.assertEqual(params['BoundsMax'],list(maximum))
                self.assertEqual(tagged_json_digest(value),tagged_json_digest(wire))

    def test_tuple_and_list_authoring_roundtrip_to_identical_metadata(self):
        loaded=self.load((-550e-9,-12e-6,30e-9),(550e-9,-9.8e-6,120e-9))
        wire=json.dumps(self.workflow(loaded),sort_keys=True,separators=(',',':'),allow_nan=False)
        script=self.root/'exported.py'
        script.write_text(render_loaded_problem_as_script(loaded))
        reloaded=fm.load_problem_from_script(script,lightweight_assets=True)
        self.assertEqual(self.workflow(loaded),self.workflow(reloaded))
        self.assertEqual(tagged_json_digest(self.workflow(loaded)),tagged_json_digest(self.workflow(reloaded)))
        # The existing renderer may print 0.0 as 0; the tagged-f64 identity is canonical.
        self.assertEqual(json.loads(json.dumps(self.workflow(reloaded),allow_nan=False)),json.loads(wire))

    def test_original_parameter_list_cannot_mutate_committed_size_field(self):
        study=fm.study('detached-field')
        study.geometry_object(fm.Box(1e-6,1e-6,1e-6),name='sample',object_id='sample')
        handle=study.objects.mesh.by_id('sample')
        minimum=[0.0,0.0,0.0];maximum=[1e-6,1e-6,1e-6]
        handle.size_field('AxisAlignedBoxDistanceThreshold',BoundsMin=minimum,BoundsMax=maximum,
                          SizeMin=50e-9,SizeMax=75e-9,DistMin=0.0,DistMax=200e-9)
        minimum[0]=123.0
        self.assertEqual(handle._owner._mesh_spec.size_fields[0]['params']['BoundsMin'][0],0.0)

    def test_non_json_parameter_refuses_before_appending_field(self):
        study=fm.study('invalid-field')
        study.geometry_object(fm.Box(1e-6,1e-6,1e-6),name='sample',object_id='sample')
        handle=study.objects.mesh.by_id('sample')
        with self.assertRaises((TypeError,ValueError)):
            handle.size_field('Ball',VIn=Path('not-a-number'))
        self.assertEqual(handle._owner._mesh_spec.size_fields,[])

if __name__=='__main__':
    unittest.main()
