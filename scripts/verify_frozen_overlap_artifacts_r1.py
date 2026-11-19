"""Read actual runner artifacts only. This never runs a solver or replaces Rust admission."""
import argparse,hashlib,json,math,os,struct
from pathlib import Path
STAGES=('relax_a','active_a','overlap_ab','inactive','reactivate_ab')
ACTIVE=(['pin_a'],['pin_a'],['pin_a','pin_b'],[],['pin_a','pin_b'])
EPOCHS=({'pin_a':1},{'pin_a':1},{'pin_a':1,'pin_b':1},{'pin_a':1,'pin_b':1},{'pin_a':2,'pin_b':2})
NONVACUITY=1e-8
MAX_JSON=64*1024*1024
ROLES=(('fdm.cpu.transactional-state-digest.v1','engine'),('fdm.cpu.coupled-m3-checkpoint-digest.v1','coupled'),('fdm.cpu.frozen-constraint-state-digest.v1','frozen'),('fdm.cpu.frozen-activation-set-digest.v1','activation'))
def need(ok,message):
    if not ok:raise ValueError(message)
def pairs(items):
    result={}
    for key,value in items:
        need(key not in result,'duplicate JSON key '+key);result[key]=value
    return result
def raw(path,maximum=MAX_JSON):
    with Path(path).open('rb') as file:
        need(file.seek(0,2)<=maximum,'oversized '+str(path));file.seek(0);data=file.read(maximum+1)
    need(len(data)<=maximum,'growing input '+str(path));return data
def decode(data):return json.loads(data,object_pairs_hook=pairs,parse_constant=lambda x:(_ for _ in ()).throw(ValueError(x)))
def load(path,maximum=MAX_JSON):return decode(raw(path,maximum))
def bits(value):return struct.pack('<d',float(value))
def exact(a,b):
    if isinstance(a,dict):return isinstance(b,dict) and a.keys()==b.keys() and all(exact(a[k],b[k]) for k in a)
    if isinstance(a,list):return isinstance(b,list) and len(a)==len(b) and all(exact(x,y) for x,y in zip(a,b))
    if isinstance(a,float):return isinstance(b,(int,float)) and bits(a)==bits(b)
    return type(a)==type(b) and a==b
def vectors(field):
    need(field['observable']=='m' and field['unit']=='1','M identity/unit differs')
    layout=field['layout'];need(layout['backend']=='fdm' and layout['grid_cells']==[8,4,1] and layout['origin_m']==[-8e-9,-4e-9,-1e-9] and layout['cell_size']==[2e-9,2e-9,2e-9],'actual grid/layout differs from authored support')
    values=field['values']
    if values and isinstance(values[0],list):result=values
    else:
        need(len(values)%3==0,'bad dense vector width');result=[values[i:i+3] for i in range(0,len(values),3)]
    need(len(result)==32 and all(len(v)==3 and all(math.isfinite(x) for x in v) for v in result),'invalid M shape/finite')
    need(all(abs(sum(x*x for x in v)-1.0)<=1e-10 for v in result),'nonunit active M')
    return result
