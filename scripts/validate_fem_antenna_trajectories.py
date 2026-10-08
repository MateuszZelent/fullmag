"""Validate native fixed/adaptive antenna CPU trajectories against an independent oracle."""

import argparse
import json
import math
import re
from pathlib import Path

from antenna_macrospin_oracle import compare_collinear_trajectory, macrospin_from_field_impulse


def envelope_at_time(waveform: dict, time: float) -> float:
    """Independent endpoint evaluator for the fixed qualification fixtures."""
    kind = waveform['kind']
    if kind == 'constant':
        return 1.0
    if kind == 'sinusoidal':
        return waveform['offset'] + math.sin(math.tau * waveform['frequency_hz'] * time + waveform['phase_rad'])
    if kind == 'pulse':
        return float(waveform['t_on'] <= time < waveform['t_off'])
    if kind == 'sinc_pulse':
        x = math.tau * waveform['cutoff_hz'] * (time - waveform['t0'])
        return waveform['amplitude'] * (math.sin(x) / x if x else 1.0)
    if kind == 'piecewise_linear':
        points = waveform['points']
        if time <= points[0][0]:
            return points[0][1]
        for (a, va), (b, vb) in zip(points, points[1:]):
            if time <= b:
                return va + (vb - va) * (time - a) / (b - a)
        return points[-1][1]
    raise ValueError('unsupported endpoint waveform')


def validate_endpoint(case: dict, sample: dict) -> None:
    time = sample['time_s'] - (case['stage_start_time_s'] if case['time_origin'] == 'stage_local' else 0)
    hz = case['basis_hz_per_a'] * case['peak_current_a'] * envelope_at_time(case['waveform'], time)
    total_hz = hz + case['bias_hz_a_per_m']
    mx, my, mz = sample['m']
    mu0 = 4e-7 * math.pi
    alpha = case['alpha']
    bz = mu0 * total_hz
    scale = -1 / (1 + alpha * alpha)
    expected_torque = [scale * bz * (my + alpha * mz * mx),
                       scale * bz * (-mx + alpha * mz * my),
                       scale * bz * (-alpha * (mx * mx + my * my))]
    # Single tetrahedron with 12 nm orthogonal edges and uniform Ms.
    energy_scale = -mu0 * 8e5 * (12e-9)**3 / 6 * mz
    expected = {
        'h_eff_a_per_m': ([0, 0, total_hz], 1e-7),
        'h_drive_a_per_m': ([0, 0, hz], 1e-7),
        'torque_t': (expected_torque, 1e-12),
        'drive_energy_j': ([energy_scale * hz], 1e-30),
        'external_energy_j': ([energy_scale * case['bias_hz_a_per_m']], 1e-30),
        'total_energy_j': ([energy_scale * total_hz], 1e-30),
        'max_torque_a_per_m': ([abs(total_hz) * math.hypot(mx, my)], 1e-7),
    }
    for name, (reference, atol) in expected.items():
        values = sample[name] if len(reference) == 3 else [sample[name]]
        if len(values) != len(reference) or any(
            not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v - target) > atol
            for v, target in zip(values, reference)
        ):
            raise ValueError(f'endpoint {name} disagrees at {sample["time_s"]} s')


