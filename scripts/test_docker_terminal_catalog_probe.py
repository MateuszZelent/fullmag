import hashlib,json,os,re,stat,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from docker_terminal_catalog_probe import PROBE
import docker_volume_dev as dev

class TerminalCatalogProofTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.store=self.root/'store';self.ledger=self.root/'ledger'
        (self.store/'runs'/'run-exact').mkdir(parents=True);self.ledger.mkdir()
        self.catalog={'schema_version':'run_catalog.v1','run_id':'run-exact','tasks':[{'lifecycle':'succeeded'}]}
        self.reservations=[{'state':'released','release_proof_sha256':'a'*64}]
        self.config=self.root/'config.json'
        self.config.write_text(json.dumps({'store_root':str(self.store),'host_execution':{'ledger_root':str(self.ledger)}}))
        self.env=patch.dict(os.environ,{'FULLMAG_RUNTIME_SERVICE_CONFIG':str(self.config)});self.env.start();self.addCleanup(self.env.stop)
        scope=dict(hashlib=hashlib,json=json,os=os,re=re,stat=stat,MAX=1024*1024,unique_object=dict)
        exec(PROBE,scope);self.proof=scope['native_terminal_catalog_proof'];self.write()
    def write(self):
        (self.store/'runs'/'run-exact'/'run_catalog.json').write_text(json.dumps(self.catalog))
        (self.ledger/'HOST_RESOURCE_LEDGER.json').write_text(json.dumps({'reservations':self.reservations}))
    def test_terminal_proof_and_drift(self):
        before=self.proof('run-exact');self.catalog['revision']=2;self.write()
        self.assertNotEqual(before,self.proof('run-exact'))
    def test_refuses_active_and_unknown_tasks(self):
        for state in ('accepted','running','queued','unknown',None):
            self.catalog['tasks']=[{'lifecycle':state}];self.write()
            with self.subTest(state=state),self.assertRaises(RuntimeError):self.proof('run-exact')
    def test_refuses_unreleased_or_unproven_reservations(self):
        for row in ({'state':'active','release_proof_sha256':'a'*64},{'state':'released'},None):
            self.reservations=[row];self.write()
            with self.subTest(row=row),self.assertRaises(RuntimeError):self.proof('run-exact')
    def test_refuses_wrong_owner_empty_catalog_and_symlink(self):
        self.catalog['run_id']='other';self.write()
        with self.assertRaises(RuntimeError):self.proof('run-exact')
        self.catalog['run_id']='run-exact';self.catalog['tasks']=[];self.write()
        with self.assertRaises(RuntimeError):self.proof('run-exact')
        path=self.ledger/'HOST_RESOURCE_LEDGER.json';path.rename(self.ledger/'elsewhere');path.symlink_to('elsewhere')
        self.catalog['tasks']=[{'lifecycle':'succeeded'}];(self.store/'runs'/'run-exact'/'run_catalog.json').write_text(json.dumps(self.catalog))
        with self.assertRaises(RuntimeError):self.proof('run-exact')
    def test_default_opt_out_and_embedded_probe_syntax(self):
        scripts=[]
        def capture(*args):scripts.append(args[-1]);return 'null'
        with patch.object(dev,'docker_text',side_effect=capture):
            dev._terminal_session_restart_probe('id')
            dev._terminal_session_restart_probe('id',allow_terminal_catalog=True)
        self.assertTrue(scripts[0].startswith('ALLOW_TERMINAL_CATALOG = False'))
        self.assertTrue(scripts[1].startswith('ALLOW_TERMINAL_CATALOG = True'))
        for script in scripts:compile(script,'terminal-drain-probe','exec')
if __name__=='__main__':unittest.main()
