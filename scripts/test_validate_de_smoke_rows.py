from pathlib import Path
import csv
import json
import pytest
from validate_de_smoke_rows import (
    load_spectrum_v3_modes, validate_rows, validate_selected_only_diagnostics, SAMPLING)

MS = 800000.0
MU0 = 4.0 * 3.141592653589793 * 1e-7
THICKNESS = 10e-9
PERIOD = 40e-9
PADDING = 2e-6
VOLUME = PERIOD * PERIOD * THICKNESS
NZ = 2.0 * PADDING / (2.0 * PADDING + THICKNESS)


def write(path, rows):
    with path.open('w',newline='') as stream:
        w=csv.DictWriter(stream,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)


def rows(sampling):
    return [dict(sample_index=i,raw_mode_index=0,branch_id=3,
                 kx_rad_per_m=0,ky_rad_per_m=k,kz_rad_per_m=0,
                 frequency_hz=9.3e9+i*2e7,residual_norm=1e-10)
            for i,k in enumerate(SAMPLING[sampling])]


def probe(status='passed'):
    sample = dict(attempted=True,passed=True,q_l2_norm=1.0,
                  potential_relative_residual=1e-12,self_energy_j=1e-18,
                  potential_energy_j=1e-18,energy_form_relative_defect=1e-12)
    if status != 'passed':
        sample['passed'] = False
    return dict(schema_version='floquet_dynamic_demag_operator_probe.v1',
                status=status,potential_equation='P_phi_plus_A_phiq_q_equals_zero',
                potential_coefficient_unit='A',energy_unit='J',
                relative_tolerance=1e-8,
                hermitian_relative_defect=1e-12,
                global_y=dict(sample),global_z=dict(sample))


def k0_probe(*, measured_nz=NZ, status='passed', mutation=None):
    energy = 0.5 * MU0 * MS * MS * measured_nz * VOLUME
    def sample(direction, factor):
        mean_field = -factor * MS
        value = dict(attempted=True,passed=True,q_l2_norm=1.0,
                     potential_relative_residual=1e-12,gauge_constraint_abs=0.0,
                     mean_field_a_per_m=mean_field,mean_magnetization_a_per_m=MS,
                     demag_factor=factor,potential_energy_j=energy if direction=='global_z' else 0.0,
                     magnetic_energy_j=energy if direction=='global_z' else 0.0,
                     energy_form_relative_defect=1e-12)
        if mutation == 'failed_direction' and direction == 'global_z':
            value['passed'] = False
        if mutation == 'unobservable_direction' and direction == 'global_z':
            value['attempted'] = False
            value['passed'] = False
        return value
    result = dict(schema_version='poisson_airbox_k0_demag_operator_probe.v1',
                  status=status,potential_equation='P_phi_plus_A_phiq_q_equals_zero',
                  potential_coefficient_unit='A',field_unit='A/m',energy_unit='J',
                  relative_tolerance=1e-8,outer_boundary_kind='poisson_dirichlet',
                  robin_beta=0.0,mu0_t_m_a=MU0,magnetic_volume_m3=VOLUME,
                  global_y=sample('global_y',0.0),global_z=sample('global_z',measured_nz))
    if mutation == 'wrong_boundary':
        result['outer_boundary_kind'] = 'poisson_robin'
    if mutation == 'wrong_volume':
        result['magnetic_volume_m3'] *= 2.0
    if mutation == 'loose_k0_tolerance':
        result['relative_tolerance'] = 1e-4
    return result


def diagnostics(sampling, *, probe_status='passed', missing_sample=None,
                k0_status='passed', k0_mutation=None):
    samples=[]
    for index,wavevector in enumerate(SAMPLING[sampling]):
        if index == missing_sample:
            continue
        if wavevector == 0:
            samples.append(dict(sample_index=index,diagnostics={
                'poisson_airbox_k0_demag_operator_probe':
                    k0_probe(status=k0_status,mutation=k0_mutation)}))
            continue
        samples.append(dict(sample_index=index,diagnostics={
            'dynamic_demag_operator_probe':probe(probe_status)}))
    return {'sample_solver_diagnostics':samples}


def write_diagnostics(path, sampling, **kwargs):
    path.write_text(json.dumps(diagnostics(sampling, **kwargs)),encoding='utf-8')


