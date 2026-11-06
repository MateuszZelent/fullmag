"""Bounded GSG reference and global field checks for the approved experiment.

The existing RT0 reference is reused without changing its field kernel. The
caller authenticates prepared IR and retained current; no basis is qualified.
"""
from types import MappingProxyType
import struct

from antenna_triangle_surface_oracle import Budget, require

PROFILE_ID = 'gsg_source_convergence_reference_v1'
PROPOSAL_SHA256 = '7c61be489e0638d52bdec8324480fc24572c3ae8988fee77e8a9f8eb6c475c04'
SOURCE_IR_SHA256S = (
    '1744d3830a359e2d17e3cfb184900a6509233facc8773857c4ae8790c0da79b3',
    'ad466216dbbe93fb0de8260711c7466b8344299fe827fc2eb1c05e82b50ba39c',
    'c6f6087b311999218fa9d188d759bd3de767c428ab2eb38b1fcd30549b9cb785',
)
TARGETS_M = ((-2e-6, -50e-9, -22.4e-9), (0., -50e-9, -22.4e-9),
             (2e-6, -50e-9, -22.4e-9))
_TARGET_KEYS = frozenset(struct.pack('<3d', *target).hex() for target in TARGETS_M)
PROFILE_LIMITS = MappingProxyType({
    'pairs_target': 1000000, 'pairs_case': 5000000,
    'transc_target': 25000000, 'transc_case': 100000000,
    'predicates_target': 4000000, 'predicates_case': 20000000,
    'reference_test': 10000000, 'reference_case': 100000000,
    'reference_comparisons_test': 174, 'reference_comparisons_case': 9396,
    'seconds_target': 10800, 'seconds_case': 43200, 'ram_bytes': 2147483648,
})


class GsgSourceConvergenceBudget(Budget):
    """One lifetime budget shared across the three sources and three targets."""
    _source_sha256 = None

    @property
    def limits(self):
        return PROFILE_LIMITS

    def activate_source(self, problem_ir_sha256):
        require(isinstance(problem_ir_sha256, str) and problem_ir_sha256 in SOURCE_IR_SHA256S,
                'unregistered GSG source IR identity')
        self.guard()
        self._source_sha256 = problem_ir_sha256
        self.target = 'unset'

    def activate(self, target):
        require(self._source_sha256 is not None, 'GSG source must be activated first')
        require(isinstance(target, str) and target in _TARGET_KEYS,
                'unregistered GSG reference target')
        super().activate(self._source_sha256 + ':' + target)

    def charge(self, kind, precision=None):
        require(self.target != 'unset', 'activate GSG source and target before work')
        super().charge(kind, precision)

    def report(self):
        return dict(super().report(), limits=dict(self.limits), profile_id=PROFILE_ID,
                    proposal_sha256=PROPOSAL_SHA256,
                    source_ir_sha256s=list(SOURCE_IR_SHA256S),
                    target_keys=sorted(_TARGET_KEYS),
                    source_provenance_authentication='caller responsibility; not a budget claim')


