"""Run one shared wire corpus against host and shipped guest validators."""
import ast
import importlib
import json
from pathlib import Path
import sys
import textwrap
import unittest

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib
    sys.modules['tomllib'] = tomllib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
CASES = json.loads((ROOT/'crates/fullmag-session/tests/fixtures/preparation-phase-timings.v1.json').read_text())
MODULES = ('docker_volume_cancelled_activation', 'docker_volume_dev',
           'docker_volume_linux_supervision_stop', 'verify_accepted_fem_preparation_runtime')

def guest_validators(filename):
    """Compile the actual shipped function, not a test-side duplicate."""
    source = ast.parse(filename.read_text())
    for node in ast.walk(source):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
            continue
        if 'def valid_phase_timings(value)' not in node.value:
            continue
        lines = node.value.splitlines()
        start = next(i for i, line in enumerate(lines)
                     if line.lstrip().startswith('def valid_phase_timings(value)'))
        indent = len(lines[start]) - len(lines[start].lstrip())
        end = start + 1
        while end < len(lines):
            line = lines[end]
            if line.strip() and len(line) - len(line.lstrip()) <= indent:
                break
            end += 1
        guest = ast.parse(textwrap.dedent('\n'.join(lines[start:end])))
        functions = [item for item in ast.walk(guest)
                     if isinstance(item, ast.FunctionDef) and item.name == 'valid_phase_timings']
        for function in functions:
            module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
            namespace = {}
            exec(compile(module, str(filename)+'::guest-validator', 'exec'), namespace)
            yield namespace['valid_phase_timings']

class PreparationTimingWireParityTests(unittest.TestCase):
    def test_host_and_guest_readers_share_the_rust_wire_corpus(self):
        validators = []
        for name in MODULES:
            module = importlib.import_module(name)
            validators.append((name+'::host', module._validate_preparation_phase_timings))
        for name in MODULES[:2]:
            guests = list(guest_validators(ROOT/'scripts'/(name+'.py')))
            self.assertEqual(len(guests), 1, name)
            validators.append((name+'::guest', guests[0]))
        self.assertEqual(len(validators), 6)
        for name, validate in validators:
            for case in CASES:
                with self.subTest(consumer=name, case=case['name']):
                    self.assertEqual(validate(case['input']), case['valid'])

if __name__ == '__main__':
    unittest.main()
