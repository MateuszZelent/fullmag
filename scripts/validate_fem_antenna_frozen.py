"""Validate antenna-driven FEM CPU trajectories with one frozen spin."""

import argparse
import json
import math
import re
from pathlib import Path

from antenna_macrospin_oracle import compare_collinear_trajectory


def validate(report: dict) -> list[dict]:
    if (report.get('schema_version'), report.get('status'),
        report.get('device'), report.get('precision')) != (
            'fem_antenna_frozen.v1', 'recorded_unvalidated', 'cpu', 'fp64'):
        raise ValueError('expected recorded FEM CPU FP64 frozen antenna artifact')
    if not re.fullmatch('[0-9a-f]{64}', report.get('source_snapshot_sha256', '')):
        raise ValueError('source snapshot digest is required')
    expected = {(name, policy) for name in ('heun', 'rk4', 'rk23', 'rk45')
                for policy in ('fixed', 'adaptive')
                if policy == 'fixed' or name in ('rk23', 'rk45')}
    seen = set()
    results = []
    waveform = {'kind': 'sinusoidal', 'frequency_hz': 1e9,
                'phase_rad': 0.7, 'offset': 0.2}
    for case in report['cases']:
        key = (case['integrator'], case['timestep_policy'])
        if key not in expected or key in seen:
            raise ValueError(f'unexpected or duplicate frozen antenna case: {key}')
        seen.add(key)
        if any(case[name] != value for name, value in (
            ('basis_hz_per_a', 1e6), ('peak_current_a', 0.02),
            ('bias_hz_a_per_m', 1e4), ('alpha', 0.1),
            ('waveform', waveform))):
            raise ValueError(f'{key}: fixture parameters changed')
        accepted, rejected = case['accepted_steps'], case['rejected_attempts']
        if type(accepted) is not int or not 0 < accepted < 200000 or type(rejected) is not int or rejected < 0:
            raise ValueError(f'{key}: invalid step counters')
        if key[1] == 'fixed' and (accepted != 2000 or rejected != 0):
            raise ValueError(f'{key}: fixed step counts changed')
        if key[1] == 'adaptive' and rejected == 0:
            raise ValueError(f'{key}: adaptive retries were not exercised')
        samples = case['samples']
        if len(samples) != 21:
            raise ValueError(f'{key}: expected 21 samples')
        free_samples = []
        for index, sample in enumerate(samples):
            time = sample['time_s']
            if not isinstance(time, (int, float)) or not math.isfinite(time) or abs(time - index * 5e-11) > 1e-20:
                raise ValueError(f'{key}: sample {index} has incorrect time')
            if sample['m_frozen'] != [0, 1, 0]:
                raise ValueError(f'{key}: frozen spin moved at sample {index}')
            field = 2e4 * (0.2 + math.sin(math.tau * 1e9 * time + 0.7))
            for observable in ('h_drive_frozen_a_per_m', 'h_drive_free_a_per_m'):
                value = sample[observable]
                if len(value) != 3 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in value) or math.dist(value, (0, 0, field)) > 1e-7:
                    raise ValueError(f'{key}: {observable} differs from waveform at sample {index}')
            free = sample['m_free']
            if len(free) != 3 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in free):
                raise ValueError(f'{key}: invalid free spin at sample {index}')
            if index:
                expected_torque = abs(1e4 + field) * math.hypot(free[0], free[1])
                torque = sample['max_torque_a_per_m']
                if not isinstance(torque, (int, float)) or not math.isfinite(torque) or abs(torque - expected_torque) > 1e-7:
                    raise ValueError(f'{key}: frozen node contaminated free-spin torque metric at sample {index}')
            free_samples.append({'time_s': time, 'm': free})
        result = compare_collinear_trajectory(
            free_samples, initial_m=(0.6, 0, 0.8), alpha=case['alpha'],
            waveform=waveform, basis_hz_per_a=case['basis_hz_per_a'],
            peak_current_a=case['peak_current_a'], bias_hz_a_per_m=case['bias_hz_a_per_m'],
            start_time_s=0.0, stage_start_time_s=0.0, time_origin='absolute',
            vector_tolerance=5e-6)
        results.append(dict(integrator=key[0], timestep_policy=key[1],
                            accepted_steps=accepted, rejected_attempts=rejected, **result))
    if seen != expected:
        raise ValueError(f'missing frozen antenna cases: {sorted(expected - seen)}')
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    try:
        results = validate(json.loads(args.report.read_text(encoding='utf-8')))
    except (ValueError, KeyError, TypeError) as error:
        parser.exit(1, f'FEM antenna frozen-spin validation FAIL: {error}\n')
    print(json.dumps({'status': 'pass', 'scope': 'native_cpu_preprojected_frozen_spin',
                      'cases': results}, indent=2))
