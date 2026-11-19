"""Interpreted rotation reconciliation tests; no Docker, compiler or runtime."""
import ast
import base64
import contextlib
import copy
import hashlib
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import docker_claimed_promotion_reconcile as reconcile
import test_docker_dev_recovery_build as repair_tests


class PromotionReconciliationTests(unittest.TestCase):
    @contextlib.contextmanager
    def fixture(self):
        with repair_tests.RecoveryPromotionTests().fixture() as f:
            backend = f.backend
            attempt = 'a'*32
            root = f.package.parent/'control'/'recovery-promotion'/'attempts'/attempt
            root.mkdir(parents=True)
            control = root.parent.parent.parent
            (control/'active').write_text(attempt+'\n')
            permit = {'identity':{'test':'immutable'}}
            relative = 'verification/claimed-interruption/'+'b'*32+'/build-pin.json'
            permit_path = control/relative; permit_path.parent.mkdir(parents=True)
            permit_path.write_bytes(backend._canonical(permit))
            inputs = {**f.request, 'source_root':'/selected','compose_project':'selected',
                'operation_root':str(root),'claimed_build_pin':relative,
                'claimed_build_pin_sha256':reconcile.digest(permit_path.read_bytes()),
                'claimed_interruption_build':permit,'controller_sha256':reconcile.ORIGINAL_CONTROLLER_SHA256}
            original = {'state':'outcome-unknown-resources-retained','failure':'original failure','inputs':inputs}
            originals = {'receipt.json':backend._canonical(original),
                'build.log':b'traceback\n'+reconcile.FAILURE,
                'previous-provenance.json':backend._canonical({'schema':'fullmag.recovery-promotion-original.v1',
                    'sha256':f.request['provenance_sha256'],
                    'base64':base64.b64encode(f.original_provenance).decode()})}
            for name,raw in originals.items():
                (root/name).write_bytes(raw)
            rotation = backend._rotate_package(f.package,f.candidate,f.control,f.previous[2],f.previous[1],f.raw)
            backend._publish_runtime_provenance(f.package)
            evidence = {'owner':'unchanged','ledger':'unchanged','process':'unchanged'}
            namespace = {'backend':backend,'os':os,'json':json,'hashlib':hashlib,'require':reconcile.require,
                'Path':lambda value: f.package.parent/'build' if value == '/build' else Path(value),
                'pinned_evidence':lambda *_:dict(evidence),
                'runtime_locks':lambda:contextlib.nullcontext(None),
                'claimed_build_locks':lambda *_:contextlib.nullcontext()}
            exec(reconcile.RUNTIME,namespace)
            namespace['no_promotion_writer'] = lambda _:None
            request = {'schema':reconcile.SCHEMA,'attempt':attempt,'request_id':'c'*32,
                'inputs':inputs,'helper':{},'source_pins':{},'controller_pids':[998],
                'original_sha256':{name:reconcile.digest(raw) for name,raw in originals.items()},'observation':{}}
            with patch.dict(os.environ,FULLMAG_COMPOSE_PROJECT='selected',FULLMAG_SOURCE_HOST_ROOT='/selected'):
                yield SimpleNamespace(f=f,root=root,request=request,namespace=namespace,
                    rotation=rotation,originals=originals,evidence=evidence,
                    call=lambda apply=False:namespace['reconcile_published'](request,apply))

    def test_preview_is_readonly_and_apply_finalizes_only_exact_published_rotation(self):
        with self.fixture() as t:
            before = {str(path):path.read_bytes() for path in t.root.parent.parent.parent.rglob('*') if path.is_file()}
            t.request['observation'] = t.call()
            after = {str(path):path.read_bytes() for path in t.root.parent.parent.parent.rglob('*') if path.is_file()}
            self.assertEqual(before,after)
            result = t.call(True)
            self.assertEqual(result['state'],'succeeded')
            self.assertFalse(Path(t.rotation['journal']).exists())
            self.assertFalse(t.f.candidate.exists())
            self.assertTrue(Path(t.rotation['backup']).exists())
            self.assertEqual((t.root.parent.parent.parent/'active').read_text(),'a'*32+'\n')
            archive_request = (t.root/'reconciliation'/('c'*32)/'request.json').read_bytes()
            self.assertEqual(archive_request,reconcile.canonical(t.request)+b'\n')
            self.assertEqual(result['decision']['request_sha256'],reconcile.digest(archive_request))
            final = json.loads((t.root/'terminal.json').read_bytes())
            self.assertEqual(final,json.loads((t.root/'receipt.json').read_bytes()))
            self.assertEqual(final['original_failure'],'original failure')
            self.assertFalse(final['result']['runtime_started'])
            for name,raw in t.originals.items():
                self.assertEqual((t.root/'reconciliation'/('c'*32)/('original-'+name)).read_bytes(),raw)
            t.f.prepare.assert_not_called(); t.f.serve.assert_not_called()

    def test_observation_drift_never_finalizes(self):
        for drift in ('runtime','receipt','provenance','journal','log','candidate','rollback','permit','active'):
            with self.subTest(drift=drift), self.fixture() as t:
                t.request['observation'] = t.call()
                if drift == 'runtime': t.evidence['ledger']='changed'
                elif drift == 'receipt': (t.root/'receipt.json').write_bytes(b'changed')
                elif drift == 'provenance': t.f.provenance.write_bytes(b'{}')
                elif drift == 'journal':
                    doc=json.loads(Path(t.rotation['journal']).read_bytes());doc['new_receipt_sha256']='0'*64
                    Path(t.rotation['journal']).write_text(json.dumps(doc))
                elif drift == 'log': (t.root/'build.log').write_bytes(b'changed')
                elif drift == 'candidate': (t.f.candidate/'unknown').write_bytes(b'payload')
                elif drift == 'rollback': (Path(t.rotation['backup'])/'bin/fullmag-api').write_bytes(b'changed')
                elif drift == 'permit':
                    (t.root.parent.parent.parent/t.request['inputs']['claimed_build_pin']).write_bytes(b'{}')
                elif drift == 'active': (t.root.parent.parent.parent/'active').write_text('d'*32)
                with self.assertRaises((ValueError,reconcile.BuildControlError,t.f.backend.BackendBuildError)):
                    t.call(True)
                self.assertTrue(Path(t.rotation['journal']).exists())
                self.assertTrue(t.f.candidate.exists())
                self.assertFalse((t.root/'terminal.json').exists())

    def test_post_finalize_runtime_drift_never_publishes_terminal(self):
        with self.fixture() as t:
            t.request['observation']=t.call()
            original=t.f.backend._clear_rotation_journal
            def drift(rotation):
                original(rotation)
                t.evidence['ledger']='changed after finalization'
            with patch.object(t.f.backend,'_clear_rotation_journal',side_effect=drift):
                with self.assertRaisesRegex(reconcile.BuildControlError,'during canonical rotation finalization'):
                    t.call(True)
            self.assertFalse((t.root/'terminal.json').exists())
            self.assertTrue((t.root.parent.parent.parent/'active').exists())

    def test_live_original_inline_body_is_rejected_even_without_pid_pin(self):
        with tempfile.TemporaryDirectory() as directory:
            proc=Path(directory); row=proc/'998';row.mkdir()
            (row/'stat').write_text('998 (python) S')
            body=b'original exact controller body'
            (row/'cmdline').write_bytes(b'python\0-c\0'+body+b'\0')
            namespace={'Path':lambda value:proc if value=='/proc' else Path(value),
                'os':os,'hashlib':hashlib,'require':reconcile.require}
            exec(reconcile.RUNTIME,namespace)
            request={'controller_pids':[],'inputs':{'controller_sha256':reconcile.digest(body)}}
            with self.assertRaisesRegex(reconcile.BuildControlError,'inline promotion controller remains alive'):
                namespace['no_promotion_writer'](request)
            (row/'cmdline').write_bytes(b'python\0-c\0print(1)\0')
            namespace['no_promotion_writer'](request)

    def test_original_writer_denies_preview(self):
        with self.fixture() as t:
            def refuse(_): raise ValueError('controller alive')
            t.namespace['no_promotion_writer']=refuse
            with self.assertRaisesRegex(ValueError,'controller alive'):t.call()
            self.assertFalse((t.root/'terminal.json').exists())

    def test_entrypoint_cannot_retry_promotion(self):
        code=reconcile.inside_code();ast.parse(code)
        self.assertNotIn('\ninside_promote(json.loads(sys.argv[1]))\n',code)
        tree=ast.parse(reconcile.RUNTIME)
        attributes={node.func.attr for node in ast.walk(tree)
            if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute)}
        self.assertFalse({'kill','unlink','rmdir','Popen','run','_rotate_package','_publish_runtime_provenance'} & attributes)

    def test_request_rejects_missing_or_ambiguous_pins(self):
        with self.fixture() as t:
            reconcile.validate_request(t.request)
            t.request['controller_pids']=[]
            reconcile.validate_request(t.request)
            for key in t.request:
                request=copy.deepcopy(t.request);del request[key]
                with self.assertRaises(reconcile.BuildControlError):reconcile.validate_request(request)
            t.request['controller_pids']=[True]
            with self.assertRaises(reconcile.BuildControlError):reconcile.validate_request(t.request)


if __name__ == '__main__':unittest.main()