def validate(report: dict) -> list[dict]:
    if (report.get('schema_version'), report.get('status'), report.get('backend'),
        report.get('device'), report.get('precision')) != (
            'fem_antenna_trajectory.v4', 'recorded_unvalidated', 'fem', 'cpu', 'fp64'):
        raise ValueError('expected recorded FEM CPU FP64 antenna trajectory artifact')
    if not re.fullmatch('[0-9a-f]{64}', report.get('source_snapshot_sha256', '')):
        raise ValueError('source snapshot digest is required')
    expected = {(clock, rk, wave, policy) for clock in ('zero_absolute', 'shifted_absolute', 'shifted_local')
                for rk in ('heun', 'rk4', 'rk23', 'rk45')
                for wave in ('constant', 'sinusoidal', 'pulse', 'piecewise_linear', 'sinc_pulse')
                for policy in ('fixed', 'adaptive') if policy == 'fixed' or rk in ('rk23', 'rk45')}
    waveforms = {
        'constant': {'kind': 'constant'},
        'sinusoidal': {'kind': 'sinusoidal', 'frequency_hz': 1e9, 'phase_rad': 0.7, 'offset': 0.2},
        'pulse': {'kind': 'pulse', 't_on': 2.5e-10, 't_off': 7.5e-10},
        'piecewise_linear': {'kind': 'piecewise_linear', 'points': [[0, 0.2], [4e-10, 1], [7e-10, -0.5], [1e-9, 0.1]]},
        'sinc_pulse': {'kind': 'sinc_pulse', 'cutoff_hz': 2e9, 't0': 5e-10, 'amplitude': 0.8},
    }
    seen = set()
    rejections = {'rk23': 0, 'rk45': 0}
    results = []
    for case in report['cases']:
        key = (case['clock_case'], case['integrator'], case['waveform']['kind'], case['timestep_policy'])
        if key not in expected or key in seen:
            raise ValueError(f'unexpected or duplicate case: {key}')
        seen.add(key)
        if case['waveform'] != waveforms[key[2]]:
            raise ValueError(f'{key}: incorrect qualification waveform parameters')
        if case['dt_s'] != 5e-13:
            raise ValueError(f'{key}: incorrect timestep policy or dt')
        accepted, rejected = case['accepted_steps'], case['rejected_attempts']
        if type(accepted) is not int or not 0 < accepted < 200000 or type(rejected) is not int or rejected < 0:
            raise ValueError(f'{key}: invalid step/rejection counters')
        if key[3] == 'fixed' and (accepted != 2000 or rejected != 0):
            raise ValueError(f'{key}: fixed trajectory step counts changed')
        if key[3] == 'adaptive':
            rejections[key[1]] += rejected
        samples = case['samples']
        expected_start = 0.0 if key[0] == 'zero_absolute' else 2.5e-10
        start = case['start_time_s']
        if not isinstance(start, (int, float)) or not math.isfinite(start) or abs(start - expected_start) > 1e-20:
            raise ValueError(f'{key}: incorrect stage start')
        if len(samples) != 21 or samples[0]['time_s'] != start:
            raise ValueError(f'{key}: requires 21 samples starting at the stage boundary')
        for index, sample in enumerate(samples):
            time = sample['time_s']
            if not isinstance(time, (int, float)) or not math.isfinite(time) or abs(time - start - index * 5e-11) > 1e-20:
                raise ValueError(f'{key}: incorrect sample time at {index}')
        # Smooth envelopes have O(dt^2) or better accuracy. Rectangular pulse
        # edges reduce global order to one without explicit event handling;
        # use two edge phase increments as the O(dt) error budget:
        # 2*gamma*|H_ant|*dt/(1+alpha^2). This is not an event-convergence proof.
        tolerance = 5e-6 if key[2] != 'pulse' or key[3] == 'adaptive' else 2 * 2.211e5 * 2e4 * 5e-13 / 1.01
        inputs = {name: case[name] for name in (
            'initial_m', 'alpha', 'waveform', 'basis_hz_per_a', 'peak_current_a',
            'bias_hz_a_per_m', 'start_time_s', 'stage_start_time_s', 'time_origin', 'gamma_mu0')}
        initial = case['initial_m']
        expected_initial = macrospin_from_field_impulse((0.6, 0, 0.8), 1e4 * start, 0.1)
        if len(initial) != 3 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in initial) or math.dist(initial, expected_initial) > 5e-6:
            raise ValueError(f'{key}: warmup state does not match bias-only LLG')
        fixed = dict(alpha=0.1, basis_hz_per_a=1e6,
                     peak_current_a=0.02, bias_hz_a_per_m=1e4, start_time_s=start,
                     stage_start_time_s=start, time_origin='stage_local' if key[0] == 'shifted_local' else 'absolute', gamma_mu0=2.211e5)
        if any(inputs[name] != value for name, value in fixed.items()):
            raise ValueError(f'{key}: fixture parameters differ from qualification contract')
        result = compare_collinear_trajectory(samples, vector_tolerance=tolerance, **inputs)
        for sample in samples[1:]:
            validate_endpoint(case, sample)
        results.append(dict(clock_case=key[0], integrator=key[1], waveform=key[2],
                            timestep_policy=key[3], accepted_steps=accepted,
                            rejected_attempts=rejected, tolerance=tolerance, **result))
    if seen != expected:
        raise ValueError(f'missing integrator/waveform cases: {sorted(expected - seen)}')
    if any(count == 0 for count in rejections.values()):
        raise ValueError('both embedded integrators must exercise rejected attempts')
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    try:
        results = validate(json.loads(args.report.read_text(encoding='utf-8')))
    except (ValueError, KeyError, TypeError) as error:
        parser.exit(1, f'FEM antenna trajectory validation FAIL: {error}\n')
    print(json.dumps({'status': 'pass', 'scope': 'native_cpu_preprojected_macrospin',
                      'cases': results}, indent=2))
