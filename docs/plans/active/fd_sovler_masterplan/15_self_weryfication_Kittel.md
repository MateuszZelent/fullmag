---
title: Independent Kittel postsolve verification contract
version: COMSOL-aligned v5.2 decision-complete
status: target validation contract with current implementation blockers
role: validation
---

# Independent Kittel postsolve verification contract

## 1. Purpose, authority and non-claim

The Kittel suite validates a solved FEM frequency-domain result. It does not
define the operator being tested. Physics and numerical semantics remain owned
by notes 0700, 0830 and 0831; K0 assembly and solve algorithms remain owned by
chapter 18; product promotion remains owned by chapters 09 and 24.

This chapter defines prospective gates. It does not claim that real
shared-domain K0-3 assembly, convergence, CPU/GPU parity or production
qualification has completed. Existing narrow no-demag and synthetic evidence
retains only its independently established scope.

The central independence rule is absolute:

```text
solve first -> freeze raw artifacts -> select branch without Kittel values
-> compute expected Kittel values and fitted M_eff -> compare -> report
```

The expected Kittel frequency and fitted `M_eff` are verifier outputs only.
The fixture-owned `M_eff_reference` is a verifier input with independent
provenance, loaded only after the raw branch is selected and frozen. All three
are forbidden from assembly, request target/window construction,
preconditioning, mode selection, solver convergence, solver certificate and
solver pass/fail paths. A Kittel-specific `demag_delta` is also forbidden from
those paths. Physical material `Ms` remains a legitimate assembly input; a
Kittel reference or fitted `M_eff` is not a substitute for it.

## 2. Current blockers and required runtime removal

The current repository violates the target independence contract. These are
active blockers, not accepted validation evidence.

| Current contamination | Why it invalidates independent Kittel validation | Required runtime removal work |
|---|---|---|
| `crates/fullmag-runner/src/fem_eigen.rs::build_pa_e4b_k0_kittel_poisson_airbox_payload` reads validation `effective_magnetisation`, computes `demag_delta=gyromagnetic_ratio*M_eff`, and uses it in `A_qphi`. | The analytical Kittel parameter constructs the operator under test. | Delete the Kittel/macrocell production payload builder from real execution. Assemble `A_qphi`, `A_phiq` and `P` from the shared-domain MFEM weak forms, physical `Ms`, mesh, BC and accepted equilibrium only. Keep synthetic builders explicitly algebra-only. |
| The same builder computes `expected_reference_frequency_hz` and assigns it to both `target_frequency_hz` and `expected_reference_frequency_hz`. | The expected answer determines where the solver searches. | Build the spectral target/window only from the user-authored modal request frozen before verifier execution. Remove expected Kittel values from runner-to-native solve requests. |
| `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` configures `EPS_TARGET_MAGNITUDE` from that target and retains the accepted positive mode with the smallest target distance. | Because the current target is the analytical answer, this is nearest expected frequency selection inside the solver. | Return the complete requested finite mode set/window. Move shape-first branch selection to the postsolve selector and keep user-authored target proximity only as a generic window policy, never as Kittel branch evidence. |
| `native/include/fullmag_fem.h`, `ModalEigenRequest`, the Rust native bridge and `PoissonAirboxEigenBlockProblem` carry `poisson_airbox_expected_reference_frequency_hz` or equivalent fields. | An analytical answer remains available to assembly and solver code even if a caller intends postsolve-only use. | Remove the field from the solve ABI/request/problem/result path in a versioned ABI change. Put expected values only in the postsolve validation artifact schema. |
| `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp` validates the expected value, computes `reference_frequency_certified`, and fails the solver with `poisson_airbox_eigen_dense_reference_mismatch`. | Kittel/dense-reference agreement participates in solver certificate and pass/fail. | Solver success must depend only on legality, convergence, finite-mode/window completeness and reconstructed original residuals. Move reference comparison and its failure class into the independent verifier. |
| Current Kittel artifact verification chooses the complete branch with the smallest error against the expected Kittel formula. | The analytical answer selects the reported branch, so comparison is circular even though it occurs in a script. | Select and freeze the branch by mode shape, continuity and numerical quality first. Compute expected frequencies and fit `M_eff` only for that frozen branch. |
| Current Kittel metadata/verifier accepts a three-field sweep, and the periodic-airbox convergence validator accepts any nonempty table then checks only its best error. | The current gate does not establish 15-field extended coverage, independent three-level mesh/padding convergence, uniqueness, monotonicity/asymptotics, observed order or a finest-two budget. | Introduce the v2 artifacts in section 10, enforce distinct raw run signatures, at least 15 positive fields for extended validation, and separate three-level mesh and `airbox.padding` sequences with section 9 acceptance. |
| GPU Poisson-airbox diagnostics compute relative reference-frequency error from the expected field carried in the problem. | GPU diagnostics preserve the same forbidden solver-side dependency. | Remove the expected value from GPU problem state and diagnostics. Compare CPU/GPU solved outputs first; run Kittel comparison only in the common postsolve verifier. |

