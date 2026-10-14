"""Independent primal-dual maximum-weight matching for tracking replay."""
import numpy as np

from comsol_n0_projection import _as_real_array


def maximum_weight_assignment(weights):
    """Match every row to a unique column; return columns and total weight.

    Supports rectangular matrices with at least as many columns as rows.
    Ascending column order provides deterministic handling of exact ties;
    consumers should verify optimum value rather than a tie-break identity.
    """
    if any(isinstance(value, (bool, np.bool_)) for value in np.asarray(weights, dtype=object).flat):
        raise ValueError("assignment weights must not contain booleans")
    matrix = _as_real_array(weights, name="assignment weights", ndim=2)
    rows, columns = matrix.shape
    if rows == 0 or columns < rows or np.any(matrix < 0) or np.any(matrix > 1):
        raise ValueError("assignment requires nonempty weights in [0, 1] and columns >= rows")
    # A per-row constant does not change the optimum. Negation avoids the
    # cancellation of tiny positive weights in the producer's 1-weight form.
    cost = -matrix
    row_potential = np.zeros(rows + 1)
    column_potential = np.zeros(columns + 1)
    matched_row = np.zeros(columns + 1, dtype=int)
    predecessor = np.zeros(columns + 1, dtype=int)
    for row in range(1, rows + 1):
        matched_row[0] = row
        column = 0
        slack = np.full(columns + 1, np.inf)
        visited = np.zeros(columns + 1, dtype=bool)
        while True:
            visited[column] = True
            active_row = matched_row[column]
            step, next_column = np.inf, 0
            for candidate in range(1, columns + 1):
                if visited[candidate]:
                    continue
                reduced = cost[active_row - 1, candidate - 1] - row_potential[active_row] - column_potential[candidate]
                if reduced < slack[candidate]:
                    slack[candidate] = reduced
                    predecessor[candidate] = column
                if slack[candidate] < step:
                    step, next_column = slack[candidate], candidate
            if not np.isfinite(step):
                raise ValueError("assignment has no finite augmenting path")
            for candidate in range(columns + 1):
                if visited[candidate]:
                    row_potential[matched_row[candidate]] += step
                    column_potential[candidate] -= step
                else:
                    slack[candidate] -= step
            column = next_column
            if matched_row[column] == 0:
                break
        while column:
            previous = predecessor[column]
            matched_row[column] = matched_row[previous]
            column = previous
    assignment = np.full(rows, -1, dtype=int)
    for column in range(1, columns + 1):
        if matched_row[column]:
            assignment[matched_row[column] - 1] = column - 1
    if np.any(assignment < 0):
        raise ValueError("assignment left an unmatched row")
    return assignment.tolist(), float(matrix[np.arange(rows), assignment].sum())
