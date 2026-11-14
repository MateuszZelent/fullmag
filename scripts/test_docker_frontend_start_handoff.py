"""Authenticated frontend generations survive service recreation and a new start."""
from __future__ import annotations
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent))
import docker_volume_dev as dev
from docker_build_control import BuildControlError, canonical
from test_docker_volume_recovery_handoff import MemoryControl

class FrontendStartHandoffTests(unittest.TestCase):
    def setUp(self):
        self.c=MemoryControl();self.c.write=self.c.put;self.c.subpath=lambda relative: '/'.join(v for v in (self.c.namespace,relative) if v);self.attempt='a'*32;self.generation='b'*32
        self.subpath='private/frontend/generations/'+self.generation
        self.document={'name':self.c.project,'services':{'frontend':{'volumes':[{'type':'volume','source':'frontend-build','target':'/state/development','volume':{'subpath':self.subpath}}]}},'volumes':{'frontend-build':{'name':self.c.volume,'external':True}}}
        self.previous={'schema':'fullmag.docker-build-operation.v1','phase':'development','state':'succeeded','attempt':self.attempt,'compose_project':self.c.project,'control_volume':self.c.volume,'private_group_storage':'group-volume-v1','frontend_volume':self.c.volume,'frontend_generation_id':self.generation,'frontend_generation_subpath':self.subpath,'state_root':'/state-own','inputs':{'source_root':'/checkout'},'config_sha256':hashlib.sha256(canonical(self.document)).hexdigest()}
        self.publish()
    def publish(self):
        self.c.put('development/attempts/'+self.attempt+'/terminal.json',self.previous)
        self.c.put('development/attempts/'+self.attempt+'/compose.json',self.document)
        self.c.put('development/current.json',self.previous)
        self.c.put('development/verified.json',self.previous)
    def pin(self):return dev._capture_frontend_start_handoff(self.c,self.previous,self.document)
    def apply(self,pin):
        op={'root':'development/attempts/'+'c'*32,'receipt':{'attempt':'c'*32}}
        dev._pin_start_frontend_storage(self.c,op,Path('/checkout'),Path('/state-own'),pin,new_render=True)
        return op
    def test_new_start_keeps_active_generation_instead_of_poisoned_legacy(self):
        before=copy.deepcopy(self.c.records);pin=self.pin();op=self.apply(pin)
        self.assertEqual(op['receipt']['frontend_generation_id'],self.generation)
        self.assertEqual(op['receipt']['frontend_generation_subpath'],self.subpath)
        for path,raw in before.items():self.assertEqual(self.c.records[path],raw)
    def test_current_or_verified_drift_refuses_before_any_new_receipt_write(self):
        for path in ('development/current.json','development/verified.json'):
            with self.subTest(path=path):
                self.setUp();pin=self.pin();self.c.put(path,{'attempt':'d'*32});before=copy.deepcopy(self.c.records)
                with self.assertRaises(BuildControlError):self.apply(pin)
                self.assertEqual(self.c.records,before)
    def test_compose_generation_mismatch_and_partial_pair_refuse(self):
        for field in ('frontend_generation_id','frontend_generation_subpath'):
            with self.subTest(field=field):
                self.setUp();self.previous.pop(field);self.publish()
                with self.assertRaises(BuildControlError):self.pin()
        self.setUp();self.document['services']['frontend']['volumes'][0]['volume']['subpath']='private/frontend'
        self.previous['config_sha256']=hashlib.sha256(canonical(self.document)).hexdigest();self.publish()
        with self.assertRaises(BuildControlError):self.pin()
    def test_source_state_and_namespace_drift_refuse_before_storage_write(self):
        pin=self.pin()
        for source,state in ((Path('/foreign'),Path('/state-own')),(Path('/checkout'),Path('/foreign'))):
            with self.subTest(source=source,state=state):
                before=copy.deepcopy(self.c.records)
                with self.assertRaises(BuildControlError):dev._pin_start_frontend_storage(self.c,{'root':'new','receipt':{}},source,state,pin,new_render=True)
                self.assertEqual(self.c.records,before)
        self.c.namespace='namespaces/'+'d'*32;self.c.namespace_registry_sha256='e'*64
        with self.assertRaises(BuildControlError):self.apply(pin)
    def test_pre_stop_preflight_rejects_changed_generation_authority(self):
        self.c.put('development/current.json', {'attempt': 'd' * 32})
        before = copy.deepcopy(self.c.records)
        with self.assertRaises(BuildControlError):
            dev.preflight_retained_recovery_handoff(self.c, self.previous, self.document, {})
        self.assertEqual(self.c.records, before)

    def test_legacy_is_allowed_only_when_receipt_and_compose_both_select_legacy(self):
        self.previous.pop('frontend_generation_id');self.previous.pop('frontend_generation_subpath')
        self.document['services']['frontend']['volumes'][0]['volume']['subpath']='private/frontend'
        self.previous['config_sha256']=hashlib.sha256(canonical(self.document)).hexdigest();self.publish()
        self.assertIsNone(self.pin())
    def test_missing_storage_mode_cannot_hide_generation_evidence(self):
        for keep_fields in (True, False):
            with self.subTest(keep_fields=keep_fields):
                self.setUp()
                self.previous.pop('private_group_storage')
                if not keep_fields:
                    self.previous.pop('frontend_generation_id')
                    self.previous.pop('frontend_generation_subpath')
                self.publish()
                before = copy.deepcopy(self.c.records)
                with self.assertRaises(BuildControlError):
                    self.pin()
                self.assertEqual(self.c.records, before)

    def test_genuine_legacy_without_group_mode_stays_compatible(self):
        self.previous.pop('private_group_storage')
        self.previous.pop('frontend_generation_id')
        self.previous.pop('frontend_generation_subpath')
        self.document['services']['frontend']['volumes'][0]['volume']['subpath'] = 'private/frontend'
        self.publish()
        self.assertIsNone(self.pin())

    def test_missing_generation_marker_cannot_hide_a_generation_mount(self):
        self.previous.pop('frontend_generation_id');self.previous.pop('frontend_generation_subpath');self.publish()
        with self.assertRaises(BuildControlError):self.pin()

if __name__=='__main__':unittest.main()
