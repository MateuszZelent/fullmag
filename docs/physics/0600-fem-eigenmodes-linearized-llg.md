# 0600. FEM Eigenmodes from Linearized LLG

Status: MVP public reference path  
Applies to: `StudyIR::Eigenmodes`, `BackendPlanIR::FemEigen`, CPU reference runner

This note covers the `modal_eigen` study product only. Driven harmonic solves
belong to the separate `driven_response` product and use `(i omega B - A) q = b`
rather than the modal generalized eigensystem `A q = lambda B q`.

## Scope

This note defines the first executable FEM eigenmode workflow in Fullmag.
It is intentionally narrower than the long-term MFEM/SLEPc target:

- equilibrium state `m0` is taken from the provided initial state, a saved artifact, or an internal overdamped relaxation pass,
- the eigenproblem is solved on the merged FEM magnetic mesh,
- the current executable path exports spectrum, mode fields, and V2 dispersion artifacts,
- the solver is CPU reference quality, not the final production eigensolver.

The production target for large geometries is not the dense reference solver.
Large FEM eigenmode studies must be formulated as sparse frequency-window
queries: for example, "return up to 20 modes in 100 MHz..5 GHz".  The public
authoring contract must therefore preserve both the requested mode count and
the requested frequency interval in SI units.  The backend may use a wider
internal search interval for robustness, but artifacts and provenance must
report the user-requested window and the resolved numerical search policy.

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

The current dense/reference solver assembles:

- a consistent scalar mass matrix on the active FEM nodes,
- a projected scalar stiffness-like operator built from exchange plus the field component parallel to `m0`,
- a tangent-basis lift from reduced nodal amplitudes back to vector mode fields.

This is an MVP reference generalized eigenproblem:

`K u = lambda M u`

followed by a frequency mapping:

`omega = gamma * mu0 * max(lambda, 0)`

`f = omega / (2 pi)`

Fullmag's public `gamma` parameter is the internal LLG constant
`gamma0 = mu0 * gamma_SI` with units `rad s^-1 (A/m)^-1`, historically also
written as `m/(A s)`. Therefore frequency artifacts must report both constants:
`gamma0_rad_s_per_A_m = gamma0` and `gamma_rad_s_T = gamma0 / mu0`. The
frequency mapping above is equivalently `omega = gamma0 * max(lambda, 0)` when
`lambda` is an effective-field eigenvalue in `A/m`.

This real symmetric reference problem is not the production gyrotropic modal
contract for general frequency-domain FEM. It is valid only as a small
effective-field/reference lane for the explicitly documented MVP scope. The
production modal/eigenfrequency contract must use the tangent LLG convention
from `docs/physics/0700-frequency-domain-linearized-llg.md`:

```text
L q = lambda B_alpha q
lambda = i omega
```

or, for an energy-Hessian gyrotropic form with the canonical
`exp(i omega t)` phasor:

```text
K phi = -i omega G phi
G_t(p, q) = integral (mu0 * Ms / gamma0) * eta dot (m0 x xi) dV
```

The documentation must not promote a real pencil `K phi = omega G phi` unless
the operator has been explicitly transformed into a real Hamiltonian or
symplectic form and the transform, signs, norm, and eigenvalue-to-frequency
mapping are stated. Before SLEPc/shift-invert promotion, a 2-DOF macrospin test
without MFEM must prove:

- undamped sign and magnitude `omega = gamma0 * H0`,
- the positive-frequency branch,
- the conjugate partner,
- residual consistency for the selected pencil,
- damping sign and linewidth mapping when damping is included.

The small-reference implementation uses a dense symmetric reduction:

1. Cholesky factorization of `M`
2. transformed symmetric eigen solve
3. back-lift to generalized eigenvectors

This is appropriate for the small reference cases used to validate semantics
and artifacts, but it is not the scalable eigensolver architecture.  The
transitional runner may use sparse LOBPCG for real-valued problems above the
dense threshold, but LOBPCG remains a bridge.  The production FEM eigen backend
must use PETSc/SLEPc-style sparse or matrix-free eigensolvers with spectral
targeting:

- Krylov-Schur, Arnoldi, LOBPCG, Jacobi-Davidson, or equivalent EPS methods for
  exterior modes;
- shift-invert or Cayley spectral transformations for interior modes near a
  target frequency;
- FEAST / contour-integral style interval solvers for frequency-window queries
  when the user asks for modes in a band;
- PETSc/hypre/MFEM linear solves and preconditioners for shifted systems;
- matrix-free `y = A x` operator application whenever assembled matrices would
  dominate memory.

Dense diagonalization is allowed only as a reference/validation lane.  It must
not be marketed as the route for COMSOL-class large-object eigenmode studies.

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

