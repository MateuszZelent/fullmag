#!/usr/bin/env python3
"""Native FDM CUDA / FEM CPU convergence against an exact pure-damping rod.

Run only in the selected managed backend, with published libraries and exact
headers. No build, GPU fallback or public API qualification is performed here.
Each execution requires a fresh adjacent .py/.zarr pair on the WSL output mount.
"""
from __future__ import annotations
import argparse, ctypes as ct, hashlib, json, math, os, re, subprocess, sys
from pathlib import Path
import numpy as np
archive=Path(__file__).with_suffix('.zarr')/'provenance'
if archive.is_dir(): sys.path.insert(0,str(archive))
import fdm_cuda_analytic_abi_checks as abi
MU0=4e-7*math.pi
L,W=64e-9,4e-9
A1,A2=13e-12,26e-12
MS1,MS2=8e5,16e5
ALPHA,GAMMA=.5,2.211e5
DT,STEPS=1e-14,100
K=2*math.pi/L
D=ALPHA*GAMMA/(1+ALPHA**2)*2*A1/(MU0*MS1)
GATES={'energy_finest':.03,'energy_refinement':2.,'field_finest':.05,'field_refinement':1.5,
       'amplitude_finest':.01,'amplitude_refinement':2.,'cross_amplitude_finest':.005,
       'cross_amplitude_refinement':2.,'norm':1e-10,'energy_increase_relative':1e-10}

def require(condition, message):
    if not condition: raise AssertionError(message)

def exact(x,t):
    a=.2*math.exp(-D*K*K*t)
    theta=a*np.cos(K*x)
    m=np.column_stack((np.cos(theta),np.sin(theta),np.zeros(len(x))))
    tangent=np.column_stack((-np.sin(theta),np.cos(theta),np.zeros(len(x))))
    h=2*A1/(MU0*MS1)*(-a*K*K*np.cos(K*x)[:,None]*tangent-a*a*K*K*np.sin(K*x)[:,None]**2*m)
    energy=W*W*L/4*(A1+A2)*a*a*K*K
    return m,h,energy,a

def load(prefix,path,header,names):
    text=abi.strip_comments(header.read_text()); types={}
    for name in names: types[name]=abi.parse_struct(text,name,types)
    lib=ct.CDLL(str(path))
    def bind(name,args,result=ct.c_int):
        f=getattr(lib,'fullmag_'+prefix+'_'+name);f.argtypes=args;f.restype=result;return f
    return text,types,lib,bind