Removal is complete only when a data-flow audit proves that changing, deleting
or corrupting Kittel verifier metadata changes no assembled block, operator
signature, target/window, selected raw mode set, solver certificate, native
status or solver pass/fail outcome. The postsolve validation artifact may
change, which is the intended boundary.

## 3. Validation families

| Case | Physical fixture | Primary purpose | Eligible promotion |
|---|---|---|---|
| K0-1 | Uniform magnet, positive in-plane bias, no demag, no anisotropy, no damping | `gamma0`, Hz/rad/s, `lambda=i*omega`, positive branch, uniform mode | Bounded K0 no-demag modal cell only |
| K0-2 | Uniform magnet with one independently specified local stiffness term, no dynamic demag | Static effective-field and local Hessian contribution | Exact local-interaction K0 modal cell only |
| K0-3 | Real thin film with x/y PBC, open z, symmetric top/bottom airbox and numeric shared-domain dynamic demag | Demag sign/scale, Poisson-airbox coupling, truncation and Kittel behavior | Exact K0 periodic-airbox modal cell after all gates |

K0-1 and K0-2 cannot substitute for K0-3. A synthetic demag factor may be an
algebra oracle but cannot satisfy K0-3 or carry a production periodic-airbox
claim.

## 4. K0-3 fixture constraints and canonical scope binding

Each production candidate records the following immutable K0-3 constraints:

```text
study_product = modal_eigen
discretization = fem
k_vector_rad_per_m = [0,0,0]
periodicity = [x,y]
open_direction = z
airbox.padding.top_m = airbox.padding.bottom_m
airbox lateral periodicity = identical to magnetic cell
dynamic_demag = periodic_airbox_k0
assembly_kind = mfem_weak_form_shared_domain
magnetic FE = tangent P1
potential FE = scalar P1 on magnetic-plus-air domain
precision = double
initial damping policy = alpha=0
equilibrium = accepted relaxed state for every positive bias
```

The top and bottom airbox regions use the same material policy, mesh policy,
outer-boundary family and padding distance. The lateral x/y cuts are periodic;
Robin or Dirichlet truncation belongs only on the open-z exterior. Pure
Neumann uses the documented mean-zero augmentation. A fully periodic z
direction is not K0-3.

This list is only a human-readable fixture summary. The fixture instantiates
the closed, typed `frequency_domain_validation_scope.v1` object from Chapter
24, including its mandatory `SolverScope` tolerances, iteration/restart,
linear-solver family, preconditioner object, transform/target representation,
residency, precision, block-residual contract and typed certificate
references. The complete object also binds physics, problem, runtime, device,
material, geometry, fixture and oracle fields. Chapter 24 canonicalizes that
object and recomputes its `scope_id`; any hash-input change creates another
readiness cell.

