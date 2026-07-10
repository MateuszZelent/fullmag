---
title: FEM frequency-domain validation, certification and benchmark gates
version: COMSOL-aligned v5.2 decision-complete
status: normative validation contract; no capability promotion implied
role: validation
---

# Validation, certification and benchmark gates

## 1. Scope and promotion rule

This chapter defines independent acceptance gates for FEM frequency-domain
`modal_eigen` and `driven_response`. It consumes the K0 Poisson-airbox
algorithms in chapter 18, the nonzero-k Floquet-airbox algorithms in chapter
23, and the physics contracts in notes 0700, 0830 and 0831. It does not record
dated evidence and does not claim that any gate has run.

Each gate has seven mandatory fields: **fixture**, **independent oracle**,
**metric**, **initial tolerance**, **production tolerance**, **required
artifacts**, and **promotable readiness cells**. A result may promote only the
exact cells named by its accepted artifact bundle. Passing a nearby synthetic,
CPU, K0, no-demag, modal, or tiny case cannot promote another cell.

A readiness cell can be summarized for human review by these dimensions:

```text
study_product
device
precision
k_scope and sampled k domain
dynamic_demag_scope
geometry/material/equilibrium class
boundary/gauge tuple
FE order and mesh/DOF envelope
operator and interaction set
damping/nonconservative policy
solver engine, preconditioner and target/sweep policy
```

This list is deliberately abbreviated and is not the canonical
`validated_scope`. Chapter 24 section 2 exclusively defines the complete scope,
its deterministic `scope_id`, and its required physics/mode/k/BC/gauge/runtime,
device, precision, problem-size, bounded geometry/material, fixture and oracle
fields. `initial` means a gate is usable during implementation. `production`
means it is eligible to satisfy chapter 24 for the canonical scope bound to the
artifact. Production tolerances supersede initial tolerances; a
fixture-specific physics note may tighten them but may not loosen them silently.

Analytical values and trusted reference solutions are verifier-side data. They
must not construct the production operator, choose its target, select a mode,
set convergence, certify solver success, or alter the artifact under test.

Every artifact named in every gate row below includes a mandatory top-level
`verified_coverage_of` field whose value is this `validation_scope_binding.v1`
object from Chapter 24:

```text
verified_coverage_of:
  schema: validation_scope_binding.v1
  scope_schema: frequency_domain_validation_scope.v1
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

The direct variant binds the recomputed hash of the one scope evaluated by the
artifact. The coverage variant is legal only with a complete typed rule; a
record cannot use both variants. Chapter 24 validates the closed scope and
coverage schemas, comparator direction and every referenced hash. A fixture
nickname, abbreviated readiness tuple, matching path, implicit parent scope or
prose assertion of exact coverage or exact `validated_scope` is invalid. In
particular, evidence whose subject is narrower than a target cannot promote
that broader target.

## 2. Common acceptance and convergence contract

All numerical comparisons use double precision unless the cell explicitly
states another qualified precision. Relative errors use a declared scale and
an absolute floor stored in the artifact. Matrix/action comparisons use

```text
eps_action = ||y_test-y_oracle||_2 /
  max(||y_oracle||_2, absolute_scale_floor).
