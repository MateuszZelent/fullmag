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
        absent.stderr=('error: no such object: '+container+'\n').encode()
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


    def _failed_prestart(self,control,ctx,**changes):
        fields=('attempt attempt_limit build_data_qualification compose_project control_volume error '
            'filesystem_after filesystem_before finished_at helper_container inputs log_byte_limit '
            'minimum_free_bytes phase schema started_at state').split()
        value=dict.fromkeys(fields)
        value.update(attempt='e'*32,compose_project='group',control_volume='control',
            phase='development',schema='fullmag.docker-build-operation.v1',state='failed-confirmed',
            error='old service absence is not authoritative: '+ctx['backend_pin']['Id'],
            started_at=1794571200.25,finished_at=1794571201.25,
            helper_container='qualified-control-helper',inputs={'failed_run_resume':ctx,
                'source_root':ctx['source_root'],'image_id':'sha256:'+'1'*64})
        value.update(changes)
        control.write('development/current.json',value)
        control.write('development/attempts/'+'e'*32+'/terminal.json',value)
        return value

    def test_only_canonical_first_prestart_failure_can_continue_removed_services(self):
        control=Control();ctx=self.prepare(control,args())['context']
        self._failed_prestart(control,ctx)
        pin=resume.qualify_prestart_failure(control,ctx)
        self.assertEqual(pin['development_attempt'],'e'*32)
        self.assertEqual(resume.qualify_prestart_failure(control,ctx,pin=pin),pin)
        for changes in ({'state':'outcome-unknown-resources-retained'}, {'state_root':None},
                        {'backend_container':'1'*64},{'error':'backend failed after start'}):
            with self.subTest(changes=changes):
                self._failed_prestart(control,ctx,**changes)
                with self.assertRaisesRegex(resume.ResumeError,'prestart|first|confirmed'):
                    resume.qualify_prestart_failure(control,ctx)

    def test_prestart_failure_pin_is_immutable_after_latest_moves(self):
        control=Control();ctx=self.prepare(control,args())['context']
        failure=self._failed_prestart(control,ctx)
        pin=resume.qualify_prestart_failure(control,ctx)
        control.write('development/current.json',{'attempt':'new-running-operation'})
        self.assertEqual(resume.qualify_prestart_failure(control,ctx,pin=pin),pin)
        failure['error']='changed proof'
        control.write('development/attempts/'+'e'*32+'/terminal.json',failure)
        with self.assertRaises(resume.ResumeError):
            resume.qualify_prestart_failure(control,ctx,pin=pin)


    def test_qualified_prestart_continues_start_once_without_recreating_again(self):
        import docker_volume_dev as dev
        control=Control();ctx=self.prepare(control,args())['context']
        failure=self._failed_prestart(control,ctx)
        failure['inputs']['frontend_start_handoff']={'fixture':'pinned-handoff','current_sha256':'3'*64}
        control.write('development/current.json',failure)
        control.write('development/attempts/'+'e'*32+'/terminal.json',failure)
        removal={'attempt':'f'*32,'inputs':{'failed_run_resume':ctx}}
        control.write('recreate-services/verified.json',removal)
        control.write('recreate-services/attempts/'+'f'*32+'/retained-containers.json',{'backend':{},'frontend':{}})
        previous={'inputs':{'image_id':'sha256:'+'2'*64,'gpu_access_requested':'disabled'}}
        control.write('development/attempts/'+'a'*32+'/terminal.json',previous)
        control.write('development/attempts/'+'a'*32+'/compose.json',{'name':'group'})
        failure_pin=resume.qualify_prestart_failure(control,ctx)
        refreshed={'fixture':'pinned-handoff','current_sha256':failure_pin['terminal_sha256']}
        request=args(preview=False,apply=True,expected_plan_sha256=ctx['plan_sha256'])
        def start(call_args,**kwargs):
            self.assertIsNone(call_args.script);self.assertFalse(call_args.fresh_state)
            self.assertEqual(kwargs['retained_device_access'],'cpu')
            self.assertEqual(kwargs['reuse_state']['frontend_start_handoff'],refreshed)
            self.assertEqual(kwargs['failed_run_resume_context']['prestart_failure']['development_attempt'],'e'*32)
            resume.bind_start_attempt(control,ctx,{'receipt':{'attempt':'9'*32}})
            control.write('development/attempts/'+'9'*32+'/terminal.json',{
                'phase':'development','state':'succeeded','attempt':'9'*32,
                'compose_project':'group','control_volume':'control','inputs':{'failed_run_resume':ctx}})
        with (mock.patch.object(resume,'_request_control',return_value=control),
              mock.patch.object(resume,'revalidate_resume_request') as validate,
              mock.patch.object(dev,'_operator_probe_record_from_retained',return_value={}),
              mock.patch.object(dev,'include_untracked_from_compose',return_value=[]),
              mock.patch.object(dev,'_retained_native_contracts',return_value=[]),
              mock.patch.object(dev,'_retained_device_access',return_value='cpu'),
              mock.patch.object(dev,'_capture_frontend_start_handoff',return_value=refreshed) as capture,
              mock.patch('docker_dev_network.retained_requested_subnet',return_value=None),
              mock.patch.object(dev,'start',side_effect=start) as started,
              mock.patch.object(dev,'resume_failed_run') as recreate):
            capture.return_value={**refreshed,'fixture':'changed-private-generation'}
            with self.assertRaisesRegex(resume.ResumeError,'changed pins'):
                resume.run(request)
            started.assert_not_called();recreate.assert_not_called()
            capture.reset_mock();capture.return_value=refreshed
            result=resume.run(request)
        self.assertEqual(result['development_attempt'],'9'*32)
        started.assert_called_once();recreate.assert_not_called()
        capture.assert_called_once_with(control,previous,{'name':'group'},expected_current_sha256=failure_pin['terminal_sha256'])
        self.assertEqual(validate.call_args.kwargs,{'phase':'before-start','removal':removal})


if __name__=='__main__':unittest.main()
