from __future__ import annotations

from pathlib import Path
import ast
import json
from types import SimpleNamespace
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import docker_dev_defaults as defaults
import docker_volume_resources as resources
from docker_build_control import BuildControlError

GIB = 1024 ** 3
VM = {"NCPU": 40, "MemTotal": 196 * GIB}


def _document():
    return {"services": {
        "backend": {"cpus": 4, "mem_limit": str(8 * GIB), "environment": {"CARGO_BUILD_JOBS": "4"}},
        "frontend": {"cpus": 4, "mem_limit": str(16 * GIB), "environment": {}},
    }}


class GroupBudgetTests(unittest.TestCase):
    def test_defaults_let_three_groups_fit_the_vm(self):
        document = _document()
        resources.apply_group_budget(document, {}, VM)
        backend, frontend = document["services"]["backend"], document["services"]["frontend"]
        self.assertEqual((backend["cpus"], backend["mem_limit"]), (8, 32 * GIB))
        self.assertEqual((frontend["cpus"], frontend["mem_limit"]), (4, 16 * GIB))
        self.assertLessEqual(3 * (backend["mem_limit"] + frontend["mem_limit"]), VM["MemTotal"])
        self.assertLessEqual(3 * (backend["cpus"] + frontend["cpus"]), VM["NCPU"])
        # Container quota, native profile and Cargo share one value.
        self.assertEqual(backend["environment"]["CARGO_BUILD_JOBS"], "8")
        self.assertEqual(backend["environment"]["FULLMAG_DOCKER_CPU_MILLIS"], "8000")
        self.assertEqual(backend["environment"]["FULLMAG_DOCKER_MEMORY_BYTES"], str(32 * GIB))

    def test_small_vm_keeps_native_minimums(self):
        document = _document()
        resources.apply_group_budget(document, {}, {"NCPU": 4, "MemTotal": 16 * GIB})
        self.assertEqual(document["services"]["backend"]["cpus"], 2)
        self.assertEqual(document["services"]["backend"]["mem_limit"], 8 * GIB)

    def test_configured_values_override_defaults_and_are_bounded(self):
        document = _document()
        resources.apply_group_budget(document, {"FULLMAG_DEV_BACKEND_CPUS": 12}, VM)
        self.assertEqual(document["services"]["backend"]["cpus"], 12)
        self.assertEqual(document["services"]["backend"]["environment"]["CARGO_BUILD_JOBS"], "12")
        with self.assertRaisesRegex(BuildControlError, "at least 2"):
            resources.apply_group_budget(_document(), {"FULLMAG_DEV_BACKEND_CPUS": 1}, VM)
        with self.assertRaisesRegex(BuildControlError, "exceeds Docker capacity"):
            resources.apply_group_budget(_document(), {"FULLMAG_DEV_BACKEND_CPUS": 41}, VM)
        with self.assertRaisesRegex(BuildControlError, "8 GiB for frontend"):
            resources.apply_group_budget(_document(), {"FULLMAG_DEV_FRONTEND_MEMORY_GIB": 4}, VM)

    def test_process_environment_overrides_main_dotenv(self):
        dotenv = {"FULLMAG_DEV_BACKEND_CPUS": "6", "FULLMAG_DEV_FRONTEND_CPUS": "3"}
        with mock.patch.object(defaults, "_known_checkouts", return_value=(Path.cwd(),)), \
                mock.patch.object(defaults, "_read_dotenv", return_value=dotenv):
            budget = defaults.configured_group_budget(
                Path.cwd(), {"FULLMAG_DEV_BACKEND_CPUS": "10"})
            self.assertEqual(budget, {"FULLMAG_DEV_BACKEND_CPUS": 10, "FULLMAG_DEV_FRONTEND_CPUS": 3})
            with self.assertRaisesRegex(defaults.DiscoveryError, "positive whole number"):
                defaults.configured_group_budget(Path.cwd(), {"FULLMAG_DEV_BACKEND_CPUS": "2.5"})



