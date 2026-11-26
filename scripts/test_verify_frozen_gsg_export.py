"""Small config-mutation checks; actual pinned inputs are checked separately."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

SOURCE=b"study = 'small mathematical config fixture'\n"
PATH='/bounded/source/gsg_convergence_100nm.py'
PIPELINE={'version':'study_pipeline.v1','nodes':[{'id':'inspect_gsg','label':'Antenna Field Solve 1',
 'enabled':True,'source':'script_imported','node_kind':'primitive','stage_kind':'antenna_field_solve',
 'payload':{'kind':'antenna_field_solve','entrypoint_kind':'flat_antenna_field_solve',
            'stage_id':'inspect_gsg','port_mode_ids':['gsg_port']}}]}


def fixture():
    meta={'name':'gsg_convergence_100nm','entrypoint_kind':'direct','script_source':None,'source_hash':None,
          'runtime_metadata':{'interactive_session_requested':True,'runtime_selection':{'backend':'fem','device':'cpu'},
          'model_builder':{'source_kind':'problem_model','entrypoint_kind':'direct','problem':{'strict':True}},
          'script_sync':{'source_kind':'problem_model','entrypoint_kind':'direct'},'source_owner':'fixed'}}
    frozen={'problem_meta':meta,'geometry_assets':{'source':{'nodes':[[0.,0.,0.]]},'target':{'nodes':[[1.,0.,0.]]}},
            'current_modules':[{'sigma':3.5e7,'jump_V':.001,'cut_pairs':[[1,2]]}],
            'antenna_field_solve_stages':[{'id':'inspect_gsg','port':'gsg_port'}]}
    stages=[]
    for kind in ['flat_workspace','flat_antenna_field_solve']:
        ir=deepcopy(frozen);ir['geometry_assets']=None;m=ir['problem_meta'];r=m['runtime_metadata']
        import hashlib
        m.update(entrypoint_kind=kind,script_source=SOURCE.decode(),source_hash=hashlib.sha256(SOURCE).hexdigest())
        r.update(output_storage_source_dir='/bounded/source',output_storage_source_stem='gsg_convergence_100nm',study_pipeline=deepcopy(PIPELINE))
        r['model_builder'].update(source_kind='flat_script',entrypoint_kind=kind,study_pipeline=deepcopy(PIPELINE))
        r['script_sync'].update(source_kind='flat_script',entrypoint_kind=kind,study_pipeline_version='study_pipeline.v1',study_pipeline_node_count=1)
        if kind=='flat_antenna_field_solve':r.update(interactive_session_requested=False,active_stage_id='inspect_gsg',stage_start_time_s=0.)
        stages.append(ir)
    config={'ir':stages[0],'shared_geometry_assets':deepcopy(frozen['geometry_assets']),'default_until_seconds':None,
            'study_pipeline':deepcopy(PIPELINE),'stages':[{'ir':stages[1],'default_until_seconds':None,
            'entrypoint_kind':'flat_antenna_field_solve','action':{'kind':'antenna_field_solve','stage_id':'inspect_gsg','port_mode_ids':['gsg_port']}}]}
    return frozen,config


def verify(config,frozen=None):
    import verify_frozen_gsg_export as check
    baseline=fixture()[0] if frozen is None else frozen
    # Isolate config comparison; this mock is never used by the real-input check.
    with patch.object(check,'_frozen_input',return_value=(baseline,100)):
        return check.verify_frozen_gsg_config(b'fixture',config,script_bytes=SOURCE,source_path=PATH)


class FrozenGsgExportTests(unittest.TestCase):
    def test_exact_flat_single_stage_export_matches_without_qualification(self):
        frozen,config=fixture();before=deepcopy(config);result=verify(config,frozen)
        self.assertEqual(result['status'],'FROZEN CONFIG EQUIVALENCE ONLY')
        self.assertFalse(result['accepted_owner_authenticated']);self.assertFalse(result['qualified_basis'])
        self.assertEqual(config,before)

    def test_changed_conductivity_source_jump_or_cut_is_refused(self):
        for key,value in [('sigma',1.),('jump_V',-.001),('cut_pairs',[[2,1]])]:
            c=fixture()[1];c['stages'][0]['ir']['current_modules'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):verify(c)

    def test_source_or_target_mesh_drift_is_refused(self):
        for asset in ['source','target']:
            c=fixture()[1];c['shared_geometry_assets'][asset]['nodes'][0][0]=2.
            with self.assertRaises(ValueError):verify(c)

    def test_backend_device_drift_in_any_ir_is_refused(self):
        for stage in [False,True]:
            c=fixture()[1];ir=c['stages'][0]['ir'] if stage else c['ir']
            ir['problem_meta']['runtime_metadata']['runtime_selection']['device']='gpu'
            with self.assertRaises(ValueError):verify(c)

    def test_pipeline_or_stage_added_disabled_reordered_or_changed_is_refused(self):
        for change in ['extra_stage','disabled','wrong_stage','wrong_port','run_action']:
            c=fixture()[1]
            if change=='extra_stage':c['stages'].append(deepcopy(c['stages'][0]))
            elif change=='disabled':c['study_pipeline']['nodes'][0]['enabled']=False
            elif change=='wrong_stage':c['stages'][0]['action']['stage_id']='relax'
            elif change=='wrong_port':c['stages'][0]['action']['port_mode_ids']=['other']
            else:c['stages'][0]['action']['kind']='run'
            with self.subTest(change=change),self.assertRaises(ValueError):verify(c)

    def test_unknown_metadata_extra_config_or_model_builder_drift_is_refused(self):
        for change in ['metadata','config','builder']:
            c=fixture()[1]
            if change=='metadata':c['ir']['problem_meta']['runtime_metadata']['unknown']=True
            elif change=='config':c['extra']=None
            else:c['ir']['problem_meta']['runtime_metadata']['model_builder']['problem']['strict']=False
            with self.assertRaises(ValueError):verify(c)

    def test_stage_horizon_interactive_and_start_time_drift_are_refused(self):
        for field,value in [('default_until_seconds',1.),('interactive_session_requested',True),('stage_start_time_s',1.)]:
            c=fixture()[1]
            if field=='default_until_seconds':c['stages'][0][field]=value
            else:c['stages'][0]['ir']['problem_meta']['runtime_metadata'][field]=value
            with self.assertRaises(ValueError):verify(c)

    def test_source_text_hash_path_and_output_destination_drift_are_refused(self):
        for field,value in [('script_source','other'),('source_hash','0'*64)]:
            c=fixture()[1];c['ir']['problem_meta'][field]=value
            with self.assertRaises(ValueError):verify(c)
        c=fixture()[1];c['stages'][0]['ir']['problem_meta']['runtime_metadata']['output_storage_source_dir']='/other'
        with self.assertRaises(ValueError):verify(c)

    def test_signed_zero_type_drift_and_nonfinite_data_are_refused(self):
        for value in [-0.,0,True,float('nan')]:
            c=fixture()[1];c['shared_geometry_assets']['source']['nodes'][0][0]=value
            with self.assertRaises(ValueError):verify(c)

    def test_missing_or_duplicated_geometry_payload_is_refused(self):
        for where in ['missing','base','stage']:
            c=fixture()[1]
            if where=='missing':c['shared_geometry_assets']=None
            elif where=='base':c['ir']['geometry_assets']=deepcopy(c['shared_geometry_assets'])
            else:c['stages'][0]['ir']['geometry_assets']=deepcopy(c['shared_geometry_assets'])
            with self.assertRaises(ValueError):verify(c)

    def test_pinned_input_does_not_allow_a_different_script(self):
        import hashlib
        import verify_frozen_gsg_export as check
        raw=json.dumps(fixture()[0]).encode()
        with patch.object(check,'SOURCE_IR_SHA256S',(hashlib.sha256(raw).hexdigest(),)):
            with self.assertRaisesRegex(ValueError,'script identity'):
                check.verify_frozen_gsg_config(raw,fixture()[1],script_bytes=SOURCE,source_path=PATH)

    def test_nonbyte_pin_inputs_are_refused_before_json_loading(self):
        from verify_frozen_gsg_export import verify_frozen_gsg_config
        for raw,source in [('text',SOURCE),(b'{}','text')]:
            with self.assertRaisesRegex(ValueError,'input bytes'):
                verify_frozen_gsg_config(raw,fixture()[1],script_bytes=source,source_path=PATH)

    def test_unregistered_actual_input_is_refused_without_mock(self):
        from verify_frozen_gsg_export import verify_frozen_gsg_config
        with self.assertRaisesRegex(ValueError,'registered'):
            verify_frozen_gsg_config(json.dumps(fixture()[0]).encode(),fixture()[1],script_bytes=SOURCE,source_path=PATH)

    def test_noncanonical_source_path_is_refused(self):
        import verify_frozen_gsg_export as check
        with patch.object(check,'_frozen_input',return_value=(fixture()[0],100)):
            for path in ['relative.py','/bounded/../source/gsg_convergence_100nm.py','/bounded/wrong.py']:
                with self.assertRaises(ValueError):check.verify_frozen_gsg_config(b'fixture',fixture()[1],script_bytes=SOURCE,source_path=path)


if __name__=='__main__':unittest.main()
