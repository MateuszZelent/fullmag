---
title: FEM frequency-domain production definition of done
version: COMSOL-aligned v5.1 decision-complete
status: normative product promotion contract; no current qualification implied
role: normative
---

# Production definition of done

## 1. Product rule

FEM frequency-domain capability is production-qualified per exact product
scope, never by solver family name alone. `production_executable` means a lane
can execute. It is not equivalent to `production_qualified`.

The only legal production promotion is:

```text
implementation_state = executable
validation_state = production_qualified
validated_scope = canonical complete non-empty scope
scope_id = canonical validated_scope hash
all applicable DoD items = pass
open production blockers = []
```

Every item in this chapter is independently evidenced. Documentation,
source-visible code, a passing synthetic oracle, one successful runtime, a
nearby CPU/GPU lane or a narrow K0 macrospin exception cannot stand in for an
applicable item. This chapter defines gates; it does not claim any current cell
has passed them.

## 2. Canonical `validated_scope` and `scope_id`

Chapter 24 owns the only canonical validation-scope schema. Chapters 09 and 15
and every validation artifact must use this schema rather than defining a
shorter local tuple. The schema identifier is
`frequency_domain_validation_scope.v1`. Empty values, `any`, `all`, unbounded
wildcards and prose such as "general FEM" are invalid.

| Scope field | Required content |
|---|---|
| `study_product` | Exactly `modal_eigen` or `driven_response`; reduced response is a separately named engine scope |
| `discretization` | `fem` |
| `physics_scope` | Canonical equation/phasor convention, equilibrium class, dynamic-field convention, damping/nonconservative policy and complete included/excluded interaction set |
| `mode_scope` | For modal evidence: finite/positive branch policy, mode or cluster class, requested count/window, multiplicity and tracking policy; for driven evidence: explicit `not_applicable` plus response observable/drive scope |
| `device` | `cpu` or `gpu` |
| `precision` | `double` or an independently qualified `single` scope |
| `k_scope` | `k0` or bounded `nonzero_k` domain with units, path/samples and Gamma tolerance |
| `dynamic_demag_scope` | `none`, `periodic_airbox_k0`, or bounded `floquet_airbox_nonzero_k` |
| `geometry_scope` | Geometry family plus closed numerical bounds and SI units for every dimension/range, periodic cell and airbox policy; fixture dimensions must lie inside those bounds |
| `material_scope` | Material classes plus closed numerical bounds and SI units for `Ms`, gamma, exchange, anisotropy, damping and every admitted interaction parameter |
| `equilibrium_scope` | Uniform/relaxed/nonuniform class, acceptance tolerances and required artifact/signature policy |
| `boundary_scope` | Magnetic BCs, periodic directions/pairing policy, open directions, scalar outer BC and bounded Robin beta policy |
| `gauge_scope` | Exact scalar gauge/nullspace policy, augmentation and acceptance tolerances |
| `fe_scope` | FE spaces/order, quadrature and mesh-quality/refinement envelope |
| `problem_size_scope` | Magnetic/scalar DOF range and largest qualified memory/runtime case |
| `operator_scope` | Included local, exchange, DMI, demag and torque linearizations; excluded terms are explicit |
| `damping_scope` | Alpha range and admitted nonconservative/nonnormal policy |
| `solver_scope` | Exact engine, scalar representation, target/window/sweep policy, preconditioner and fallback policy |
| `runtime_scope` | Fullmag build/commit identity, native ABI, PETSc/SLEPc/hypre/libCEED/CUDA versions as applicable, device family, driver/runtime identity and managed execution route |
| `fixture_ids` | Ordered immutable fixture IDs, versions and content `sha256` hashes used by the evidence |
| `oracle_ids` | Ordered immutable analytical/numerical oracle IDs, versions and content `sha256` hashes used by the evidence |

Two records that differ in any field are different readiness cells. Evidence
may be shared only when its own scope explicitly covers both values and all
other signatures match.

Canonicalization is deterministic:

1. validate the complete object against
   `frequency_domain_validation_scope.v1`;
2. express SI quantities as finite JSON numbers in canonical SI units and
   preserve the schema-defined order of path samples, fixture IDs and oracle
   IDs;
