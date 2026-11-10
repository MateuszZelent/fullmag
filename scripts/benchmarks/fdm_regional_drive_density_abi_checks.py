#!/usr/bin/env python3
"""Native CUDA density oracle; use the selected, ready DEV backend, never skip GPU.

FP64/FP32 regional-only, bias, partial-volume/mask and static-profile cases.
Local Ms uses full cells; phi cases use uniform scalar Ms/alpha because the native heterogeneous+phi tuple is explicitly refused. Low-level phi checks do not expand public FP32 sub-cell capability. Legacy
Oersted is compared with an optional pre-change baseline, not requalified.
"""
from __future__ import annotations
import argparse, ctypes as ct, hashlib, json, math
from pathlib import Path

def require_finite_energy(value):
    if not math.isfinite(value):
        raise ValueError('Native scalar total energy must be finite')

def snapshot_total_energy(native, handle):
    stats = native.stats_type()
    status = native.lib.fullmag_fdm_backend_snapshot_stats(handle, ct.byref(stats))
    if status != 0:
        raise RuntimeError(('Native scalar snapshot failed', status))
    require_finite_energy(stats.total_energy_joules)
    return stats.total_energy_joules


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--library', type=Path, required=True)
    parser.add_argument('--header', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args()
    import sys
    sys.path.insert(0, str(args.header.resolve(strict=True).parents[2] / 'scripts/benchmarks'))
    import fdm_regions_interaction_abi_checks as regional
    import fdm_cuda_analytic_abi_checks as abi
    library = args.library.resolve(strict=True)
    header = args.header.resolve(strict=True)
    binary_sha = hashlib.sha256(library.read_bytes()).hexdigest()
    native = regional.NativeFdm(library, header)
    types = native.types
    for name in ['fullmag_fdm_regional_field_drive_desc_v1', 'fullmag_fdm_regional_field_drive_desc_v2']:
        types[name] = abi.parse_struct(native.text, name, types)
    desc = types['fullmag_fdm_regional_field_drive_desc_v2']
    if not ct.sizeof(desc) == 128:
        raise AssertionError('ABI qualification contract failed')
    native.bind('fullmag_fdm_backend_set_regional_field_drives_v2', [ct.c_void_p, ct.POINTER(desc), ct.c_uint32], ct.c_int)
    native.bind('fullmag_fdm_backend_set_static_external_field_f64', [ct.c_void_p, ct.POINTER(ct.c_double), ct.c_uint64], ct.c_int)
    native.bind('fullmag_fdm_backend_copy_scalar_field_f64', [ct.c_void_p, ct.c_int, ct.POINTER(ct.c_double), ct.c_uint64], ct.c_int)
    m = [regional.normalized([1, 2, 3]), regional.normalized([-2, 3, 1])]
    drive = [[0.0, 0.0, 2000.0], [0.0, 0.0, 4000.0]]
    profile = [[1000.0, 0.0, 3000.0], [0.0, -2000.0, 4000.0]]
    cases = [dict(name='regional_only', bias=0.0), dict(name='bias_regional', bias=12000.0), dict(name='partial_regional', bias=12000.0, phi=[0.35, 0.65]), dict(name='masked_partial_regional', bias=12000.0, phi=[0.35, 0.65], mask=[1, 0]), dict(name='static_profile_regional', bias=12000.0, profile=profile), dict(name='legacy_oersted', bias=12000.0, legacy=True)]
    baseline = json.loads((args.baseline / '.zattrs').read_text()) if args.baseline else None
    args.output.mkdir(parents=True, exist_ok=False)
    (args.output / '.zgroup').write_text('{"zarr_format":2}')
    (args.output / 'oracle.py').write_bytes(Path(__file__).read_bytes())
    failures = []
    measurements = []
    for precision in ['double', 'single']:
        gate = 1e-10 if precision == 'double' else 1e-05
        for case in cases:
            mask = case.get('mask', [1, 1])
            phi = case.get('phi', [1.0, 1.0])
            active = (ct.c_uint8 * 2)(*mask)
            settings = {'has_external_field': 1 if case['bias'] else 0, 'external_field_am': [0.0, 0.0, case['bias']], 'active_mask': ct.cast(active, ct.c_void_p), 'active_mask_len': 2}
            arrays = {}
            if 'phi' in case:
                settings.update(boundary_correction=native.enum('BOUNDARY_VOLUME'), ms_field=None, ms_field_len=0, alpha_field=None, alpha_field_len=0)
                arrays['volume_fraction'] = phi
            ms = [600000.0, 600000.0] if 'phi' in case else regional.MS
            if case.get('legacy'):
                arrays['oersted_field_xyz'] = [v for row in drive for v in row]
            if precision == 'single' and 'phi' in case:
                try:
                    with native.backend(m, precision, settings=settings, arrays=arrays):
                        raise AssertionError('FP32 sub-cell capability unexpectedly accepted')
                except RuntimeError as error:
                    if 'FDM FP32 sub-cell boundary correction is unavailable' not in str(error):
                        raise
                    measurements.append(dict(case=case['name'], precision=precision, state='expected_refusal', reason=str(error)))
                continue
            with native.backend(m, precision, settings=settings, arrays=arrays) as (handle, _):
                buffers = []
                if not case.get('legacy'):
                    basis = (ct.c_double * 6)(*[v for row in drive for v in row])
                    buffers.append(basis)
                    d = desc()
                    d.drive.abi_version = 2
                    d.drive.struct_size = ct.sizeof(desc)
                    d.drive.field_xyz = ct.cast(basis, ct.c_void_p)
                    d.drive.field_len = 6
                    d.drive.waveform = native.enum('REGIONAL_FIELD_DRIVE_CONSTANT')
                    d.drive.time_origin = native.enum('REGIONAL_FIELD_DRIVE_ABSOLUTE')
                    d.drive.amplitude = 1.0
                    code = native.lib.fullmag_fdm_backend_set_regional_field_drives_v2(handle, ct.byref(d), 1)
                    if not code == 0:
                        raise AssertionError((case, precision, code, native.lib.fullmag_fdm_backend_last_error(handle)))
                if 'profile' in case:
                    values = (ct.c_double * 6)(*[v for row in case['profile'] for v in row])
                    buffers.append(values)
                    code = native.lib.fullmag_fdm_backend_set_static_external_field_f64(handle, values, 6)
                    if not code == 0:
                        raise AssertionError((case, precision, code))
                actual = {}
                for quantity in ['EX', 'DEMAG', 'EXT', 'DRIVE', 'ANI', 'DMI', 'TOTAL']:
                    values = (ct.c_double * 2)()
                    code = native.lib.fullmag_fdm_backend_copy_scalar_field_f64(handle, native.enum('OBSERVABLE_EDEN_' + quantity), values, 2)
                    if not code == 0:
                        raise AssertionError((case, precision, quantity, code))
                    actual[quantity] = list(values)
                    if not all((math.isfinite(v) for v in values)):
                        raise AssertionError('ABI qualification contract failed')
                total_energy = snapshot_total_energy(native, handle)
                state = native.field(handle, 'M')
                observed = dict(case=case['name'], precision=precision, gate=gate, mask=mask, phi=phi, ms_apm=ms, m=state, density=actual, scalar_total_j=total_energy)
                if not all(math.isfinite(v) for row in state for v in row):
                    raise ValueError('Native magnetization must be finite')
                if case.get('legacy'):
                    if baseline:
                        (ref,) = [v for v in baseline['measurements'] if v['case'] == case['name'] and v['precision'] == precision]
                        for quantity in actual:
                            for (i, value) in enumerate(actual[quantity]):
                                error = abs(value - ref['density'][quantity][i]) / max(1.0, abs(ref['density'][quantity][i]))
                                if not math.isfinite(error) or error > gate:
                                    failures.append(dict(case=case['name'], precision=precision, quantity=quantity, cell=i, relative_error=error, gate=gate))
                    observed['scope'] = 'legacy baseline preservation' if baseline else 'measurement only; no baseline qualification'
                else:
                    expected_ext = []
                    expected_drive = []
                    for i in range(2):
                        ext = [0.0, 0.0, case['bias']]
                        if 'profile' in case:
                            ext = [x + y for (x, y) in zip(ext, case['profile'][i])]
                        factor = -regional.MU0 * ms[i] * phi[i] * mask[i]
                        expected_ext.append(factor * sum((x * y for (x, y) in zip(state[i], ext))))
                        expected_drive.append(factor * sum((x * y for (x, y) in zip(state[i], drive[i]))))
                    expected = {'EXT': expected_ext, 'DRIVE': expected_drive, 'TOTAL': [x + y for (x, y) in zip(expected_ext, expected_drive)]}
                    observed['expected_density'] = expected
                    for (quantity, reference) in expected.items():
                        for (i, value) in enumerate(actual[quantity]):
                            error = abs(value - reference[i]) / max(1.0, abs(reference[i]))
                            if not math.isfinite(error) or error > gate:
                                failures.append(dict(case=case['name'], precision=precision, quantity=quantity, cell=i, relative_error=error, gate=gate))
                    for i in range(2):
                        error = abs(actual['TOTAL'][i] - sum((actual[q][i] for q in ['EX', 'DEMAG', 'EXT', 'DRIVE', 'ANI', 'DMI']))) / max(1.0, abs(actual['TOTAL'][i]))
                        if not math.isfinite(error) or error > gate:
                            failures.append(dict(case=case['name'], precision=precision, quantity='component_sum', cell=i, relative_error=error, gate=gate))
                    expected_energy = sum(expected['TOTAL']) * regional.VOLUME
                    error = abs(total_energy - expected_energy) / max(abs(expected_energy), 1e-30)
                    observed['scalar_integral_relative_error'] = error
                    if not math.isfinite(error) or error > gate:
                        failures.append(dict(case=case['name'], precision=precision, quantity='scalar_integral', relative_error=error, gate=gate))
                measurements.append(observed)
                (args.output / '.zattrs').write_text(json.dumps(dict(state='running', measurements=measurements, failures=failures), indent=2))
    if not hashlib.sha256(library.read_bytes()).hexdigest() == binary_sha:
        raise AssertionError('ABI qualification contract failed')
    report = dict(schema='fullmag.fdm.regional-drive-density.v1', state='failed' if failures else 'passed', library=str(library), library_sha256=binary_sha, header_sha256=hashlib.sha256(header.read_bytes()).hexdigest(), measurements=measurements, failures=failures)
    (args.output / '.zattrs').write_text(json.dumps(report, indent=2))
    print(json.dumps(dict(state=report['state'], cases=len(measurements), failures=failures)))
    return int(bool(failures))
if __name__ == '__main__':
    raise SystemExit(main())
