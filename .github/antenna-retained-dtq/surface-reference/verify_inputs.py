"""Validate frozen synthetic inputs with stdlib only; never import an oracle."""
from copy import deepcopy
from fractions import Fraction as Q
import hashlib
import json
from pathlib import Path
import re

FIXTURE_SHA = '1e1d38a360a47f69bd1fdee804231f93f851b69101c15a74f6bd246806c4d891'
EXPECTED_IDS = [(3, 139), (0, 236), (0, 257)]



def require(ok, message):
    if not ok:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def exact_rows(rows):
    return [[Q.from_float(float.fromhex(x)) for x in row] for row in rows]


def determinant(points):
    a, b, c = [[x-y for x, y in zip(p, points[0])] for p in points[1:]]
    return (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0])
            + a[2]*(b[0]*c[1]-b[1]*c[0]))


def validate(data):
    require(data['schema'] == 'retained-dtq-surface-reference-input.v1', 'schema mismatch')
    leaves = data['leaves']
    require([(e['source'], e['sequence']) for e in leaves] == EXPECTED_IDS,
            'exactly three ordered unique records required')
    checks = []
    for e in leaves:
        parent = exact_rows(e['parent_vertices_hex'])
        coeff = [Q.from_float(float.fromhex(x)) for x in e['parent_coefficients_hex']]
        D = determinant(parent)
        require(D > 0 and sum(coeff) == 0, 'parent determinant/current slope mismatch')
        current = [-sum(c*p[k] for c, p in zip(coeff, parent))/D for k in range(3)]
        require(current == [4, 0, 0], 'constant current exact reconstruction mismatch')
        leaf = exact_rows(e['leaf_vertices_hex'])
        d = determinant(leaf)
        require(d != 0 and d == Q(e['leaf_signed_determinant_exact']), 'leaf determinant mismatch')
        order = e['fitter_vertex_permutation']
        require(order == ([0, 1, 2, 3] if d > 0 else [1, 0, 2, 3]), 'fitter-only permutation mismatch')
        require(determinant([leaf[i] for i in order]) == abs(d), 'positive fitter geometry required')
        # Verify the target stays inside the unchanged parent, using exact barycentrics.
        target = exact_rows([e['target_hex']])[0]
        barycentric = []
        for i in range(4):
            replaced = parent[:]
            replaced[i] = target
            barycentric.append(determinant(replaced)/D)
        require(sum(barycentric) == 1 and min(barycentric) >= 0, 'target is outside parent')
        high = exact_rows([e['old_high_hex']])[0]
        N2 = sum(x*x for x in high)
        B, L = Q(e['bound_apm_exact']), Q(e['lower_error_apm_exact'])
        require(e['proof_depth'] == 2 and B > 0 and L > 0, 'invalid bound contract')
        require(N2 == Q(e['old_high_norm_squared_exact']), 'old-high N2 mismatch')
        require(N2 > (B+L)**2, 'independent exact error proof failed')
        require(e['snapshot_occurrences'] == 2, 'snapshot multiplicity mismatch')
        checks.append({'source': e['source'], 'sequence': e['sequence'],
                       'parent_D_exact': str(D), 'sum_c_exact': str(sum(coeff)),
                       'reconstructed_J_apm2_exact': [str(x) for x in current],
                       'parent_target_barycentric_exact': [str(x) for x in barycentric],
                       'leaf_D_exact': str(d), 'fitter_vertex_permutation': order,
                       'N2_gt_B_plus_L_squared': True})
    control = data['control']
    require(exact_rows(control['vertices_hex']) == [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], 'control geometry mismatch')
    require(exact_rows([control['target_hex']]) == [[0, 0, 0]], 'control target mismatch')
    require(control['vertex_current_apm2_exact'] == [['4', '0', '0']]*4, 'control current mismatch')
    require(control['expected_h_apm_exact'] == ['0', '1/6', '-1/6'], 'control H mismatch')
    return checks


def load_fixture(path):
    raw = path.read_bytes()
    require(sha(raw) == FIXTURE_SHA, 'fixture byte pin mismatch')
    data = json.loads(raw)
    return data, validate(data)


def verify_oracles(root, data):
    result = {}
    for name, pin in data['provenance']['oracles'].items():
        raw = (root/'scripts'/name).read_bytes()
        require(len(raw) == pin['bytes'] and sha(raw) == pin['sha256'], 'oracle source pin mismatch: '+name)
        result[name] = {'bytes': len(raw), 'sha256': sha(raw)}
    return result