def mask(child):return {i for i in range(child['mask_len']) if child['mask_bits'][i//8]&(1<<(i%8))}
def same_rows(a,b,ids):return all(all(bits(x)==bits(y) for x,y in zip(a[i],b[i])) for i in ids)
def delta(a,b,ids):return max((max(abs(x-y) for x,y in zip(a[i],b[i])) for i in ids),default=0.0)
def bound_child(child,m,ids):
    need(child['mask_len']==32 and mask(child)==ids,'actual resolved frozen mask differs from authored geometry')
    need(child['free_dof_count']>0,'empty free support')
    need(same_rows(m,child['reference'],ids),'frozen M drifted from exact reference')
def parse_bindings(values):
    result={}
    for value in values:
        key,sep,path=value.partition('=');need(sep and key in STAGES and key not in result,'bad/duplicate stage binding');result[key]=Path(path).resolve()
    return result
def rust_e15(value):
    # Rust {:.15e} uses an unpadded exponent without a plus sign.
    mantissa,exponent=format(value,'.15e').split('e')
    return mantissa+'e'+str(int(exponent))

def resolved_frozen(plan):
    backend=plan['backend_plan']
    need(backend['kind']=='fdm','actual execution plan is not inline kind=fdm')
    frozen=backend.get('frozen_spins')
    if frozen is None:return None
    need(isinstance(frozen,dict),'resolved frozen plan is not an object')
    frozen=dict(frozen);frozen.setdefault('source_state_revision',None)
    certificate=dict(frozen['certificate'])
    for key,default in (('source_state_revision',None),('bounds_m',None),('warnings',[])):
        certificate.setdefault(key,default)
    frozen['certificate']=certificate
    ids=frozen['constraint_ids'];dense=frozen['frozen_mask']
    need(isinstance(ids,list) and ids==sorted(set(ids)) and all(isinstance(x,str) and x for x in ids),'actual plan constraint IDs invalid')
    need(isinstance(dense,list) and len(dense)==32 and all(type(x) is bool for x in dense),'actual plan frozen mask invalid')
    need(certificate['constraint_ids']==ids,'actual certificate constraint IDs differ')
    for key in ('active_dof_count','frozen_dof_count','free_dof_count','mask_sha256','grid_or_mesh_fingerprint','source_state_revision'):
        need(certificate[key]==frozen[key],'actual certificate differs from resolved plan: '+key)
    return frozen

def check_child_plan(child,plan,activation):
    need(plan is not None,'active child has no actual resolved plan')
    need(child['constraint_ids']==plan['constraint_ids'] and child['authored_fingerprints']==plan['certificate']['authored_fingerprints'],'child authored certificate/IDs differ from actual plan')
    need(child['mask_len']==len(plan['frozen_mask']) and len(child['mask_bits'])==(child['mask_len']+7)//8 and all(type(x) is int and 0<=x<=255 for x in child['mask_bits']),'invalid child packed mask shape')
    need(mask(child)=={i for i,value in enumerate(plan['frozen_mask']) if value} and child['mask_sha256']==plan['mask_sha256'],'child mask differs from actual plan')
    need(child['activation']['topology_fingerprint']==plan['grid_or_mesh_fingerprint'] and child['activation']['source_state_revision']==plan['source_state_revision'],'child topology/source revision differs from actual plan')
    for key in ('active_dof_count','frozen_dof_count','free_dof_count'):
        need(child[key]==plan[key],'child count differs from actual plan: '+key)
    for key in ('constraint_activation_epochs','active_constraint_ids','resolved_constraint_set_revision'):
        need(child[key]==activation[key],'child differs from complete activation history: '+key)

def check_inventory(root,masks):
    counts={};sealed=False;field_samples=0
    with (root/'terminal-output-inventory.v1.jsonl').open('rb') as file:
        for line in iter(lambda:file.readline(128*1024+1),b''):
            need(len(line)<=128*1024 and line.endswith(b'\n') and not sealed,'partial/oversized/post-seal inventory')
            item=decode(line);kind=item['kind']
            if kind=='header':need(item['schema_version']=='fullmag.runner.output_inventory.v1','wrong inventory schema')
            elif kind=='sample':
                stream=item['stream_id'];need(item['ordinal']==counts.get(stream,0),'inventory ordinal gap');counts[stream]=counts.get(stream,0)+1
                need(math.isfinite(item['time_s']) and math.isfinite(item['solver_dt_s']),'nonfinite sample clock')
                relative=Path(item['relative_path']);need(not relative.is_absolute() and '..' not in relative.parts,'unsafe sample path')
                path=(root/relative).resolve();need(root in path.parents,'sample outside artifact root')
                if item['collection']=='field':
                    field=load(path);m=vectors(field);need(item['quantity_id']=='m','unsupported field in this preregistration')
                    need(field['step']==item['step'] and bits(field['time'])==bits(item['time_s']) and bits(field['solver_dt'])==bits(item['solver_dt_s']),'field writer clock mismatch')
                    if masks is not None:need(same_rows(m,masks[0],masks[1]),'history sample frozen reference drift')
                    field_samples+=1
                else:
                    count=item['writer_byte_count'];offset=item['byte_offset'];step=item['step']
                    need(item['collection']=='scalar' and type(count) is int and 0<count<=4096,'invalid bounded scalar byte count')
                    need(type(offset) is int and 0<=offset<=2**64-1 and type(step) is int and 0<=step<=2**64-1,'invalid scalar range/step metadata')
                    need(type(item['time_s']) in (int,float) and type(item['solver_dt_s']) in (int,float) and item['solver_dt_s']>=0.0,'invalid scalar source clock metadata')
                    with path.open('rb') as scalar:
                        size=os.fstat(scalar.fileno()).st_size
                        need(offset<=size and count<=size-offset,'scalar range exceeds actual file metadata')
                        scalar.seek(offset);row=scalar.read(count)
                    need(len(row)==count and row.endswith(b'\n') and b'\n' not in row[:-1] and b'\r' not in row,'short or noncanonical scalar row')
                    tokens=row[:-1].decode('utf8').split(',');need(len(tokens)==19,'canonical scalar row width')
                    need(tokens[0]==str(step) and tokens[1]==rust_e15(item['time_s']) and tokens[2]==rust_e15(item['solver_dt_s']),'scalar step/time/dt differ from actual writer format')
                    need(all(math.isfinite(float(x)) for x in tokens[1:]),'nonfinite scalar values')
            elif kind=='seal':need(item['streams']==counts,'writer seal lost a sample');sealed=True
            else:need(kind=='cause','unknown inventory record')
    need(sealed and field_samples>=2,'missing drained actual vector history')
    return counts
def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--stage',action='append',required=True,metavar='STAGE=ARTIFACT_ROOT');parser.add_argument('--envelope',action='append',default=[],metavar='STAGE=ACTUAL_CAS_OBJECT');parser.add_argument('--plan',action='append',required=True,metavar='STAGE=ACTUAL_EXECUTION_PLAN_JSON',help='Five execution plans captured by the actual runtime/admission owner; replanned defaults are not evidence.');args=parser.parse_args()
    roots=parse_bindings(args.stage);envelopes=parse_bindings(args.envelope);plans=parse_bindings(args.plan);need(set(roots)==set(STAGES),'all five actual stages required');need(set(plans)==set(STAGES),'all five actual runtime/admission execution plans required')
    if envelopes:need(set(envelopes)==set(STAGES),'all five publication envelopes required')
    # x-major indexing and centered box origin are existing geometry::voxelize_shape contracts.
    a={x+8*y for y in range(4) for x in (1,2,3)};b={x+8*y for y in range(4) for x in (3,4,5)}
    need(a&b and set(range(32))-(a|b),'vacuous authored geometry')
    previous=None;first_reference=None;results=[];previous_plan=None;previous_active=[];expected_revision=0
    for index,name in enumerate(STAGES):
        plan_bytes=raw(plans[name]);actual_plan=decode(plan_bytes);frozen_plan=resolved_frozen(actual_plan)
        active=[] if frozen_plan is None else frozen_plan['constraint_ids']
        need(active==ACTIVE[index],'actual plan active IDs differ from this preregistered stage')
        changed=frozen_plan!=previous_plan or active!=previous_active
        if changed:expected_revision+=1
        root=roots[name];initial=load(root/'m_initial.json');final=load(root/'m_final.json');mi=vectors(initial);mf=vectors(final)
        if previous is not None:need(same_rows(mi,previous,set(range(32))),'initial M is not actual predecessor')
        lifecycle=load(root/'solver/frozen_output_lifecycle.v1.json');need(lifecycle['schema_version']=='fullmag.frozen_output_lifecycle.v1','wrong lifecycle schema');need('frozen_spins' in lifecycle,'missing nullable child')
        activation=lifecycle['frozen_activation_set'];need(activation['active_constraint_ids']==ACTIVE[index] and activation['constraint_activation_epochs']==EPOCHS[index],'full history or exact epoch count differs')
        need(type(activation['resolved_constraint_set_revision']) is int and activation['resolved_constraint_set_revision']==expected_revision,'activation revision differs from actual resolved-plan/active-set transition')
        child=lifecycle['frozen_spins'];ids=a if index<2 else a|b
        if index==3:need(child is None,'inactive child must be null')
        else:
            need(child is not None,'active child missing');check_child_plan(child,frozen_plan,activation);bound_child(child,mf,ids)
            if index==0:first_reference=child['reference']
            if index in (1,2):need(same_rows(child['reference'],first_reference,a),'continuous A reference recaptured at overlap')
            if index==2:need(same_rows(child['reference'],previous,b-a),'new B reference not actual predecessor M')
            if index==4:need(same_rows(child['reference'],previous,a|b),'reactivation did not capture inactive terminal M')
        if index==1:need(delta(mi,mf,set(range(32))-a)>NONVACUITY,'free support did not evolve measurably')
        if index==3:need(delta(mi,mf,a|b)>NONVACUITY,'released frozen support did not evolve measurably')
        snapshot=None
        if index:
            snapshot=load(root/'solver/fdm_cpu_accepted_state_snapshot.v2.json',64*1024);clock=snapshot['clock'];need(snapshot['schema_version']=='fullmag.fdm.cpu.accepted-state-snapshot.v2','wrong accepted snapshot')
            carriers={c['carrier_id']:c for c in snapshot['primary_carriers']};need(set(carriers)=={r[0] for r in ROLES},'not exactly four semantic roles');payloads={}
            for carrier_id,stem in ROLES:
                data=raw(root/('solver/accepted-primary/v2/'+stem+'.json'));binding=carriers[carrier_id];need(hashlib.sha256(data).hexdigest()==binding['preimage_sha256'] and len(data)==binding['byte_count'],'raw carrier SHA/count differs');payloads[stem]=decode(data)
            engine=payloads['engine']['solver'];coupled=payloads['coupled'];need(same_rows(engine['magnetization'],mf,set(range(32))) and same_rows(coupled['magnetization'],mf,set(range(32))),'raw4 M differs')
            need(bits(engine['time_seconds'])==bits(clock['time_seconds'])==bits(coupled['time_s'])==bits(final['time']),'primary single clock differs')
            need(clock['accepted_step']==coupled['accepted_steps']==final['step'] and bits(clock['dt_seconds'])==bits(coupled['previous_dt_s'])==bits(final['solver_dt']),'outer accepted step/dt differs')
            need(exact(payloads['frozen']['frozen_spins'],child) and exact(payloads['activation'],activation),'raw4 lifecycle differs')
            if child:need(child['step']==clock['accepted_step'] and bits(child['time_s'])==bits(clock['time_seconds']) and bits(child['dt'])==bits(clock['dt_seconds']),'child single clock differs')
        counts=check_inventory(root,None if child is None else (child['reference'],ids))
        if envelopes:
            envelope=load(envelopes[name]);need(set(envelope)=={'schema_version','state','frozen_spins','frozen_activation_set'} and envelope['schema_version']=='fullmag.frozen_state_output.v1','wrong explicit state envelope');need(same_rows(vectors(envelope['state']),mf,set(range(32))) and exact(envelope['frozen_spins'],child) and exact(envelope['frozen_activation_set'],activation),'published terminal envelope differs');need(envelope['state']['step']==final['step'] and bits(envelope['state']['time'])==bits(final['time']) and bits(envelope['state']['solver_dt'])==bits(final['solver_dt']),'published terminal envelope clock differs')
        results.append({'stage_id':name,'actual_artifact_root':str(root),'actual_samples':counts,'activation_epochs':activation['constraint_activation_epochs'],'raw4_checked':bool(index),'actual_execution_plan':{'path':str(plans[name]),'sha256':hashlib.sha256(plan_bytes).hexdigest(),'byte_count':len(plan_bytes)},'resolved_identity_changed':changed,'expected_resolved_revision':expected_revision})
        previous=mf;previous_plan=frozen_plan;previous_active=active
    report={'status':'ACTUAL_RUNNER_ARTIFACT_RELATIONS_PASS','stages':results,'envelopes_checked':bool(envelopes),'limits':'Does not prove plan runtime/admission provenance, Rust semantic digest/admission, Published catalog/lease, public cold reopen, or ExactResume. Supplied plans must be pinned independently to the actual runtime/admission; replanned defaults are not evidence. Raw inventory contains no SHA; published CAS verification belongs to the existing Rust consumer.'}
    (Path(__file__).parent/'runtime-artifact-check.actual.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8',newline='\n');print(json.dumps(report,ensure_ascii=False))
if __name__=='__main__':main()