---
title: FEM frequency-domain production definition of done
version: COMSOL-aligned v5.2 decision-complete
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

## 2. `frequency_domain_validation_scope.v1`

Chapter 24 owns the only canonical validation-scope schema. Chapters 09 and 15
and every validation artifact must use this schema rather than defining a
shorter local tuple. `frequency_domain_validation_scope.v1` is the closed JSON
object defined below: every listed field is required, no additional field is
allowed, and `null`, an empty identifier, `any`, `all`, an infinity, a NaN and
an unbounded wildcard are invalid.

### 2.1 Primitive types

| Type | Normative JSON representation |
|---|---|
| `Identifier` | Non-empty string matching `^[a-z0-9][a-z0-9._:/+-]*$` |
| `Sha256Id` | Lowercase string matching `^sha256:[0-9a-f]{64}$` |
| `PositiveNumber` | Finite JSON number greater than zero |
| `NonNegativeInteger` | JSON integer greater than or equal to zero |
| `PositiveInteger` | JSON integer greater than or equal to one |
| `ClosedInterval` | Closed object `{minimum: finite number, maximum: finite number, unit: Identifier}` with `minimum<=maximum` |
| `IntegerInterval` | Closed object `{minimum: NonNegativeInteger, maximum: NonNegativeInteger}` with `minimum<=maximum` |
| `IdentifierSet` | Non-empty JSON array of unique `Identifier` values, sorted by UTF-8 byte order |
| `IdentityRef` | Closed object `{id: Identifier, version: Identifier, sha256: Sha256Id}` |

All physical intervals use the canonical SI unit named by the schema path.
`IdentifierSet` is a mathematical set; path samples, sweep samples,
`fixture_ids` and `oracle_ids` are ordered sequences and retain their declared
order.

### 2.2 Required top-level object

| Field | Type and constraint |
|---|---|
| `schema` | Literal string `frequency_domain_validation_scope.v1` |
| `study_product` | Enum `modal_eigen | driven_response` |
| `discretization` | Literal string `fem` |
| `physics_scope` | Closed `PhysicsScope` object from section 2.3 |
| `problem_scope` | Closed `ProblemScope` object from section 2.4 |
| `solver_scope` | Closed `SolverScope` object from section 2.5 |
| `runtime_scope` | Closed `RuntimeScope` object from section 2.6 |
| `device_scope` | Closed `DeviceScope` object from section 2.6 |
| `material_scope` | Closed `MaterialScope` object from section 2.7 |
| `geometry_scope` | Closed `GeometryScope` object from section 2.7 |
| `fixture_ids` | Non-empty ordered array of unique `IdentityRef` values |
| `oracle_ids` | Non-empty ordered array of unique `IdentityRef` values |

### 2.3 `PhysicsScope`

| Field | Type and constraint |
|---|---|
| `equation_set` | `Identifier` naming the canonical linearized equation contract |
| `phasor_convention` | `Identifier` naming the time/complex-sign convention |
| `dynamic_field_convention` | `Identifier` naming the dynamic-field and observable convention |
| `equilibrium_class` | Enum `uniform | relaxed | nonuniform` |
| `included_interactions` | `IdentifierSet` containing every admitted interaction |
| `excluded_interactions` | Sorted unique array of `Identifier`; empty is allowed |
| `damping_policy` | `Identifier` |
| `nonconservative_policy` | `Identifier`; use literal `none` when excluded |

An interaction cannot occur in both interaction arrays. Omission is not an
exclusion declaration.

### 2.4 `ProblemScope`

`ProblemScope` is a closed object containing every field below.