def measure(lane,n,paths,output):
    keep=[]
    def ptr(values,scalar=ct.c_double):
        a=(scalar*len(values))(*values);keep.append(a);return ct.cast(a,ct.c_void_p)
    if lane=='fdm_cuda':
        text,types,lib,bind=load('fdm',paths['fdm_lib'],paths['fdm_header'],[
            'fullmag_fdm_grid_desc','fullmag_fdm_material_desc','fullmag_fdm_plan_desc',
            'fullmag_fdm_time_policy_desc_v2','fullmag_fdm_plan_desc_v2','fullmag_fdm_step_stats'])
        enum=lambda name:abi.enum_value(text,'FULLMAG_FDM_'+name)
        if not lib.fullmag_fdm_is_available(): raise RuntimeError('CUDA required')
        x=(np.arange(n)+.5)*L/n;weights=np.full(n,L*W*W/n)
        m0=exact(x,0)[0]
        p=types['fullmag_fdm_plan_desc']();p.grid.nx=n;p.grid.ny=p.grid.nz=1
        p.grid.dx=L/n;p.grid.dy=p.grid.dz=W
        p.material.saturation_magnetisation=MS1;p.material.exchange_stiffness=A1
        p.material.damping=ALPHA;p.material.gyromagnetic_ratio=GAMMA
        p.precision=enum('PRECISION_DOUBLE');p.integrator=enum('INTEGRATOR_RK4');p.enable_exchange=1;p.disable_precession=1
        p.periodic_y=p.periodic_z=1
        p.initial_magnetization_xyz=ptr(m0.ravel());p.initial_magnetization_len=3*n
        p.ms_field=ptr(np.where(x<L/2,MS1,MS2));p.ms_field_len=n
        p.region_mask=ptr([257 if xx<L/2 else 2**32-1 for xx in x],ct.c_uint32);p.region_mask_len=n
        extended=types['fullmag_fdm_plan_desc_v2']();extended.abi_version=2;extended.struct_size=ct.sizeof(extended);extended.base=p
        extended.exchange_operator_mode=enum('EXCHANGE_OPERATOR_FACES');extended.exchange_face_len=n
        aa=np.where(x<L/2,A1,A2);faces=np.zeros(n);faces[:-1]=2*aa[:-1]*aa[1:]/(aa[:-1]+aa[1:])
        extended.exchange_face_x_plus=ptr(faces);extended.exchange_face_y_plus=ptr(np.zeros(n));extended.exchange_face_z_plus=ptr(np.zeros(n))
        create=bind('backend_create_time_policy_v2',[ct.POINTER(type(extended))],ct.c_void_p)
        handle=create(ct.byref(extended));stats_type=types['fullmag_fdm_step_stats']
    else:
        text,types,lib,bind=load('fem',paths['fem_lib'],paths['fem_header'],[
            'fullmag_fem_mesh_desc','fullmag_fem_material_desc','fullmag_fem_solver_config',
            'fullmag_fem_field_refresh_policy','fullmag_fem_relax_stop','fullmag_fem_sot_envelope_desc',
            'fullmag_fem_plan_desc','fullmag_fem_step_stats'])
        def enum(name):
            symbol='FULLMAG_FEM_'+name
            macro=re.search(r'^#define\s+'+re.escape(symbol)+r'\s+(\d+)u?\s*$',text,re.M)
            return int(macro.group(1)) if macro else abi.enum_value(text,symbol)
        # Local cube numbering follows the independently checked transport fixture.
        vertices=np.array([(i*L/n,y*W,z*W) for i in range(n+1) for y,z in [(0,0),(1,0),(0,1),(1,1)]])
        cube=[(0,1,2,6),(0,2,3,6),(0,4,5,6),(0,5,1,6),(0,3,7,6),(0,7,4,6)]
        cells=[];labels=[];ms=[];aa=[]
        for i in range(n):
            mapping=[4*i,4*(i+1),4*(i+1)+1,4*i+1,4*i+2,4*(i+1)+2,4*(i+1)+3,4*i+3]
            for tet in cube:
                cell=[mapping[j] for j in tet]
                # Positive orientation of the canonical tet; no imported permutations.
                q=vertices[cell];det=np.linalg.det((q[1:]-q[0]).T)
                if det<0:cell[1],cell[2]=cell[2],cell[1]
                cells.append(cell);labels.append(257 if i<n//2 else 2**32-1)
                ms.append(MS1 if i<n//2 else MS2);aa.append(A1 if i<n//2 else A2)
        face_map={};weights=np.zeros(len(vertices))
        for cell in cells:
            q=vertices[cell];v=abs(np.linalg.det((q[1:]-q[0]).T))/6
            for node in cell:weights[node]+=v/4
            for face in [(1,2,3),(0,3,2),(0,1,3),(0,2,1)]:
                nodes=tuple(cell[j] for j in face);key=tuple(sorted(nodes))
                face_map[key]=None if key in face_map else nodes
        facets=[f for f in face_map.values() if f is not None]
        facet_roles=[];facet_markers=[]
        for facet in facets:
            q=vertices[list(facet)]
            marker=next((marker for axis,coordinate,marker in [(1,0.,10),(1,W,11),(2,0.,12),(2,W,13)]
                         if np.all(q[:,axis]==coordinate)),None)
            facet_roles.append(enum('FACET_ROLE_EXTERIOR' if marker is None else 'FACET_ROLE_PERIODIC_SEAM'))
            facet_markers.append(2**32-1 if marker is None else marker)
        x=vertices[:,0];m0=exact(x,0)[0]
        p=types['fullmag_fem_plan_desc']();p.mesh.abi_version=int(re.search(r'^#define FULLMAG_FEM_MESH_DESC_ABI_VERSION ([0-9]+)u?',text,re.M).group(1));p.mesh.struct_size=ct.sizeof(types['fullmag_fem_mesh_desc'])
        def arr(name,values,scalar=ct.c_uint32):
            setattr(p.mesh,name,ptr(values,scalar));setattr(p.mesh,name+'_len',len(values))
        arr('nodes_xyz',vertices.ravel(),ct.c_double);arr('cell_types',[enum('CELL_TET4')]*len(cells))
        arr('cell_global_ordinals',list(range(len(cells))),ct.c_uint64);arr('cell_offsets',list(range(0,4*len(cells)+1,4)));arr('cell_nodes',[j for c in cells for j in c]);arr('cell_markers',labels)
        arr('facet_global_ordinals',list(range(len(facets))),ct.c_uint64);arr('facet_types',[enum('FACET_TRI3')]*len(facets));arr('facet_roles',facet_roles)
        arr('facet_offsets',list(range(0,3*len(facets)+1,3)));arr('facet_nodes',[j for f in facets for j in f]);arr('facet_markers',facet_markers)
        # Retain the exact one-dimensional invariant subspace in both lanes.
        # Unconstrained tetrahedral interpolation on a single transverse cell
        # has boundary-node strong-Laplacian artifacts despite correct weak K/M.
        arr('periodic_node_pairs',[4*i+a for i in range(n+1) for pair in [(0,1),(0,2),(1,3),(2,3)] for a in pair])
        arr('periodic_boundary_pair_markers',[10,11,12,13])
        p.material.saturation_magnetisation=MS1;p.material.exchange_stiffness=A1;p.material.damping=ALPHA;p.material.gyromagnetic_ratio=GAMMA
        p.fe_order=1;p.hmax=L/n;p.precision=enum('PRECISION_DOUBLE');p.integrator=enum('INTEGRATOR_RK4');p.enable_exchange=1
        p.has_precession_enabled=1;p.precession_enabled=0;p.use_consistent_mass=1;p.eager_initial_effective_field=1
        p.initial_magnetization_xyz=ptr(m0.ravel());p.initial_magnetization_len=m0.size
        p.ms_element_field=ptr(ms);p.ms_element_field_len=len(ms);p.a_element_field=ptr(aa);p.a_element_field_len=len(aa)
        p.dt_seconds=DT;p.gpu_device_index=-1
        device=ct.create_string_buffer(b'cpu');keep.append(device);p.mfem_device_string=ct.cast(device,ct.c_void_p)
        create=bind('backend_create',[ct.POINTER(type(p))],ct.c_void_p);handle=create(ct.byref(p));stats_type=types['fullmag_fem_step_stats']
    last_error=bind('backend_last_error',[ct.c_void_p],ct.c_char_p)
    if not handle:raise RuntimeError((lane,n,last_error(None)))
    destroy=bind('backend_destroy',[ct.c_void_p],None)
    snapshot=bind('backend_snapshot_stats',[ct.c_void_p,ct.POINTER(stats_type)])
    step=bind('backend_step',[ct.c_void_p,ct.c_double,ct.POINTER(stats_type)])
    copy=bind('backend_copy_field_f64',[ct.c_void_p,ct.c_int,ct.POINTER(ct.c_double),ct.c_uint64])
    def field(kind):
        buf=(ct.c_double*m0.size)();status=copy(handle,enum('OBSERVABLE_'+kind),buf,m0.size)
        if status:raise RuntimeError((lane,kind,status,last_error(handle)))
        return np.array(buf).reshape((-1,3))
    stats=stats_type();energies=[];records=[];raw={}
    try:
        if lane=='fem_cpu':
            abi.SCALARS['char']=ct.c_char
            device_type=abi.parse_struct(text,'fullmag_fem_device_info',types)
            get_device=bind('backend_get_device_info',[ct.c_void_p,ct.POINTER(device_type)])
            dev=device_type();status=get_device(handle,ct.byref(dev))
            require(status==0 and not dev.is_gpu_enabled, 'FEM CPU device query or resolution failed')
        for accepted in range(STEPS+1):
            status=snapshot(handle,ct.byref(stats)) if accepted==0 else step(handle,DT,ct.byref(stats))
            if status:raise RuntimeError((lane,n,accepted,status,last_error(handle)))
            if stats.step!=accepted:raise AssertionError(('actual accepted step',stats.step,accepted))
            if not math.isclose(stats.time_seconds,accepted*DT,rel_tol=1e-12,abs_tol=1e-25):raise AssertionError(('actual physical time',stats.time_seconds,accepted*DT))
            energies.append(stats.exchange_energy_joules)
            if accepted in (0,STEPS):
                m=field('M');h=field('H_EX');em,eh,ee,ea=exact(x,accepted*DT)
                require(np.isfinite(m).all() and np.isfinite(h).all(), 'nonfinite magnetization or field')
                amp=float(np.dot(weights*np.cos(K*x),np.arctan2(m[:,1],m[:,0]))/np.dot(weights,np.cos(K*x)**2))
                records.append({'step':accepted,'time_s':stats.time_seconds,'energy_J':energies[-1],
                    'energy_relative':abs(energies[-1]-ee)/abs(ee),'amplitude':amp,'exact_amplitude':ea,
                    'amplitude_relative':abs(amp-ea)/ea,
                    'field_relative_l2':math.sqrt(float(np.sum(weights[:,None]*(h-eh)**2)/np.sum(weights[:,None]*eh**2))),
                    'norm_error':float(np.max(np.abs(np.linalg.norm(m,axis=1)-1)))})
                raw[f'm_{accepted}']=m;raw[f'h_{accepted}']=h;raw[f'exact_m_{accepted}']=em;raw[f'exact_h_{accepted}']=eh
        raw.update(x=x,weights=weights,exchange_energy_history_J=np.array(energies))
        np.savez(output/f'{lane}_{n}.npz',**raw)
        require(all(math.isfinite(e) for e in energies), 'nonfinite exchange energy')
        require(all(math.isfinite(value) for row in records for value in row.values()), 'nonfinite scalar metric')
        require(all(e2<=e1+GATES['energy_increase_relative']*abs(e1) for e1,e2 in zip(energies,energies[1:])), 'exchange energy increased')
        require(max(r['norm_error'] for r in records)<=GATES['norm'], 'magnetization norm error')
        device_evidence={}
        if lane=='fdm_cuda':
            layout=paths['fdm_receipt_layout'].read_text()
            declarations=re.findall(r'FULLMAG_FDM_EXECUTION_RECEIPT_FIELD\((\w+),\s*(\w+),\s*(\d+)\)',layout)
            receipt_type=type('FdmExecutionReceipt',(ct.Structure,),{'_fields_':[
                (name,ct.c_uint64 if typ=='uint64_t' else ct.c_uint32 if typ=='uint32_t' else ct.c_int32)
                for typ,name,offset in declarations]})
            for typ,name,offset in declarations:require(getattr(receipt_type,name).offset==int(offset), 'receipt ABI offset mismatch')
            require(ct.sizeof(receipt_type)==int(re.search(r'FULLMAG_FDM_EXECUTION_RECEIPT_SIZE\((\d+)\)',layout).group(1)), 'receipt ABI size mismatch')
            receipt=receipt_type();receipt.abi_version=1;receipt.struct_size=ct.sizeof(receipt)
            get_receipt=bind('backend_execution_receipt_v1',[ct.c_void_p,ct.POINTER(receipt_type)])
            status=get_receipt(handle,ct.byref(receipt))
            require(status==0, 'native receipt query failed')
            constants=dict((name,int(value)) for name,value in re.findall(r'VALUE\((\w+),\s*(\d+)\)',paths['fdm_receipt_values'].read_text()))
            require(receipt.executed_backend==constants['FULLMAG_FDM_EXECUTED_CUDA_FDM'], 'CUDA execution not demonstrated')
            require(receipt.execution_class in (constants['FULLMAG_FDM_EXECUTION_DEVICE_RESIDENT'],constants['FULLMAG_FDM_EXECUTION_GPU_OPERATOR_HOST_CONTROL']), 'unsupported execution class')
            require(receipt.fallback_count==0 and receipt.accounting_valid and receipt.host_operator_mask==0, 'fallback or host execution')
            require(receipt.device_operator_mask & receipt.required_operator_mask == receipt.required_operator_mask, 'incomplete device operator coverage')
            require(receipt.precision==enum('PRECISION_DOUBLE'), 'incorrect executed precision')
            device_evidence={name:getattr(receipt,name) for typ,name,offset in declarations}
        else:device_evidence={'is_gpu_enabled':int(dev.is_gpu_enabled),'name':dev.name.decode('utf-8','strict')}
        return {'lane':lane,'nx':n,'points':len(x),'actual_steps':int(stats.step),'states':records,'execution':device_evidence}
    finally:destroy(handle)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',required=True,type=Path)
    for name in ('fdm-lib','fem-lib','fdm-header','fem-header'):p.add_argument('--'+name,required=True,type=Path)
    args=p.parse_args();out=args.output
    if out.suffix!='.zarr' or out.exists() or out.with_suffix('.py').exists():raise ValueError('new adjacent scientific pair required')
    paths={k:v.resolve(strict=True) for k,v in vars(args).items() if k!='output'}
    for key,filename in [('fdm_receipt_layout','fullmag_fdm_execution_receipt_v1_layout.def'),('fdm_receipt_values','fullmag_fdm_execution_receipt_v1_values.def')]:
        paths[key]=(paths['fdm_header'].parent/filename).resolve(strict=True)
    out.mkdir(parents=True);(out/'.zgroup').write_text('{"zarr_format":2}\n');out.with_suffix('.py').write_bytes(Path(__file__).read_bytes())
    provenance=out/'provenance';provenance.mkdir();(provenance/'fdm_cuda_analytic_abi_checks.py').write_bytes(Path(abi.__file__).read_bytes())
    for k in ('fdm_header','fem_header','fdm_receipt_layout','fdm_receipt_values'):(provenance/paths[k].name).write_bytes(paths[k].read_bytes())
    report={'schema':'fullmag.regional-fdm-fem-convergence.v1','state':'planned','gates':GATES,
            'inputs':{'L_m':L,'w_m':W,'A_Jpm':[A1,A2],'Ms_Apm':[MS1,MS2],'alpha':ALPHA,'gamma':GAMMA,
                      'dt_s':DT,'steps':STEPS,'nx':[8,16,32],'a0':.2,'D_m2ps':D,'k_pm':K,'precession':False,'boundary':'Neumann x; periodic y/z'},
            'identity':{k:{'path':str(v),'sha256':hashlib.sha256(v.read_bytes()).hexdigest()} for k,v in paths.items()},
            'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'measurements':[],
            'gpu_inventory':subprocess.run(['nvidia-smi','--query-gpu=index,uuid,name,driver_version','--format=csv,noheader'],capture_output=True,text=True,check=True).stdout.strip()}
    def save():(out/'.zattrs').write_text(json.dumps(report,indent=2)+'\n')
    save()
    try:
        for lane in ('fdm_cuda','fem_cpu'):
            for n in (8,16,32):
                r=measure(lane,n,paths,out);report['measurements'].append(r);save();print(json.dumps(r),flush=True)
        failures=[]
        for lane in ('fdm_cuda','fem_cpu'):
            rows=[r for r in report['measurements'] if r['lane']==lane]
            for state in (0,1):
                for quantity in ('energy','field')+ (('amplitude',) if state==1 else ()):
                    key={'energy':'energy_relative','field':'field_relative_l2','amplitude':'amplitude_relative'}[quantity]
                    errors=[r['states'][state][key] for r in rows]
                    if errors[-1]>GATES[quantity+'_finest'] or any(a<GATES[quantity+'_refinement']*b for a,b in zip(errors,errors[1:])):
                        failures.append({'lane':lane,'state':state,'quantity':quantity,'errors':errors})
        a=[r for r in report['measurements'] if r['lane']=='fdm_cuda'];b=[r for r in report['measurements'] if r['lane']=='fem_cpu']
        gaps=[abs(x['states'][1]['amplitude']-y['states'][1]['amplitude'])/x['states'][1]['exact_amplitude'] for x,y in zip(a,b)]
        report['cross_amplitude_relative']=gaps
        if gaps[-1]>GATES['cross_amplitude_finest'] or any(x<GATES['cross_amplitude_refinement']*y for x,y in zip(gaps,gaps[1:])):failures.append({'quantity':'cross_amplitude','errors':gaps})
        report['failures']=failures;report['state']='failed' if failures else 'passed';save()
        print(json.dumps({'state':report['state'],'failures':failures,'cross_amplitude_relative':gaps}),flush=True)
        return int(bool(failures))
    except BaseException as error:
        report['state']='error';report['error']=repr(error);save();raise
if __name__=='__main__':raise SystemExit(main())