The fixture also records geometry dimensions, material constants, physical
`Ms`, `gamma`/`gamma0`, bias direction, equilibrium signatures, BC/gauge tuple,
mesh generator/version, FE order, quadrature, solver request, target/window,
device, engine and all artifact hashes. The fixture publishes an external
content-addressed Chapter 24 `scope_catalog.v1` and records its
`scope_catalog_uri` plus `scope_catalog_sha256`; that catalog contains every
canonical scope object named by its solver, postsolve, convergence and summary
artifacts. An aggregate or convergence artifact that covers multiple canonical
cells uses Chapter 24's typed `coverage_rule.v1`, including the subject and
covered scope IDs resolved from that catalog and one unambiguous field
predicate for every canonical comparison address. It never invents a shorter
local scope or covers a target broader than its evaluated subject.

## 5. Field sweep

Extended validation uses at least 15 field values with strictly positive bias.
The fields must span the declared stable uniform-equilibrium interval and must
not be chosen after inspecting solved resonance errors. Linear, logarithmic or
hybrid spacing is allowed when the spacing rule, endpoints and units are fixed
in the fixture before solving.

Every production mesh and airbox-padding sequence uses the same field set.
Each field has its own accepted equilibrium or an accepted continuation whose
provenance proves the correct field value and signatures.

A fast CI gate may use a documented subset of at least three positive-bias
fields. Its artifact records `coverage=fast_ci_subset`, the parent extended
fixture ID, omitted field indices and the direct `scope_id` of its own narrower
`frequency_domain_validation_scope.v1` object resolved through the same
`scope_catalog.v1` contract. It may record the parent scope ID as non-binding
provenance, but it must not use a coverage binding whose
`coverage_rule.v1` names that broader parent as a covered scope: Chapter 24's
comparator direction rejects that promotion. Fast CI can detect regressions but
cannot satisfy analytical validation, convergence or `production_qualified`.

A near-zero field is optional. If present, it has a separately declared
zero-mode/degeneracy policy and is excluded from relative-error denominators
when that denominator is ill-conditioned. It cannot replace any positive-bias
gate and cannot reduce the required 15 field count.

## 6. Solver-side protocol

Before any Kittel value is computed:

1. build and accept the equilibrium, mesh and periodic certificates;
2. assemble from physical inputs only and freeze block/operator signatures;
3. execute the user-authored broad positive-frequency window or mode-count
   request; the request must not be derived from Kittel expectations;
4. classify finite positive-branch modes and reconstruct full fields;
5. compute original `eps_q`, `eps_phi`, `eps_gauge` and `eps_full`;
6. export every admitted candidate mode needed for independent branch
   selection, including mode fields and overlap inputs; and
7. close the solver artifact with native status based only on legality,
   convergence, completeness and residual certification.

The closed solver artifact contains no expected Kittel frequency, fitted
`M_eff`, Kittel relative error, `reference_frequency_certified`, or Kittel
pass/fail status. Those fields exist only in validation outputs linked to the
immutable solver artifact.

## 7. Independent mode and branch selection

Mode selection never minimizes distance to an expected Kittel frequency. It
uses the following ordered evidence:

1. **eligibility:** finite positive-frequency branch, accepted original full
   residual, accepted tangent leakage and accepted periodic seam mismatch;
2. **uniform overlap:** mass-weighted overlap with the uniform Cartesian
   transverse subspace, evaluated from exported mode fields;
3. **branch continuity:** mass-inner-product overlap or cluster subspace
   overlap with the previously selected field point;
4. **numerical quality:** lower original residual, tangent leakage and seam
   mismatch; and
5. **deterministic tie-break:** stable raw mode key, never expected frequency.

At the first positive field, select the eligible mode/cluster with maximum
uniform overlap. At later fields, use overlap-based Hungarian/cluster matching
from the previous selected subspace, then uniform overlap and numerical
quality. Frequency continuity may reject an unphysical jump using only prior
solved points and a documented local predictor; no Kittel formula or fitted
parameter may enter that predictor.

Initial selection thresholds are:

```text
uniform_overlap >= 0.85
branch_overlap_previous >= 0.70 for non-seed points
eps_full <= 1e-6
tangent_leakage_max_abs <= 1e-6
periodic_seam_mismatch_max_abs <= 1e-6
```

