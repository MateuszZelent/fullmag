"""Validate antenna FEM CPU trajectories on a magnetic/airbox tet mesh."""

import argparse
import json
import math
import re
from pathlib import Path

from antenna_macrospin_oracle import compare_collinear_trajectory


def validate(report: dict) -> list[dict]:
    schema = report.get('schema_version')
    if schema not in ('fem_antenna_mixed.v1', 'fem_antenna_mixed_pbc.v1') or (
        report.get('status'), report.get('device'), report.get('precision')) != (
            'recorded_unvalidated', 'cpu', 'fp64'):
        raise ValueError('expected recorded FEM CPU FP64 mixed antenna artifact')
    if schema == 'fem_antenna_mixed_pbc.v1':
        if report.get('periodic_node_pairs') != [1, 2] or report.get('periodic_basis_mismatch_rejected') is not True:
            raise ValueError('periodic pair or mismatch rejection evidence is missing')
    elif report.get('periodic_node_pairs', []) != []:
        raise ValueError('nonperiodic mixed mesh carries periodic pairs')
    if not re.fullmatch('[0-9a-f]{64}', report.get('source_snapshot_sha256', '')):
        raise ValueError('source snapshot digest is required')
    expected = {'heun', 'rk4', 'rk23', 'rk45'}
    seen = set()
    results = []
    for case in report['cases']:
        name = case['integrator']
        if name not in expected or name in seen:
            raise ValueError(f'unexpected or duplicate mixed antenna integrator: {name}')
        seen.add(name)
        if type(case['accepted_steps']) is not int or case['accepted_steps'] != 2000:
            raise ValueError(f'{name}: expected 2000 fixed steps')
        samples = case['samples']
        if len(samples) != 21:
            raise ValueError(f'{name}: expected 21 samples')
        magnetic = []
        for index, sample in enumerate(samples):
            time = sample['time_s']
            if not isinstance(time, (int, float)) or not math.isfinite(time) or abs(time - index * 5e-11) > 1e-20:
                raise ValueError(f'{name}: incorrect time at sample {index}')
            if sample['m_air'] != [1, 0, 0]:
                raise ValueError(f'{name}: airbox-only node moved at sample {index}')
            field = 2e4 * (0.2 + math.sin(math.tau * 1e9 * time + 0.7))
            for observable in ('h_drive_magnetic_a_per_m', 'h_drive_air_a_per_m'):
                value = sample[observable]
                if len(value) != 3 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in value) or math.dist(value, (0, 0, field)) > 1e-7:
                    raise ValueError(f'{name}: {observable} differs from waveform at sample {index}')
            m = sample['m_magnetic']
            if len(m) != 3 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in m):
                raise ValueError(f'{name}: invalid magnetic spin at sample {index}')
            if index:
                expected_torque = abs(1e4 + field) * math.hypot(m[0], m[1])
                torque = sample['max_torque_a_per_m']
                if not isinstance(torque, (int, float)) or not math.isfinite(torque) or abs(torque - expected_torque) > 1e-7:
                    raise ValueError(f'{name}: airbox node contaminated torque at sample {index}')
            magnetic.append({'time_s': time, 'm': m})
        result = compare_collinear_trajectory(
            magnetic, initial_m=(0.6, 0, 0.8), alpha=0.1,
            waveform={'kind': 'sinusoidal', 'frequency_hz': 1e9, 'phase_rad': 0.7, 'offset': 0.2},
            basis_hz_per_a=1e6, peak_current_a=0.02, bias_hz_a_per_m=1e4,
            start_time_s=0.0, stage_start_time_s=0.0, time_origin='absolute',
            vector_tolerance=5e-6)
        results.append(dict(integrator=name, accepted_steps=case['accepted_steps'], **result))
    if seen != expected:
        raise ValueError(f'missing mixed antenna integrators: {sorted(expected - seen)}')
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    try:
        results = validate(json.loads(args.report.read_text(encoding='utf-8')))
    except (ValueError, KeyError, TypeError) as error:
        parser.exit(1, f'FEM antenna mixed-mesh validation FAIL: {error}\n')
    print(json.dumps({'status': 'pass', 'scope': 'native_cpu_preprojected_magnetic_airbox',
                      'cases': results}, indent=2))