3. serialize the object using RFC 8785 JSON Canonicalization Scheme UTF-8; and
4. compute `scope_id = "sha256:" + lowercase_hex(SHA-256(serialized_bytes))`.

No artifact path, timestamp, gate outcome, tolerance result or promotion state
is part of the scope hash. The promotion validator recomputes the hash; a
caller-supplied `scope_id` is never trusted.

## 3. DoD state and evidence rules

Each item has one state:

```text
pass
fail
not_applicable
```

`not_applicable` requires a machine-readable reason and a `validated_scope`
that excludes the feature. It cannot waive a requirement that is inherent to
the claimed cell. For example, GPU residency is inherent to a GPU device-Krylov
claim, while CPU/GPU numerical parity is not required to call a CPU-only cell
device-resident. A GPU promotion always requires a qualified CPU oracle and
CPU/GPU parity.

Each `pass` links immutable artifacts and records:

```text
gate_id
scope_id
evidence paths and sha256 hashes
fixture and oracle identities
metric values
required initial and production tolerances
verifier identity and result
implementation_state
validation_state before promotion
open blockers
```

Every evidence artifact uses one explicit scope binding:

```text
scope_id = canonical scope directly evaluated by this artifact
```

or, for a bounded oracle/aggregate that verifies one or more separately hashed
readiness cells:

```text
verified_coverage_of = [canonical scope_id, ...]
coverage_rule = machine-readable subset/range relation proved by the verifier
```

An abbreviated tuple, fixture nickname, parent directory or matching runtime
signature is not a scope binding. Each `verified_coverage_of` target must be
recomputed from a complete canonical scope and the coverage rule must verify
all differing bounded fields; otherwise the evidence is stale for that target.

Evidence from another physical signature, precision, device, product, k scope,
demag realization or solver engine is stale for this record even if its files
are newer.

## 4. Product checklist

