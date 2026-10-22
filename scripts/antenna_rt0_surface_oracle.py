"""Independent retained-RT0 reconstruction for the surface-field reference.

Implements the existing 0950 centered scalar-slope fit, not a charge solver,
triangle integrator, scientific receipt, or qualification of any backend.
"""
from decimal import Context, Decimal, DivisionByZero, InvalidOperation, Overflow, ROUND_HALF_EVEN, localcontext
from fractions import Fraction
import itertools
import math


def _rows(values, name):
    if not isinstance(values, (tuple, list)) or len(values) != 4:
        raise ValueError(f'{name} must have four vector3 rows')
    result = []
    for row in values:
        if not isinstance(row, (tuple, list)) or len(row) != 3:
            raise ValueError(f'{name} must have four vector3 rows')
        if any(type(x) not in (int, float) for x in row):
            raise ValueError(f'{name} requires finite binary64 values')
        try:
            row = tuple(float(x) for x in row)
        except OverflowError as error:
            raise ValueError(f'{name} requires finite binary64 values') from error
        if not all(math.isfinite(x) for x in row):
            raise ValueError(f'{name} requires finite binary64 values')
        result.append(row)
    return tuple(result)


def _positive_tetrahedron(vertices):
    points = [tuple(Fraction.from_float(x) for x in p) for p in vertices]
    a, b, c = [tuple(p[k]-points[0][k] for k in range(3)) for p in points[1:]]
    determinant = (a[0]*(b[1]*c[2]-b[2]*c[1])
                   -a[1]*(b[0]*c[2]-b[2]*c[0])
                   +a[2]*(b[0]*c[1]-b[1]*c[0]))
    if determinant <= 0:
        raise ValueError('retained geometry must be a positive tetrahedron')


def _householder(matrix, rhs, total, norm):
    """Own 12x4 QR; never form normal equations or use the native fitter."""
    for column in range(4):
        vector = [row[column] for row in matrix[column:]]
        length = norm(vector)
        if length == 0:
            raise ValueError('RT0 reference fit has rank below four')
        vector[0] += length if vector[0] >= 0 else -length
        length = norm(vector)
        vector = [x/length for x in vector]
        for j in range(column, 4):
            projection = 2*total(v*matrix[i][j] for i, v in enumerate(vector, column))
            for i, v in enumerate(vector, column):
                matrix[i][j] -= projection*v
        projection = 2*total(v*rhs[i] for i, v in enumerate(vector, column))
        for i, v in enumerate(vector, column):
            rhs[i] -= projection*v
    solution = [rhs[0]*0]*4
    for i in range(3, -1, -1):
        if matrix[i][i] == 0:
            raise ValueError('RT0 reference fit has rank below four')
        solution[i] = (rhs[i]-total(matrix[i][j]*solution[j] for j in range(i+1, 4)))/matrix[i][i]
    return solution


def _fit(vertices, current, high_precision):
    cast = Decimal.from_float if high_precision else float
    total = sum if high_precision else math.fsum
    norm = (lambda v: total(x*x for x in v).sqrt()) if high_precision else (lambda v: math.hypot(*v))
    finite = (lambda x: x.is_finite()) if high_precision else math.isfinite
    zero, one = cast(0.), cast(1.)
    points = [tuple(map(cast, p)) for p in vertices]
    field = [tuple(map(cast, j)) for j in current]
    center = tuple(total(p[k]/4 for p in points) for k in range(3))
    length = max(norm(tuple(b[k]-a[k] for k in range(3)))
                 for a, b in itertools.combinations(points, 2))
    if not finite(length) or length <= zero:
        raise ValueError('RT0 geometry scale is outside the arithmetic range')
    xi = [tuple((p[k]-center[k])/length for k in range(3)) for p in points]
    if not all(finite(x) for p in xi for x in p):
        raise ValueError('RT0 centered geometry is outside the arithmetic range')
    scale = max(abs(j) for p in field for j in p) or one
    matrix = [[one if axis == k else zero for k in range(3)] + [p[axis]]
              for p in xi for axis in range(3)]
    rhs = [j/scale for p in field for j in p]
    coefficients = [x*scale for x in _householder(matrix, rhs, total, norm)]
    alpha, beta = tuple(coefficients[:3]), coefficients[3]
    residual = max(norm(tuple(j[k]-total((alpha[k], beta*p[k])) for k in range(3)))
                   for j, p in zip(field, xi))
    magnitude = max(*(norm(j) for j in field), norm(alpha), abs(beta))
    limit = cast(256.)*cast(2.**-52)*magnitude
    if not all(finite(x) for x in (*center, *alpha, beta, residual, limit)):
        raise ValueError('RT0 fit is outside the arithmetic range')
    if residual > limit:
        raise ValueError('retained current violates the scalar RT0 residual gate')
    return {'center_m': center, 'length_m': length, 'alpha_apm2': alpha,
            'beta_apm2': beta, 'maximum_residual_apm2': residual,
            'residual_limit_apm2': limit}


def fit_retained_rt0(vertices_m, vertex_current_apm2):
    """Fit one positive Tet4's unchanged four local J traces in both precisions.

    Returns binary64 and Decimal120 centered coefficients and diagnostics.
    Both residual gates use binary64 epsilon, without an absolute current floor.
    IDs, bundle validation and source provenance remain the caller's contract.
    """
    vertices = _rows(vertices_m, 'vertices_m')
    current = _rows(vertex_current_apm2, 'vertex_current_apm2')
    _positive_tetrahedron(vertices)
    try:
        binary = _fit(vertices, current, False)
        context = Context(prec=120, rounding=ROUND_HALF_EVEN, Emin=-999999,
                          Emax=999999, capitals=1, clamp=0, flags=[],
                          traps=[InvalidOperation, DivisionByZero, Overflow])
        with localcontext(context):
            decimal = _fit(vertices, current, True)
    except ArithmeticError as error:
        raise ValueError('RT0 arithmetic range is unresolved') from error
    return {'binary64': binary, 'decimal120': decimal}
