"""Contract tests only; synthetic payloads never qualify a scientific source."""
import copy
import hashlib
import itertools
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import run_gsg_junction_reference as junction
from antenna_gsg_convergence_reference import GsgJunctionFineBudget, TARGETS_M

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def fixture(root):
    samples = [(x,y,z) for x in (-2e-6,-4.5e-7,0.,4.5e-7,2e-6)
               for y in (-5e-8,5e-8) for z in (-2.24e-8,-5e-9)]
    target_cells = []
    for start in range(0,16,4):
        for order in itertools.permutations((4,2,1)):
            a,b,c = order
            target_cells.extend((start,start+a,start+a+b,start+a+b+c))
    vertices = [[0.,0.,30e-9],[10e-9,0.,30e-9],[0.,10e-9,30e-9],[0.,0.,40e-9]]
    current = [[0.,1.,0.]]*4
    cells = struct.pack('<5Q30d',0,0,1,2,3,*sum(vertices,[]),*sum(current,[]),
                        2.5e-9,2.5e-9,32.5e-9,0.,1.,0.)
    data = {
        'cells':cells,'vertex_xyz':struct.pack('<12d',*sum(vertices,[])),
        'stable_vertex_ids':struct.pack('<4Q',0,1,2,3),'conductivity':struct.pack('<d',35000000.),
        'j_local_raw':struct.pack('<12d',*sum(current,[])),'j_center_raw':struct.pack('<3d',0.,1.,0.),
        'v_raw':struct.pack('<4d',0.,0.,0.,0.),
        'sample_xyz':b''.join(struct.pack('<3d',*r) for r in samples),
        'sample_cells':struct.pack('<96I',*target_cells),
        'h_raw':struct.pack('<60d',*([1.,2.,3.]*20)),
    }
    source = dict(object_id='antenna',geometry_id='antenna',stable_vertex_ids=[0,1,2,3],
                  closure={'kind':'full'},mesh_digest=sha(b'mesh'),materials_digest=sha(b'material'),
                  authored_input_digest=sha(b'intent'))
    ir = {'current_modules':[{'name':'gsg','conservative_current_source':source,
                              'materials':[{'material':{'sigma_Spm':35000000.}}]}],
          'geometry_assets':{'fem_mesh_assets':[{'geometry_name':'antenna','mesh':{
              'nodes':vertices,'cells':{'types':['tet4'],'offsets':[0,4],'nodes':[0,1,2,3]}}}],
              'fem_domain_mesh_asset':{'mesh':{'nodes':samples,'cells':{
                  'types':['tet4']*24,'offsets':list(range(0,97,4)),'nodes':target_cells}}}}}
    manifest = dict(schema_version='antenna_field_solution.v2',status='inspection_only',solution_id='fine',
                    cell_count=1,vertex_count=4,target_count=20,source_object_id='antenna',
                    current_transport_id='gsg',full_closure=source['closure'],
                    requested_intent={k:source[k] for k in ('mesh_digest','materials_digest','authored_input_digest')},
                    source={'source_current_a':1.5e-5,'accepted_source_state_digest':sha(b'state'),
                            'prepared_execution_digest':sha(b'prepared')},
                    payloads={k:{'path':'antenna/field_solutions/fine/'+k+'.bin',
                                 'byte_length':len(v),'sha256':sha(v)} for k,v in data.items()})
    meta = json.dumps(manifest).encode()
    bundle = b'FMACLB01'+struct.pack('<QI',len(meta),len(data))+meta
    for key in sorted(data):
        path = manifest['payloads'][key]['path'].encode()
        bundle += struct.pack('<H',len(path))+path+struct.pack('<Q',len(data[key]))+data[key]
    ir_raw = json.dumps(ir).encode()
    (root/'source.json').write_bytes(ir_raw);(root/'source.bundle').write_bytes(bundle)
    run = dict(project_id='project-a',run_id='run-a',solution_set_id='solution-a',revision='2',
               payload_fingerprint=sha(b'run'))
    expected, frames = [], {}
    for field,key,unit,components,elements in [
        ('field:V_electric','v_raw','V',1,4),('field:J_charge','j_local_raw','A/m^2',3,4),
        ('field:H_ant','h_raw','A/m',3,20)]:
        payload=data[key];digest=sha(payload)
        provenance=dict(run_id=run['run_id'],solution_set_id=run['solution_set_id'],solution_revision=1,
                        member_id='member-a',artifact_id='tensor-'+key,tensor_object_ref=sha(key.encode()),
                        run_spec_digest='sha256:'+sha(b'run-spec'))
        row=dict(member_id='member-a',artifact_id='artifact-'+key,manifest_object_ref=sha(b'manifest'+key.encode()),
                 source=provenance,unit=unit,dataset_id='dataset-'+key,dataset_revision='1',
                 sample_id='default',item_id='item-'+key,field_id=field,elements=elements,components=components,
                 payload_bytes=len(payload),payload_sha256=digest,parts=[dict(object_ref=digest,bytes=len(payload))])
        transport=dict(project_id=run['project_id'],run_id=run['run_id'],solution_set_id=run['solution_set_id'],
                       containing_solution_revision=run['revision'],member_id=row['member_id'],artifact_id=row['artifact_id'],
                       manifest_object_ref=row['manifest_object_ref'],source=dict(provenance,solution_revision='1'),
                       descriptor={'unit':unit},slice=dict(dataset_id=row['dataset_id'],dataset_revision='1',sample_id='default',
                       item_id=row['item_id'],field_id=field,element_offset='0',element_count=str(elements),
                       total_elements=str(elements),component_count=str(components),precision='f64',byte_order='little_endian',
                       payload_bytes=str(len(payload)),parts=[dict(object_ref=digest,plane='values',object_offset_bytes='0',
                       plane_offset_bytes='0',byte_length=str(len(payload)),range_sha256='sha256:'+digest)]))
        raw=json.dumps(transport).encode();frames[field]=b'FMDS\x01\x00\x00\x00'+struct.pack('<I',len(raw))+raw+payload
        expected.append(row)
    binding=dict(schema='fullmag.gsg-junction-reference-source.v1',label='corner12p5',cells=1,
                 ir_path='source.json',ir_sha256=sha(ir_raw),bundle_path='source.bundle',bundle_sha256=sha(bundle),
                 source_current_a=manifest['source']['source_current_a'],
                 source_state_sha256=manifest['source']['accepted_source_state_digest'],
                 prepared_execution_sha256=manifest['source']['prepared_execution_digest'],run=dict(run,datasets=expected))
    class Client:
        fail=False
        def json(self,path):
            if self.fail:raise ValueError('HTTP404')
            if path.endswith('/saved-field-geometry'):
                return {'node_count':'20','source':expected[2]['source']}
            if '/revisions/' in path:return {'execution_status':'succeeded'}
            return dict(run,tasks=[{'lifecycle':'succeeded'}])
        def get(self,path,query=None,**kw):
            if self.fail:raise ValueError('HTTP404')
            return frames[query['field_id']]
    return binding,data,manifest,Client()