def write_selected_diagnostics(path, *, target_hz=12.5e9, target_kind='nearest_frequency',
                               completeness='selected_only', window_complete=False,
                               include_omega=True):
    value = {
        'target_kind': target_kind,
        'spectrum_completeness': completeness,
        'window_complete': window_complete,
    }
    if include_omega:
        value['target_omega_rad_s'] = target_hz * 2.0 * 3.141592653589793
    path.write_text(json.dumps(value), encoding='utf-8')


def write_metadata(path):
    metadata = {'problem_meta': {'runtime_metadata': {'de_smoke': {
        'schema': 'fullmag.de-smoke.v1',
        'orientation': 'M0=x,k=y,normal=z',
        'outer_boundary_kind': 'poisson_dirichlet',
        'eigen_solver_rtol': 1e-8,
        'film_thickness_m': THICKNESS,
        'cell_period_m': PERIOD,
        'air_padding_each_side_m': PADDING,
        'saturation_magnetization_a_per_m': MS,
        'mu0_t_m_a': MU0,
    }}}}
    path.write_text(json.dumps(metadata),encoding='utf-8')


def write_spectrum_v3(path, sampling, *, residual=1e-12, omit_residual=False,
                      block_residual=None, certification_tolerance=1e-8):
    samples = []
    for sample_index, ky in enumerate(SAMPLING[sampling]):
        r = residual if isinstance(residual, (int, float)) else residual[sample_index]
        block_r = r if block_residual is None else block_residual
        full = ky == 0.0
        mode = {
            'sample_index': sample_index,
            'raw_mode_index': 0,
            'frequency_hz': 9.3e9 + sample_index * 2e7,
            'residual_relative_l2': r,
            'block_residuals': {
                'eps_q': block_r,
                'eps_phi': block_r,
                'eps_gauge': 0.0,
                'eps_full': r if full else None,
                'eps_reduced': None if full else r,
                'certification_tolerance': certification_tolerance,
                'scope': 'native_descriptor' if full else 'reduced_original_blocks_only',
                'certified': full,
                'reduced_pencil_certified': not full,
                'full_descriptor_certified': full,
            },
        }
        if omit_residual:
            del mode['residual_relative_l2']
        samples.append({'sample_index': sample_index,
                        'sample_id': f'k-sample-{sample_index:04}',
                        'modes': [mode]})
    path.write_text(json.dumps({'schema_version': 'eigen_spectrum.v3',
                                'sample_count': len(samples),
                                'samples': samples}), encoding='utf-8')


def validate_fixture(tmp_path, csv_path, sampling, diagnostics_path):
    metadata_path=tmp_path/'metadata.json';write_metadata(metadata_path)
    if sampling == 'signed-fifteen':
        metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
        model = metadata['problem_meta']['runtime_metadata']['de_smoke']
        model['sampling'] = sampling
        model['k_vectors_rad_per_m'] = [[0.0, k, 0.0] for k in SAMPLING[sampling]]
        metadata_path.write_text(json.dumps(metadata), encoding='utf-8')
    write_spectrum_v3(csv_path.parent/'spectrum.v3.json', sampling)
    return validate_rows(csv_path,sampling,diagnostics_path,metadata_path)


