# Mixed-mesh volume evidence tolerance design

**Status:** approved design, awaiting implementation

## Problem

The mixed prism/pyramid/tetrahedron certificate is produced in Python using
NumPy/LAPACK determinant evaluation and array reduction. Rust independently
recomputes the same evidence using direct scalar determinant arithmetic and a
sequential sum. For a valid 134,095-cell shared-domain mesh, both sides accept
the dimensional volumes but their near-zero derived
`shared_domain_relative_volume_error` values can differ by more than the generic
dimensionless absolute tolerance of `16 * f64::EPSILON`. Solver initialization
then rejects a valid certificate as stale.

## Decision

Keep the generic `dimensionless_float_close()` contract unchanged. Add a
dedicated comparison for the two derived certificate fields:

- `magnetic_relative_volume_error`;
- `shared_domain_relative_volume_error`.

The comparison retains relative tolerance `1e-12` and uses a dedicated absolute
tolerance of `4e-12`. This bound covers independent determinant/reduction
rounding after the underlying dimensional volumes have already passed their
strict comparisons. It remains far below the certificate's physical acceptance
limit of `1e-8` and therefore does not make an invalid volume partition valid.

No Python DSL, `ProblemIR` serialization, planner, runtime, OpenAPI, or UI
schema changes are required. Only Rust validation of recomputed certificate
evidence changes.

## Failure semantics

- Differences attributable to cross-language rounding near zero are accepted.
- A discrepancy of `1e-9` remains stale and is rejected.
- Dimensional volume, bounds, marker coverage, topology fingerprint,
  conformity, and quality validation remain unchanged.

## Verification

1. Add a Rust regression test that fails under the old generic tolerance for a
   near-zero derived-volume discrepancy.
2. Add a negative assertion proving a `1e-9` discrepancy remains rejected.
3. Run focused `fullmag-ir` tests through the repository container-backed
   `just` route.
4. Re-run the managed SP4 script with sequential projected-gradient and
   overdamped-LLG relaxation stages and confirm solver initialization passes the
   formerly failing materialized validation boundary.