- `eigen/spectrum.v2.json`
- `eigen/branches.v2.json` when branch tracking is available
- `eigen/dispersion.csv`
- `eigen/spectrum.json`
- `eigen/modes/mode_XXXX.json`
- `eigen/dispersion/branch_table.csv`
- `eigen/dispersion/path.json`
- `eigen/metadata/eigen_summary.json`
- `eigen/metadata/normalization.json`
- `eigen/metadata/equilibrium_source.json`

The V2 artifact contract is defined in
`docs/specs/frequency-domain-artifacts-v2.md`. These artifacts are consumed by
the Analyze UI and by the v2 API resources under
`/v2/sessions/current/analysis/eigen/*`.

Production-scale artifacts must additionally record the spectral search
contract:

- requested frequency window in Hz (`frequency_min_hz`, `frequency_max_hz`);
- requested mode cap (`count`);
- resolved eigensolver family (`krylov_schur`, `lobpcg`, `jacobi_davidson`,
  `feast`, `shift_invert`, or equivalent);
- spectral transform and shift/window actually used;
- linear solver and preconditioner used by shifted systems;
- residual tolerance, maximum iterations, converged mode count, and final
  residuals;
- whether modes outside the requested window were computed only as internal
  guard modes and filtered before publication.

## Production large-object solver requirement

For large structures, the correct user-level question is not "compute the first
N eigenvectors of the full dense operator".  It is:

```python
study.stages.add_eigenmodes(
    count=20,
    target="frequency_window",
    frequency_min=100e6,
    frequency_max=5e9,
    equilibrium_source="relax",
)
```

The SI contract is:

- `frequency_min` and `frequency_max` are in Hz;
- both bounds must be finite and positive;
- `frequency_min < frequency_max`;
- `count` is a maximum number of accepted modes returned from that window;
- if fewer modes exist in the interval, the solver returns fewer modes and
  reports `stop_reason="window_exhausted"`;
- if the iteration cap or tolerance stops the solve first, the solver reports a
  partial result with residual diagnostics instead of pretending success.

Dispersion validation should mirror the common experimental/theoretical workflow
instead of defaulting to an exhaustive sweep over every k direction. Production
acceptance must include narrow one-dimensional film sweeps in both standard
geometries:

- Damon-Eshbach (DE): in-plane `k` perpendicular to the equilibrium
  magnetization;
- backward-volume (BV): in-plane `k` parallel to the equilibrium magnetization.

The default validation range is `|k| <= 2e6..3e6 rad/m` (`2..3 1/um`) and a
low-frequency modal window such as `0..5e9 Hz`, unless the material/bias setup
requires a narrower window. Those sweeps must be compared with the applicable
analytic dispersion for the documented film thickness, saturation
magnetization, exchange, bias field, demag model, and boundary assumptions. The
existing higher-k exchange-only checks may remain as unit/sign stress tests, but
they are not a substitute for the DE/BV low-k acceptance sweeps.

This is the route to COMSOL-class behavior: sparse operators, spectral targeting,
preconditioned shifted solves, and clear diagnostics.  The UI must expose this
as a first-class eigenmode target, not as an advanced hidden backend knob.

## Live progress contract

Production eigensolve progress is solver progress, not time-step telemetry.
The control room should show:

- assembly phase and DOF count;
- requested frequency window and requested mode cap;
- resolved eigensolver and spectral transform;
- Krylov/FEAST outer iteration;
- shifted linear-solve iterations where applicable;
- residual norm and converged mode count;
- last checkpoint or last emitted artifact;
- clear dense-path warning when no internal iteration telemetry exists.

## Current limitations

- CPU reference path plus transitional sparse LOBPCG for selected real-valued
  cases; no production SLEPc/FEAST lane yet
- no residual / orthogonality / tangent leakage diagnostics exported yet
- production gyrotropic pencil and eigenvalue mapping are not closed until the
  macrospin and phasor-convention tests above pass
- nonzero-k Floquet demag is explicitly rejected until dynamic demag-k exists
- no native MFEM/libCEED/hypre/SLEPc eigen backend yet
- interactive preview snapshots are not supported for FEM eigen plans

## Acceptance expectations for this phase

The MVP is considered correct when:

- `Problem(..., study=fm.Eigenmodes(...))` lowers into `StudyIR::Eigenmodes`,
- FEM planning produces `BackendPlanIR::FemEigen`,
- the runner exports the eigen artifact family,
- Analyze can open spectrum, saved modes, and dispersion rows without reconstructing semantics from ad hoc UI logic,
- `KSamplingIR::Path` uses the same open/closed segment semantics in Python,
  ProblemIR validation, runtime expansion, and `eigen/dispersion.csv`: open
  paths have `len(points)-1` segments, closed paths have `len(points)` segments
  with the final segment returning to the first point, and both publish
  `sum(samples_per_segment)+1` samples,
- validation rejects mixing time outputs with eigen outputs.