def write_full_floquet_spectrum(path, *, seam_residual=6e-12):
    reduced_q = 3e-12
    reduced_phi = 4e-12
    full_q = 5e-12
    full_phi = 4.5e-12
    seam_values = {
        'floquet_scalar_phase_seam_relative_residual': seam_residual,
        'floquet_tangent_frame_seam_relative_residual': 2e-12,
        'floquet_cartesian_magnetic_seam_relative_residual': 3e-12,
        'floquet_equilibrium_pair_relative_residual': 4e-12,
    }
    overall = max(reduced_q, reduced_phi, full_q, full_phi, *seam_values.values())
    mode = {
        'sample_index': 0,
        'raw_mode_index': 0,
        'frequency_hz': 9.3e9,
        'residual_relative_l2': overall,
        'floquet_descriptor_certified': True,
        'floquet_full_descriptor_certified': True,
        'floquet_seam_frame_certified': True,
        'floquet_gauge_policy_satisfied': True,
        'floquet_geometric_bc_certified': False,
        'potential_representation': 'complex_coefficients',
        'poisson_boundary_kind': 'poisson_dirichlet',
        'poisson_gauge_policy': 'none',
        'gauge_constraint_policy': 'nonzero_k_poisson_without_mean_constraint',
        'gauge_constraint_backward_error': None,
        'magnetic_relative_residual': reduced_q,
        'potential_relative_residual': reduced_phi,
        'floquet_full_magnetic_relative_residual': full_q,
        'floquet_full_potential_relative_residual': full_phi,
        **seam_values,
        'block_residuals': {
            'eps_q': reduced_q,
            'eps_phi': reduced_phi,
            'eps_gauge': None,
            'eps_full': max(full_q, full_phi),
            'eps_reduced': max(reduced_q, reduced_phi),
            'certification_tolerance': 1e-8,
            'scope': 'full_projected_weak_form_and_periodic_seams',
            'certified': True,
            'reduced_pencil_certified': True,
            'full_descriptor_certified': True,
        },
    }
    path.write_text(json.dumps({
        'schema_version': 'eigen_spectrum.v3',
        'sample_count': 1,
        'samples': [{'sample_index': 0, 'sample_id': 'k-sample-0000', 'modes': [mode]}],
    }), encoding='utf-8')


def test_certified_nonzero_k_rows_keep_reduced_full_and_seam_residuals_distinct(tmp_path):
    csv_path = tmp_path / 'dispersion.csv'
    write(csv_path, rows('k2'))
    diagnostics_path = tmp_path / 'solver.v1.json'
    write_diagnostics(diagnostics_path, 'k2')
    metadata_path = tmp_path / 'metadata.json'
    write_metadata(metadata_path)
    write_full_floquet_spectrum(tmp_path / 'spectrum.v3.json')

    modes = load_spectrum_v3_modes(tmp_path / 'spectrum.v3.json')
    result = validate_rows(csv_path, 'k2', diagnostics_path, metadata_path)

    mode = modes[(0, 0)]
    assert mode['residual_relative_l2'] == 6e-12
    assert mode['residual_scope'] == 'full_projected_weak_form_and_periodic_seams'
    assert mode['block_residuals']['eps_gauge'] is None
    assert mode['block_residuals']['eps_reduced'] == 4e-12
    assert mode['block_residuals']['eps_full'] == 5e-12
    assert result['status'] == 'pass'
    assert result['full_descriptor_certified'] is True


def test_selected_only_rows_use_a_separate_scope_without_window_claim(tmp_path):
    csv_path = tmp_path / 'dispersion.csv'
    selected = rows('k2')
    selected[0]['frequency_hz'] = 2.0e9
    write(csv_path, selected)
    diagnostics_path = tmp_path / 'solver.v1.json'
    write_diagnostics(diagnostics_path, 'k2')
    write_metadata(tmp_path / 'metadata.json')
    write_spectrum_v3(tmp_path / 'spectrum.v3.json', 'k2')
    spectrum = json.loads((tmp_path / 'spectrum.v3.json').read_text())
    spectrum['samples'][0]['modes'][0]['frequency_hz'] = 2.0e9
    (tmp_path / 'spectrum.v3.json').write_text(json.dumps(spectrum))

    with pytest.raises(ValueError, match='outside the frozen DE-SMOKE window'):
        validate_rows(csv_path, 'k2', diagnostics_path, tmp_path / 'metadata.json')
    result = validate_rows(
        csv_path, 'k2', diagnostics_path, tmp_path / 'metadata.json',
        selection_scope='selected_only')
    assert result['status'] == 'pass'
    assert result['selection_scope'] == 'selected_only'
    assert result['qualification'] == 'NOT VERIFIED'


def test_selected_only_native_diagnostics_require_exact_target(tmp_path):
    path = tmp_path / 'solver.v1.json'
    write_selected_diagnostics(path)
    report = validate_selected_only_diagnostics(path, 12.5e9)
    assert report['status'] == 'pass'
    assert report['target_kind'] == 'nearest_frequency'
    assert report['target_field'] == 'target_omega_rad_s'
    assert report['window_complete'] is False
    for mutation, kwargs in (
        ('wrong_kind', {'target_kind': 'frequency_window'}),
        ('wrong_completeness', {'completeness': 'complete_window'}),
        ('complete_window', {'window_complete': True}),
        ('wrong_target', {'target_hz': 13e9}),
        ('missing_target', {'include_omega': False}),
    ):
        with pytest.raises(ValueError):
            write_selected_diagnostics(path, **kwargs)
            validate_selected_only_diagnostics(path, 12.5e9)


