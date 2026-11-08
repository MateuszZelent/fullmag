"""An unused admitted permit authorizes a pinned repair build, never a release."""
import copy
import ast
import os
import re
import tempfile
from types import SimpleNamespace
import hashlib
import json
from pathlib import Path
import unittest
import docker_dev_recovery_build as repair
import docker_volume_claimed_interruption as collector


def raw(value):
    return json.dumps(value,sort_keys=True,separators=(',',':')).encode()


def fixture():
    rid={'store_id':'sha256:'+'a'*64,'run_id':'run-pending','task_id':'task-pending','resource_id':'cpu',
         'lease_token':'lease-pending','owner':{'kind':'solver','attempt_id':'attempt-pending','ownership_epoch':1}}
    row={'identity':rid,'state':'committed','worker_launch_gate':{'state':'pending'}}
    task={'task_id':rid['task_id'],'attempt_id':'attempt-pending','ownership_epoch':1,'resource_id':'cpu',
          'lifecycle':'preparing','artifact_ids':[]}
    lease={'schema_version':'resource_lease.v1','state':'active','heartbeat_sequence':0,
           **{k:rid[k] for k in ('run_id','task_id','resource_id','lease_token')},'attempt_id':'attempt-pending','ownership_epoch':1}
    values={'catalog':{'run_id':rid['run_id'],'tasks':[task]},'lease':lease,
            'admission':{'schema_version':'task_admission.v1','task':task,'lease':lease,'resolved_inputs_snapshot':{}},
            'launch':{'schema_version':'runtime_service_launch.v1','state':'ready'}}
    observed={k:raw(v) for k,v in values.items()};ledger={'reservations':[row]}
    pin=collector.make_pending_build_pin(ledger,{k:Path('/private')/k for k in values},observed,rid['run_id'],rid['task_id'])
    return pin,ledger,observed


class PendingAdmissionBuildTests(unittest.TestCase):
    def test_pinned_unused_admission_is_accepted_without_mutation(self):
        pin,ledger,observed=fixture();before=copy.deepcopy((pin,ledger,observed))
        repair.validate_pending_build_snapshot(pin,ledger,observed)
        self.assertEqual((pin,ledger,observed),before)

    def test_consumed_closed_extra_and_released_reservations_refuse(self):
        for mode in ('consumed','closed','released','extra'):
            pin,ledger,observed=fixture();row=ledger['reservations'][0]
            if mode=='extra':ledger['reservations'].append(copy.deepcopy(row))
            elif mode=='released':row['state']='released'
            else:row['worker_launch_gate']={'state':mode}
            pin['reservation_sha256']=hashlib.sha256(raw(row)).hexdigest()
            with self.subTest(mode=mode),self.assertRaises(ValueError):repair.validate_pending_build_snapshot(pin,ledger,observed)

    def test_rehashed_mismatched_or_progressed_records_refuse(self):
        for role,field,value in [('lease','heartbeat_sequence',1),('lease','state','released'),
                                 ('admission','task',{}),('admission','lease',{}),('admission','resolved_inputs_snapshot',None)]:
            pin,ledger,observed=fixture();record=json.loads(observed[role]);record[field]=value
            observed[role]=raw(record);pin['files'][role]['sha256']=hashlib.sha256(observed[role]).hexdigest()
            with self.subTest(role=role,field=field),self.assertRaises(ValueError):repair.validate_pending_build_snapshot(pin,ledger,observed)
        pin,ledger,observed=fixture();pin['identity']['run_id']='../foreign'
        with self.assertRaises(ValueError):repair.validate_pending_build_snapshot(pin,ledger,observed)

    def test_filesystem_evidence_refuses_worker_and_supervisor_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            base=Path(temporary);store=base/'store';runtime_root=base/'runtime'
            pin,ledger,observed=fixture();identity=pin['identity'];run=store/'runs'/identity['run_id']
            fixed={'catalog':run/'run_catalog.json','lease':run/'resource_leases'/'cpu'/'lease-pending.json',
                   'admission':run/'task_admissions'/'task-pending'/'attempt-pending.json','launch':runtime_root/'LAUNCH.json'}
            launch=json.loads(observed['launch']);launch['pid']=102;observed['launch']=raw(launch)
            for role,path in fixed.items():
                path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(observed[role])
                pin['files'][role]={'path':str(path),'sha256':hashlib.sha256(observed[role]).hexdigest()}
            namespace=dict(require=repair.require,os=os,re=re,json=json,hashlib=hashlib,
                           read=lambda path:Path(path).read_bytes(),validate_pending_build_snapshot=repair.validate_pending_build_snapshot,
                           runtime=SimpleNamespace(runtime_services_root=lambda paths:runtime_root))
            node=next(n for n in ast.parse(repair.RUNTIME).body if isinstance(n,ast.FunctionDef) and n.name=='pending_build_evidence')
            exec(compile(ast.Module(body=[node],type_ignores=[]),'<pending-filesystem-evidence>','exec'),namespace)
            check=lambda:namespace['pending_build_evidence'](pin,SimpleNamespace(store=store),ledger,{'state':'failed','pid':102})
            check()
            epoch=run/'worker-attempts'/'task-pending'/'attempt-pending'/'epoch-1';epoch.mkdir(parents=True)
            with self.assertRaisesRegex(ValueError,'worker attempt'):check()
            epoch.rmdir()
            slot=store/'supervisor-slots'/'resource'/'owner.v2.json';slot.parent.mkdir(parents=True);slot.write_text('{}')
            with self.assertRaisesRegex(ValueError,'supervisor'):check()
            slot.unlink()
            journal=run/'coordinator_journal'/'command'/'command.json';journal.parent.mkdir(parents=True)
            journal.write_text(json.dumps({'task_id':'task-pending'}))
            with self.assertRaisesRegex(ValueError,'execution evidence'):check()
            journal.write_text(json.dumps({'task_id':'earlier-completed-task'}))
            check()


if __name__=='__main__':
    unittest.main()