| Field | Type and constraint |
|---|---|
| `mode_scope` | Closed object `{kind, branch_policy, class_ids, requested_count, spectral_window_rad_per_s, multiplicity_policy, tracking_policy, response_observable_ids, drive_scope}`. `kind` is `modal | driven`; `class_ids` is `IdentifierSet`; `requested_count` is `IntegerInterval`; `spectral_window_rad_per_s` is `ClosedInterval` with unit `rad_per_s` or literal `not_applicable`; `response_observable_ids` is a sorted unique identifier array; all other members are `Identifier`. Modal uses `response_observable_ids=[]` and `drive_scope=not_applicable`; driven uses `requested_count={minimum:0,maximum:0}`, `branch_policy=not_applicable`, `multiplicity_policy=not_applicable` and `tracking_policy=not_applicable`. |
| `k_scope` | Closed tagged union. K0 is `{kind:"k0", gamma_tolerance_rad_per_m:PositiveNumber}`. Nonzero-k is `{kind:"nonzero_k", path_id:Identifier, samples_rad_per_m:ordered non-empty array of finite three-number arrays, domain_rad_per_m:ClosedInterval(unit="rad_per_m"), gamma_tolerance_rad_per_m:PositiveNumber}`. |
| `dynamic_demag_scope` | Enum `none | periodic_airbox_k0 | floquet_airbox_nonzero_k` |
| `equilibrium_scope` | Closed object `{acceptance_policy:Identifier, torque_tolerance:PositiveNumber, norm_tolerance:PositiveNumber, artifact_policy:Identifier, signature_policy:Identifier}` |
| `boundary_scope` | Closed object `{magnetic_bc:Identifier, periodic_directions:sorted unique array drawn from [x,y,z], pairing_policy:Identifier, open_directions:sorted unique array drawn from [x,y,z], scalar_outer_bc:Identifier, robin_beta_per_m:ClosedInterval(unit="per_m") or "not_applicable"}`; periodic and open direction sets are disjoint |
| `gauge_scope` | Closed object `{policy:Identifier, augmentation:Identifier, nullspace_tolerance:PositiveNumber, constraint_tolerance:PositiveNumber}` |
| `fe_scope` | Closed object `{magnetic_space:Identifier, magnetic_order:PositiveInteger, scalar_space:Identifier, scalar_order:PositiveInteger, quadrature_rule:Identifier, mesh_quality:ClosedInterval(unit="dimensionless"), refinement_policy:Identifier}` |
| `problem_size_scope` | Closed object `{magnetic_dofs:IntegerInterval, scalar_dofs:IntegerInterval, total_dofs:IntegerInterval, largest_memory_bytes:NonNegativeInteger, largest_runtime_seconds:PositiveNumber}` |
| `operator_scope` | Closed object `{included_terms:IdentifierSet, excluded_terms:sorted unique identifier array, assembly_kind:Identifier, scalar_representation:Identifier}`; a term cannot occur in both arrays |
| `damping_scope` | Closed object `{alpha:ClosedInterval(unit="dimensionless"), nonnormal_policy:Identifier}` |

### 2.5 Mandatory `SolverScope`

`solver_scope` is not an engine nickname. It is the closed object below, and
every field is mandatory for modal and driven artifacts alike.

| Field | Type and constraint |
|---|---|
| `engine` | `Identifier` naming the exact production solver engine |
| `rtol` | `PositiveNumber` less than one |
| `max_iterations` | `PositiveInteger` |
| `restart` | `PositiveInteger` not greater than `max_iterations`; direct solvers use `1` |
| `linear_solver_family` | `Identifier`; use literal `none` only when no linear solve exists |
| `preconditioner` | Closed object `{family:Identifier, variant:Identifier, setup_policy:Identifier, reuse_policy:Identifier}`. Use `family=none` only when no preconditioner exists, and then every other member must also be `none`. |
| `spectral_transform` | Closed object `{family:Identifier, shift_rad_per_s:finite number or "not_applicable"}`; `none` is explicit |
| `target_representation` | Closed object `{family:Identifier, target_rad_per_s:finite number or "not_applicable", window_rad_per_s:ClosedInterval(unit="rad_per_s") or "not_applicable", sweep_hz:ordered array of finite positive numbers}`; modal uses an empty `sweep_hz`, driven uses `target_rad_per_s=not_applicable` |
| `device_residency` | Closed object `{operator, krylov_vectors, basis, preconditioner}` with each value in `host | device | mixed | not_applicable`, plus `{per_iteration_h2d_max:NonNegativeInteger, per_iteration_d2h_max:NonNegativeInteger, hidden_host_solves_allowed:boolean}` |
| `precision` | Enum `double | single` |
| `block_residual_contract` | Closed object `{operator_form:"original_unscaled", norm:"l2", required_blocks:IdentifierSet, aggregation:"max", denominator_policy:Identifier, absolute_scale_floor:PositiveNumber, acceptance_tolerance:PositiveNumber}`. `required_blocks` names every physical and constraint block, including scalar and gauge blocks when present. |
| `certificate_set` | `IdentifierSet` naming every certificate required for solver acceptance |
| `fallback_policy` | `Identifier`; strict no-fallback is explicit |
| `accepted_stop_reasons` | `IdentifierSet` |

