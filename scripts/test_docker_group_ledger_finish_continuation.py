"""Pinned completed-finish continuation checks; no Docker lifecycle."""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from docker_build_control import BuildControlError
import docker_group_ledger_finish_host as finish


class ContinuationTests(unittest.TestCase):
    def fixture(self):
        args = SimpleNamespace(source_root=Path("/source"), promotion_attempt="a"*32,
            promotion_sha256="b"*64, image_id="sha256:"+"c"*64, completed_finish="d"*32,
            completed_finish_sha256="e"*64, failed_development="f"*32, failed_development_sha256="1"*64)
        root=finish.PHASE+"/attempts/"+args.completed_finish
        failed_root="development/attempts/"+args.failed_development
        ids={"backend":"2"*64,"frontend":"3"*64}
        done={"schema":"fullmag.docker-build-operation.v1","phase":finish.PHASE,"state":"succeeded",
            "compose_project":"own","control_volume":"volume","removed_containers":ids,
            "retained_state_root":"/state","runtime_started":False,"solve_started":False,"finished_at":10,
            "inputs":{"source_root":"/source","promotion_attempt":args.promotion_attempt,
                "promotion_sha256":args.promotion_sha256,"image_id":args.image_id}}
        failed={"schema":"fullmag.docker-build-operation.v1","phase":"development","state":"failed-confirmed",
            "attempt":args.failed_development,"compose_project":"own","control_volume":"volume",
            "state_root":"/state","started_at":11,"inputs":{"source_root":"/source","image_id":args.image_id,
                "previous_config_sha256":"4"*64}}
        records={root+"/terminal.json":done, failed_root+"/terminal.json":failed,
            "development/current.json":deepcopy(failed),**{root+"/"+key+"-container.json":{"Id":value}
                for key,value in ids.items()}}
        control=SimpleNamespace(project="own",volume="volume",read=lambda path:records[path],
            read_bytes=lambda path,optional=False:records.get(path))
        def checked(control,path,digest):
            self.assertEqual(digest,args.completed_finish_sha256 if path.startswith(root+"/") else args.failed_development_sha256)
            return records[path]
        params=(control,args,{"promotion_backend_container":ids["backend"]},
            {"records":{"config":{"sha256":"4"*64}}},{"frontend":{"Id":ids["frontend"]}},Path("/state"))
        return args,records,failed_root,checked,params

    def run_fixture(self, *, change=None, present=b""):
        args,records,failed_root,checked,params=self.fixture()
        if change: change(args,records,failed_root)
        with patch.object(finish,"record",side_effect=checked), patch.object(finish.common,"docker_capture",
            return_value=SimpleNamespace(stdout=present)):
            return finish.completed_archive(*params)

    def test_valid_completed_finish_returns_history_only(self):
        result=self.run_fixture()
        self.assertEqual(result["archives"]["backend"]["Id"],"2"*64)
        self.assertEqual(result["pins"]["failed_development"],"f"*32)

    def test_any_new_publication_refuses_preallocation_continuation(self):
        for name in ("compose.json","backend-cache.json","private-group-storage.json","group-ledger.json",
                     "runtime-config.json","storage-host-certificate.json"):
            with self.subTest(name=name),self.assertRaisesRegex(BuildControlError,"published state"):
                self.run_fixture(change=lambda a,r,root:r.update({root+"/"+name:b"{}"}))

    def test_existing_removed_identity_or_changed_current_refuses(self):
        with self.assertRaisesRegex(BuildControlError,"still exists"):
            self.run_fixture(present=("2"*64+"\n").encode())
        with self.assertRaisesRegex(BuildControlError,"preallocation start"):
            self.run_fixture(change=lambda a,r,root:r["development/current.json"].update(attempt="5"*32))

    def test_missing_pin_foreign_scope_or_allocated_receipt_refuses(self):
        changes=[lambda a,r,root:setattr(a,"failed_development_sha256",""),
            lambda a,r,root:r[root+"/terminal.json"].update(backend_container="6"*64),
            lambda a,r,root:r[finish.PHASE+"/attempts/"+a.completed_finish+"/terminal.json"]["inputs"].update(source_root="/foreign")]
        for change in changes:
            with self.subTest(change=change),self.assertRaises(BuildControlError):self.run_fixture(change=change)