Production thresholds are:

```text
uniform_overlap >= 0.95
branch_overlap_previous >= 0.85 for non-seed points
eps_full <= 1e-8
tangent_leakage_max_abs <= 1e-8
periodic_seam_mismatch_max_abs <= 1e-8
```

Degenerate or near-degenerate modes are tracked as invariant subspaces; an
arbitrary eigenvector basis inside the cluster is not a branch failure.
Selection artifacts publish all eligible candidates and scores so the chosen
branch can be reproduced without analytical values.

## 8. Postsolve Kittel evaluation

Only after the selected branch and solver artifacts are immutable does the
verifier load `M_eff_reference` and evaluate:

```text
K0-1: f_expected(H) = gamma0 H / (2*pi)

K0-3 in-plane thin-film form:
f_expected(H) = gamma0 sqrt((H+H_k1)(H+H_k2+M_eff_reference)) / (2*pi)
```

`M_eff_reference` is owned by the immutable validation fixture, not by the
solver request or production material object. Its provenance record is frozen
before solving and contains:

```text
reference_id and oracle_id
source kind, URI/version and content sha256
derivation identifier and exact formula
independently measured or published SI inputs and their uncertainties
M_eff_reference_A_per_m and standard_uncertainty_A_per_m
fixture_id, fixture_sha256 and applicable bounded material/geometry range
```

The reference may use independently specified fixture quantities such as
`Ms_reference-Hk_perp_reference`; it must not be inferred from solved
frequencies, selected modes, assembled matrices, mesh/truncation results or a
fit to the artifact under test. The physical `Ms` supplied to assembly remains
a separate physics input even when both values trace to the same independently
versioned material characterization. The reference record is available only to
the postsolve verifier and is included in the canonical `oracle_ids`; changing
it changes `scope_id`.

The exact admitted analytical form, anisotropy fields, units and validity
limits are recorded by the validation fixture. The verifier emits expected
frequency rows; the solver does not consume them.

The verifier fits `M_eff` from the frozen solved branch using the fixture-fixed
model, field indices, weights and parameter bounds. It reports estimate,
standard uncertainty, confidence interval, covariance, rank, dimensionless
scaled-Jacobian condition number, residuals and included field indices. Fitted
`M_eff` is a verifier output only. It cannot be written back into material
input, reused as a Kittel demag delta, or used to rerun, retarget, reselect or
retroactively certify the solver.

The primary agreement metric is

```text
fitted_M_eff_relative_error =
  abs(fitted_M_eff_A_per_m - M_eff_reference_A_per_m) /
  abs(M_eff_reference_A_per_m)
```

`M_eff_reference_A_per_m` must be finite, nonzero and inside the fixture's
predeclared physical range. Initial acceptance requires
`fitted_M_eff_relative_error<=2e-2`; production requires `<=5e-3`. These are
the existing 2% initial and 0.5% production K0-3 fit limits and remain separate
from the frequency, mesh and airbox-truncation budgets.

The fit is rejected, irrespective of agreement, when the scaled Jacobian is
rank deficient, the covariance/uncertainty is absent or non-finite, a fitted
parameter is pinned to an undeclared bound, or the fit uses fewer than the
fixture-declared positive-field indices. It is also rejected when either staged
diagnostic exceeds its limit:

| Fit diagnostic | Initial | Production |
|---|---:|---:|
| `fitted_M_eff_standard_uncertainty / abs(M_eff_reference)` | `1e-2` | `2.5e-3` |
| dimensionless scaled-Jacobian condition number | `1e8` | `1e6` |

Parameter scaling and weights are fixture-fixed before solving and are emitted
with the fit, so conditioning cannot be improved post hoc by rescaling or
dropping inconvenient fields.

The postsolve verifier executes in this order:

1. recompute the canonical `scope_id` and validate the immutable solver hashes;
2. reproduce and freeze `selection.v2.json` without loading expected
   frequencies or `M_eff_reference`;