Consequently, changing only `rtol`, iteration cap, restart, linear-solver
family, preconditioner object, transform/target representation, residency, precision,
residual contract or certificate set creates a different readiness cell.

### 2.6 Runtime and device scope

`RuntimeScope` is the closed object
`{fullmag_commit, build_id, native_abi, dependency_versions, managed_route}`.
`fullmag_commit` is exactly 40 lowercase hexadecimal characters; `build_id` and
`managed_route` are `Identifier`; `native_abi` is a `PositiveInteger`; and
`dependency_versions` is a sorted, non-empty array of closed
`{name:Identifier, version:Identifier}` objects covering every applicable
PETSc, SLEPc, hypre, libCEED, CUDA and compiler/runtime dependency.

`DeviceScope` is the closed object
`{requested, resolved, family, architecture, driver, runtime}`. `requested` is
`cpu | gpu | auto`, `resolved` is `cpu | gpu`, and the remaining fields are
`Identifier`; CPU scopes use explicit CPU values rather than `not_applicable`.

### 2.7 Material and geometry scope

`MaterialScope` is the closed object
`{class_ids:IdentifierSet, region_policy:Identifier, parameter_bounds}`.
`parameter_bounds` is a non-empty array of closed
`{name:Identifier, bounds:ClosedInterval}` objects, unique by `name`, and must
include bounded SI entries for `Ms`, gamma, exchange, anisotropy, damping and
every parameter used by an included interaction. After uniqueness validation,
canonicalization sorts `parameter_bounds` by `name` before serialization.

`GeometryScope` is the closed object
`{family:Identifier, dimension_bounds, periodic_cell_policy,
airbox_policy}`. `dimension_bounds` is a non-empty array of closed
`{name:Identifier, bounds:ClosedInterval}` objects, unique by `name`, covering
every fixture dimension and periodic-cell dimension. After uniqueness
validation, canonicalization sorts `dimension_bounds` by `name` before
serialization. `periodic_cell_policy` is a closed
`{directions:sorted unique array drawn from [x,y,z], cell_id:Identifier}`
object. `airbox_policy` is a closed
`{kind:Identifier, top_padding_m:ClosedInterval(unit="m") or "not_applicable",
bottom_padding_m:ClosedInterval(unit="m") or "not_applicable",
symmetry:Identifier}` object.

### 2.8 Reject-before-hash cross-field rules

The validator rejects contradictory objects before canonical serialization and
before any `scope_id` is computed. These rules are part of
`frequency_domain_validation_scope.v1` validation, not post-hash promotion
policy.

- `study_product=modal_eigen` requires
  `problem_scope.mode_scope.kind=modal`.
- `study_product=driven_response` requires
  `problem_scope.mode_scope.kind=driven`.
- `problem_scope.dynamic_demag_scope=periodic_airbox_k0` requires
  `problem_scope.k_scope.kind=k0`, accepted Gamma-resolved k under the stored
  `gamma_tolerance_rad_per_m`,
  `periodic_mesh_certificate.v6` in `solver_scope.certificate_set` with K0
  periodic policy, and no Floquet/nonzero-k demag certificate claim.
