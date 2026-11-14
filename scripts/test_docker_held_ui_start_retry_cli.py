"""Closed failed-held-start CLI dispatch; no Docker actions."""
from contextlib import redirect_stderr
from io import StringIO
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
import docker_dev
import test_docker_held_ui_materialization_cli as original

class HeldUiStartRetryCliTests(unittest.TestCase):
    def arguments(self):
        return original.HeldUiMaterializationCliTests().arguments()[0:2] + [
            "retry-held-ui-start-volume", "--attempt", "a"*32, "--config-sha256", "b"*64,
            "--source-root", "/registered/task", "--run-id", "run-live-"+"c"*64,
            "--request-id", "11111111-1111-4111-8111-111111111111", "--port", "3243",
            "--expected-plan-sha256", "d"*64, "--failed-held-start-attempt", "e"*32,
            "--failed-held-start-sha256", "f"*64]

    def dispatch(self, suffix):
        import os, subprocess, tempfile
        text=(Path(__file__).parent/'just_storage_shell.sh').read_text()
        body=text.split('  *"scripts/docker_dev.py"*)\n',1)[1].split('\n    ;;',1)[0]
        values=self.arguments()
        # Recipe syntax quotes every argument value, matching the just wrapper.
        recipe='python "/ignored/scripts/docker_dev.py" --repo-root "/registered/repo" '+values[2]
        for i in range(3,len(values),2):
            recipe += " "+values[i]+" '"+values[i+1]+"'"
        recipe+=suffix
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'docker_dev.py').write_text('import json,sys; print(json.dumps(sys.argv[1:]))\n')
            program='set -euo pipefail\nrecipe="$RECIPE"\npython_cmd="$PYTHON"\nscript_dir="$SCRIPTS"\nrepo_root="/registered/repo"\n'+body
            return subprocess.run(['bash','--noprofile','--norc','-c',program],env={**os.environ,'RECIPE':recipe,'PYTHON':sys.executable,'SCRIPTS':directory},capture_output=True,text=True,timeout=15)

    def test_explicit_modes_keep_original_and_failed_start_pins(self):
        for mode in [['--preview'],['--apply','--retry-plan-sha256','9'*64]]:
            args=docker_dev._parser().parse_args(self.arguments()+mode)
            self.assertEqual(args.action,'retry-held-ui-start-volume')
            self.assertEqual(args.failed_held_start_attempt,'e'*32)
            self.assertEqual(args.expected_plan_sha256,'d'*64)
            self.assertFalse(args.fresh_state)

    def test_missing_pins_and_conflicting_modes_refused(self):
        for values in [self.arguments(),self.arguments()+['--preview','--apply'],self.arguments()[:-2]+['--preview']]:
            with redirect_stderr(StringIO()),self.assertRaises(SystemExit):
                docker_dev._parser().parse_args(values)

    def test_direct_cli_rejects_missing_or_malformed_retry_sha_before_module_io(self):
        from contextlib import redirect_stdout
        from types import SimpleNamespace
        from unittest.mock import Mock, patch
        for mode in [['--apply'],['--apply','--retry-plan-sha256','bad'],
                     ['--preview','--retry-plan-sha256','9'*64]]:
            run=Mock(return_value={})
            with patch.dict(sys.modules,{'docker_volume_held_ui_start_retry':SimpleNamespace(run=run)}), redirect_stderr(StringIO()), redirect_stdout(StringIO()):
                self.assertEqual(docker_dev.main(self.arguments()+mode),2)
            run.assert_not_called()

    def test_capture_rejects_alternate_port_before_observing_or_stopping_backend(self):
        import types
        from unittest.mock import Mock, patch
        import docker_volume_held_ui_start_retry as retry
        import docker_volume_held_ui_start_retry_lifecycle as lifecycle
        control=types.SimpleNamespace(read_bytes=lambda *a,**kw: None)
        original={'control':control,'claim':{'recreate_attempt':'c'*32}}
        document={'services':{'frontend':{'ports':[{'host_ip':'127.0.0.1','target':8080,
            'protocol':'tcp','mode':'ingress','published':'3243'}]}}}
        fake_dev=types.SimpleNamespace(
            _load_held_ui_request_context=Mock(return_value=original),
            _held_ui_context_with_recreate_claim=Mock(side_effect=lambda value:value),
            _read_canonical_control_record=Mock(side_effect=[(b'{}\n',{}),(b'{}\n',document)]))
        args=docker_dev._parser().parse_args(self.arguments()+['--preview'])
        args.port=3197
        observe=Mock()
        with patch.object(lifecycle,'dev',return_value=fake_dev), patch.object(lifecycle,'historical_recreate',return_value={'raw':b'{}\n'}), patch.dict(sys.modules,{'docker_volume_held_ui_retry_probe':types.SimpleNamespace(observe=observe)}):
            with self.assertRaisesRegex(docker_dev.BuildControlError,'Requested port differs'):
                lifecycle.capture(args,retry)
        observe.assert_not_called()

    def test_capture_refuses_retained_untracked_inputs_before_backend_observation(self):
        import types
        from unittest.mock import Mock, patch
        import docker_volume_held_ui_start_retry as retry
        import docker_volume_held_ui_start_retry_lifecycle as lifecycle
        control=types.SimpleNamespace(read_bytes=lambda *a,**kw: None)
        original={'control':control,'claim':{'recreate_attempt':'c'*32}}
        document={'services':{'frontend':{'ports':[{'host_ip':'127.0.0.1','target':8080,
            'protocol':'tcp','mode':'ingress','published':'3243'}]}}}
        fake_dev=types.SimpleNamespace(
            _load_held_ui_request_context=Mock(return_value=original),
            _held_ui_context_with_recreate_claim=Mock(side_effect=lambda value:value),
            include_untracked_from_compose=Mock(return_value=['scratch.py']),
            _read_canonical_control_record=Mock(side_effect=[(b'{}\n',{}),(b'{}\n',document)]))
        args=docker_dev._parser().parse_args(self.arguments()+['--preview'])
        observe=Mock()
        with patch.object(lifecycle,'dev',return_value=fake_dev), patch.object(lifecycle,'historical_recreate',return_value={'raw':b'{}\n'}), patch.dict(sys.modules,{'docker_volume_held_ui_retry_probe':types.SimpleNamespace(observe=observe)}):
            with self.assertRaisesRegex(docker_dev.BuildControlError,'untracked inputs are unsupported'):
                lifecycle.capture(args,retry)
        observe.assert_not_called()

    def test_closed_shell_forwards_exact_reviewed_pins(self):
        for suffix in [' --preview'," --apply --retry-plan-sha256 '"+'9'*64+"'"]:
            result=self.dispatch(suffix)
            self.assertEqual(result.returncode,0,result.stderr)
            values=json.loads(result.stdout)
            self.assertIn('retry-held-ui-start-volume',values)
            self.assertEqual(values[values.index('--failed-held-start-sha256')+1],'f'*64)

    def test_shell_refuses_unreviewed_or_injected_apply(self):
        for suffix in [' --apply',' --preview --apply'," --preview --retry-plan-sha256 '"+'9'*64+"'", " --apply --retry-plan-sha256 '"+'9'*64+"'; printf injected",' --force']:
            result=self.dispatch(suffix)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertNotIn('injected',result.stdout)

if __name__=='__main__': unittest.main()
