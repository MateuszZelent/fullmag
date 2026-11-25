"""Private offline FFT of saved inspection H; never solves or qualifies a source.

The explicit expected profile is an input requirement, not a resampling grid.
No native antenna_spectrum stage or reference comparison is executed here.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import struct

import numpy as np

from verify_sushruth_2020_field_fft import fourier_minus, write_csv

ROOT = Path(__file__).resolve().parents[1]
SOURCE_READER = ROOT / 'tools/gsg_surface_native_probe.py'
CHILD_READER = ROOT / 'examples/sushruth_2020_closed_gsg/edge_field_20261111/verification/compare_edge_field.py'
PINS = ('prepared_execution_digest', 'accepted_charge_field_digest',
        'accepted_source_state_digest', 'view_identity_digest', 'current_balance_certificate_digest')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def _module(path):
    spec = importlib.util.spec_from_file_location('native_fft_'+path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _pin(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def _input_manifest(source_bundle, source_sha256, field_bundle, field_sha256):
    result = {'source_bundle': {'path': str(Path(source_bundle).resolve()),
                               'requested_sha256': source_sha256, 'verified': False}}
    if field_bundle is not None or field_sha256 is not None:
        result['field_bundle'] = {'path': str(Path(field_bundle).resolve()) if field_bundle is not None else None,
                                 'requested_sha256': field_sha256, 'verified': False}
    return result


def load_native_field(source_bundle, source_sha256, field_bundle=None, field_sha256=None):
    """Read pinned full-source H or a retained child bound to that same source."""
    inputs = _input_manifest(source_bundle, source_sha256, field_bundle, field_sha256)
    try:
        require(_pin(source_sha256), 'Expected a lowercase source SHA256')
        require((field_bundle is None) == (field_sha256 is None), 'Field bundle and SHA256 must be supplied together')
        parent, data = _module(SOURCE_READER).read_bundle(Path(source_bundle).resolve(), source_sha256)
        source = parent['source']
        require(all(_pin(source[key]) for key in PINS), 'Invalid source identity pins')
        current = source['source_current_a']
        require(type(current) in (float, int) and np.isfinite(current) and current != 0,
                'Finite nonzero signed source current required')
        require(np.isfinite(1. / current), 'Signed current reciprocal is not finite')
        require(parent['signed_normalization_a'] == current and parent['scale_per_a'] == 1. / current,
                'Source signed normalization differs')
        manifest = parent
        if field_bundle is not None:
            require(__debug__, 'Retained parser requires Python without optimization (-O)')
            require(_pin(field_sha256), 'Expected a lowercase field SHA256')
            path = Path(field_bundle).resolve()
            require(path.is_file() and 16 < path.stat().st_size <= 512*1024**2, 'Field bundle size/type differs')
            raw = path.read_bytes()
            require(hashlib.sha256(raw).hexdigest() == field_sha256, 'Field bundle hash differs')
            try:
                manifest, data = _module(CHILD_READER).unpack_child(raw)
            except AssertionError as error:
                raise ValueError('Retained field framing, descriptors, units or layout differ') from error
            require(manifest['parent']['owner']['package']['object_ref'] == source_sha256,
                    'Retained field owner bundle differs')
            require(manifest['parent']['source'] == {key: 'sha256:'+source[key] for key in PINS},
                    'Retained field parent identity pins differ')
            require(manifest['source_cell_count'] == parent['cell_count'] and
                    manifest['source_vertex_count'] == parent['vertex_count'], 'Retained field source counts differ')
            require(all(manifest[key] == parent[key] for key in
                        ('source_object_id', 'current_transport_id', 'port_mode_id')),
                    'Retained field source object, transport or port differs')
        for key, unit in (('sample_xyz', 'm'), ('h_raw', 'A/m')):
            descriptor = manifest['payloads'][key]
            require(descriptor['unit'] == unit and descriptor['layout'] == 'sample_xyz_f64_le',
                    'Field units/layout differ: '+key)
            require(len(data[key]) == manifest['target_count']*24, 'Field target count differs: '+key)
        require(type(manifest['target_count']) is int and manifest['target_count'] > 0,
                'Invalid field target count')
        require(len(data['sample_cells']) == manifest['sample_cell_count']*16,
                'Field sample-cell count differs')
        positions = np.frombuffer(data['sample_xyz'], dtype='<f8').reshape(-1, 3).copy()
        field = np.frombuffer(data['h_raw'], dtype='<f8').reshape(-1, 3).copy()
        require(np.all(np.isfinite(positions)) and np.all(np.isfinite(field)), 'Nonfinite saved coordinates or H')
        for entry in inputs.values():
            entry['verified'] = True
        inputs.update(source_identity={key: source[key] for key in PINS}, signed_current_a=current,
                      source_current_orientation=source.get('source_current_orientation'),
                      source_object_id=parent['source_object_id'], port_mode_id=parent['port_mode_id'],
                      requested_intent=parent.get('requested_intent'),
                      field_payload_sha256={key:manifest['payloads'][key]['sha256'] for key in ('sample_xyz','h_raw')})
        return dict(positions_m=positions, field_apm=field, signed_current_a=current, input_manifest=inputs)
    except (AssertionError, KeyError, TypeError, OSError, struct.error) as error:
        raise ValueError('Invalid saved native field: '+str(error)) from error


def extract_line(positions_m, field_apm, signed_current_a, y_m, z_m, *,
                 expected_count, expected_x_first_m, expected_step_m):
    """Select exact y/z; preserve measured x and reject an incomplete authored line."""
    positions, field = np.asarray(positions_m, dtype=float), np.asarray(field_apm, dtype=float)
    require(positions.ndim == 2 and positions.shape[1] == 3 and positions.shape == field.shape
            and np.all(np.isfinite(positions)) and np.all(np.isfinite(field)), 'Finite shape-matched XYZ/H required')
    require(np.all(np.isfinite([signed_current_a,y_m,z_m,expected_x_first_m,expected_step_m]))
            and signed_current_a != 0 and expected_step_m > 0, 'Finite profile and nonzero signed current required')
    require(type(expected_count) is int and expected_count >= 4, 'Expected count must be an integer of at least four')
    selected = (positions[:,1] == y_m) & (positions[:,2] == z_m)
    require(int(np.count_nonzero(selected)) == expected_count,
            f'Incomplete profile: selected {np.count_nonzero(selected)} samples, expected {expected_count}')
    order = np.argsort(positions[selected,0], kind='stable')
    x = positions[selected,0][order]
    require(np.all(np.diff(x) > 0), 'Duplicate x coordinates in selected profile')
    expected = expected_x_first_m + np.arange(expected_count)*expected_step_m
    # Same 1e-9 relative spacing tolerance as fourier_minus; never snap x.
    require(np.all(np.isfinite(expected)) and
            np.all(np.abs(x-expected) <= 1e-9*expected_step_m) and
            np.allclose(np.diff(x),expected_step_m,rtol=1e-9,atol=0),
            'Nonuniform or incomplete profile: coordinates differ from authored start/count/step')
    with np.errstate(over='ignore', invalid='ignore', divide='ignore'):
        normalized = field[selected,0][order] / signed_current_a
    require(np.all(np.isfinite(normalized)), 'Normalized Hx/I is not finite')
    return x, normalized


def compute_spectrum(x_m, hx_per_ampere):
    """Integral-SI F_minus and A_plus=conj(-2 F_minus), without fitting or padding."""
    with np.errstate(over='ignore', invalid='ignore'):
        k, fminus = fourier_minus(x_m, hx_per_ampere)
        aplus = (-2*fminus).conjugate()
    require(np.all(np.isfinite(k)) and np.all(np.isfinite(fminus)) and np.all(np.isfinite(aplus)),
            'Fourier output is not finite')
    return k, fminus, aplus


def run_postprocessor(source_bundle, source_sha256, *, y_m, z_m, output_dir,
                      expected_count, expected_x_first_m, expected_step_m,
                      field_bundle=None, field_sha256=None):
    """Write a fresh result directory; rejected inputs produce no spectral arrays."""
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=False)
    code_paths = (Path(__file__).resolve(),SOURCE_READER,CHILD_READER,
                  ROOT/'scripts/verify_sushruth_2020_field_fft.py')
    code_sha256 = {str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in code_paths}
    inputs = _input_manifest(source_bundle, source_sha256, field_bundle, field_sha256)
    profile = dict(y_m=y_m,z_m=z_m,expected_count=expected_count,
                   expected_x_first_m=expected_x_first_m,expected_step_m=expected_step_m)
    report = dict(schema='fullmag.private.native_field_fft.v1', verdict='INPUT_REJECTED',
                  source_status='inspection_only', publication_agreement='NOT_VERIFIED',
                  native_spectrum_executed=False, reference_comparison_performed=False,
                  sampling_convergence='NOT_VERIFIED', numpy_version=np.__version__,
                  new_native_field_solve=False, requested_profile=profile,
                  operation='NumPy postprocessing of saved inspection H',
                  convention='F_minus=integral(Hx/I exp(-ikx) dx); A_plus=conj(-2 F_minus)',
                  amplitude_unit='1', wave_vector_unit='rad/m', parameter_fit=False,
                  padding=False, interpolation=False)
    arrays = None
    try:
        data = load_native_field(source_bundle,source_sha256,field_bundle,field_sha256)
        inputs = data['input_manifest']
        x, normalized = extract_line(data['positions_m'],data['field_apm'],data['signed_current_a'],
                                     y_m,z_m,expected_count=expected_count,
                                     expected_x_first_m=expected_x_first_m,expected_step_m=expected_step_m)
        k, fminus, aplus = compute_spectrum(x,normalized)
        arrays = (x,normalized,k,fminus,aplus)
        report.update(verdict='FFT_POSTPROCESSING_PASS', signed_current_a=data['signed_current_a'],
                      sample_count=len(x), reason='Authored profile coordinates verified; source and publication qualification unchanged')
    except ValueError as error:
        report['reason'] = str(error)
    try:
        require(code_sha256 == {str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest()
                                for path in code_paths}, 'Implementation code changed during postprocessing')
    except (ValueError, OSError) as error:
        arrays = None
        report.update(verdict='INPUT_REJECTED',reason='Implementation code verification failed: '+str(error))
    if arrays is not None:
        x,normalized,k,fminus,aplus = arrays
        write_csv(output/'field-profile.csv',['x_m','Hx_over_I_per_m'],zip(x,normalized))
        write_csv(output/'spectrum.csv',['k_rad_per_m','F_minus_re','F_minus_im','A_plus_re','A_plus_im'],
                  zip(k,fminus.real,fminus.imag,aplus.real,aplus.imag))
        report['artifacts'] = {name:{'sha256':hashlib.sha256((output/name).read_bytes()).hexdigest(),
                                    'bytes':(output/name).stat().st_size} for name in ('field-profile.csv','spectrum.csv')}
    inputs['requested_profile'] = profile
    inputs['code_sha256'] = code_sha256
    # Invalid numeric CLI inputs must still yield a standards-compliant refusal receipt.
    for key,value in profile.items():
        if isinstance(value,float) and not np.isfinite(value):
            profile[key] = str(value)
    for name,value in (('input-manifest.json',inputs),('result.json',report)):
        with (output/name).open('x',encoding='utf-8') as stream:
            json.dump(value,stream,indent=2,allow_nan=False)
            stream.write('\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-bundle',type=Path,required=True)
    parser.add_argument('--source-sha256',required=True)
    parser.add_argument('--field-bundle',type=Path)
    parser.add_argument('--field-sha256')
    parser.add_argument('--y-m',type=float,required=True)
    parser.add_argument('--z-m',type=float,required=True)
    parser.add_argument('--expected-count',type=int,required=True)
    parser.add_argument('--expected-x-first-m',type=float,required=True)
    parser.add_argument('--expected-step-m',type=float,required=True)
    parser.add_argument('--output-dir',type=Path,required=True)
    report = run_postprocessor(**vars(parser.parse_args()))
    print(json.dumps(report,allow_nan=False))
    return 0 if report['verdict'] == 'FFT_POSTPROCESSING_PASS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