def self_check(data):
    mutations = {}
    bad = deepcopy(data); bad['leaves'].pop(); mutations['missing_record'] = bad
    bad = deepcopy(data); bad['leaves'].append(deepcopy(bad['leaves'][0])); mutations['extra_duplicate'] = bad
    bad = deepcopy(data); bad['leaves'][1] = deepcopy(bad['leaves'][0]); mutations['duplicate_replacement'] = bad
    bad = deepcopy(data); bad['leaves'][0]['source'] = 0; mutations['wrong_source'] = bad
    bad = deepcopy(data); bad['leaves'][0]['parent_vertices_hex'] = deepcopy(bad['leaves'][1]['parent_vertices_hex']); mutations['mixed_parent_geometry'] = bad
    bad = deepcopy(data); bad['leaves'][0]['parent_coefficients_hex'] = deepcopy(bad['leaves'][1]['parent_coefficients_hex']); mutations['mixed_parent_moments'] = bad
    bad = deepcopy(data); bad['leaves'][0]['old_high_hex'] = deepcopy(bad['leaves'][1]['old_high_hex']); mutations['mixed_old_high'] = bad
    bad = deepcopy(data); bad['leaves'][2]['fitter_vertex_permutation'] = [0, 1, 2, 3]; mutations['missing_orientation_correction'] = bad
    result = {}
    for name, bad in mutations.items():
        try:
            validate(bad)
        except (ValueError, KeyError) as error:
            result[name] = {'status': 'REJECTED', 'reason': str(error)}
        else:
            raise ValueError('invalid input accepted: '+name)
    return result


def evidence_readback(evidence, data):
    log = (evidence/'ci-leaf-43615353978-early/antenna-retained-dtq-green-native.log').read_bytes()
    pin = data['provenance']['log']
    require(len(log) == pin['bytes'] and sha(log) == pin['sha256'], 'log pin mismatch')
    inputs = [('geometric-envelope-v0.json', 'geometric_envelope_sha256'),
              ('exact-certificate-readback.json', 'exact_certificate_sha256')]
    documents = []
    for name, key in inputs:
        raw = (evidence/'task-2-geometric-envelope-20261115'/name).read_bytes()
        require(sha(raw) == data['provenance'][key], 'proof input pin mismatch')
        documents.append(json.loads(raw))
    envelope, certificate = documents
    require(envelope['source_sha256'] == certificate['source_sha256'] == pin['sha256'], 'proof source mismatch')
    def field(line, name, end):
        return line.split(name+'=', 1)[1].split(' '+end+'=', 1)[0]
    def vector(text):
        return [x for x in text.strip('()').split(',') if x]
    for e in data['leaves']:
        source, sequence = e['source'], e['sequence']
        matches = [line for line in log.decode().splitlines() if ' SNAPSHOT ' in line and f' source={source} sequence={sequence} ' in line]
        require(len(matches) == 2 and matches[0] == matches[1], 'snapshot missing/duplicate/input mismatch')
        line = matches[0]
        for key, label, end in [('leaf_vertices_hex', 'vertices_m', 'source_vertices_m'),
                                ('parent_vertices_hex', 'source_vertices_m', 'source_signed_coefficients_a')]:
            rows = [vector(x) for x in re.findall(r'\(([^()]*)\)', field(line, label, end))]
            require(e[key] == rows, 'snapshot vertex bytes mismatch')
        for key, label, end in [('parent_coefficients_hex', 'source_signed_coefficients_a', 'retained_high_apm'),
                                ('target_hex', 'target_m', 'source'), ('old_high_hex', 'retained_high_apm', 'retained_error_apm')]:
            require(e[key] == vector(field(line, label, end)), 'snapshot hex mismatch')
        rows = [x for x in envelope['rows'] if (x['source'], x['sequence']) == (source, sequence)]
        proofs = [x for x in certificate['proofs'] if (x['source'], x['sequence']) == (source, sequence)]
        require(len(rows) == len(proofs) == 1, 'missing/duplicate proof records')
        bounds = [x for x in rows[0]['levels'] if x['depth'] == 2]
        require(len(bounds) == 1 and e['bound_apm_exact'] == bounds[0]['bound_exact'] == proofs[0]['geometric_upper_bound_exact'], 'exact B mismatch')
        require(e['lower_error_apm_exact'] == proofs[0]['certified_error_lower_bound_exact'], 'exact L mismatch')
        require(e['old_high_norm_squared_exact'] == proofs[0]['high_norm_squared_exact'], 'exact N2 mismatch')
    return 'PASS: pinned log pairs and exact proof readback'


def main():
    root = Path.cwd()
    output = root/'surface-reference-evidence'
    output.mkdir(exist_ok=True)
    report = {'scope': 'stdlib input checks only', 'oracle_calls': 0, 'dependency_imports': 0}
    try:
        data, report['exact_inputs'] = load_fixture(Path(__file__).with_name('fixture.json'))
        report['oracle_sources'] = verify_oracles(root, data)
        report['negative_self_checks'] = self_check(data)
        report['status'] = 'PASS'
    except Exception as error:
        report.update(status='REFUSED', reason=type(error).__name__+': '+str(error))
    (output/'input-readback.json').write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False)+'\n')
    print(json.dumps(report, ensure_ascii=False, allow_nan=False))
    return 0 if report['status'] == 'PASS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