3. load and validate the fixture-owned reference and oracle provenance;
4. evaluate expected-frequency rows for the already selected branch;
5. fit `M_eff` using only the predeclared model, fields, weights, scaling and
   bounds;
6. reject rank, covariance, uncertainty, conditioning, bound or field-coverage
   failures before evaluating agreement;
7. evaluate frequency, fitted-`M_eff`, mesh and truncation thresholds; and
8. emit validation outcomes without modifying the request, selection, solver
   artifact or solver certificate.

For K0-3, compare both the prescribed analytical reference and the fitted
curve. A good fit alone cannot pass if the fitted value is physically wrong;
agreement with a prescribed value alone cannot pass if residuals show the
wrong field dependence.

Initial analytical tolerance is maximum relative frequency error `<=5e-2` and
median `<=2e-2`. Production tolerance is maximum `<=2e-2` and median `<=1e-2`.
The fit must have finite uncertainty, no excluded solved point unless the
fixture declared the exclusion before solving, and no single point may control
the fit undiagnosed.

## 9. Mesh and airbox convergence

Production K0-3 requires two independent sequences over the same positive
field set:

1. **mesh sequence:** minimum three mesh levels, fixed magnetic geometry,
   fixed symmetric top/bottom airbox padding and fixed BC/gauge policy;
2. **truncation sequence:** minimum three `airbox.padding` levels at one fixed
   magnetic mesh, with equal top/bottom padding at every level.

Changing mesh and padding in the same row does not satisfy either independent
sequence. The fixed mesh used for the padding sequence is the finest or a
separately justified production-candidate magnetic mesh. The fixed padding
used for the mesh sequence is the largest or a separately justified
production-candidate padding.

Every row is a distinct runtime solve with a distinct problem signature. Raw
rows include all 15 or more extended-validation fields. Duplicating one result,
copying analytical values into solved columns, or emitting repeated synthetic
rows fails the suite.

For each selected field and for aggregate fitted `M_eff`, report:

```text
raw level values
monotonicity classification
asymptotic-fit model and fit residual when used
observed_order when applicable
Richardson extrapolation when stable
finest_two_relative_delta
estimated_mesh_error
estimated_truncation_error
```

P1 expected-order checks use the directly measured quantity and norm; no
frequency observed-order claim is required when the model does not justify a
single order. In that case an accepted asymptotic fit and finest-two delta are
mandatory.

Acceptance budgets are separate:

| Budget | Initial | Production |
|---|---:|---:|
| Maximum finest-two mesh delta over positive fields | `2e-2` | `1e-2` |
| Maximum finest-two airbox-truncation delta | `2e-2` | `5e-3` |
| Aggregate fitted `M_eff` mesh delta | `2e-2` | `1e-2` |
| Aggregate fitted `M_eff` truncation delta | `2e-2` | `5e-3` |
| Maximum postsolve Kittel frequency error | `5e-2` | `2e-2` |
| Fitted `M_eff` relative error against fixture reference | `2e-2` | `5e-3` |
| Fitted `M_eff` relative standard uncertainty | `1e-2` | `2.5e-3` |
| Fitted `M_eff` scaled-Jacobian condition number | `1e8` | `1e6` |
| Poisson original constraint residual | `1e-6` | `1e-8` |

If the last three levels are not monotone, the verifier must demonstrate a
resolved asymptotic fit with a declared residual below one quarter of the
applicable budget. Otherwise the convergence gate fails; selecting only the
best row is forbidden.

## 10. Required artifacts

### 10.1 Immutable solver artifacts

```text
frequency_domain/manifest.v1.json
eigen/diagnostics/solver.v1.json
eigen/spectrum.v2.json
eigen/branches.v2.json
eigen/modes/sample_XXXX/mode_YYYY.json
eigen/mode_fields.zarr/
mesh/periodic_pairs.v1.json
```

They contain requested/resolved execution, equilibrium and mesh signatures,
BC/gauge, assembly kind, block/operator signatures, target/window provenance,
candidate modes, original residuals and mode fields. They contain no Kittel
expected values or Kittel pass/fail decision.

