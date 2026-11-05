"""Cancellation preserves the pinned private group layout before allocation."""
import ast
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_volume_unclaimed_cancellation as cancellation
import docker_volume_dev as volume_dev
from docker_build_control import BuildControlError


class CancellationLayoutTests(unittest.TestCase):
    def test_group_layout_is_inherited_and_written(self):
        operation={'root':'development/attempts/test','receipt':{}}
        control=SimpleNamespace(write=lambda *args: None)
        cancellation._pin_cancellation_layout(control,operation,{'private_group_storage':'group-volume-v1'})
        self.assertEqual(operation['receipt']['private_group_storage'],'group-volume-v1')

    def test_unknown_layout_or_legacy_fallback_is_refused(self):
        control=SimpleNamespace(write=lambda *args: None,read=lambda *args,**kw:
            {'schema':'fullmag.docker-group-storage-owner.v1'})
        for previous in ({'private_group_storage':'unknown'},{}):
            with self.subTest(previous=previous),self.assertRaises(BuildControlError):
                cancellation._pin_cancellation_layout(control,{'root':'test','receipt':{}},previous)

    def test_all_three_maintenance_paths_pin_before_start(self):
        tree=ast.parse(Path(cancellation.__file__).read_text())
        for name in ('cancel_unclaimed','_resume_cancel_unclaimed','_resume_native_cancellation_failure'):
            function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
            calls=[n for n in ast.walk(function) if isinstance(n,ast.Call)]
            pins=[n.lineno for n in calls if isinstance(n.func,ast.Name) and n.func.id=='_pin_cancellation_layout']
            starts=[n.lineno for n in calls if isinstance(n.func,ast.Attribute) and n.func.attr=='start']
            self.assertEqual(len(pins),1,name)
            self.assertLess(pins[0],min(starts),name)


if __name__=='__main__':
    unittest.main()
