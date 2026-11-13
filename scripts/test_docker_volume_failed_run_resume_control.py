"""Control-only tests: no Docker or accepted-store writes."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import docker_volume_failed_run_resume as resume
from docker_build_control import canonical


class Control:
    project='group'
    volume='control'
    namespace=''
    def __init__(self):
        self.records={}
        self.writes=[]
    def read_bytes(self,path,optional=False):
        if optional:return self.records.get(path)
        return self.records[path]
    def write(self,path,value):
        self.records[path]=canonical(value)+b'\n'
        self.writes.append(path)


def args(**changes):
    result=SimpleNamespace(attempt='a'*32,config_sha256='b'*64,stop_attempt='c'*32,
        stop_terminal_sha256='d'*64,run_id='run-existing',request_id='11111111-1111-4111-8111-111111111111',
        source_root=Path('/tmp/source'),port=3243,preview=True,apply=False,
        expected_plan_sha256=None,fresh_state=False,script=None,profile='dev',image=None,
        toolchain_image=None,source_manifest=None)
    for k,v in changes.items():setattr(result,k,v)
    return result


def context():
    return {'schema':'fullmag.failed-run-resume-context.v1','request_id':args().request_id,
        'run_id':'run-existing','stop_pin':{'stop_attempt':'c'*32,'stop_terminal_raw_sha256':'d'*64,'development_attempt':'a'*32},'run_pin':{'store_inventory_sha256':'a'*64},
        'previous_terminal_sha256':'b'*64,'config_sha256':'b'*64,
        'source_root':'/tmp/source','compose_project':'group','control_volume':'control',
        'backend_pin':{'Id':'e'*64},'frontend_pin':{'Id':'f'*64},'state_root':'/tmp/state'}


class FailedRunResumeControlTests(unittest.TestCase):
    def prepare(self,control,request,ctx=None):
        with mock.patch.object(resume,'_collect_resume_context',return_value=ctx or context()):
            return resume.prepare_resume_request(control,request,{}, {}, {},Path('/tmp/state'))

    def test_preview_plan_is_repeatable_and_writes_only_its_control_record(self):
        control=Control();request=args()
        first=self.prepare(control,request)
        second=self.prepare(control,request)
        self.assertEqual(first,second)
        self.assertEqual(len(control.writes),1)
        self.assertTrue(control.writes[0].startswith('failed-run-resume/requests/'))

    def test_apply_rejects_wrong_reviewed_plan_without_overwriting_it(self):
        control=Control();first=self.prepare(control,args())
        with self.assertRaisesRegex(resume.ResumeError,'plan'):
            self.prepare(control,args(preview=False,apply=True,expected_plan_sha256='f'*64))
        self.assertEqual(len(control.writes),1)

    def test_reusing_request_for_changed_run_pin_is_refused(self):
        control=Control();self.prepare(control,args())
        changed=context();changed['run_pin']['store_inventory_sha256']='f'*64
        with self.assertRaisesRegex(resume.ResumeError,'plan|request'):
            self.prepare(control,args(),changed)
        self.assertEqual(len(control.writes),1)

    def test_invalid_request_and_script_are_rejected_before_observation(self):
        for changes in ({'request_id':'../../other'},{'script':'replay.py'},{'fresh_state':True},
                        {'preview':False,'apply':True,'expected_plan_sha256':None}):
            with self.subTest(changes=changes),mock.patch.object(resume,'_collect_resume_context') as observe:
                with self.assertRaises(resume.ResumeError):
                    resume.prepare_resume_request(Control(),args(**changes),{}, {}, {},Path('/tmp/state'))
                observe.assert_not_called()

    def test_context_drift_is_refused_before_any_lifecycle_mutation(self):
        control=Control();prepared=self.prepare(control,args())
        changed=context();changed['run_pin']['store_inventory_sha256']='f'*64
        with mock.patch.object(resume,'_collect_resume_context',return_value=changed):
            with self.assertRaisesRegex(resume.ResumeError,'changed|differ'):
                resume.revalidate_resume_request(control,args(preview=False,apply=True,expected_plan_sha256=prepared['context']['plan_sha256']),prepared['context'],{}, {}, {},
                                                 Path('/tmp/state'),phase='recreate-lease')
        self.assertEqual(len(control.writes),1)

    def test_before_start_requires_exact_completed_removal_receipt(self):
        control=Control();prepared=self.prepare(control,args())
        with self.assertRaisesRegex(resume.ResumeError,'removal|recreat'):
            resume.revalidate_resume_request(control,args(preview=False,apply=True,expected_plan_sha256=prepared['context']['plan_sha256']),prepared['context'],{}, {}, {},
                                             Path('/tmp/state'),phase='before-start',removal=None)


    def test_completed_request_replays_exact_start_after_verified_pointer_moves(self):
        control=Control();prepared=self.prepare(control,args());ctx=prepared['context']
        operation={'receipt':{'attempt':'e'*32}}
        resume.bind_start_attempt(control,ctx,operation)
        terminal={'attempt':'e'*32,'phase':'development','state':'succeeded',
            'compose_project':'group','control_volume':'control','inputs':{'failed_run_resume':ctx}}
        control.write('development/attempts/'+'e'*32+'/terminal.json',terminal)
        control.write('development/verified.json',{'attempt':'later-unrelated'})
        request=args(preview=False,apply=True,expected_plan_sha256=ctx['plan_sha256'])
        with mock.patch.object(resume,'_request_control',return_value=control), mock.patch(
                'docker_volume_dev.resume_failed_run') as start:
            result=resume.run(request)
        self.assertEqual(result['development_attempt'],'e'*32)
        start.assert_not_called()

    def test_unfinished_start_pointer_never_dispatches_another_start(self):
        control=Control();prepared=self.prepare(control,args());ctx=prepared['context']
        resume.bind_start_attempt(control,ctx,{'receipt':{'attempt':'e'*32}})
        request=args(preview=False,apply=True,expected_plan_sha256=ctx['plan_sha256'])
        with mock.patch.object(resume,'_request_control',return_value=control), mock.patch(
                'docker_volume_dev.resume_failed_run') as start:
            with self.assertRaisesRegex(resume.ResumeError,'unresolved|completed|replay'):
                resume.run(request)
        start.assert_not_called()


    def test_missing_docker_object_accepts_empty_json_but_not_daemon_failure(self):
        container='a'*64
        absent=SimpleNamespace(returncode=1,stdout=b'[]\n',
            stderr=('Error: No such object: '+container+'\n').encode())
        with mock.patch('docker_build_control.docker_capture',return_value=absent):
            self.assertIsNone(resume._inspect_container(container,absent=True))
        failed=SimpleNamespace(returncode=1,stdout=b'',stderr=b'Cannot connect to Docker daemon')
        with mock.patch('docker_build_control.docker_capture',return_value=failed):
            with self.assertRaisesRegex(resume.ResumeError,'absence'):
                resume._inspect_container(container,absent=True)


    def test_revalidation_requires_apply_and_the_same_reviewed_digest(self):
        control=Control();prepared=self.prepare(control,args());ctx=prepared['context']
        for request in (args(),args(preview=False,apply=True,expected_plan_sha256='f'*64)):
            with mock.patch.object(resume,'_collect_resume_context',return_value=context()):
                with self.assertRaisesRegex(resume.ResumeError,'apply|reviewed'):
                    resume.revalidate_resume_request(control,request,ctx,{}, {}, {},
                                                     Path('/tmp/state'),phase='recreate-lease')


if __name__=='__main__':unittest.main()
