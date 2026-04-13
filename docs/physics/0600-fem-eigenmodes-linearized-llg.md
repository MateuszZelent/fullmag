# 0600. FEM Eigenmodes from Linearized LLG

Status: MVP public reference path  
Applies to: `StudyIR::Eigenmodes`, `BackendPlanIR::FemEigen`, CPU reference runner

## Scope

This note defines the first executable FEM eigenmode workflow in Fullmag.
It is intentionally narrower than the long-term MFEM/SLEPc target:

- equilibrium state `m0` is taken from the provided initial state, a saved artifact, or an internal overdamped relaxation pass,
- the eigenproblem is solved on the merged FEM magnetic mesh,
- the current executable path exports spectrum, mode fields, and a basic dispersion table,
- the solver is CPU reference quality, not the final production eigensolver.

## Physical model

We linearize magnetization dynamics around an equilibrium state `m0(r)` with `|m0| = 1`:

`m(r, t) = m0(r) + dm(r, t)`

with the tangent-space constraint:

`m0 . dm = 0`

For the MVP, Fullmag constructs a local tangent basis `(e1, e2)` at each active FEM node and represents perturbations in that reduced basis. This avoids the non-physical radial component that would appear in an unconstrained `3N` formulation.

The executable reference path currently retains the following field contributions:

- exchange
- demag
- zeeman / external field
- uniaxial anisotropy (first- and second-order)
- cubic anisotropy (first-order)
- interfacial DMI
- bulk DMI
- surface anisotropy (boundary-face mass term)

Spin torques and Bloch-periodic complex operators remain future work.

## Operator variants

Two operator formulations are available (selected via `EigenOperatorIR`):

### Scalar projected operator (`LinearizedLlg`)

The default and historically first path. The perturbation at each node is
represented by a single scalar amplitude in a local e1 tangent direction.
This yields an `N × N` generalized eigenproblem and is accurate when the
equilibrium is approximately uniform.

### Full 2×2 Herring–Kittel block operator (`Full2x2`)

The full tangent-plane formulation. At each node the perturbation is
represented by two scalar amplitudes `(u1, u2)` in the `(e1, e2)` tangent
basis, yielding a `2N × 2N` generalized eigenproblem. This correctly
captures cross-coupling between tangent-plane components and is required
for non-uniform equilibria (vortices, skyrmions, domain walls).

See `docs/physics/0600-fem-eigenmodes.md` for the block-matrix equations.

## Discrete operator

The current solver assembles:

- a consistent scalar mass matrix on the active FEM nodes,
- a projected scalar stiffness-like operator built from exchange plus the field component parallel to `m0`,
- a tangent-basis lift from reduced nodal amplitudes back to vector mode fields.

This is an MVP generalized eigenproblem:

`K u = lambda M u`

followed by a frequency mapping:

`omega = gamma * mu0 * max(lambda, 0)`

`f = omega / (2 pi)`

The implementation uses a dense symmetric reduction:

1. Cholesky factorization of `M`
2. transformed symmetric eigen solve
3. back-lift to generalized eigenvectors

This is appropriate for the small-to-medium reference cases used to validate semantics and artifacts, but it is not the final scalable eigensolver architecture.

## Equilibrium handling

`StudyIR::Eigenmodes.equilibrium` supports three sources:

- `provided`
- `artifact`
- `relaxed_initial_state`

For `relaxed_initial_state`, the current reference runner performs a short overdamped relaxation loop before assembling the operator. The number of relaxation steps is recorded in the exported metadata.

## Normalization and modal fields

The runner currently supports:

- `unit_l2`
- `unit_max_amplitude`

Mode artifacts export:

- `real`
- `imag`
- `amplitude`
- `phase`

The current circular polarization export is a tangent-basis reconstruction convenience for visualization. It should be treated as a reference visualization product contract, not yet as a full non-Hermitian modal analysis package.

## Artifact contract

The runner writes:

- `eigen/spectrum.json`
- `eigen/modes/mode_XXXX.json`
- `eigen/dispersion/branch_table.csv`
- `eigen/dispersion/path.json`
- `eigen/metadata/eigen_summary.json`
- `eigen/metadata/normalization.json`
- `eigen/metadata/equilibrium_source.json`

These artifacts are consumed by the Analyze UI and by the dedicated API endpoints under `/v1/live/current/eigen/*`.

## Current limitations

- CPU reference only (dense eigensolve, O(N³) scaling)
- no residual / orthogonality / tangent leakage diagnostics exported yet
- Floquet BC requires `k_sampling = Single{...}`; `Floquet + Path` not yet supported
- no native MFEM/libCEED/hypre/SLEPc eigen backend yet
- `mode_tracking` field is in IR but not yet used in the runner
- interactive preview snapshots are not supported for FEM eigen plans

## Acceptance expectations for this phase

The MVP is considered correct when:

- `Problem(..., study=fm.Eigenmodes(...))` lowers into `StudyIR::Eigenmodes`,
- FEM planning produces `BackendPlanIR::FemEigen`,
- the runner exports the eigen artifact family,
- Analyze can open spectrum, saved modes, and dispersion rows without reconstructing semantics from ad hoc UI logic,
- validation rejects mixing time outputs with eigen outputs.
