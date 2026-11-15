"""Four reference-only surface diagnostics; production DTQ remains unqualified."""
from decimal import Decimal, localcontext
from fractions import Fraction as Q
import hashlib
import json
from pathlib import Path
import platform
import sys
import time

from verify_inputs import load_fixture, require, verify_oracles

ADDITIONAL_GATE = '1e-12*(1+norm(H120)) A/m'


def norm2(values):
    return sum(x*x for x in values)


def diagnostic_checks(result, leaf=None):
    passes = {p['precision']: p for p in result['passes']}
    require(passes[80]['status'] == passes[120]['status'] == 'evaluated', '80/120 field pass missing')
    h80, h120 = [[Q(x) for x in passes[p]['h_xyz_apm']] for p in (80, 120)]
    require(len(h80) == len(h120) == 3, 'vector shape mismatch')
    with localcontext() as context:
        context.prec = 160
        dec = lambda q: Decimal(q.numerator)/Decimal(q.denominator)
        magnitude = dec(norm2(h120)).sqrt()
        gate = Decimal('1e-12')*(1+magnitude)
        delta2 = norm2([x-y for x, y in zip(h80, h120)])
        checks = {'gate_apm': str(gate), 'gate_definition': ADDITIONAL_GATE,
                  'H80_apm': passes[80]['h_xyz_apm'], 'H120_apm': passes[120]['h_xyz_apm'],
                  'norm_H120_apm': str(magnitude),
                  'precision_delta_apm': str(dec(delta2).sqrt()),
                  'precision_vector_pass': delta2 <= Q(gate)**2}
        if leaf is None:
            expected = [Q(0), Q(1, 6), -Q(1, 6)]
            error2 = norm2([x-y for x, y in zip(h120, expected)])
            checks.update(expected_H_apm_exact=[str(x) for x in expected],
                          vertex_error_apm=str(dec(error2).sqrt()),
                          vertex_control_pass=error2 <= Q(gate)**2)
        else:
            old = [Q.from_float(float.fromhex(x)) for x in leaf['old_high_hex']]
            B, L = Q(leaf['bound_apm_exact']), Q(leaf['lower_error_apm_exact'])
            distance2 = norm2([x-y for x, y in zip(old, h120)])
            checks.update(bound_apm_exact=str(B), lower_error_apm_exact=str(L),
                          reference_norm_le_B=norm2(h120) <= B**2,
                          old_high_reference_distance_apm=str(dec(distance2).sqrt()),
                          old_high_reference_distance_gt_L=distance2 > L**2,
                          independent_exact_N2_gt_B_plus_L_squared=norm2(old) > (B+L)**2,
                          integral_certification='NOT VERIFIED: decimal reference agreement is not an exact integral proof')
        checks['pass'] = all(value for key, value in checks.items()
                             if key.endswith('_pass') or key in ('reference_norm_le_B', 'old_high_reference_distance_gt_L', 'independent_exact_N2_gt_B_plus_L_squared'))
        return checks