def test_selected_only_native_diagnostics_reads_the_single_sample_payload(tmp_path):
    path = tmp_path / 'solver.v1.json'
    path.write_text(json.dumps({
        'sample_solver_diagnostics': [{
            'sample_index': 0,
            'diagnostics': {
                'target_kind': 'nearest_frequency',
                'spectrum_completeness': 'selected_only',
                'window_complete': False,
                'target_omega_rad_s': 12.5e9 * 2.0 * 3.141592653589793,
            },
        }],
    }))
    assert validate_selected_only_diagnostics(path, 12.5e9)['status'] == 'pass'
    value = json.loads(path.read_text())
    value['sample_solver_diagnostics'].append(value['sample_solver_diagnostics'][0])
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match='one sample record'):
        validate_selected_only_diagnostics(path, 12.5e9)


@pytest.mark.parametrize('key,value', [
    ('spectrum_completeness', 'complete_window'),
    ('window_complete', True),
    ('target_omega_rad_s', 13.0e9 * 2.0 * 3.141592653589793),
])
def test_selected_only_native_diagnostics_rejects_conflicting_root_alias(tmp_path, key, value):
    path = tmp_path / 'solver.v1.json'
    sample = {
        'target_kind': 'nearest_frequency',
        'spectrum_completeness': 'selected_only',
        'window_complete': False,
        'target_omega_rad_s': 12.5e9 * 2.0 * 3.141592653589793,
    }
    path.write_text(json.dumps({
        'sample_solver_diagnostics': [{'sample_index': 0, 'diagnostics': sample}],
        key: value,
    }))
    with pytest.raises(ValueError, match='root and sample diagnostics disagree'):
        validate_selected_only_diagnostics(path, 12.5e9)


def test_selected_only_native_diagnostics_rejects_boolean_sample_index(tmp_path):
    path = tmp_path / 'solver.v1.json'
    path.write_text(json.dumps({
        'sample_solver_diagnostics': [{
            'sample_index': False,
            'diagnostics': {
                'target_kind': 'nearest_frequency',
                'spectrum_completeness': 'selected_only',
                'window_complete': False,
                'target_omega_rad_s': 12.5e9 * 2.0 * 3.141592653589793,
            },
        }],
    }))
    with pytest.raises(ValueError, match='identify sample 0'):
        validate_selected_only_diagnostics(path, 12.5e9)


def test_certified_nonzero_k_rows_reject_a_mismatched_full_residual_summary(tmp_path):
    path = tmp_path / 'spectrum.v3.json'
    write_full_floquet_spectrum(path, seam_residual=2e-7)

    with pytest.raises(ValueError, match='exceeds its block certification tolerance'):
        load_spectrum_v3_modes(path)


@pytest.mark.parametrize('sampling',['k0','k2','two','five','signed-eleven'])
def test_complete_rows_are_only_preflight_not_qualification(tmp_path,sampling):
    path=tmp_path/'dispersion.csv';write(path,rows(sampling))
    diagnostic_path=tmp_path/'solver.v1.json'
    write_diagnostics(diagnostic_path,sampling)
    result=validate_fixture(tmp_path,path,sampling,diagnostic_path)
    assert result['status']=='pass'
    assert result['qualification']=='NOT VERIFIED'
    assert result['pending_requirements']
    assert bool(result['dynamic_demag_operator_probes']) == (sampling != 'k0')


@pytest.mark.parametrize('key,value',[
    ('sample_index',-1),('sample_index',0.5),('sample_index',1),
    ('raw_mode_index',-1),('branch_id',''),('frequency_hz',''),
    ('frequency_hz',float('nan')),('frequency_hz',2.8e9),
    ('residual_norm',-1),('residual_norm',float('inf')),
    ('ky_rad_per_m',1e6),('kx_rad_per_m',1),
])
def test_invalid_or_misbound_row_is_rejected(tmp_path,key,value):
    data=rows('two');data[0][key]=value
    path=tmp_path/'dispersion.csv';write(path,data)
    diagnostic_path=tmp_path/'solver.v1.json';write_diagnostics(diagnostic_path,'two')
    with pytest.raises(ValueError):validate_fixture(tmp_path,path,'two',diagnostic_path)


