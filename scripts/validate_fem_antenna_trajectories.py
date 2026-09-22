"""Validate native fixed-step antenna CPU trajectories against an independent oracle."""

import argparse
import json
import math
import re
from pathlib import Path

from antenna_macrospin_oracle import compare_collinear_trajectory


def validate(report: dict) -> list[dict]:
    if (report.get('schema_version'), report.get('status'), report.get('backend'),
        report.get('device'), report.get('precision')) != (
            'fem_antenna_trajectory.v1', 'recorded_unvalidated', 'fem', 'cpu', 'fp64'):
        raise ValueError('expected recorded FEM CPU FP64 antenna trajectory artifact')
    if not re.fullmatch('[0-9a-f]{64}', report.get('source_snapshot_sha256', '')):
        raise ValueError('source snapshot digest is required')
    expected = {(rk, wave) for rk in ('heun', 'rk4', 'rk23', 'rk45')
                for wave in ('constant', 'sinusoidal', 'pulse', 'piecewise_linear', 'sinc_pulse')}
    waveforms = {
        'constant': {'kind': 'constant'},
        'sinusoidal': {'kind': 'sinusoidal', 'frequency_hz': 1e9, 'phase_rad': 0.7, 'offset': 0.2},
        'pulse': {'kind': 'pulse', 't_on': 2.5e-10, 't_off': 7.5e-10},
        'piecewise_linear': {'kind': 'piecewise_linear', 'points': [[0, 0.2], [4e-10, 1], [7e-10, -0.5], [1e-9, 0.1]]},
        'sinc_pulse': {'kind': 'sinc_pulse', 'cutoff_hz': 2e9, 't0': 5e-10, 'amplitude': 0.8},
    }
    seen = set()
    results = []
    for case in report['cases']:
        key = (case['integrator'], case['waveform']['kind'])
        if key not in expected or key in seen:
            raise ValueError(f'unexpected or duplicate case: {key}')
        seen.add(key)
        if case['waveform'] != waveforms[key[1]]:
            raise ValueError(f'{key}: incorrect qualification waveform parameters')
        if case['timestep_policy'] != 'fixed' or case['dt_s'] != 5e-13:
            raise ValueError(f'{key}: incorrect timestep policy or dt')
        samples = case['samples']
        if len(samples) != 21 or samples[0]['time_s'] != 0:
            raise ValueError(f'{key}: requires 21 samples starting at zero')
        for index, sample in enumerate(samples):
            time = sample['time_s']
            if not isinstance(time, (int, float)) or not math.isfinite(time) or abs(time - index * 5e-11) > 1e-20:
                raise ValueError(f'{key}: incorrect sample time at {index}')
        # Smooth envelopes have O(dt^2) or better accuracy. Rectangular pulse
        # edges reduce global order to one without explicit event handling;
        # use two edge phase increments as the O(dt) error budget:
        # 2*gamma*|H_ant|*dt/(1+alpha^2). This is not an event-convergence proof.
        tolerance = 5e-6 if key[1] != 'pulse' else 2 * 2.211e5 * 2e4 * 5e-13 / 1.01
        inputs = {name: case[name] for name in (
            'initial_m', 'alpha', 'waveform', 'basis_hz_per_a', 'peak_current_a',
            'bias_hz_a_per_m', 'start_time_s', 'stage_start_time_s', 'time_origin', 'gamma_mu0')}
        fixed = dict(initial_m=[0.6, 0, 0.8], alpha=0.1, basis_hz_per_a=1e6,
                     peak_current_a=0.02, bias_hz_a_per_m=1e4, start_time_s=0,
                     stage_start_time_s=0, time_origin='absolute', gamma_mu0=2.211e5)
        if any(inputs[name] != value for name, value in fixed.items()):
            raise ValueError(f'{key}: fixture parameters differ from qualification contract')
        result = compare_collinear_trajectory(samples, vector_tolerance=tolerance, **inputs)
        results.append(dict(integrator=key[0], waveform=key[1], tolerance=tolerance, **result))
    if seen != expected:
        raise ValueError(f'missing integrator/waveform cases: {sorted(expected - seen)}')
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    try:
        results = validate(json.loads(args.report.read_text(encoding='utf-8')))
    except (ValueError, KeyError, TypeError) as error:
        parser.exit(1, f'FEM antenna trajectory validation FAIL: {error}\n')
    print(json.dumps({'status': 'pass', 'scope': 'native_cpu_fixed_preprojected_macrospin',
                      'cases': results}, indent=2))