def evaluate_retained_field(cells, target_m, expected_cells, budget, *, native_h_apm=None, progress=None):
    """Sum all supplied cells280 records with existing local/global precision gates.

    No solve or source authentication. The caller verifies the full source count
    and owner, uses one shared budget for all checks and preserves refusals.
    """
    import hashlib
    import json
    import math
    import antenna_triangle_surface_oracle as triangle
    from antenna_rt0_surface_oracle import evaluate_retained_rt0

    def vector(values):
        require(isinstance(values, (list, tuple)) and len(values) == 3 and
                all(type(v) in (int, float) and math.isfinite(v) for v in values), 'finite vector3 required')
        return tuple(float(v) for v in values)

    require(type(expected_cells) is int and 0 < expected_cells <= 72911, 'invalid full source cell count')
    require(isinstance(budget, Budget), 'explicit shared reference budget required')
    target = vector(target_m)
    native = None if native_h_apm is None else vector(native_h_apm)
    budget.activate(struct.pack('<3d', *target).hex())
    pair_start = budget.counts['pairs']
    arithmetic = triangle.Arithmetic(120, budget); ctx = arithmetic.ctx
    high_rows, middle_rows, whole_rows, precision_errors, formula_errors, local_norms = [], [], [], [], [], []
    chain = hashlib.sha256(); completed = 0; binary_high = 0
    for row in cells:
        require(completed < expected_cells, 'source cell count exceeds expected count')
        require(isinstance(row, (list, tuple)) and len(row) == 35 and
                type(row[0]) is int and row[0] == completed, 'source cell ordinal or shape differs')
        require(all(type(v) is int and 0 <= v < 2**64 for v in row[1:5]) and len(set(row[1:5])) == 4,
                'source cell vertex identity differs')
        require(all(type(v) in (float, int) and math.isfinite(v) for v in row[5:]), 'nonfinite source cell')
        value = evaluate_retained_rt0([row[5+3*i:8+3*i] for i in range(4)],
                                     [row[17+3*i:20+3*i] for i in range(4)], target, budget)
        high, middle = value['passes'][-1], value['passes'][1]
        high_rows.append(tuple(map(ctx.mpf, value['h_xyz_apm'])))
        middle_rows.append(tuple(map(ctx.mpf, middle['h_xyz_apm'])))
        whole_rows.append(tuple(map(ctx.mpf, high['whole_h_xyz_apm'])))
        precision_errors.append(ctx.mpf(value['local_precision_error_apm']))
        formula_errors.append(ctx.mpf(value['local_formula_error_apm']))
        local_norms.append(ctx.mpf(high['sum_local_norm_apm']))
        binary_high += bool(value['binary64_requires_highprecision']); completed += 1
        chain.update(json.dumps({'cell': row[0], 'high': high, 'middle': middle,
                                 'precision_error': value['local_precision_error_apm'],
                                 'formula_error': value['local_formula_error_apm']},
                                sort_keys=True, separators=(',', ':')).encode())
        if progress is not None and completed % 256 == 0:
            progress(completed, expected_cells)
    require(completed == expected_cells, 'source cell count is incomplete')
    require(budget.counts['pairs'] - pair_start == 12 * completed, 'source face/precision work count differs')
    total = lambda rows: tuple(ctx.fsum(row[k] for row in rows) for k in range(3))
    norm = lambda values: arithmetic.call('sqrt', ctx.fsum(v*v for v in values))
    difference = lambda a, b: norm(tuple(x-y for x, y in zip(a, b)))
    high, middle, whole = total(high_rows), total(middle_rows), total(whole_rows)
    magnitude = norm(high); gate = ctx.mpf('1e-6') * (1 + magnitude)
    p_error, f_error, norm_sum = map(ctx.fsum, (precision_errors, formula_errors, local_norms))
    cancellation = norm_sum / max(magnitude, ctx.mpf('1e-6'))
    require(p_error <= gate and difference(high, middle) <= gate, 'global precision budget exceeded')
    require(f_error <= gate and difference(high, whole) <= gate, 'global whole-face/fan budget exceeded')
    require(cancellation <= ctx.mpf('1e40'), 'global highprecision cancellation exceeded')
    comparison = None
    if native is not None:
        delta = difference(high, tuple(ctx.mpf(v) for v in native))
        comparison_gate = ctx.mpf('1e-3') * (1 + magnitude)
        comparison = {'absolute_difference_apm': ctx.nstr(delta, 120),
                      'gate_apm': ctx.nstr(comparison_gate, 120), 'within_gate': bool(delta <= comparison_gate)}
    budget.guard()
    if progress is not None and completed % 256:
        progress(completed, expected_cells)
    return {'status': 'MATHEMATICAL EVALUATION ONLY', 'qualification': 'NOT VERIFIED', 'qualified_basis': False,
            'unit': 'A/m', 'resolved_precision': '120digits', 'h_xyz_apm': [ctx.nstr(v, 120) for v in high],
            'cells_completed': completed, 'global_precision_error_apm': ctx.nstr(p_error, 120),
            'global_formula_error_apm': ctx.nstr(f_error, 120), 'precision_gate_apm': ctx.nstr(gate, 120),
            'global_cancellation': ctx.nstr(cancellation, 120), 'sum_local_norm_apm': ctx.nstr(norm_sum, 120),
            'binary64_requires_highprecision_cells': binary_high, 'cell_evidence_sha256': chain.hexdigest(),
            'native_comparison': comparison, 'source_authentication': 'caller responsibility; not a mathematical claim'}