| DoD item | Required exact-scope evidence | Pass condition | Does not satisfy the item |
|---|---|---|---|
| DOD-01 Physics note | Applicable publication-style notes in `docs/physics`, including equations, SI units, assumptions, FDM/FEM interpretation, CPU/GPU policy, validation and limits | Notes are canonical, internally consistent with 0700/0830/0831, and cover every operator/BC/damping feature in scope | Masterplan equations alone, a status report or undocumented runtime behavior |
| DOD-02 Python/UI round-trip | Canonical Python DSL script, UI-authored equivalent, exported script and normalized semantic comparison | Python -> IR -> UI/export -> Python preserves all physics-first fields and requested intent for the exact scope | UI-only state, backend metadata injected as public physics, or one-way authoring |
| DOD-03 ProblemIR validation | Canonical lowered `ProblemIR`, normalization output and positive/negative validation cases | Units, k, gamma, equilibrium, BC/gauge, demag, target/sweep, precision and duplicate/conflict rules accept legal input and reject illegal input with stable reasons | Runtime defaults repairing malformed IR or planner-only rejection |
| DOD-04 Planner legality | Requested and resolved plans for strict CPU, strict GPU, auto and allowed fallback cases | Exactly one legal lane resolves; unsupported strict requests fail; any fallback is explicit and provenance-preserved | Hidden CPU fallback, heuristic selection before intent, or capability inferred from source presence |
| DOD-05 Equilibrium/mesh certificates | Accepted equilibrium/linearization artifact and complete magnetic/scalar periodic certificate with matching signatures | Acceptance, torque/norm, topology/equivalence classes, frame transport, seams, BC/gauge and invalidation checks pass for the exact solve | Preflight candidate not consumed by native assembly, pair-only corner handling, or mismatched signatures |
| DOD-06 Native assembly | Backend-owned real FEM blocks/actions and chapter 09 manufactured/reciprocity/isolation evidence | `assembly_kind` is the production kind; block signs/units/order/scaling pass; analytical expected values cannot affect blocks, target or signatures | `synthetic_algebraic_oracle`, Kittel `demag_delta`, macrocell payload or postsolve phase projection |
| DOD-07 Solver engine | Exact modal or driven production engine, preconditioner and lifecycle artifacts | Engine converges over the bounded size/window/sweep scope, has correct target representation/restart/stop reasons, and has no undeclared fallback | Dense/apply probe, one successful tiny case, host-Krylov path claimed as device Krylov, or another product's engine |
| DOD-08 Full residual | Reconstructed original unscaled block residuals for every accepted mode/frequency point | Chapter 09 production tolerance passes for every required block; transformed/backend/tracked residuals remain separate | Solver-library residual alone, capped residual, magnetic-only residual when scalar/gauge blocks apply |
| DOD-09 Artifacts/OpenAPI/UI | Complete artifacts-v2 bundle, typed OpenAPI/resource exposure and UI state for complete/partial/failed/unavailable outcomes | Cross-artifact hashes, units, revisions, requested/resolved state, canonical `scope_id` or verified `verified_coverage_of`, and resource links agree; UI cannot overstate capability | Abbreviated scope tuple, raw files without resource contract, UI claim inferred from route presence, or JSON carrying heavy payloads outside the data plane |
| DOD-10 Analytical validation | Applicable chapter 09 independent physics gate: Larmor/Kittel, ellipsoid, DE/BV, modal/driven resonance or another physics-note oracle | Production tolerance passes after solve and after independent selection; for K0-3, fixture-owned independently provenanced `M_eff_reference`, fitted-`M_eff` agreement, uncertainty and conditioning all pass; oracle inputs never enter assembly/request target/selection/certificate/solver status | Best-fit-only agreement, solver-derived `M_eff_reference`, nearest-expected mode selection, synthetic operator built from the answer, or fast CI subset |
| DOD-11 Convergence | Raw distinct mesh and truncation sequences plus solver tolerance evidence | At least three levels per applicable dimension; monotonicity/asymptotic fit, observed order where applicable, Richardson/finest-two delta and separate frequency and fitted-`M_eff` budgets pass | Best row only, duplicated synthetic rows, simultaneous mesh/padding changes without independent sequences, or analytical values copied as solved rows |
| DOD-12 CPU/GPU parity | For GPU: exact qualified CPU oracle and chapter 09 operator/solver/physics parity; for CPU-only: explicit `not_applicable` reason excluding GPU | GPU blocks, modes/responses, residuals and accepted/rejected outcomes pass production tolerances on identical signatures | No-demag macrospin parity used for demag, CPU result copied into GPU artifacts, or precision mismatch |
| DOD-13 Performance/residency | Raw performance envelope, memory scaling and, for GPU, independent transfer/residency audit | Bounded release performance passes; GPU hot loop, vectors, basis, operator and preconditioner are device-resident with zero per-iteration H2D/D2H and hidden host solves | One-shot GPU kernel, device matrix with host Krylov, unbounded workload, or timing without environment identity |
| DOD-14 Release regression | Managed/container-backed release gate and immutable regression bundle for the exact scope | All applicable DoD validators run from a clean release candidate, expected negative controls fail, and accepted baselines are versioned | Host-only check, docs-only assertion, stale artifact, skipped negative control or unrelated lane's managed gate |

## 5. Product-specific applicability

### 5.1 Modal eigen

Modal qualification additionally requires finite-mode classification, correct
`lambda=i*omega` mapping, positive-branch policy, physical mode count, window
completeness, multiplicity/cluster handling, full mode reconstruction and
shape/overlap branch tracking when a sweep or k path is claimed.

K0 Poisson-airbox modal scope requires chapter 18 stages K0-P1 through K0-P6.
GPU scope additionally requires K0-G1 through K0-G4. Chapter 15 K0-3 is
mandatory for a real-film periodic-airbox production claim.

Nonzero-k modal scope requires chapter 23 NK-P1 through NK-P5. GPU scope
additionally requires NK-G1 through NK-G4. Passing Gamma only does not promote
a nonzero-k domain.

### 5.2 Driven response

Driven qualification additionally requires a physical projected RHS, complete
frequency sweep semantics, true original residual at every accepted point,
complex field/observable artifacts, cancellation/interruption behavior and
full-versus-Schur/reduced cross-checks for every claimed alternate engine.

