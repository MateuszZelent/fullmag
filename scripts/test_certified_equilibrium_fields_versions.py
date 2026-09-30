"""Cross-language field-certificate contract; does not execute native FEM."""
import copy
import hashlib
from pathlib import Path
import struct
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_fem_periodic_antidot_relax_eigenmodes_runtime import (
    ValidationError, validate_certified_equilibrium_fields,
)


def reference_digest(fields):
    # Independent literal binary preimage for this one-node fixture.
    vectors = [fields['h_ex_a_per_m'], fields['h_demag_a_per_m']]
    if fields['schema_version'] == 'CertifiedFemEquilibriumFields.v2':
        vectors.append(fields['h_anisotropy_a_per_m'])
    vectors += [fields['h_ext_a_per_m'], fields['h_eff_a_per_m']]
    body = fields['schema_version'].encode() + bytes([0])
    for values in vectors:
        body += struct.pack('<Q', len(values))
        for vector in values:
            body += struct.pack('<3d', *vector)
    body += struct.pack('<Q', len(fields['phi_a']))
    body += struct.pack('<' + 'd'*len(fields['phi_a']), *fields['phi_a'])
    return 'sha256:' + hashlib.sha256(body).hexdigest()


def fixture(version):
    fields = dict(schema_version='CertifiedFemEquilibriumFields.' + version,
                  h_ex_a_per_m=[[1., 0., 0.]], h_demag_a_per_m=[[2., 0., 0.]],
                  h_ext_a_per_m=[[8., 0., 0.]], h_eff_a_per_m=[[11., 0., 0.]],
                  phi_a=[0.])
    if version == 'v2':
        fields['h_anisotropy_a_per_m'] = [[4., 0., 0.]]
        fields['h_eff_a_per_m'] = [[15., 0., 0.]]
    fields['content_sha256'] = reference_digest(fields)
    return fields


@pytest.mark.parametrize('version', ['v1', 'v2'])
def test_valid_legacy_and_anisotropy_certificates(version):
    validate_certified_equilibrium_fields(fixture(version), 1, 'fields')


@pytest.mark.parametrize('mutation', ['missing_ani', 'legacy_with_ani', 'unknown_schema',
                                     'wrong_shape', 'nonfinite', 'wrong_digest',
                                     'forged_decomposition', 'unknown_view', 'boolean_component'])
def test_rejects_incoherent_or_forged_fields(mutation):
    fields = copy.deepcopy(fixture('v2'))
    if mutation == 'missing_ani': del fields['h_anisotropy_a_per_m']
    if mutation == 'legacy_with_ani': fields['schema_version'] = 'CertifiedFemEquilibriumFields.v1'
    if mutation == 'unknown_schema': fields['schema_version'] = 'CertifiedFemEquilibriumFields.v9'
    if mutation == 'wrong_shape': fields['h_anisotropy_a_per_m'] = []
    if mutation == 'nonfinite': fields['h_anisotropy_a_per_m'][0][0] = float('nan')
    if mutation == 'wrong_digest': fields['content_sha256'] = 'sha256:' + '0'*64
    if mutation == 'forged_decomposition':
        fields['h_eff_a_per_m'][0][0] += 1.
        fields['content_sha256'] = reference_digest(fields)
    if mutation == 'unknown_view': fields['h_fake_a_per_m'] = [[0., 0., 0.]]
    if mutation == 'boolean_component': fields['h_anisotropy_a_per_m'][0][0] = True
    with pytest.raises(ValidationError):
        validate_certified_equilibrium_fields(fields, 1, 'fields')


def test_forged_legacy_digest_is_rejected():
    fields = fixture('v1')
    fields['h_eff_a_per_m'][0][0] += 1.
    with pytest.raises(ValidationError):
        validate_certified_equilibrium_fields(fields, 1, 'fields')


def test_legacy_binary_digest_matches_frozen_native_fixture():
    assert fixture('v1')['content_sha256'] == 'sha256:534a654a6ca21daff11b59fc99026f02ab3f02f3f341bec6c8ead73df73fe730'
    assert fixture('v2')['content_sha256'] == 'sha256:3b4b095aa8a9ed90102425a27ed8cceab494f88816dbd4f5101d14883d278a54'


def test_native_addition_order_is_required_after_large_cancellation():
    fields = fixture('v2')
    fields['h_ex_a_per_m'][0][0] = 1e16
    fields['h_demag_a_per_m'][0][0] = -1e16
    fields['h_anisotropy_a_per_m'][0][0] = 1.
    fields['h_ext_a_per_m'][0][0] = 2.
    fields['h_eff_a_per_m'][0][0] = 3.
    fields['content_sha256'] = reference_digest(fields)
    validate_certified_equilibrium_fields(fields, 1, 'fields')
    fields['h_eff_a_per_m'][0][0] = 2.
    fields['content_sha256'] = reference_digest(fields)
    with pytest.raises(ValidationError):
        validate_certified_equilibrium_fields(fields, 1, 'fields')


@pytest.mark.parametrize('version', ['v1', 'v2'])
def test_explicit_null_anisotropy_view_is_rejected(version):
    fields = fixture(version)
    fields['h_anisotropy_a_per_m'] = None
    with pytest.raises(ValidationError):
        validate_certified_equilibrium_fields(fields, 1, 'fields')


@pytest.mark.parametrize('version', ['v1', 'v2'])
def test_saved_field_payload_is_checked_at_its_versioned_path(tmp_path, version):
    import json
    from validate_fem_periodic_antidot_relax_eigenmodes_runtime import read_json
    path = tmp_path / 'equilibrium' / ('certified_fem_equilibrium_fields.' + version + '.json')
    path.parent.mkdir()
    fields = fixture(version)
    path.write_text(json.dumps(fields), encoding='utf-8')
    validate_certified_equilibrium_fields(read_json(path), 1, str(path))
    fields['h_eff_a_per_m'][0][0] += 1.
    path.write_text(json.dumps(fields), encoding='utf-8')
    with pytest.raises(ValidationError):
        validate_certified_equilibrium_fields(read_json(path), 1, str(path))