class JunctionReferenceTests(unittest.TestCase):
    def test_explicit_86k_binding_keeps_the_old80k_default(self):
        work="gsg_junction_fine_reference_86k_v1"
        self.binding["cells"]=85980
        junction.validate_binding(self.binding,work_profile=work)
        with self.assertRaises(ValueError):
            junction.validate_binding(self.binding)
        for count in (86001,True,85980.,0):
            self.binding["cells"]=count
            with self.subTest(count=count),self.assertRaises(ValueError):
                junction.validate_binding(self.binding,work_profile=work)
        self.binding["cells"]=1
        with self.assertRaises(ValueError):
            junction.validate_binding(self.binding,work_profile="unknown")

    def test_86k_driver_passes_explicit_source_profile_to_same_three_checks(self):
        data,proof=self.load();seen=[]
        budget=GsgJunctionFineBudget(proof["ir_sha256"],work_profile="gsg_junction_fine_reference_86k_v1")
        def evaluate(rows,target,count,budget,**kwargs):
            seen.append(kwargs["cell_limit_profile"])
            return {"cells_completed":count,"native_comparison":{"within_gate":True}}
        with patch.object(junction,"evaluate_retained_field",side_effect=evaluate):
            junction.run_checks(data,proof,budget,lambda *args:None)
        self.assertEqual(seen,["gsg_junction_refinement_86k.v1"]*3)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.binding,self.data,self.manifest,self.client=fixture(self.root)

    def load(self):
        return junction.load_source(self.client,self.binding,self.root)

    def test_exact_full_source_and_all_three_http_fields_are_verified(self):
        data,proof=self.load()
        self.assertEqual(data,self.data)
        self.assertEqual(proof['source_current_a'],1.5e-5)
        self.assertEqual(len(proof['http_fields']),3)
        self.assertEqual(proof['sample_xyz_sha256'],junction.SAMPLE_XYZ_SHA256)

    def test_closed_cell_count_and_identity_refuse_before_evaluation(self):
        for count in (80001,True,1.5,0,-1):
            with self.subTest(count=count):
                self.binding['cells']=count
                with self.assertRaises(ValueError):self.load()
        self.binding['cells']=1
        for key in ('ir_sha256','bundle_sha256','source_state_sha256','prepared_execution_sha256'):
            with self.subTest(key=key):
                original=self.binding[key];self.binding[key]='f'*64
                with self.assertRaises(ValueError):self.load()
                self.binding[key]=original

    def test_signed_current_is_not_fitted_or_flipped(self):
        for current in (-1.5e-5,True,0.,float('nan'),float('inf')):
            with self.subTest(current=current):
                self.binding['source_current_a']=current
                with self.assertRaises(ValueError):self.load()

    def test_foreign_target_or_incomplete_carrier_cannot_pass(self):
        for key in ('sample_xyz','cells','j_local_raw'):
            with self.subTest(key=key):
                changed=dict(self.data);changed[key]=changed[key][:-8]
                with patch.object(junction,'decode_bundle',return_value=(self.manifest,changed)):
                    with self.assertRaises(ValueError):self.load()

    def test_foreign_http_run_or_payload_refuses_before_reference(self):
        with patch.object(self.client,'json',return_value={'run_id':'other'}):
            with self.assertRaises((ValueError,KeyError)):self.load()
        self.client.fail=True
        with patch.object(junction,'evaluate_retained_field') as evaluate:
            with self.assertRaisesRegex(ValueError,'HTTP404'):self.load()
        evaluate.assert_not_called()

    def test_source_paths_cannot_leave_registered_tree(self):
        for path in ('../other','/etc/passwd','a/../../other'):
            with self.subTest(path=path):
                self.binding['ir_path']=path
                with self.assertRaises(ValueError):self.load()

    def test_three_points_share_one_budget_and_preserve_signed_native_values(self):
        data,proof=self.load();records=[];seen=[]
        def evaluate(rows,target,count,budget,**kw):
            seen.append((id(budget),target,kw['native_h_apm'],kw['cell_limit_profile']))
            budget.activate(struct.pack('<3d',*target).hex())
            for _ in range(12*count):budget.charge('pairs')
            return {'cells_completed':count,'native_comparison':{'within_gate':True}}
        budget=GsgJunctionFineBudget(proof['ir_sha256'])
        with patch.object(junction,'evaluate_retained_field',side_effect=evaluate):
            values=junction.run_checks(data,proof,budget,lambda name,value:records.append((name,value)))
        self.assertEqual(len(values),3)
        self.assertEqual(len({v[0] for v in seen}),1)
        self.assertEqual([v[1] for v in seen],list(TARGETS_M))
        self.assertTrue(all(v[2]==(1.,2.,3.) for v in seen))
        self.assertEqual(budget.report()['counts']['pairs'],36)
        self.assertTrue(all(v[3]=='gsg_junction_refinement_80k.v1' for v in seen))

    def test_first_failed_gate_stops_without_retry(self):
        data,proof=self.load()
        budget=GsgJunctionFineBudget(proof['ir_sha256'])
        with patch.object(junction,'evaluate_retained_field',return_value={
                'cells_completed':1,'native_comparison':{'within_gate':False}}) as evaluate:
            with self.assertRaisesRegex(ValueError,'gate'):
                junction.run_checks(data,proof,budget,lambda *args:None)
        self.assertEqual(evaluate.call_count,1)

    def test_second_failed_gate_retains_completed_values_and_failure_counts(self):
        data,proof=self.load();results=[];calls=[]
        def evaluate(*args,**kwargs):
            calls.append(None)
            return {'cells_completed':1,'native_comparison':{'within_gate':len(calls)==1}}
        budget=GsgJunctionFineBudget(proof['ir_sha256'])
        with patch.object(junction,'evaluate_retained_field',side_effect=evaluate):
            with self.assertRaisesRegex(ValueError,'gate'):
                junction.run_checks(data,proof,budget,lambda *args:None,results=results)
        self.assertEqual(len(results),2)
        self.assertEqual(sum(v['native_comparison']['within_gate'] for v in results),1)
        self.assertEqual(len(calls),2)

    def test_dual_evidence_has_identical_bytes_and_refuses_unbounded_name(self):
        control=self.root/'control';scientific=self.root/'scientific'
        control.mkdir();scientific.mkdir()
        junction.write_evidence('progress.json',{'new_solve':False},control,scientific)
        self.assertEqual((control/'progress.json').read_bytes(),(scientific/'progress.json').read_bytes())
        for name in ('../outside','anything.json'):
            with self.subTest(name=name),self.assertRaises(ValueError):
                junction.write_evidence(name,{},control,scientific)

if __name__=='__main__':
    unittest.main()