@pytest.mark.parametrize('mutation',['missing','duplicate','branch_alias'])
def test_incomplete_or_duplicate_samples_fail(tmp_path,mutation):
    data=rows('two')
    if mutation=='missing':data.pop()
    else:
        extra=dict(data[0])
        if mutation=='branch_alias':extra['raw_mode_index']=1
        data.append(extra)
    path=tmp_path/'dispersion.csv';write(path,data)
    diagnostic_path=tmp_path/'solver.v1.json';write_diagnostics(diagnostic_path,'two')
    with pytest.raises(ValueError):validate_fixture(tmp_path,path,'two',diagnostic_path)


def test_absolute_residual_is_not_compared_to_relative_tolerance(tmp_path):
    data=rows('two')
    for row in data: row['residual_norm']=1e3
    path=tmp_path/'dispersion.csv';write(path,data)
    diagnostic_path=tmp_path/'solver.v1.json';write_diagnostics(diagnostic_path,'two')
    result=validate_fixture(tmp_path,path,'two',diagnostic_path)
    assert result['max_absolute_residual_norm']==1e3
    assert result['qualification']=='NOT VERIFIED'
    assert any('full descriptor' in item for item in result['pending_requirements'])


def test_relative_original_block_residual_is_used_when_absolute_alias_is_unavailable(tmp_path):
    data=rows('k2')
    data[0]['residual_norm']=''
    csv_path=tmp_path/'dispersion.csv';write(csv_path,data)
    diagnostics_path=tmp_path/'solver.v1.json';write_diagnostics(diagnostics_path,'k2')
    metadata_path=tmp_path/'metadata.json';write_metadata(metadata_path)
    write_spectrum_v3(tmp_path/'spectrum.v3.json','k2',residual=1.78e-14)

    result=validate_rows(csv_path,'k2',diagnostics_path,metadata_path)

    assert result['status']=='pass'
    assert result['qualification']=='NOT VERIFIED'
    assert result['max_absolute_residual_norm'] is None
    assert result['max_relative_residual_l2']==pytest.approx(1.78e-14)
    assert result['residual_scope']=='reduced_original_blocks_only'
    assert any('full descriptor' in item for item in result['pending_requirements'])


def test_relative_residual_must_be_present_and_within_metadata_tolerance(tmp_path):
    csv_path=tmp_path/'dispersion.csv';write(csv_path,rows('k2'))
    diagnostics_path=tmp_path/'solver.v1.json';write_diagnostics(diagnostics_path,'k2')
    metadata_path=tmp_path/'metadata.json';write_metadata(metadata_path)
    spectrum_path=tmp_path/'spectrum.v3.json'
    write_spectrum_v3(spectrum_path,'k2',omit_residual=True)
    with pytest.raises(ValueError,match='residual_relative_l2'):
        validate_rows(csv_path,'k2',diagnostics_path,metadata_path)

    write_spectrum_v3(spectrum_path,'k2',residual=1.1e-8,
                      certification_tolerance=1e-6)
    with pytest.raises(ValueError,match='exceeds solver tolerance'):
        validate_rows(csv_path,'k2',diagnostics_path,metadata_path)


def test_relative_residual_must_match_published_block_residuals(tmp_path):
    csv_path=tmp_path/'dispersion.csv';write(csv_path,rows('k2'))
    diagnostics_path=tmp_path/'solver.v1.json';write_diagnostics(diagnostics_path,'k2')
    metadata_path=tmp_path/'metadata.json';write_metadata(metadata_path)
    write_spectrum_v3(tmp_path/'spectrum.v3.json','k2',
                      residual=1e-12,block_residual=2e-12)
    spectrum_path = tmp_path/'spectrum.v3.json'
    spectrum = json.loads(spectrum_path.read_text(encoding='utf-8'))
    spectrum['samples'][0]['modes'][0]['block_residuals']['eps_reduced'] = 2e-12
    spectrum_path.write_text(json.dumps(spectrum), encoding='utf-8')
    with pytest.raises(ValueError,match='residual_relative_l2 does not match its certified residual scope'):
        validate_rows(csv_path,'k2',diagnostics_path,metadata_path)