### 10.2 Postsolve validation artifacts

```text
validation/kittel_k0_pbc/selection.v2.json
validation/kittel_k0_pbc/points.v2.csv
validation/kittel_k0_pbc/points.v2.csv.validation_manifest.v1.json
validation/kittel_k0_pbc/mesh_convergence.v2.csv
validation/kittel_k0_pbc/mesh_convergence.v2.csv.validation_manifest.v1.json
validation/kittel_k0_pbc/airbox_convergence.v2.csv
validation/kittel_k0_pbc/airbox_convergence.v2.csv.validation_manifest.v1.json
validation/kittel_k0_pbc/fit.v2.json
validation/kittel_k0_pbc/summary.v2.json
validation/kittel_k0_pbc/independence_audit.v1.json
```

The three CSV artifacts require the listed
`validation_artifact_manifest.v1` sidecars. Each sidecar names the CSV
`artifact_uri`, CSV `artifact_sha256`, `artifact_kind=csv`, the table schema
and the same direct or coverage `validation_scope_binding.v1` that a JSON
object would carry at top level. The sidecar is immutable evidence and is
validated before any CSV row is consumed.

Every JSON-object immutable solver artifact and postsolve validation artifact
above carries a mandatory top-level `verified_coverage_of` field whose value is
one `validation_scope_binding.v1` object from Chapter 24:

```text
verified_coverage_of:
  schema: validation_scope_binding.v1
  scope_schema: frequency_domain_validation_scope.v1
  scope_catalog_uri: validation/scopes/scope_catalog.v1.json
  scope_catalog_sha256: Sha256Id
  exactly one closed variant:
    kind: direct
    scope_id: Sha256Id
  or:
    kind: coverage
    coverage_rule:
      schema: coverage_rule.v1
      relation: exact | subset
      subject_scope_id: Sha256Id
      covered_scope_ids: non-empty ordered unique Sha256Id array
      field_predicates: complete Chapter 24 FieldPredicate array
```

`scope_catalog_uri` and `scope_catalog_sha256` are mandatory in both binding
variants; an embedded catalog is not a valid alternative. Exactly one binding
variant is legal. The coverage variant is reserved for a multi-level
convergence or CPU/GPU aggregate whose evaluated subject contains every covered
target after the catalog digest and every referenced `scope_id` are verified. A
subject narrower in fields, mesh/padding interval, device, precision, solver
configuration or any other canonical dimension cannot cover the broader target.
`validated_scope_id`, fixture names, run directories, abbreviated K0-3 tuples,
bare `validated_scope` claims, standalone scope hashes and prose assertions of
exact scope are not accepted aliases.

`selection.v2.json` contains candidate scores and the frozen selected branch
without expected frequencies. `points.v2.csv` may add expected frequencies and
relative errors only after selection and only when its sidecar manifest has
validated the CSV hash and direct scope binding. The two convergence CSV files
are separate, contain raw unique run IDs and signatures, and carry their
aggregate coverage binding only through their required sidecar manifests.

Each convergence row contains at least:

```text
run_id, solver_artifact_sha256, solver_artifact_scope_id
field_index, H0_A_per_m
mesh_level, magnetic_h_m, magnetic_dof_count
airbox_padding_top_m, airbox_padding_bottom_m, phi_dof_count
selected_raw_mode_index, selected_branch_id
frequency_hz, eps_q, eps_phi, eps_gauge, eps_full
uniform_overlap, branch_overlap_previous
tangent_leakage_max_abs, periodic_seam_mismatch_max_abs
```

`solver_artifact_scope_id` must equal the direct
`verified_coverage_of.scope_id` in the immutable solver artifact named by
`solver_artifact_sha256`. A convergence CSV may be an aggregate whose
sidecar manifest uses a coverage binding, but it cannot replace any raw solve
row's direct binding with a bare scope ID or coverage-rule hash.