- `problem_scope.dynamic_demag_scope=floquet_airbox_nonzero_k` requires
  `problem_scope.k_scope.kind=nonzero_k`, a non-Gamma resolved k domain, and a
  `periodic_mesh_certificate.v6` entry whose Floquet metadata covers every
  listed k sample.
- `problem_scope.k_scope.kind=nonzero_k` rejects an all-Gamma sample set and
  requires `periodic_mesh_certificate.v6` in `solver_scope.certificate_set`.
  Its compatible dynamic demag values are `none` for no-demag Floquet products
  and `floquet_airbox_nonzero_k` for dynamic-demag products; it cannot use
  `periodic_airbox_k0`.
- `problem_scope.k_scope.kind=k0` cannot use
  `floquet_airbox_nonzero_k`, cannot carry nonzero-k Floquet samples, and
  cannot use a Floquet-only certificate as a substitute for the required K0
  periodic certificate.

Any contrary product/k/demag/certificate combination is invalid and receives no
canonical hash. The validator must report the first conflicting field paths so
the artifact is rejected rather than silently reclassified.

### 2.9 Canonical serialization and `scope_id`

The hash input is exactly the complete closed top-level object in section 2.2:

```text
schema, study_product, discretization
physics_scope, problem_scope, solver_scope
runtime_scope, device_scope, material_scope, geometry_scope
fixture_ids, oracle_ids
```

Each named object contributes every one of its required nested values. In
particular, the hash always includes the complete `solver_scope`: engine,
`rtol`, `max_iterations`, `restart`, `linear_solver_family`,
`preconditioner`, spectral transform, transform target/window/sweep,
device-residency layout and transfer limits, precision, full original-block
residual contract, certificate set, fallback policy and accepted stop reasons.
`scope_id`, artifact paths, timestamps, gate outcomes, metric results,
promotion state, evidence bindings and coverage rules are not hash inputs.

Canonicalization is deterministic:

1. validate the closed object against
   `frequency_domain_validation_scope.v1`, including every cross-field rule;
2. reject non-finite numbers and negative zero; encode all quantities in the
   schema-prescribed SI unit, sort every schema-declared set, reject duplicate
   set members, sort `material_scope.parameter_bounds` and
   `geometry_scope.dimension_bounds` by `name` after proving `name`
   uniqueness, and preserve only schema-declared ordered sequences;
3. serialize the validated object as UTF-8 with RFC 8785 JSON Canonicalization
   Scheme; and
4. compute `scope_id = "sha256:" + lowercase_hex(SHA-256(serialized_bytes))`.

The validator resolves and revalidates the complete object before recomputing
the hash. A caller-supplied ID is never trusted. Two objects that differ in any
hash input are different readiness cells.

### 2.10 `scope_catalog.v1`

Coverage cannot rely on an opaque hash alone. Every direct or coverage binding
resolves through a content-addressed `scope_catalog.v1` artifact that maps each
`scope_id` used by the binding to the complete canonical scope object.

`scope_catalog.v1` is the closed JSON object:

| Field | Type and constraint |
|---|---|
| `schema` | Literal string `scope_catalog.v1` |
| `scope_schema` | Literal string `frequency_domain_validation_scope.v1` |
| `scopes` | Non-empty closed map whose property names are `Sha256Id` values and whose values are complete `frequency_domain_validation_scope.v1` objects |

The catalog digest is computed as
`scope_catalog_sha256 = "sha256:" + lowercase_hex(SHA-256(RFC8785(scope_catalog.v1)))`.
For each `scopes` entry, the validator validates the complete scope object,
applies section 2.8, canonicalizes it under section 2.9, recomputes its
`scope_id`, and requires the recomputed ID to equal the map key. Duplicate
semantic scopes under different keys, a map key whose value hashes elsewhere,
or a catalog digest mismatch invalidates every binding that cites the catalog.