@pytest.mark.parametrize('mutation',['missing','not_observable','failed','loose_tolerance'])
def test_nonzero_k_requires_a_passed_native_demag_probe(tmp_path,mutation):
    data=rows('two')
    csv_path=tmp_path/'dispersion.csv';write(csv_path,data)
    diagnostics_path=tmp_path/'solver.v1.json'
    value=diagnostics('two',probe_status='not_observable' if mutation=='not_observable' else 'passed',
                      missing_sample=1 if mutation=='missing' else None)
    nonzero_diagnostics = next(
        (record['diagnostics'] for record in value['sample_solver_diagnostics']
         if record['sample_index'] == 1), None)
    if mutation=='loose_tolerance':
        nonzero_diagnostics['dynamic_demag_operator_probe']['relative_tolerance']=1e-4
    if mutation=='failed':
        nonzero_diagnostics['dynamic_demag_operator_probe']['global_z']['passed']=False
    diagnostics_path.write_text(json.dumps(value),encoding='utf-8')
    with pytest.raises(ValueError):
        validate_fixture(tmp_path,csv_path,'two',diagnostics_path)


@pytest.mark.parametrize('mutation',['missing_window_probe','failed_window_probe'])
def test_windowed_nonzero_k_requires_a_passed_probe_for_every_subwindow(tmp_path,mutation):
    csv_path=tmp_path/'dispersion.csv';write(csv_path,rows('k2'))
    diagnostics_path=tmp_path/'solver.v1.json'
    value=diagnostics('k2')
    sample_diagnostics=value['sample_solver_diagnostics'][0]['diagnostics']
    sample_diagnostics.pop('dynamic_demag_operator_probe')
    probes=[probe(),probe()]
    if mutation=='missing_window_probe':
        probes[1]=None
    else:
        probes[1]=probe(status='failed')
    sample_diagnostics['subwindows']=[
        {'index':index, **({'dynamic_demag_operator_probe':item} if item else {})}
        for index,item in enumerate(probes)
    ]
    diagnostics_path.write_text(json.dumps(value),encoding='utf-8')
    with pytest.raises(ValueError,match='subwindow 1'):
        validate_fixture(tmp_path,csv_path,'k2',diagnostics_path)


def test_windowed_nonzero_k_reports_all_demag_probes(tmp_path):
    csv_path=tmp_path/'dispersion.csv';write(csv_path,rows('k2'))
    diagnostics_path=tmp_path/'solver.v1.json'
    value=diagnostics('k2')
    sample_diagnostics=value['sample_solver_diagnostics'][0]['diagnostics']
    sample_diagnostics.pop('dynamic_demag_operator_probe')
    sample_diagnostics['subwindows']=[
        {'index':index,'dynamic_demag_operator_probe':probe()}
        for index in range(2)
    ]
    diagnostics_path.write_text(json.dumps(value),encoding='utf-8')
    result=validate_fixture(tmp_path,csv_path,'k2',diagnostics_path)
    report=result['dynamic_demag_operator_probes'][0]
    assert report['subwindow_count']==2
    assert [item['subwindow_index'] for item in report['subwindows']]==[0,1]


@pytest.mark.parametrize('mutation',[
    'missing','not_observable','failed_direction','unobservable_direction',
    'wrong_nz','wrong_boundary',
    'wrong_volume','loose_k0_tolerance'])
def test_gamma_requires_geometry_matched_dirichlet_demag_probe(tmp_path,mutation):
    data=rows('two')
    csv_path=tmp_path/'dispersion.csv';write(csv_path,data)
    diagnostics_path=tmp_path/'solver.v1.json'
    value=diagnostics('two',k0_status='not_observable' if mutation=='not_observable' else 'passed',
                      k0_mutation=mutation if mutation not in ('missing','not_observable','wrong_nz') else None)
    if mutation == 'wrong_nz':
        value['sample_solver_diagnostics'][0]['diagnostics'][
            'poisson_airbox_k0_demag_operator_probe']['global_z']['demag_factor'] = 0.8
    if mutation == 'missing':
        value['sample_solver_diagnostics'] = [value['sample_solver_diagnostics'][1]]
    diagnostics_path.write_text(json.dumps(value),encoding='utf-8')
    with pytest.raises(ValueError):
        validate_fixture(tmp_path,csv_path,'two',diagnostics_path)