K0 Poisson-airbox driven scope requires chapter 18 K0-P1 through K0-P3 and
K0-P7 plus the applicable residual/physics gates. A modal basis is required
only for a modal-reduced cell, where left/right or Petrov-Galerkin contracts are
also mandatory.

Nonzero-k driven scope requires chapter 23 NK-P1 through NK-P5 for the driven
product. Modal nonzero-k evidence does not promote driven response without its
own RHS, sweep, residual and observable evidence.

### 5.3 CPU

A CPU cell may qualify independently of GPU implementation. It still needs a
bounded performance envelope and exact CPU engine evidence. DOD-12 is
`not_applicable` only with reason `validated_scope.device=cpu excludes GPU`;
the record must not imply GPU parity or availability.

### 5.4 GPU

A GPU cell requires every applicable CPU physics/assembly oracle, CPU/GPU
parity and GPU performance/residency gate. GPU operator residency does not
qualify GPU solver residency. Strict GPU execution must resolve to the exact
GPU engine or reject without CPU fallback.

## 6. Required promotion record

The release candidate publishes one record per readiness cell. The schema is
`frequency_domain_production_dod.v1` and requires:

| Record field | Required value |
|---|---|
| `scope_schema` | `frequency_domain_validation_scope.v1` |
| `scope_id` | RFC 8785/SHA-256 identifier computed exactly as section 2 specifies |
| `validated_scope` | Every canonical field in section 2, with no wildcard or omitted field |
| `implementation_state` | `executable` |
| `validation_state_before_promotion` | The actual pre-promotion state |
| `items.DOD-01` through `items.DOD-14` | `pass`, `fail` or justified `not_applicable` |
| `item_evidence.DOD-01` through `item_evidence.DOD-14` | Gate IDs, immutable artifact paths/hashes, fixture/oracle IDs, metrics, production tolerances and verifier result for every `pass` |
| `not_applicable_reasons` | One exact scope-derived reason for every `not_applicable` item |
| `open_blockers` | Empty for promotion |
| `promotion_decision` | `production_qualified` only after section 7 succeeds; otherwise `blocked` |

The record validator recomputes `scope_id` and validates every direct or
coverage binding. A record that omits a canonical scope field, evidence hash or
coverage proof is invalid rather than partially complete.

## 7. Promotion algorithm

The promotion validator performs these checks in order:

1. validate, RFC 8785-canonicalize and hash the complete `validated_scope`;
2. require `implementation_state=executable` for that scope;
3. resolve item applicability from the exact product/device/k/demag/engine
   tuple;
4. validate every evidence artifact's `scope_id` or `verified_coverage_of`,
   fixture/oracle identity, metric and production tolerance;
5. reject stale or mismatched signatures and evidence from neighboring cells;
6. require every expected negative control to fail for the intended reason;
7. require `open_blockers=[]` and no contradiction with current status docs;
8. set `validation_state=production_qualified` only for the hashed scope; and
9. leave every other readiness cell unchanged.

Any failed or missing applicable item yields `promotion_decision=blocked`.
There is no partial `production_qualified` state. Narrow qualification is
represented by a narrow `validated_scope`, not by weakening this checklist.

## 8. Current blockers relevant to this DoD

Current source and canonical physics/status documents identify blockers that
prevent broad FEM frequency-domain production qualification, including:

- real shared-domain Poisson-airbox modal assembly is not yet qualified;
- the current Kittel path allows expected frequency and validation `M_eff` to
  influence assembly, targeting, selection or solver certification as detailed
  in chapter 15;
- real-PETSc imaginary-axis target representation is not yet broadly
  qualified;
- general GPU modal device Krylov and device-resident driven Krylov are not
  established by dense/apply probes or host-Krylov GPU paths;
- nonzero-k numeric dynamic demag and its full CPU/GPU validation remain
  unqualified; and
- current partial executable and narrow validated cells cannot be promoted
  beyond their existing exact evidence.

These blockers are statements of current non-qualification, not dated evidence
logs. Their removal requires implementation and fresh managed evidence owned by
the corresponding tasks; this documentation change does not satisfy them.
