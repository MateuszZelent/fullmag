"""Compare the complete frozen GSG config; never produce stages or authenticate a run."""
from copy import deepcopy
import hashlib
import json
from pathlib import PurePosixPath

from antenna_gsg_convergence_reference import SOURCE_IR_SHA256S

SCRIPT_SHA256S=(
    'fa71554c2e58ef7540edc27c64cb412d9c026770d0f8ad100f23bce7ebf1247d',
    'f8bce2565f7de8bdb49a397c6ee2153a7d1d0756a24991067a8e5fc4e6f9185a',
    '299c77b22dc123613949b084ffe3a39591e24452db00c5848ebf9bba97f33939',
)


def _require(condition,reason):
    if not condition:
        raise ValueError(reason)


def _frozen_input(frozen_ir_bytes,script_bytes):
    _require(type(frozen_ir_bytes) is bytes and type(script_bytes) is bytes,'registered input bytes required')
    digest=hashlib.sha256(frozen_ir_bytes).hexdigest()
    _require(digest in SOURCE_IR_SHA256S,'unregistered frozen GSG input')
    index=SOURCE_IR_SHA256S.index(digest)
    _require(hashlib.sha256(script_bytes).hexdigest()==SCRIPT_SHA256S[index],'registered script identity differs')
    return json.loads(frozen_ir_bytes),(100,75,50)[index]


def _canonical(value):
    try:
        return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
    except (TypeError,ValueError) as error:
        raise ValueError('config must contain finite JSON data') from error


def verify_frozen_gsg_config(frozen_ir_bytes,config,*,script_bytes,source_path):
    """Check the one approved flat export without stripping any unknown metadata.

    This reads no files, executes no script and never returns an executable
    config. Native capture, accepted ownership and preparation stay separate.
    """
    frozen,level=_frozen_input(frozen_ir_bytes,script_bytes)
    _require(isinstance(config,dict),'complete config required')
    _require(isinstance(source_path,str),'explicit source path required')
    path=PurePosixPath(source_path);stem='gsg_convergence_'+str(level)+'nm'
    _require(path.is_absolute() and str(path)==source_path and '..' not in path.parts and
             path.name==stem+'.py','canonical source path identity differs')
    _require(frozen['problem_meta']['name']==stem,'frozen problem name differs')
    pipeline={'version':'study_pipeline.v1','nodes':[{'id':'inspect_gsg','label':'Antenna Field Solve 1',
        'enabled':True,'source':'script_imported','node_kind':'primitive','stage_kind':'antenna_field_solve',
        'payload':{'kind':'antenna_field_solve','entrypoint_kind':'flat_antenna_field_solve',
                   'stage_id':'inspect_gsg','port_mode_ids':['gsg_port']}}]}

    def expected_ir(kind):
        # An expected comparison value only; the canonical exporter builds real stages.
        ir=deepcopy({k:v for k,v in frozen.items() if k!='geometry_assets'});ir['geometry_assets']=None
        meta=ir['problem_meta'];runtime=meta['runtime_metadata']
        meta.update(entrypoint_kind=kind,script_source=script_bytes.decode('utf-8'),
                    source_hash=hashlib.sha256(script_bytes).hexdigest())
        runtime.update(output_storage_source_dir=str(path.parent),output_storage_source_stem=stem,
                       study_pipeline=deepcopy(pipeline))
        runtime['model_builder'].update(source_kind='flat_script',entrypoint_kind=kind,study_pipeline=deepcopy(pipeline))
        runtime['script_sync'].update(source_kind='flat_script',entrypoint_kind=kind,
                                     study_pipeline_version='study_pipeline.v1',study_pipeline_node_count=1)
        if kind=='flat_antenna_field_solve':
            runtime.update(interactive_session_requested=False,active_stage_id='inspect_gsg',stage_start_time_s=0.)
        return ir

    expected={'ir':expected_ir('flat_workspace'),'shared_geometry_assets':frozen['geometry_assets'],
              'default_until_seconds':None,'study_pipeline':pipeline,'stages':[{
                  'ir':expected_ir('flat_antenna_field_solve'),'default_until_seconds':None,
                  'entrypoint_kind':'flat_antenna_field_solve',
                  'action':{'kind':'antenna_field_solve','stage_id':'inspect_gsg','port_mode_ids':['gsg_port']}}]}
    actual=_canonical(config)
    _require(actual==_canonical(expected),'complete config differs from the frozen single-stage export')
    return {'status':'FROZEN CONFIG EQUIVALENCE ONLY','qualification':'NOT VERIFIED','qualified_basis':False,
            'accepted_owner_authenticated':False,'native_prepare_verified':False,'level_nm':level,
            'frozen_ir_sha256':hashlib.sha256(frozen_ir_bytes).hexdigest(),
            'script_sha256':hashlib.sha256(script_bytes).hexdigest(),
            'config_canonical_sha256':hashlib.sha256(actual).hexdigest(),'source_path':source_path}