```

Modal and driven acceptance uses the reconstructed original, unscaled operator:

```text
eps_modal = max(eps_q, eps_phi, eps_gauge)
eps_driven = max(eps_q, eps_phi, eps_gauge)
```

Library, transformed, preconditioned and tracked residuals remain separate
diagnostics. None may cap or replace the original-operator residual.

Every convergence artifact must contain raw, distinct solve rows. It must
identify the varied parameter, hold all other declared parameters fixed, and
include at least three levels. Acceptance requires one of:

1. monotone entry into the asymptotic regime followed by a finest-two delta;
2. a documented asymptotic fit with residual and confidence diagnostics when
   strict monotonicity is not expected; or
3. Richardson extrapolation when a stable observed order is available.

Where an order is applicable, publish `observed_order`. Always publish the raw
levels, `finest_two_relative_delta`, any `richardson_extrapolated_value`, and
the fit residual. Mesh error and airbox/truncation error have separate budgets.
Duplicated synthetic rows, relabelled copies of one solve, or rows that reuse
one numerical result under several levels fail the gate.

## 3. Physics gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| PHY-1 units, phasor and Larmor | Uniform magnet, positive bias sweep, no demag, no damping, K0 | Closed-form `f=gamma0 H/(2*pi)` evaluated only after branch selection; independent SI-token audit | Maximum/median relative frequency error; `lambda=i*omega`; gamma/mu0 consistency | max `2e-2`; median `1e-2`; mapping/token mismatches `0` | max `5e-3`; median `2e-3`; mapping/token mismatches `0` | `validation/physics/larmor.v1.json`, selected branch rows, solver diagnostics | `modal_eigen/*/k0/demag_none`; driven cells only through PHY-4 |
| PHY-2 demag sign and energy | Uniformly magnetized sphere and at least two ellipsoids, open boundary | Analytical demag tensor and positive magnetostatic energy, generated outside assembly | Componentwise field error, energy error, sign failures | field/energy `<=3e-2`; sign failures `0` | field/energy `<=1e-2`; sign failures `0` | `validation/physics/demag_ellipsoid.v1.json`, raw mesh/padding rows | K0 demag cells for the evidenced BC/geometry envelope |
| PHY-3 Kittel thin film | Chapter 15 K0-3 real-film suite | Fixture-owned, independently provenanced, postsolve-only `M_eff_reference`; postsolve Kittel evaluator and fitted `M_eff`; none is a solver/request/selection/certificate input | Maximum/median field-sweep frequency error; `abs(fitted_M_eff-M_eff_reference)/abs(M_eff_reference)`; fitted-parameter uncertainty and scaled-Jacobian conditioning; separate frequency and fitted-`M_eff` mesh/truncation budgets | frequency max `5e-2`, median `2e-2`; fitted `M_eff` relative error `2e-2`; relative standard uncertainty `1e-2`; scaled-Jacobian condition number `1e8`; mesh `2e-2`; truncation `2e-2` | frequency max `2e-2`, median `1e-2`; fitted `M_eff` relative error `5e-3`; relative standard uncertainty `2.5e-3`; scaled-Jacobian condition number `1e6`; mesh `1e-2`; truncation `5e-3` | Chapter 15 fixture/reference provenance, fit, summary, points, selection, independence and convergence artifacts, each with the required `verified_coverage_of` binding | `modal_eigen/{cpu,gpu}/k0/periodic_airbox_k0` only after all predecessor gates |
| PHY-4 modal/driven resonance | Same assembled blocks, physical transverse drive, frequency sweep bracketing independently selected modes | Driven full solve is the modal oracle and modal spectrum is the driven-location oracle; neither selects the other | Resonance-frequency delta, complex observable delta, original residual | frequency `1e-2`; observable `5e-2`; residual `1e-6` | frequency `2e-3`; observable `1e-2`; residual `1e-8` | spectrum, response sweep, point diagnostics and cross-link artifact | Matching modal and driven cells only |

## 4. Manufactured assembly gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| ASM-1 scalar Poisson BC/gauge | Manufactured P1 potential/source on Robin, Dirichlet and pure-Neumann shared domains | Symbolic potential differentiated outside the FEM assembler | L2/H1 error, observed order, boundary residual, gauge residual | L2 order `>=1.7`; H1 order `>=0.8`; residuals `<=1e-7` | L2 order `>=1.9`; H1 order `>=0.95`; residuals `<=1e-9` | `validation/k0_poisson_airbox/manufactured_poisson.v1.json`, raw levels | K0 modal/driven demag cells for each passed BC/gauge tuple |
| ASM-2 magnetic/scalar reciprocity | Deterministic element fixtures plus sphere/ellipsoid assembled meshes | Separate element quadrature implementation and energy variation identity | Element/global adjoint-energy relative error; sign-negative-control outcome | `<=1e-9`; negative control must fail | `<=1e-11`; negative control must fail | `validation/k0_poisson_airbox/reciprocity.v1.json` | K0 demag cells using the evidenced material/quadrature order |
| ASM-3 full descriptor assembly | Tiny real shared-domain P1 cases for every BC/gauge tuple | Independently assembled dense descriptor and seeded random-vector actions | Per-block/action error; ordering/signature mismatch count | action `<=1e-9`; mismatch count `0` | action `<=1e-11`; mismatch count `0` | assembly section of solver diagnostics and `descriptor_parity.v1.json` | Exact K0 modal/driven CPU cells; GPU only after GPU parity |
| ASM-4 analytical-input isolation | Same physical problem solved with absent, perturbed and nonsensical Kittel verifier metadata | Hash/action invariance oracle; solver request inspection | Changes in blocks, target/window, preconditioner, selected spectrum before verifier, certificate or solve status | all changes `0` | all changes `0` | `validation/k0_poisson_airbox/analytical_isolation.v1.json` | Every Kittel-dependent promotion cell; failure blocks all production qualification |

## 5. Algebra parity gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| ALG-1 operator dictionary | Seeded complex tangent vectors over admitted local/exchange/demag blocks | Direct application of note 0831's `L`, `B_alpha` and `i*omega*B_alpha-L` dictionary | Modal/driven action relative error and sign/unit mismatch count | action `<=1e-9`; mismatches `0` | action `<=1e-11`; mismatches `0` | `validation/algebra/operator_dictionary.v1.json` | All exact operator-set cells |
| ALG-2 complex/real split | Multi-mode interior-window descriptor with known complex representation | Complex arithmetic path versus named `real_frequency_rotated` realization | Action error, frequency-cluster error, invariant-subspace sine, J-closure | action `1e-9`; cluster/subspace `1e-7`; J failures `0` | action `1e-11`; cluster/subspace `1e-9`; J failures `0` | `validation/k0_poisson_airbox/interior_window.v1.json` | CPU modal cells using the passed scalar representation |
| ALG-3 full/Schur parity | Same descriptor and exact-signature Schur certificate | Full descriptor direct solve | Modal cluster, driven complex response and reconstructed full residual | modal `1e-6`; response `1e-5`; residual `1e-6` | modal `1e-8`; response `1e-7`; residual `1e-8` | `validation/algebra/full_schur_parity.v1.json` and certificate | Only Schur-engine cells with the exact certificate signature |
| ALG-4 dense/sparse/action parity | Bounded deterministic descriptors with multiple sparsity patterns | Dense oracle assembled independently from sparse and MatShell paths | Matrix/action error and accepted/rejected outcome equality | `<=1e-9`; outcome mismatches `0` | `<=1e-11`; outcome mismatches `0` | `validation/algebra/dense_sparse_action.v1.json` | Exact CPU engines; no physical promotion without physics gates |

## 6. Modal gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| MOD-1 finite-mode and full residual | Descriptors containing finite, algebraic, zero and rejected modes | Direct dense finite-spectrum classification plus original block action | Classification mismatch, `eps_full`, positive-branch/mapping mismatch | mismatches `0`; `eps_full<=1e-6` | mismatches `0`; `eps_full<=1e-8` | spectrum and solver diagnostics with all block residuals | Exact modal cells |
| MOD-2 interior-window completeness | At least three positive modes around a nonzero interior target and a wrong-axis negative control | Dense full spectrum outside the production selection path | Missing/extra physical classes, multiplicity/subspace error, negative-control outcome | missing/extra `0`; subspace `<=1e-6`; negative control fails | missing/extra `0`; subspace `<=1e-8`; negative control fails | `validation/k0_poisson_airbox/interior_window.v1.json` | Exact modal target/window/engine cells |
| MOD-3 shape-first branch tracking | Field or k sweep with crossings and a uniform branch | Mass-inner-product Hungarian/cluster tracker using exported modes; no analytical frequency | Uniform overlap, previous-point overlap, tangent leakage, seam mismatch, branch gaps | uniform `>=0.85`; overlap `>=0.70`; leakage/seam `<=1e-6`; gaps `0` | uniform `>=0.95`; overlap `>=0.85`; leakage/seam `<=1e-8`; gaps `0` | `eigen/branches.v2.json`, mode metadata/fields and selection audit | Exact modal sweep/path cells, including chapter 15 Kittel |
| MOD-4 damped/nonnormal spectrum | Small damped or nonconservative problem with left/right vectors | Independent dense QZ or direct response oracle | Eigenvalue cluster, biorthogonality, damping sign, response reconstruction | cluster/biorthogonality `1e-6`; sign failures `0`; response `1e-4` | `1e-8`; sign failures `0`; response `1e-6` | damped spectrum, left/right metadata and response cross-check | Only exact damped/nonconservative cells |

## 7. Driven gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| DRV-1 physical RHS and original residual | Nonzero transverse RF drive plus zero-RHS negative/degenerate case | Direct projected RHS from `T^T[-gamma0(m0 x delta_h)]` and direct operator action | RHS action error, `eps_full`, stop-reason mismatch | RHS `1e-9`; residual `1e-6`; mismatches `0` | RHS `1e-11`; residual `1e-8`; mismatches `0` | response diagnostics and per-frequency artifacts | Exact driven engine/drive cells |
| DRV-2 full/field-split/Schur | Same blocks and sweep through all admitted CPU engines | Sparse-direct full solve on bounded samples | Complex field/observable delta, residual and accepted/rejected equality | field/observable `1e-4`; residual `1e-6`; mismatches `0` | `1e-6`; residual `1e-8`; mismatches `0` | `validation/response/engine_parity.v1.json` | Each engine independently, only over sampled size/frequency envelope |
| DRV-3 reduced response | Resonant and off-resonant sweep with omitted-mode negative control | Full coupled solve not used to construct the reduced basis | Observable/field error, original residual, enrichment/fallback outcome | error `1e-2`; residual `1e-5`; negative control rejects/enriches | error `2e-3`; residual `1e-7`; negative control rejects/enriches | basis certificate, response sweep and reduction audit | Exact ROM method/window/operator cells only |

## 8. Periodic and Floquet gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| PBC-1 equivalence classes and frame transport | Corner/edge-rich periodic mesh with varying tangent frames | Independent graph closure and Cartesian reconstruction | Missing/duplicate members, cycle phase/frame residual, orientation/topology mismatch | counts `0`; phase `<=1e-10` rad; frame `<=1e-9` | counts `0`; phase `<=1e-12` rad; frame `<=1e-11` | periodic mesh certificate and pair/class artifacts | Exact periodic K0/nonzero-k cells using that topology |
| PBC-2 K0 reduction parity | Same primitive cell through chapter 18 and chapter 23 at Gamma | Direct equality of assembled K0 blocks/actions after explicit permutation | Per-block/action error, gauge transition mismatch, spectrum/response delta | action `1e-9`; observable `1e-6`; mismatches `0` | action `1e-11`; observable `1e-8`; mismatches `0` | `validation/floquet/k0_limit.v1.json` | Nonzero-k cells only after their matching K0 cell passes |
| PBC-3 manufactured Bloch Poisson | Complex manufactured potential/source at axial and oblique signed k | Independent matched-mesh `C_phi(k)^H P C_phi(k)` oracle or separate refinement sequence | L2/H1 order, phase/flux/seam error, sign-negative-control outcome | L2 `>=1.7`; H1 `>=0.8`; seam/flux `<=1e-6`; negative control fails | L2 `>=1.9`; H1 `>=0.95`; seam/flux `<=1e-8`; negative control fails | `validation/floquet/manufactured_poisson.v1.json`, raw levels | Nonzero-k demag cells for the exact k/BC domain |
| PBC-4 production/oracle operator parity | Signed axial/oblique k samples with all five Task 7 blocks | Independent `C_m(k)`/`C_phi(k)` reduction when matching basis exists; otherwise independent three-level sequence | Raw action error or bounded convergence/observable error; demag sign | raw `1e-8` or convergence `5e-2`; sign failures `0` | raw `1e-10` or convergence `2e-2`; sign failures `0` | Floquet parity certificate with declared comparison mode | Exact nonzero-k operator-set cells |
| PBC-5 DE/BV dispersion and symmetry | Signed DE/BV k paths, K0 endpoint, declared symmetry-map cases | Postsolve analytical/semi-analytical limits and transformed symmetry pairs | Branch/cluster error, K0 limit, transformed `k<->-k` error | `<=5e-2`; K0 `<=1e-2`; symmetry `<=1e-3` | `<=2e-2`; K0 `<=2e-3`; symmetry `<=1e-5` | dispersion, branches, mode fields, symmetry-map and convergence artifacts | Exact modal nonzero-k cells; driven cells need matched response evidence |

## 9. CPU/GPU parity gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| GPU-1 block and operator apply | Identical CPU/GPU problem signatures and seeded vectors over each qualified block | Qualified CPU double path | Per-block/action and reconstructed-field relative error | `<=1e-8` | `<=1e-10` | `validation/cpu_gpu/operator_parity.v1.json` | GPU cells for the exact operator/k/demag scope |
| GPU-2 scalar and shifted solves | Identical Poisson and shifted systems with repeated solves | Qualified CPU residual-certified solve | Solution/action error, contraction, original residual and setup reuse | solution `1e-7`; residual `1e-6`; reuse failures `0` | solution `1e-9`; residual `1e-8`; reuse failures `0` | scalar/shifted parity plus transfer audit | GPU solver/preconditioner cells only |
| GPU-3 modal parity | Exact CPU/GPU modal bundles including degeneracies | Qualified CPU cluster/subspace result | Frequency cluster, invariant-subspace sine, residual/outcome mismatch | cluster/subspace `1e-6`; residual `1e-6`; mismatches `0` | cluster/subspace `1e-8`; residual `1e-8`; mismatches `0` | `validation/k0_poisson_airbox/cpu_gpu_parity.v1.json` or Floquet equivalent | Exact GPU modal cells |
| GPU-4 driven parity | Exact CPU/GPU complex sweeps | Qualified CPU full response | Complex field/observable error, residual and stop-reason mismatch | error `1e-5`; residual `1e-6`; mismatches `0` | error `1e-7`; residual `1e-8`; mismatches `0` | response CPU/GPU parity and point diagnostics | Exact GPU driven cells |

CPU/GPU parity never promotes CPU evidence into GPU residency. Single precision
requires its own error budget and physics qualification; double-precision
parity cannot promote a single-precision cell.

## 10. Performance and residency gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| PERF-1 GPU hot-loop residency | At least one restart and enough iterations to exercise operator and preconditioner reuse | Transfer counters plus profiler/runtime trace from an independent instrumentation layer | Per-iteration H2D/D2H transfers, hidden host solve count, hot-loop buffer locations | all forbidden counts `0`; all hot-loop buffers `device` | same, with no waiver | `gpu_transfer_audit.v1.json` and trace summary | GPU modal or driven cells only; probes cannot satisfy it |
| PERF-2 persistent setup and memory | Repeated k/frequency/target solves within one unchanged signature, plus signature-change invalidation | Allocation tracker and context-key audit | Rebuild count, leaked bytes, peak device/host bytes, invalid reuse | unchanged-signature rebuilds `0`; leaks `0`; peak within declared initial envelope | same; peak `<=1.05` of accepted release baseline | context lifecycle and memory artifact | Exact persistent GPU engine cells |
| PERF-3 runtime envelope | Checked-in small, medium and largest-qualified workloads with fixed hardware/software identity | Previous accepted release baseline and CPU reference where applicable | Median and p95 wall time, setup/solve split, iterations, throughput | p95 `<=1.25` baseline or explicitly lower provisional ceiling | p95 `<=1.10` accepted baseline; no unexplained iteration regression | benchmark manifest, raw samples and environment identity | Exact engine/size/hardware envelope only |
| PERF-4 bounded scaling | At least three distinct DOF levels without duplicated rows | Complexity fit and memory accounting independent of solver success | Observed time/memory slope and out-of-memory boundary | finite fit; no superlinear memory beyond declared algorithm | fitted slope within declared engine model plus `10%`; no leak or hidden dense allocation | raw scaling table and fit artifact | Exact size envelope, not larger unmeasured problems |

Performance gates are not correctness substitutes. A slower but bounded CPU
cell may qualify if it meets its declared product envelope; a GPU cell cannot
qualify as device resident without PERF-1 even when wall time is low.

## 11. Artifact and provenance gates

| Gate | Fixture | Independent oracle | Metric | Initial tolerance | Production tolerance | Required artifacts | Promotable readiness cells |
|---|---|---|---|---|---|---|---|
| ART-1 schema and cross-artifact identity | Complete, failed and interrupted modal/driven bundles | Independent schema/resource validator | Missing fields, invalid direct/coverage binding, scope or coverage-rule schema failure, hash/signature mismatch, dangling path, status contradiction | all counts `0` | all counts `0` | manifest, solver diagnostics, spectra/response, mesh and validation artifacts | All cells |
| ART-2 requested/resolved truth | Strict CPU, strict GPU, auto and explicit-fallback fixtures | Planner request compared with runtime and artifact provenance | Hidden fallback, device/precision/engine mismatch, absent rejection token | all counts `0` | all counts `0` | plan, manifest, diagnostics and rejection artifact | All cells; strict GPU mismatch blocks GPU promotion |
| ART-3 validation isolation | Kittel, DE/BV, manufactured and CPU-reference bundles | Data-flow audit from solver request through postsolve verifier | Analytical/fitted/reference fields present in assembly, target, selection, certificate or solver pass/fail payload | occurrences `0` | occurrences `0` | validation-isolation report and request/artifact schemas | Every analytical-validation cell |
| ART-4 product/API/UI consistency | Published modal and driven resource bundles | OpenAPI/type/resource validator and browser-facing resource inventory | Missing resource, unit mismatch, stale revision, UI claim beyond artifact state | all counts `0` | all counts `0` | API contract report and artifact resource index | Cells exposed through API/UI |
| ART-5 promotion record | Candidate canonical-scope release bundle | Chapter 24 machine-readable checklist validator | Missing applicable item, invalid canonical scope/hash/coverage binding, empty/wildcard `validated_scope`, stale evidence, unresolved blocker | all counts `0` | all counts `0` | production DoD record linked to immutable evidence | Only the canonical recorded readiness cell |

## 12. Promotion boundaries and current truth

The matrices above are requirements, not evidence that they pass. Current
source-visible helpers, synthetic descriptors, old managed artifacts, tiny
dense GPU exceptions and partial driven-response lanes retain only their
existing bounded status. In particular:

- `synthetic_algebraic_oracle` can satisfy algebra gates but cannot promote
  real shared-domain Poisson-airbox physics;
- a no-demag K0 macrospin GPU result cannot promote GPU Poisson-airbox modal,
  nonzero-k Floquet, or driven-response cells;
- operator/apply probes cannot satisfy a solver or residency gate;
- a best observed convergence row without raw independent levels cannot
  satisfy convergence; and
- `production_executable` remains distinct from `production_qualified`.

Promotion occurs only when chapter 24 accepts every applicable
`verified_coverage_of`/`validation_scope_binding.v1` for one recomputed
canonical `scope_id`, and the readiness/capability status is updated by its own
owning task.