`scope_catalog_uri` is a non-empty artifact URI in the same immutable bundle or
an absolute content-addressed URI. A binding may instead embed the complete
catalog in `scope_catalog`, but it must still provide `scope_catalog_sha256`
and the embedded catalog's digest must match.

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
verified_coverage_of = validation_scope_binding.v1
evidence paths and sha256 hashes
fixture and oracle identities
metric values
required initial and production tolerances
verifier identity and result
implementation_state
validation_state before promotion
open blockers
```

Every evidence artifact has a required top-level `verified_coverage_of` field.
Its value is exactly one closed `validation_scope_binding.v1` object:

```text
verified_coverage_of = {
  schema: "validation_scope_binding.v1",
  scope_schema: "frequency_domain_validation_scope.v1",
  kind: "direct",
  scope_id: Sha256Id,
  scope_catalog_uri: string,
  scope_catalog_sha256: Sha256Id
}

verified_coverage_of = {
  schema: "validation_scope_binding.v1",
  scope_schema: "frequency_domain_validation_scope.v1",
  kind: "coverage",
  scope_catalog_uri: string,
  scope_catalog_sha256: Sha256Id,
  coverage_rule: coverage_rule.v1
}
```

Both objects are closed. A binding has exactly one catalog source: either
`scope_catalog_uri` plus `scope_catalog_sha256`, or an embedded
`scope_catalog` plus the same `scope_catalog_sha256`. A direct binding has no
`coverage_rule`; a coverage binding has no `scope_id`; no additional field or
third kind is legal. The direct form means the artifact evaluated the one
catalog-resolved `frequency_domain_validation_scope.v1` object whose recomputed
hash is `scope_id`. The coverage form is legal only for a bounded oracle or
aggregate whose evaluated subject scope covers every listed target under
section 3.2.

### 3.1 `verified_coverage_of` and `validation_scope_binding.v1` validation

The artifact validator first reads the required `verified_coverage_of` field,
then validates the closed binding variant and the literal `scope_schema`. It
loads `scope_catalog_uri` or the embedded `scope_catalog`, verifies
`scope_catalog_sha256`, validates the catalog under section 2.10, and
recomputes every catalogued `scope_id` from the complete canonical scope
object. It then accepts either one direct scope present in that catalog or one
`coverage_rule.v1` whose `subject_scope_id` and every `covered_scope_id` are
present in the same verified catalog. A caller cannot substitute a fixture
name, abbreviated tuple, parent scope ID, prose `validated_scope` claim,
standalone hash or independently supplied coverage list. A coverage binding is
invalid unless its rule is valid under section 3.2.

### 3.2 `coverage_rule.v1`

`coverage_rule.v1` is the following closed JSON object. It is mandatory for
`verified_coverage_of` when its `validation_scope_binding.v1.kind` is
`coverage`.

| Field | Type and constraint |
|---|---|
| `schema` | Literal string `coverage_rule.v1` |
| `relation` | Enum `exact | subset` |
| `subject_scope_id` | `Sha256Id` of the canonical scope actually evaluated by the artifact |
| `covered_scope_ids` | Non-empty ordered array of unique `Sha256Id` |
| `field_predicates` | Non-empty ordered array of closed `FieldPredicate` objects |

`FieldPredicate` is the closed object
`{covered_scope_id:Sha256Id, field_path:string, comparator:Comparator}`.
`field_path` is an RFC 6901 JSON Pointer to one canonical comparison address in
`frequency_domain_validation_scope.v1`; `covered_scope_id` must occur in
`covered_scope_ids`; and `Comparator` is exactly one of `equal`, `set_subset`
or `interval_subset`. A comparison address is one scalar, one complete
schema-declared `IdentifierSet`, one complete `ClosedInterval` or
`IntegerInterval`, or one complete schema-declared ordered sequence. Pointers
to partial containers, array slices, ancestors and wildcards are invalid.

Comparator direction is fixed and cannot be inverted:

- `equal`: the covered target value equals the subject value after canonical
  type validation;
- `set_subset`: the covered target set is a subset of the subject set; it is
  legal only on a complete schema-declared `IdentifierSet`; and
- `interval_subset`: the covered target closed or integer interval is contained
  in the subject interval with the same canonical SI unit where applicable,
  meaning
  `subject.minimum <= covered.minimum <= covered.maximum <= subject.maximum`.

For every `covered_scope_id`, `field_predicates` contains exactly one predicate
for every canonical comparison address, with no duplicate or omitted path.
Identity-bearing fields, ordered arrays, samples, fixture/oracle
references, product, discretization, runtime, resolved device, precision and
every non-set/non-interval solver field require `equal`. `relation=exact`
requires `covered_scope_ids=[subject_scope_id]` and `equal` at every path.
`relation=subset` requires at least one valid
`set_subset` or `interval_subset` predicate and equality everywhere else.

The validator resolves the complete subject and covered scope objects from the
verified `scope_catalog.v1`, recomputes every ID, evaluates all predicates and
rejects the rule if any covered target is broader than the subject's evaluated
domain. Therefore a three-field fast-CI subject cannot cover or promote a
15-field target, a K0 subject cannot cover nonzero-k, and CPU/double evidence
cannot cover GPU or single precision. Coverage permits reuse only from a scope
whose evaluated domain contains the target; it never promotes the broader
target scope.

An abbreviated tuple, fixture nickname, parent directory or matching runtime
signature is not a scope binding. Missing scope objects, an untyped prose
relation, a coverage binding without `coverage_rule.v1`, a binding without a
verified scope catalog, a catalog that does not contain every referenced
`scope_id`, or an unevaluated predicate makes the artifact stale for every
listed target.

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
| DOD-09 Artifacts/OpenAPI/UI | Complete artifacts-v2 bundle, typed OpenAPI/resource exposure and UI state for complete/partial/failed/unavailable outcomes | Cross-artifact hashes, scope catalog digest, units, revisions, requested/resolved state, accepted `verified_coverage_of` binding, and resource links agree; UI cannot overstate capability | Abbreviated scope tuple, untyped coverage claim, opaque scope hash without a verified catalog, raw files without resource contract, UI claim inferred from route presence, or JSON carrying heavy payloads outside the data plane |
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
| `scope_catalog_uri` or embedded `scope_catalog` | `scope_catalog.v1` containing the complete `validated_scope` object and every evidence-referenced scope object |
| `scope_catalog_sha256` | Digest of the exact catalog bytes or embedded catalog |
| `implementation_state` | `executable` |
| `validation_state_before_promotion` | The actual pre-promotion state |
| `items.DOD-01` through `items.DOD-14` | `pass`, `fail` or justified `not_applicable` |
| `item_evidence.DOD-01` through `item_evidence.DOD-14` | Gate IDs, one accepted `verified_coverage_of` binding, immutable artifact paths/hashes, fixture/oracle IDs, metrics, production tolerances and verifier result for every `pass` |
| `not_applicable_reasons` | One exact scope-derived reason for every `not_applicable` item |
| `open_blockers` | Empty for promotion |
| `promotion_decision` | `production_qualified` only after section 7 succeeds; otherwise `blocked` |

The record validator recomputes `scope_id`, verifies the scope catalog digest,
and validates every direct or coverage binding against catalog-resolved scope
objects. A record that omits a canonical scope field, evidence hash, catalog
entry or coverage proof is invalid rather than partially complete.

## 7. Promotion algorithm

The promotion validator performs these checks in order:

1. validate, RFC 8785-canonicalize and hash the complete `validated_scope`,
   after applying all reject-before-hash rules;
2. require `implementation_state=executable` for that scope;
3. resolve item applicability from the exact product/device/k/demag/engine
   tuple;
4. validate every evidence artifact's complete `verified_coverage_of` binding,
   including its `scope_catalog.v1` digest, every catalogued scope hash, and a
   directional `coverage_rule.v1` when its kind is `coverage`, fixture/oracle
   identity, metric and production tolerance;
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
