"""Fixed GSG numerical convergence criteria; never source authentication or qualification."""
import hashlib
import math
import struct

from antenna_gsg_convergence_reference import PROPOSAL_SHA256

TARGET_XYZ_SHA256 = 'd22b100caf3c09f8ae484809ba4cef267d80c6a9d24415dc0153e52377da0684'


def _require(condition, reason):
    if not condition:
        raise ValueError(reason)


def _number(value, name):
    _require(type(value) in (float, int) and math.isfinite(value), name + ' must be finite numeric data')
    return float(value)


def _vectors(values, count, name):
    _require(isinstance(values, (list, tuple)) and len(values) == count, name + ' cardinality differs')
    result = []
    for vector in values:
        _require(isinstance(vector, (list, tuple)) and len(vector) == 3, name + ' requires vector3 rows')
        result.append(tuple(_number(v, name) for v in vector))
    return result


def _metric(fine_medium, medium_coarse, norm_fine, floor, relative):
    tolerance = floor + relative * norm_fine
    _require(all(math.isfinite(v) for v in (fine_medium, medium_coarse, tolerance, floor)),
             'nonfinite convergence metric')
    below = max(fine_medium, medium_coarse) <= floor
    return {'fine_medium_difference': fine_medium, 'medium_coarse_difference': medium_coarse,
            'tolerance': tolerance, 'absolute_floor': floor,
            'within_tolerance': fine_medium <= tolerance, 'both_below_floor': below,
            'contraction_pass': below or fine_medium < medium_coarse}


def compare_source_convergence(currents_A, fields_Apm, positions_m, *, etas=None):
    """Compare ordered 100/75/50nm results on the exact preregistered carrier.

    The caller authenticates owners and supplies the weighted-L2 RT0/H1 eta,
    not a charge/KKT residual. Missing eta is never zero. A numerical pass
    does not qualify this source, the full film, RF validity, projection or LLG.
    """
    positions = _vectors(positions_m, 20, 'carrier')
    xyz = struct.pack('<60d', *(v for row in positions for v in row))
    _require(hashlib.sha256(xyz).hexdigest() == TARGET_XYZ_SHA256, 'carrier binary64 identity differs')
    _require(isinstance(currents_A, (list, tuple)) and len(currents_A) == 3, 'three signed currents required')
    currents = [_number(v, 'current') for v in currents_A]
    _require(all(v != 0 for v in currents), 'zero normalization current')
    _require(isinstance(fields_Apm, (list, tuple)) and len(fields_Apm) == 3, 'three H fields required')
    fields = [_vectors(rows, 20, 'field') for rows in fields_Apm]
    normalized = [[tuple(v / current for v in row) for row in rows]
                  for rows, current in zip(fields, currents)]
    _require(all(math.isfinite(v) for rows in normalized for row in rows for v in row),
             'nonfinite H/I normalization')
    norm = lambda vector: math.hypot(*vector)
    delta = lambda a, b: norm(tuple(x - y for x, y in zip(a, b)))
    current = _metric(abs(currents[2] - currents[1]), abs(currents[1] - currents[0]),
                      abs(currents[2]), 1e-18, .01)
    targets = []
    for i, position in enumerate(positions):
        h = [rows[i] for rows in fields]
        k = [rows[i] for rows in normalized]
        targets.append({'index': i, 'position_m': position,
                        'H': _metric(delta(h[2], h[1]), delta(h[1], h[0]), norm(h[2]), 5e-4, 5e-4),
                        'H_per_A': _metric(delta(k[2], k[1]), delta(k[1], k[0]), norm(k[2]),
                                             5e-4 / abs(currents[2]), 5e-4)})
    checks = [current] + [row[key] for row in targets for key in ('H', 'H_per_A')]
    field_pass = all(v['within_tolerance'] and v['contraction_pass'] for v in checks)
    eta = {'values': None, 'pass': None, 'definition': 'weighted L2 RT0 minus H1 over H1; caller authenticates'}
    if etas is not None:
        _require(isinstance(etas, (list, tuple)) and len(etas) == 3, 'three eta estimates required')
        values = [None if v is None else _number(v, 'eta') for v in etas]
        _require(all(v is None or v >= 0 for v in values), 'negative eta estimate')
        eta['values'] = values
        if all(v is not None for v in values):
            contracts = lambda fine, medium: max(fine, medium) <= 1e-6 or fine <= .8 * medium
            eta['pass'] = values[2] <= .05 and contracts(values[2], values[1]) and contracts(values[1], values[0])
    passed = False if not field_pass else eta['pass']
    status = ('NOT VERIFIED / MISSING CURRENT ESTIMATOR' if passed is None else
              'NUMERICAL CRITERIA PASS / NOT QUALIFIED' if passed else 'NUMERICAL CRITERIA FAIL / NOT QUALIFIED')
    return {'status': status, 'qualification': 'NOT VERIFIED', 'qualified_basis': False,
            'proposal_sha256': PROPOSAL_SHA256, 'levels_nm': [100, 75, 50],
            'carrier_xyz_sha256': TARGET_XYZ_SHA256, 'currents_A': currents,
            'current': current, 'targets': targets, 'eta': eta,
            'field_and_current_criteria_pass': field_pass, 'numerical_criteria_pass': passed,
            'source_authentication': 'caller responsibility; numerical comparison only'}


def compare_junction_source_convergence(currents_A, fields_Apm, positions_m, *, etas=None):
    """Compare junction50/corner25/corner12p5 using the unchanged fixed criteria.

    Inputs are authenticated by the caller. This local-family label does not
    promote the independent global100/75/50 results or qualify a field basis.
    """
    result = compare_source_convergence(currents_A, fields_Apm, positions_m, etas=etas)
    return {**result,
            'proposal_sha256': 'c43eb7b0c56b9673590781cebb355ee8a7f579174b98f810c6f993594c6c5198',
            'levels_nm': [50, 25, 12.5],
            'refinement_family': 'local_junction50_corner25_corner12p5'}