class PreparedBudgetTests(unittest.TestCase):
    def setUp(self):
        import docker_volume_linux_supervision_stop as supervision
        self.supervision = supervision
        self.control = SimpleNamespace(project='project', volume='volume', namespace='',
                                       namespace_registry_sha256=None)
        request_id = '12345678-1234-4234-8234-123456789abc'
        self.request = {'request_id': request_id, 'run_id': 'run', 'task_id': 'task'}
        request_raw = resources.canonical(self.request) + b'\n'
        self.maintenance = {'request_id': request_id,
            'request_sha256': resources.hashlib.sha256(request_raw).hexdigest(),
            'request_path': '/opt/fullmag/control/backend/runtime-service/unclaimed-cancellation/requests/' + request_id + '.json'}
        self.record = {'schema': supervision.PREPARED_QUARANTINE_SCHEMA, 'state': 'cancellation-required',
            'scope': {'compose_project': 'project', 'control_volume': 'volume', 'control_namespace': '',
                      'namespace_registry_sha256': None, 'source_root': '/checkout'},
            'target': {'run_id': 'run', 'task_id': 'task'}, 'stop_journal_sha256': 'a' * 64}
        raw = resources.canonical(self.record) + b'\n'
        self.witness = {'schema': supervision.PREPARED_QUARANTINE_SCHEMA,
            'quarantine_sha256': resources.hashlib.sha256(raw).hexdigest(),
            'stop_journal_sha256': 'a' * 64, 'target': self.record['target'],
            'backend_budget': {'Memory': 32 * GIB, 'NanoCpus': 40 * 10**9, 'MemorySwap': 64 * GIB},
            'retained_native_contracts': ['fem-demag-poisson'], 'retained_include_untracked': []}
        self.operation = {'root': 'development/attempts/' + 'b' * 32, 'receipt': {
            'inputs': {'prepared_unclaimed_quarantine': self.witness},
            'unclaimed_cancellation_preflight': {'prepared_unclaimed_quarantine': self.witness}}}
        self.files = {supervision.PREPARED_QUARANTINE: raw,
                      self.maintenance['request_path'][len('/opt/fullmag/control/'):]: request_raw}
        self.control.read_bytes = mock.Mock(side_effect=lambda path, **kwargs: self.files.get(path))
        self.control.read = mock.Mock(side_effect=lambda path, **kwargs:
            json.loads(self.files[path]) if path in self.files else None)

    def render(self, *, capacity=VM):
        document = _document()
        document['name'] = 'project'
        resources.apply_development_budget(self.control, document,
            {'FULLMAG_DEV_BACKEND_MEMORY_GIB': 64}, capacity=capacity,
            source_root='/checkout', prepared_maintenance=(self.operation, self.maintenance))
        return document

    def test_prepared_budget_overrides_main_config_exactly(self):
        document = self.render()
        backend = document['services']['backend']
        self.assertEqual((backend['mem_limit'], backend['cpus'], backend['memswap_limit']), (32 * GIB, 40, 64 * GIB))
        self.assertEqual(backend['environment'], {'CARGO_BUILD_JOBS': '40',
            'FULLMAG_DOCKER_CPU_MILLIS': '40000', 'FULLMAG_DOCKER_MEMORY_BYTES': str(32 * GIB)})
        self.supervision.validate_prepared_render({**document, 'services': {**document['services'],
            'backend': {**backend, 'command': ['start', '--native-contract', 'fem-demag-poisson']}}}, self.witness)

    def test_prepared_budget_rejects_capacity_foreign_or_malformed_witness(self):
        for case in ('capacity', 'foreign', 'missing-live', 'wrong-request', 'wrong-witness',
                     'bad-memory', 'bad-cpu', 'bad-swap'):
            with self.subTest(case=case):
                self.setUp()
                capacity = VM
                if case == 'capacity': capacity = {**VM, 'NCPU': 32}
                if case == 'foreign': self.control.project = 'foreign'
                if case == 'missing-live': self.files.pop(self.supervision.PREPARED_QUARANTINE)
                if case == 'wrong-request': self.maintenance['request_sha256'] = '0' * 64
                if case == 'wrong-witness':
                    self.operation['receipt']['unclaimed_cancellation_preflight'] = {'prepared_unclaimed_quarantine': {}}
                if case == 'bad-memory': self.witness['backend_budget']['Memory'] = True
                if case == 'bad-cpu': self.witness['backend_budget']['NanoCpus'] = 0
                if case == 'bad-swap': self.witness['backend_budget']['MemorySwap'] = 1
                with self.assertRaises((BuildControlError, ValueError)): self.render(capacity=capacity)

    def test_fresh_archive_uses_the_same_authenticated_retained_limits(self):
        import docker_volume_cancelled_activation as activation
        recovery = {'schema': 'fullmag.docker-prepared-cancelled-fresh-admission.v1',
                    'quarantine_sha256': self.witness['quarantine_sha256'],
                    'cancellation_terminal_sha256': 'd' * 64, 'store_snapshot_sha256': 'e' * 64,
                    'constraints': self.witness}
        attempt = 'c' * 32
        archive_root = 'recreate-services/attempts/' + attempt
        archive_path = archive_root + '/runtime-control-archive-terminal.json'
        archive = {'schema': 'fullmag.docker-fresh-runtime-archive-terminal.v1',
                   'state': 'succeeded', 'operation_attempt': attempt, 'intent_sha256': 'f' * 64,
                   'compose_project': 'project', 'control_volume': 'volume', 'control_namespace': '',
                   'removed_containers': {'backend': '1' * 64, 'frontend': '2' * 64},
                   'mapping': {}, 'preserved_group_ledger_volume': 'volume', 'finished_at': 1.0}
        archive_raw = resources.canonical(archive) + b'\n'
        self.files[archive_path] = archive_raw
        def publish(control, path, record, *, expected_raw):
            self.assertEqual(self.files[path], expected_raw)
            self.files[path] = resources.canonical(record) + b'\n'
        with mock.patch.object(activation, '_publish_cas', side_effect=publish):
            self.supervision.pin_prepared_fresh_archive(self.control,
                {'root': archive_root, 'receipt': {'attempt': attempt}}, recovery)
        live_raw = self.files[self.supervision.PREPARED_QUARANTINE]
        self.assertNotEqual(resources.hashlib.sha256(live_raw).hexdigest(), recovery['quarantine_sha256'])
        self.assertEqual(json.loads(live_raw)['state'], 'archived')
        document = _document()
        resources.apply_development_budget(self.control, document,
            {'FULLMAG_DEV_BACKEND_MEMORY_GIB': 64}, capacity=VM,
            source_root='/checkout', prepared_recovery_constraints=recovery)
        self.assertEqual(document['services']['backend']['cpus'], 40)
        self.assertEqual(document['services']['backend']['mem_limit'], 32 * GIB)
        self.assertEqual(document['services']['backend']['memswap_limit'], 64 * GIB)
        altered = {**recovery, 'quarantine_sha256': '0' * 64}
        with self.assertRaisesRegex(BuildControlError, 'scope/admission'):
            resources.apply_development_budget(self.control, _document(), {}, capacity=VM,
                source_root='/checkout', prepared_recovery_constraints=altered)
        with self.assertRaisesRegex(BuildControlError, 'scope/admission'):
            resources.apply_development_budget(self.control, _document(), {}, capacity=VM,
                source_root='/foreign', prepared_recovery_constraints=recovery)
        self.files[archive_path] = resources.canonical({**archive, 'state': 'failed-confirmed'}) + b'\n'
        with self.assertRaisesRegex(ValueError, 'authentic completed fresh archive'):
            resources.apply_development_budget(self.control, _document(), {}, capacity=VM,
                source_root='/checkout', prepared_recovery_constraints=recovery)

    def test_preflight_rejects_before_any_cache_ledger_or_certificate_side_effect(self):
        import docker_volume_dev as volume_dev
        with mock.patch.object(defaults, 'configured_group_budget', return_value={'FULLMAG_DEV_BACKEND_MEMORY_GIB': 64}), \
                mock.patch.object(resources, '_docker_capacity', return_value={**VM, 'NCPU': 32}), \
                mock.patch.object(volume_dev, '_backend_cache') as cache, \
                mock.patch.object(volume_dev, '_group_ledger') as ledger, \
                mock.patch.object(volume_dev, '_session_host') as host:
            with self.assertRaisesRegex(BuildControlError, 'exceeds Docker capacity'):
                volume_dev._preflight_prepared_start_budget(self.control, self.operation,
                    self.maintenance, None, Path('/checkout'), ['fem-demag-poisson'], [])
            cache.assert_not_called()
            ledger.assert_not_called()
            host.assert_not_called()
        tree = ast.parse(Path(volume_dev.__file__).read_text())
        start = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'start')
        calls = [node for node in ast.walk(start) if isinstance(node, ast.Call)]
        preflight_line = next(node.lineno for node in calls if isinstance(node.func, ast.Name)
                              and node.func.id == '_preflight_prepared_start_budget')
        for name in ('_backend_cache', '_frontend', '_group_ledger', '_host_ledger'):
            self.assertLess(preflight_line, min(node.lineno for node in calls
                if isinstance(node.func, ast.Name) and node.func.id == name), name)
        rotations = [node.lineno for node in calls if isinstance(node.func, ast.Attribute)
                     and node.func.attr in ('attest', '_provisional_development_certificate')]
        self.assertTrue(rotations)
        self.assertLess(preflight_line, min(rotations))

    def test_preflight_rejects_native_or_allowlist_drift_before_budget_render(self):
        import docker_volume_dev as volume_dev
        for contracts, paths in (([], []), (['fem-demag-poisson'], ['foreign.py'])):
            with mock.patch.object(resources, 'apply_development_budget') as apply:
                with self.assertRaisesRegex(BuildControlError, 'native contracts or source allowlist'):
                    volume_dev._preflight_prepared_start_budget(self.control, self.operation,
                        self.maintenance, None, Path('/checkout'), contracts, paths)
                apply.assert_not_called()

    def test_saved_budget_is_still_authenticated_when_prepared_pin_takes_precedence(self):
        self.control.read.side_effect = None
        self.control.read.return_value = {'schema': 'foreign'}
        with self.assertRaisesRegex(BuildControlError, 'identity differs'):
            self.render()

if __name__ == "__main__":
    unittest.main()
