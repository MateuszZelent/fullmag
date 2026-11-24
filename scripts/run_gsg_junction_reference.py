"""Three bounded reference checks of one pinned saved junction source.

This diagnostic reads immutable V/J/H; it never starts a solver or qualifies
a reusable basis. The managed controller owns admission and the one launch.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import signal
import struct
import sys
import time
from urllib.parse import quote

from run_gsg_source_convergence_reference import checked, decode_bundle, verify_carriers, INDICES, sync_directory
from verify_archived_solution_http import Client, MAX_BINARY, MAX_METADATA, current_identity, require, verify_slice
from antenna_gsg_convergence_reference import GsgJunctionFineBudget, TARGETS_M, evaluate_retained_field, SOURCE_CELL_LIMITS

CONTROL_ROOT = Path('/opt/fullmag/control/verification/gsg-junction-fine-reference-20261112/one-approved-attempt')
SOURCE_ROOT = Path('/opt/fullmag/script-output/sushruth_2020_closed_gsg/corner12p5_20261112')
SCIENTIFIC_ROOT = SOURCE_ROOT / 'verification/reference-80k'
SAMPLE_XYZ_SHA256 = 'd22b100caf3c09f8ae484809ba4cef267d80c6a9d24415dc0153e52377da0684'
PROPOSAL_SHA256 = 'c43eb7b0c56b9673590781cebb355ee8a7f579174b98f810c6f993594c6c5198'
WHEEL_SHA256 = 'a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c'
TOOLS = {'run_gsg_source_convergence_reference.py', 'verify_archived_solution_http.py',
         'antenna_gsg_convergence_reference.py', 'antenna_rt0_surface_oracle.py',
         'antenna_triangle_surface_oracle.py'}
FIELDS = {'field:V_electric':'v_raw', 'field:J_charge':'j_local_raw', 'field:H_ant':'h_raw'}
NAMES = {'progress.json','result.json','source.json',*(f'corner12p5-target-{i}.json' for i in INDICES)}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def is_sha(value):
    return type(value) is str and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def fine_cell_profile(work_profile):
    choices={"gsg_junction_fine_reference_v1":"gsg_junction_refinement_80k.v1",
             "gsg_junction_fine_reference_86k_v1":"gsg_junction_refinement_86k.v1"}
    require(type(work_profile) is str and work_profile in choices,"unknown fine work profile")
    return choices[work_profile]


def validate_binding(value, *, work_profile="gsg_junction_fine_reference_v1"):
    cell_profile=fine_cell_profile(work_profile)
    keys = {'schema','label','cells','ir_path','ir_sha256','bundle_path','bundle_sha256',
            'source_current_a','source_state_sha256','prepared_execution_sha256','run'}
    require(type(value) is dict and set(value) == keys, 'fine source binding shape differs')
    require(value['schema'] == 'fullmag.gsg-junction-reference-source.v1'
            and value['label'] == 'corner12p5', 'fine source family differs')
    require(type(value['cells']) is int and 0 < value['cells'] <= SOURCE_CELL_LIMITS[cell_profile], 'fine source exceeds closed cell limit')
    for key in ('ir_sha256','bundle_sha256','source_state_sha256','prepared_execution_sha256'):
        require(is_sha(value[key]), 'invalid fine source digest: '+key)
    current = value['source_current_a']
    require(type(current) in (int,float) and math.isfinite(current) and current != 0., 'invalid measured signed current')
    for key in ('ir_path','bundle_path'):
        path = value[key]
        require(type(path) is str and 0 < len(path) <= 1024, 'invalid fine source path')
        parts = Path(path).parts
        require(not Path(path).is_absolute() and '..' not in parts and len(parts) <= 32
                and not any(c in path for c in '\0\r\n\\'), 'source path leaves registered tree')
    run = value['run']
    require(type(run) is dict, 'fine accepted run missing')
    for key in ('project_id','run_id','solution_set_id','revision'):
        require(type(run.get(key)) is str and 0 < len(run[key]) <= 256
                and not any(ord(c) < 32 for c in run[key]), 'invalid accepted run identity')
    require(is_sha(run.get('payload_fingerprint')), 'invalid accepted payload fingerprint')
    rows = run.get('datasets')
    require(type(rows) is list and len(rows) == 3
            and {row.get('field_id') for row in rows if type(row) is dict} == set(FIELDS),
            'complete V/J/H readback required')
    return value


def load_source(client, binding, source_root=SOURCE_ROOT, *, work_profile="gsg_junction_fine_reference_v1"):
    validate_binding(binding,work_profile=work_profile)
    root = Path(source_root)
    require(root.is_absolute() and root.resolve(strict=True) == root, 'noncanonical source root')
    ir = json.loads(checked(root / binding['ir_path'], binding['ir_sha256'], 12*1024*1024))
    manifest, data = decode_bundle(checked(root / binding['bundle_path'], binding['bundle_sha256'], 512*1024*1024))
    target = ir['geometry_assets']['fem_domain_mesh_asset']['mesh']['cells']
    require(target['types'] == ['tet4']*24 and target['offsets'] == list(range(0,97,4)),
            'registered24Tet4 sampling carrier differs')
    proof = verify_carriers(ir, manifest, data, binding['cells'], TARGETS_M)
    require(len(data['h_raw']) == 20*24 and len(data['v_raw']) == manifest['vertex_count']*8,
            'complete V/H carrier lengths differ')
    require(digest(data['sample_xyz']) == SAMPLE_XYZ_SHA256, 'registered20 bitwise targets differ')
    require(struct.pack('<d',proof['source_current_a']) == struct.pack('<d',binding['source_current_a'])
            and all(proof[key] == binding[key] for key in ('source_state_sha256','prepared_execution_sha256')),
            'source state, preparation or signed current differs')
    run = binding['run']
    base = '/v2/persistence/projects/'+quote(run['project_id'],safe='')+'/runs/'+quote(run['run_id'],safe='')
    observed = client.json(base)
    require(all(observed[key] == run[key] for key in ('project_id','run_id','payload_fingerprint'))
            and [row['lifecycle'] for row in observed['tasks']] == ['succeeded'], 'accepted source run differs')
    revision = base+'/solution-sets/'+quote(run['solution_set_id'],safe='')+'/revisions/'+quote(run['revision'],safe='')
    require(client.json(revision)['execution_status'] == 'succeeded', 'source solution did not succeed')
    http = []
    for expected in run['datasets']:
        key = FIELDS[expected['field_id']]
        require(digest(data[key]) == expected['payload_sha256'], 'native/CAS V/J/H differs from accepted tensor')
        artifact = revision+'/members/'+quote(expected['member_id'],safe='')+'/artifacts/'+quote(expected['artifact_id'],safe='')
        query = {key:expected[key] for key in ('dataset_id','dataset_revision','sample_id','item_id','field_id')}
        query.update(schema_version='1.0.0',expected_manifest_object_ref=expected['manifest_object_ref'],
                     element_offset='0',element_count=str(expected['elements']),max_response_bytes=str(MAX_BINARY))
        result = verify_slice(client.get(artifact+'/materialized-dataset/slice',query,
                              maximum=MAX_BINARY+MAX_METADATA+12),expected,run)
        http.append(dict(result,field_id=expected['field_id']))
        if key == 'h_raw':
            geometry = client.json(artifact+'/saved-field-geometry')
            require(geometry['source']['tensor_object_ref'] == expected['source']['tensor_object_ref']
                    and int(geometry['node_count']) == 20, 'saved H carrier differs')
    proof.update(label='corner12p5', ir_sha256=binding['ir_sha256'],bundle_sha256=binding['bundle_sha256'],
                 sample_xyz_sha256=SAMPLE_XYZ_SHA256,run_id=run['run_id'],solution_set_id=run['solution_set_id'],
                 revision=run['revision'],http_fields=http)
    return data,proof


def write_evidence(name, value, control_root=CONTROL_ROOT, scientific_root=SCIENTIFIC_ROOT):
    require(name in NAMES, 'unregistered evidence name')
    raw = (json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False,indent=2)+'\n').encode()
    require(len(raw) <= MAX_METADATA, 'reference evidence exceeds bound')
    for root in (Path(control_root),Path(scientific_root)):
        require(root.resolve(strict=True) == root, 'noncanonical evidence root')
        temporary = root / (name+'.tmp')
        with temporary.open('xb') as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,root/name)
        fd = os.open(root,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)


def run_checks(data, proof, budget, record, *, results=None):
    cell_profile=budget.report()["cell_limit_profile"]
    require(type(proof['cells']) is int and 0 < proof['cells'] <= SOURCE_CELL_LIMITS[cell_profile], 'closed source count differs')
    budget.activate_source(proof['ir_sha256'])
    native = list(struct.iter_unpack('<3d',data['h_raw']))
    results = [] if results is None else results
    for index,target in zip(INDICES,TARGETS_M):
        started = time.monotonic()
        def progress(done,total):
            require(total == proof['cells'] and 0 < done <= total, 'reference progress differs')
            elapsed = time.monotonic()-started
            value = dict(status='running',target_index=index,checks_completed=len(results),checks_total=3,
                         cells_completed=done,source_cells=total,target_elapsed_seconds=elapsed,
                         estimated_target_remaining_seconds=elapsed*(total-done)/done,
                         budget=budget.report(),new_solve=False)
            record('progress.json',value)
            print(json.dumps({k:v for k,v in value.items() if k != 'budget'}),flush=True)
        value = evaluate_retained_field(struct.iter_unpack('<5Q30d',data['cells']),target,proof['cells'],budget,
                    native_h_apm=native[index],progress=progress,cell_limit_profile=cell_profile)
        value.update(label='corner12p5',target_index=index,position_m=target,native_h_apm=native[index],
                     elapsed_seconds=time.monotonic()-started)
        record(f'corner12p5-target-{index}.json',value)
        results.append(value)
        require(value['native_comparison']['within_gate'], 'native comparison outside preregistered gate')
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request-sha256',required=True)
    parser.add_argument('--preflight',action='store_true')
    args = parser.parse_args()
    request = json.loads(checked(Path(__file__).parent.parent/'request.json',args.request_sha256,MAX_METADATA))
    work_profile=request.get("work_profile","gsg_junction_fine_reference_v1")
    fine_cell_profile(work_profile)
    expanded=work_profile == "gsg_junction_fine_reference_86k_v1"
    proposal="bb7667f455287d43f7e127ccbc28da4dfa6f15b3795d375c7503e9eb5781e901" if expanded else PROPOSAL_SHA256
    control_root=(Path("/opt/fullmag/control/verification/gsg-junction-fine86k-reference-20261112/one-approved-attempt")
                  if expanded else CONTROL_ROOT)
    scientific_root=SOURCE_ROOT/"verification/reference-86k" if expanded else SCIENTIFIC_ROOT
    record=lambda name,value:write_evidence(name,value,control_root,scientific_root)
    require(request['schema'] == 'fullmag.gsg-junction-reference-request.v1'
            and request['reference_checks'] == 3 and request['automatic_retries'] == 0
            and request['proposal_sha256'] == proposal, 'fine reference request differs')
    binding_raw = checked(control_root/'source-binding.json',request['source_binding_sha256'],MAX_METADATA)
    require(json.loads(binding_raw) == request['source'], 'fine source binding differs')
    require(set(request['tools']) == TOOLS, 'fine reference tool closure differs')
    for name,pin in request['tools'].items():
        checked(Path(__file__).parent/name,pin,MAX_METADATA)
    checked(Path(__file__),request['driver_sha256'],MAX_METADATA)
    wheel = Path(request['wheel'])
    require(wheel.is_relative_to(Path('/opt/fullmag/control/verification'))
            and wheel.name == 'mpmath-1.3.0-py3-none-any.whl','registered wheel required')
    checked(wheel,WHEEL_SHA256,2*MAX_METADATA)
    sys.path.insert(0,str(wheel))
    import antenna_triangle_surface_oracle as triangle
    resource.setrlimit(resource.RLIMIT_AS,(2147483648,2147483648))
    os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
    client = Client('http://127.0.0.1:8081')
    before = current_identity(client)
    require(before is None or before['run'] is None, 'reference requires idle authoring')
    data,proof = load_source(client,request['source'],work_profile=work_profile)
    dependency = triangle.dependency_provenance()
    if args.preflight:
        print(json.dumps(dict(status='PREFLIGHT PASS',cases=[proof],dependency=dependency,
                              reference_evaluations=0,new_solve=False)),flush=True)
        return 0
    require(not scientific_root.exists() and scientific_root.parent.resolve(strict=True) == scientific_root.parent,
            'scientific evidence directory already exists or is not canonical')
    with (control_root/'started.json').open('x') as stream:
        json.dump(dict(pid=os.getpid(),request_sha256=args.request_sha256,new_solve=False),stream)
        stream.flush();os.fsync(stream.fileno())
    sync_directory(control_root)
    scientific_root.mkdir()
    sync_directory(scientific_root.parent)
    record('source.json',proof)
    def stop(signum,frame):
        raise triangle.Refusal('reference wall-time exhausted or controlled termination')
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGALRM,stop);signal.alarm(43200)
    budget = GsgJunctionFineBudget(proof['ir_sha256'],work_profile=work_profile)
    results = []
    report = dict(schema='fullmag.gsg-junction-reference-result.v1',request_sha256=args.request_sha256,
                  inputs=[proof],dependency=dependency,new_solve=False,qualified_basis=False,qualification='NOT VERIFIED')
    try:
        run_checks(data,proof,budget,record,results=results)
        require(current_identity(client) == before,'authoring identity changed')
        for name,pin in request['tools'].items():
            checked(Path(__file__).parent/name,pin,MAX_METADATA)
        for key in ('ir','bundle'):
            checked(SOURCE_ROOT/request['source'][key+'_path'],request['source'][key+'_sha256'],
                    12*1024*1024 if key == 'ir' else 512*1024*1024)
        checked(control_root/'source-binding.json',request['source_binding_sha256'],MAX_METADATA)
        budget.guard()
        report.update(status='THREE CHECKS PASS / NOT FULL QUALIFICATION',exit_code=0)
    except BaseException as error:
        report.update(status='REFUSED / NOT VERIFIED',exit_code=2,error=type(error).__name__+': '+str(error))
    report.update(point_results=results,budget=budget.report(),checks_completed=len(results),
                  checks_passed=sum(v['native_comparison']['within_gate'] for v in results),checks_total=3)
    record('result.json',report);signal.alarm(0)
    print(json.dumps({k:report[k] for k in ('status','exit_code','checks_completed')}),flush=True)
    return report['exit_code']


if __name__ == '__main__':
    raise SystemExit(main())