Verifier-enriched rows additionally contain `expected_frequency_hz`,
`relative_frequency_error` and the fit membership flag. `fit.v2.json` contains
the complete `M_eff_reference` provenance, fit model/weights/scaling, fitted
value, `fitted_M_eff_relative_error`, uncertainty/confidence interval,
covariance/rank/condition number and all rejection reasons. Summary artifacts
publish the complete `verified_coverage_of` binding, fixture/oracle/reference
IDs and hashes, initial/production tolerance
sets, raw row counts, distinct signature
counts, field coverage, observed orders/fits, finest-two deltas, separate
frequency and fitted-`M_eff` mesh/truncation budgets, fit conditioning and
uncertainty outcomes, and final gate outcomes.

`fit.v2.json` and `summary.v2.json` expose these exact fit fields:

```text
M_eff_reference_A_per_m
M_eff_reference_standard_uncertainty_A_per_m
M_eff_reference_id
M_eff_reference_oracle_id
M_eff_reference_source_sha256
fitted_M_eff_A_per_m
fitted_M_eff_standard_uncertainty_A_per_m
fitted_M_eff_relative_error
fitted_M_eff_scaled_jacobian_condition_number
fitted_M_eff_covariance_rank
fitted_M_eff_initial_threshold
fitted_M_eff_production_threshold
fitted_M_eff_uncertainty_initial_threshold
fitted_M_eff_uncertainty_production_threshold
fitted_M_eff_condition_initial_threshold
fitted_M_eff_condition_production_threshold
fitted_M_eff_agreement_outcome
fitted_M_eff_uncertainty_outcome
fitted_M_eff_conditioning_outcome
```

## 11. CPU/GPU parity and residency

GPU Kittel qualification starts only after the exact CPU K0-3 scope is
production-qualified. CPU and GPU consume byte-identical physical inputs and
equivalent assembled operator signatures. They compare the branch selected by
the same shape-first protocol, not by expected frequency.

Production double-precision tolerances are:

```text
frequency cluster relative delta <= 1e-8
invariant-subspace sine <= 1e-8
complex reconstructed-field relative delta <= 1e-7
original eps_full <= 1e-8 on both devices
accepted/rejected outcome mismatches = 0
```

The GPU artifact must identify `gpu_modal_device_krylov`, keep operator,
preconditioner, vectors, Krylov basis and hot-loop state on device, and report:

```text
per_iteration_h2d_transfer_count = 0
per_iteration_d2h_transfer_count = 0
hidden_host_solve_count = 0
```

Setup uploads, bounded scalar reductions and final exports are counted and
declared. A dense K0 macrospin solve, descriptor apply probe, shifted-action
probe or host-Krylov GPU operator path cannot satisfy GPU K0-3 residency.

## 12. Gate outcomes and promotion

The verifier emits independent outcomes for:

```text
solver_artifact_integrity
analytical_input_isolation
shape_first_branch_selection
positive_bias_field_coverage
mesh_convergence
airbox_truncation_convergence
kittel_frequency_agreement
fitted_M_eff_agreement
fitted_M_eff_uncertainty
fitted_M_eff_conditioning
cpu_gpu_parity when applicable
gpu_residency when applicable
```

`production_qualified` is legal only when every applicable outcome is `pass`,
the promotion record's `validated_scope` passes the closed v1 schema and hash
check, every JSON-object artifact has an accepted top-level
`verified_coverage_of` direct or typed coverage binding, every CSV/non-object
artifact has an accepted `validation_artifact_manifest.v1` sidecar, all
bindings resolve through a verified external `scope_catalog.v1`, and
chapter 24 is complete for the same immutable evidence bundle. `fast_ci_subset`, synthetic demag,
absent raw levels, mixed mesh/padding variation, solver-side expected values,
ill-conditioned/uncertain fits, or analytical-value-based branch selection cap
the result below production.

The current contamination listed in section 2 blocks K0-3 production
qualification until the specified runtime removal work is implemented and an
independence audit passes. This documentation change does not remove that
runtime blocker.