def main():
    root = Path.cwd()
    here = Path(__file__).parent
    output = root/'surface-reference-evidence'
    output.mkdir(parents=True, exist_ok=True)
    path = output/'reference.json'
    started = time.monotonic()
    report = {'schema': 'retained-dtq-surface-reference-diagnostic.v1',
              'status': 'NOT RUN', 'qualification': 'NOT VERIFIED',
              'scope': 'four mathematical Biot-Savart source controls; no closed-circuit or runtime qualification',
              'production_gate': 'PRODUCTION_DTQ_GATE_REMAINS_FAIL_FROM_RUN_43647488516',
              'declared_before_calls': {'precision80_vs120': ADDITIONAL_GATE,
                                        'vertex_control': ADDITIONAL_GATE,
                                        'production_tolerances_changed': False,
                                        'oracle_limits_changed': False,
                                        'expected_call_count': 4, 'budget_scope': 'one shared Budget; never reset'},
              'runtime': {'python': sys.version, 'implementation': platform.python_implementation(),
                          'platform': platform.platform(), 'machine': platform.machine()},
              'source_pins': {}, 'attempted_calls': 0, 'records': []}
    def save():
        report['elapsed_seconds'] = time.monotonic()-started
        path.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False)+'\n')
    save()
    print(json.dumps(report['declared_before_calls']), flush=True)
    budget = None
    try:
        data, report['exact_input_checks'] = load_fixture(here/'fixture.json')
        report['source_pins']['oracles'] = verify_oracles(root, data)
        for name in ('reference.py', 'verify_inputs.py', 'fixture.json'):
            raw = Path(__file__).with_name(name).read_bytes()
            report['source_pins'][name] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        wheel = (output/'dependency/mpmath-1.3.0-py3-none-any.whl').resolve()
        require(wheel.name == 'mpmath-1.3.0-py3-none-any.whl', 'unexpected wheel filename')
        require(hashlib.sha256(wheel.read_bytes()).hexdigest() == data['provenance']['mpmath_wheel_sha256'], 'wheel byte pin mismatch')
        sys.path.insert(0, str(wheel))
        sys.path.insert(0, str(root/'scripts'))
        import antenna_triangle_surface_oracle as triangle
        from antenna_rt0_surface_oracle import evaluate_retained_rt0
        report['runtime']['mpmath'] = triangle.dependency_provenance()
        report['oracle_limits'] = dict(triangle.LIMITS)
        budget = triangle.Budget()
        cases = [(data['control']['id'], data['control']['vertices_hex'], data['control']['target_hex'], None)]
        for leaf in data['leaves']:
            order = leaf['fitter_vertex_permutation']
            cases.append((f"face-{leaf['source']}-{leaf['sequence']}",
                          [leaf['leaf_vertices_hex'][i] for i in order], leaf['target_hex'], leaf))
        for case_id, vertices_hex, target_hex, leaf in cases:
            vertices = [[float.fromhex(x) for x in row] for row in vertices_hex]
            target = [float.fromhex(x) for x in target_hex]
            record = {'id': case_id, 'status': 'NOT RUN', 'input_vertices_hex': vertices_hex,
                      'target_hex': target_hex, 'vertex_current_apm2': [[4, 0, 0]]*4,
                      'fitter_vertex_permutation': [0, 1, 2, 3] if leaf is None else leaf['fitter_vertex_permutation']}
            before = dict(budget.counts)
            call_started = time.monotonic()
            report['records'].append(record)
            report['attempted_calls'] += 1
            save()
            try:
                result = evaluate_retained_rt0(vertices, ((4., 0., 0.),)*4, target, budget)
                record['oracle'] = result
                record['checks'] = diagnostic_checks(result, leaf)
                require(record['checks']['pass'], 'additional reference-only diagnostic gate failed')
                record['status'] = 'PASS: mathematical reference only / NOT VERIFIED'
            except Exception as error:
                record.update(status='REFUSED / NOT VERIFIED', reason=type(error).__name__+': '+str(error))
            finally:
                record['elapsed_seconds'] = time.monotonic()-call_started
                record['counter_delta'] = {key: value-before.get(key, 0) for key, value in budget.counts.items()}
                record['shared_budget_snapshot'] = budget.report()
                report['budget'] = budget.report()
                save()
                print(json.dumps(record, ensure_ascii=False, allow_nan=False), flush=True)
        require(report['attempted_calls'] == 4 and len(report['records']) == 4, 'four-call contract failed')
        require(all(r['status'].startswith('PASS:') for r in report['records']), 'one or more reference cases refused')
        report['status'] = 'PASS: four mathematical reference cases only / NOT VERIFIED'
    except Exception as error:
        report.update(status='REFUSED / NOT VERIFIED', reason=type(error).__name__+': '+str(error))
    finally:
        if budget is not None:
            report['budget'] = budget.report()
        save()
    print(json.dumps({'status': report['status'], 'attempted_calls': report['attempted_calls'],
                      'elapsed_seconds': report['elapsed_seconds'], 'qualification': 'NOT VERIFIED'}), flush=True)
    return 0 if report['status'].startswith('PASS:') else 2


if __name__ == '__main__':
    raise SystemExit(main())