@pytest.mark.parametrize("sampling", ["k25", "bv-k25", "k-25", "bv-k-25", "k17", "k22", "bv-k7", "bv-k12", "bv-k17", "bv-k22"])
def test_25_wavevector_and_geometry_are_checked(tmp_path, sampling):
    csv_path = tmp_path / "dispersion.csv"
    sample_rows = rows(sampling)
    wavevector = float(sampling.removeprefix("bv-")[1:]) * 1e6
    if sampling.startswith("bv-"):
        sample_rows[0]["kx_rad_per_m"] = wavevector
        sample_rows[0]["ky_rad_per_m"] = 0
    frequency = 13.6e9 if not sampling.startswith("bv-") else 9.7e9
    sample_rows[0]["frequency_hz"] = frequency
    write(csv_path, sample_rows)
    diagnostics_path = tmp_path / "solver.json"
    write_diagnostics(diagnostics_path, sampling)
    metadata_path = tmp_path / "metadata.json"
    write_metadata(metadata_path)
    metadata = json.loads(metadata_path.read_text())
    model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    model.update(sampling=sampling, orientation="M0=x,k=x,normal=z" if sampling.startswith("bv-") else "M0=x,k=y,normal=z",
                 k_vectors_rad_per_m=[[wavevector,0,0] if sampling.startswith("bv-") else [0,wavevector,0]])
    metadata_path.write_text(json.dumps(metadata))
    spectrum_path = tmp_path / "spectrum.v3.json"
    write_spectrum_v3(spectrum_path, sampling)
    spectrum = json.loads(spectrum_path.read_text())
    spectrum["samples"][0]["modes"][0]["frequency_hz"] = frequency
    spectrum_path.write_text(json.dumps(spectrum))
    validate_rows(csv_path, sampling, diagnostics_path, metadata_path)
    sample_rows[0]["kx_rad_per_m"], sample_rows[0]["ky_rad_per_m"] = sample_rows[0]["ky_rad_per_m"], sample_rows[0]["kx_rad_per_m"]
    write(csv_path, sample_rows)
    with pytest.raises(ValueError, match="propagation direction"):
        validate_rows(csv_path, sampling, diagnostics_path, metadata_path)


def test_signed_fifteen_has_exact_indices_and_enforces_gamma_probe(tmp_path):
    expected = (-25, -20, -15, -10, -7, -5, -2, 0, 2, 5, 7, 10, 15, 20, 25)
    assert SAMPLING['signed-fifteen'] == tuple(k * 1e6 for k in expected)
    csv_path = tmp_path / 'dispersion.csv'
    write(csv_path, rows('signed-fifteen'))
    diag_path = tmp_path / 'solver.v1.json'
    write_diagnostics(diag_path, 'signed-fifteen')
    report = validate_fixture(tmp_path, csv_path, 'signed-fifteen', diag_path)
    assert report is not None
    write_diagnostics(diag_path, 'signed-fifteen', k0_mutation='failed_direction')
    with pytest.raises(ValueError):
        validate_fixture(tmp_path, csv_path, 'signed-fifteen', diag_path)


def test_signed_fifteen_rejects_inconsistent_model_descriptor(tmp_path):
    csv_path = tmp_path / 'dispersion.csv'
    write(csv_path, rows('signed-fifteen'))
    diag_path = tmp_path / 'solver.v1.json'
    write_diagnostics(diag_path, 'signed-fifteen')
    validate_fixture(tmp_path, csv_path, 'signed-fifteen', diag_path)
    metadata_path = tmp_path / 'metadata.json'
    pristine = metadata_path.read_text(encoding='utf-8')
    for key, value in [('orientation', 'M0=x,k=x,normal=z'),
                       ('sampling', 'signed-eleven'), ('k_vectors_rad_per_m', [[0, 0, 0]])]:
        metadata = json.loads(pristine)
        metadata['problem_meta']['runtime_metadata']['de_smoke'][key] = value
        metadata_path.write_text(json.dumps(metadata), encoding='utf-8')
        with pytest.raises(ValueError, match='metadata disagrees'):
            validate_rows(csv_path, 'signed-fifteen', diag_path, metadata_path)
