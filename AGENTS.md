# AGENTS.md — Fullmag Operating System

> **Canonical governance file for Fullmag**
>
> This file is the highest-priority project document for:
>
> - AI coding agents
> - human contributors
> - reviewers
> - maintainers
> - documentation authors
> - architecture and roadmap work
>
> If another instruction file contradicts this document, this file wins.

---

## 1. Mission

Fullmag is being built to become a **best-in-class micromagnetics platform** for:

- **authoring** physical problems,
- **running** them across multiple numerical backends,
- **observing** them live in a control room,
- **exporting** and **reproducing** the exact same simulation through one canonical public model.

Fullmag is **not** a collection of loosely related solvers.

Fullmag is **one application** with:

- one product identity,
- one semantic core,
- one canonical physical model,
- multiple execution realizations.

---

## 2. North star

Fullmag must always describe a **physical micromagnetic problem**, never a numerical storage layout or a solver implementation accident.

This has four consequences:

1. the public authoring contract must stay **physics-first**,
2. solver/backend choice must remain **explicit but secondary** to the problem definition,
3. all user surfaces must converge to the same canonical model,
4. provenance must preserve **requested intent** and **resolved execution reality**.

If a change makes Fullmag feel like “a thin wrapper around a backend,” it is likely the wrong change.

---

## 3. Product promise

The intended user experience is:

1. a user can author a simulation in the Python DSL,
2. a user can author the same simulation interactively in the browser,
3. both flows converge to the same canonical semantic representation,
4. the same problem can be executed headlessly, interactively, locally, or through managed runtimes,
5. the browser can export a canonical, human-editable Python script,
6. the browser can inspect live fields, meshes, artifacts, and stage execution without inventing alternate physics semantics,
7. reproducibility is preserved across authoring, planning, execution, and artifacts.

The browser is **not** a secondary admin panel.
It is a **first-class control room** and **authoring companion**.

---

## 4. Canonical public contract

The following are non-negotiable:

1. **One physical model contract**
   - Shared semantics live above solver internals.

2. **One canonical semantic representation**
   - `ProblemIR` is the canonical lowered representation.

3. **One canonical public scripting surface**
   - The embedded Python DSL in `packages/fullmag-py`.

4. **One runtime abstraction**
   - sessions, runs, stages, fields, artifacts, and live state.

5. **One round-trip rule**
   - UI-authored problems must round-trip to canonical Python DSL.

6. **One provenance model**
   - requested intent and resolved backend/runtime must both be visible.

7. **One capability language**
   - Python, UI, planner, runner, docs, and provenance must speak the same capability vocabulary.

8. **One resource-first control-room API**
   - The local browser contract is versioned, resource-scoped, and revision-driven.

9. **One control-plane / data-plane split**
   - Thin JSON carries state, capabilities, commands, and diagnostics; binary transport carries
     heavy numerical payloads.

10. **One frontend access path**
   - Components and hooks go through one typed API client, one resource-hook layer, and one
     capability/adapter boundary.

**Round-trip drift is a product bug.**

---

## 5. Canonical source hierarchy

When deciding truth, use this order:

1. **Physics notes in `docs/physics/`**
   - canonical scientific intent
   - equations, units, assumptions, observables, limits

2. **Architecture / spec docs in `docs/specs/` and `docs/adr/`**
   - canonical application and runtime design

3. **This file (`AGENTS.md`)**
   - canonical project operating rules

4. **Canonical public API**
   - `packages/fullmag-py`

5. **Canonical semantic model**
   - `ProblemIR`, validation, normalization, planning

6. **UI authoring / session state / script export**
   - must follow, never redefine, the above

If two layers disagree, the higher layer wins and the lower layer must be repaired.

---

## 6. Golden rule: physics before implementation

Before implementing any new physics or numerical feature, create or update a publication-style note in `docs/physics/`.

Every such note must include:

1. physical problem statement,
2. governing equations,
3. symbols and **SI units**,
4. assumptions and validity limits,
5. FDM interpretation,
6. FEM interpretation,
7. CPU/GPU/backend interpretation where relevant,
8. public Python API impact,
9. `ProblemIR` impact,
10. planner/capability impact,
11. runtime/session impact,
12. artifact/provenance impact,
13. validation plan,
14. completeness checklist,
15. deferred work.

If the physics note is missing or incomplete, the task is **not implementation-ready**.

---

## 7. Strategic priority stack

## 7.1 Current top execution priority

**GPU-first FDM/CUDA** remains the top execution priority until it is truly production-grade.

That means:

1. CPU FDM reference remains the trusted `double` oracle.
2. GPU FDM public execution must reach strong parity in `double`.
3. GPU `single` stays behind qualification gates until validated.
4. Backend selection must become **more explicit**, not less explicit.
5. FDM performance work must not destroy semantic consistency.

## 7.2 In parallel, but not at the expense of correctness

The following workstreams are important and active:

- FEM shared-domain meshing
- FEM magnetostatics / demag realizations
- relaxation correctness and stage lifecycle
- live field-store / quantity switching
- matrix-free eigensolve / frequency-domain stack
- viewport and inspection UX
- managed runtime packaging

But no workstream is allowed to bypass the canonical model.

---

## 8. What Fullmag is and is not

## 8.1 Fullmag is

- a micromagnetics application,
- a canonical Python DSL,
- a Rust control plane,
- a browser control room,
- a multi-backend execution platform,
- a provenance-preserving scientific toolchain.

## 8.2 Fullmag is not

- a UI-only simulation editor,
- a bag of backend-specific scripts,
- a mesh viewer pretending to be a solver,
- a backend-specific config generator,
- a hidden-fallback execution shell,
- a place where stale concepts accumulate unchallenged.

---

## 9. Architectural layers

Fullmag must remain explicitly layered.

```mermaid
flowchart TD
  U[User surfaces] --> P[Python DSL / UI authoring]
  P --> IR[Canonical ProblemIR]
  IR --> V[Validation + normalization]
  V --> PL[Planning + capability checks]
  PL --> RT[Session / run / stage runtime]
  RT --> BE[Native backends]
  RT --> ART[Artifacts + provenance + live fields]
  ART --> UI[Control room / analysis / export]
```

### Layer responsibilities

| Layer | Responsibility | Must never do |
|---|---|---|
| Python DSL | public authoring surface | leak backend internals into common semantics |
| UI authoring | first-class authoring companion | invent a second physical model |
| ProblemIR | canonical lowered semantics | encode UI-only quirks |
| Planner | validation, capability resolution, backend selection | silently erase user intent |
| Runtime | sessions, stages, state, fields, artifacts | become solver-specific policy soup |
| Native backends | high-performance compute | define public product semantics |
| Control room | observability + live authoring + export | bypass canonical model |

### 9.1 Control-room API invariant

The canonical local browser contract is the v2 session-scoped resource-first API documented in:

- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/adr/0011-resource-first-api.md`

Rules:

- frontend work targets `/v2/platform/...` and `/v2/sessions/current/...`; public `/v1/live/current/...` has been removed,
- v2 route families are `platform`, `sessions`, `model`, `meshing`, `simulation`, `data`, `visualization`, `workspace`, `analysis`, `persistence`, and `diagnostics`,
- `GET /v2/sessions/current/status` stays thin and revision-driven,
- domain, field, scalar, artifact, mesh, workspace, and session data are fetched as named resources,
- heavy fields and topology belong on the binary data plane, not inside status,
- mesh/topology and field samples must support scoped access for selected objects, mesh parts, airbox, and workspace selection,
- frontend code must use the central typed client/facade and must not hand-roll endpoint strings outside the API client layer,
- JSON contract changes must be reflected in OpenAPI and shared frontend types.

### 9.2 Frontend architecture invariant

The control room must use:

- one typed API client,
- one resource-hook layer,
- one capability vocabulary,
- one domain-adapter layer,
- one unified UI tree.

The control room must not:

- call `fetch()` directly from React components,
- fork the product tree into separate FDM and FEM applications,
- treat old `bootstrap` / `poll` / `preview/*` flows as canonical architecture.

---

## 10. Execution-selection doctrine

Execution choice must be easy for the user and explicit in the architecture.

The user-facing execution vocabulary should remain:

- **discretization**: `fdm | fem | auto | hybrid (future)`
- **device**: `cpu | gpu | auto`
- **precision**: `single | double`
- **execution mode**: `strict | extended | hybrid`
- **UI mode**: `headless | ui | auto`

### Rules

1. Requested intent and resolved reality must both be preserved.
2. `auto` may be resolved, but never silently forgotten.
3. Unsupported paths must fail clearly or degrade explicitly.
4. Public surfaces must not require users to understand CUDA image names, MFEM internals, raw buffers, or implementation-only toggles.
5. If one surface cannot express a choice another surface can express, that is product debt.
6. Backend-specific knobs belong in explicit advanced/backend-hint scopes only.

---

## 11. Backend authority policy

Each solver family needs:

- one **authoritative production backend**
- one **reference / validation backend**

### 11.1 FDM

| Role | Backend | Authority |
|---|---|---|
| Reference | Rust CPU reference | trusted physics oracle |
| Production CPU/HPC | Rust production FDM | authoritative CPU production path |
| Production GPU | native CUDA FDM | authoritative GPU production path |

### 11.2 FEM

| Role | Backend | Authority |
|---|---|---|
| Reference | Rust FEM reference | validation oracle, debug path |
| Production CPU | native MFEM/hypre/libCEED | authoritative CPU production path |
| Production GPU | native MFEM/libCEED/CUDA | authoritative GPU production path |

### 11.3 Frequency-domain / eigensolve

Long term, the authoritative path should be:

- **matrix-free Krylov-based modal and linear-response backend**
- shared operator stack with time-domain solvers
- no dense O(n³) default path for realistic production problems

Dense eigensolvers may exist only as:

- small-problem bootstrap tools,
- debugging tools,
- regression or parity tools.

---

## 12. Performance doctrine

Fullmag aims for top-tier computational performance, but never through semantic shortcuts.

## 12.1 Performance priorities

1. **correctness**
2. **semantic clarity**
3. **backend authority**
4. **zero-alloc hot loops**
5. **data layout and cache behavior**
6. **parallel scaling**
7. **I/O and artifact efficiency**
8. **UI and transport efficiency**

## 12.2 Required performance principles

### Native compute
- no hot-loop heap allocations,
- explicit workspace reuse,
- SoA where appropriate,
- predictable ownership and memory lifetime,
- CPU affinity / NUMA awareness for HPC paths,
- GPU kernels validated in `double` before `single`.

### Runtime / data plane
- heavy field payloads must not ride on JSON if binary transport is appropriate,
- status/control-plane payloads must stay thin and revision-driven,
- live quantity switching must prefer field-store reads over preview recompute,
- mesh/topology must be separated from field values,
- expensive operators should be cached and keyed by valid provenance signatures,
- request correlation and contract-version headers must remain first-class for browser/API work.

### UI
- no accidental always-on rendering without reason,
- topology rebuilds must be separate from field-buffer swaps,
- overlays and viewport logic should be modular and low-churn,
- state shape must be canonical and transport-friendly.

---

## 13. Semantic invariants by subsystem

## 13.1 Python DSL invariant

The embedded Python DSL is the only canonical public scripting surface.

Implications:

- UI must be exportable to Python DSL.
- Public scripts must remain human-editable.
- Backend-specific implementation details must not leak into the common surface.
- If a UI concept cannot be expressed in canonical Python, the concept is incomplete.

## 13.2 ProblemIR invariant

`ProblemIR` is the semantic center of gravity.

Implications:

- planner decisions must be derivable from IR,
- provenance must refer back to IR intent,
- UI scene/script-builder state must not drift from IR semantics.

## 13.3 Session/run invariant

The session runtime is the product control-plane.

Implications:

- stages must have explicit lifecycle,
- commands must have explicit intent and completion status,
- live state must distinguish compute state from display-selection state,
- fields, scalars, artifacts, and display resources must have stable contracts,
- local current-live API must expose revisions and capabilities as first-class runtime truth.

## 13.4 Provenance invariant

Every meaningful action must be reproducible.

Implications:

- requested backend vs resolved backend must be stored,
- mesh configuration and realized mesh summary must be exportable,
- stage completion reason must be explicit,
- field revisions and mesh revisions must be visible where needed.

---

## 14. FEM mesh doctrine

This rule is non-negotiable.

For FEM, Fullmag must preserve **three distinct semantic layers**:

1. **Universe mesh config**
   - study-level meshing policy for air/domain

2. **Per-object mesh config**
   - independent local meshing policy for each magnetic object

3. **Final shared-domain solver mesh**
   - one conforming solver mesh assembled from universe + objects

### Consequences

- `Universe` is not “just another object”.
- Per-object controls must stay first-class.
- Build-selected may be context-sensitive, but final FEM solve still consumes one conforming shared-domain mesh.
- Visibility / isolate mode must never alter physics.
- Air meshing is expected to be coarser than magnetic/interfacial meshing where appropriate.
- Interface refinement, transition grading, swept regions, and adaptive remeshes are solver semantics, not viewport tricks.

### Anti-regression rule

Any change that collapses:

- universe mesh,
- object mesh,
- final solver mesh

back into one anonymous blob is an architectural regression.

---

## 15. Mesh modernization doctrine

Fullmag currently carries multiple mesh workstreams. They must converge, not fork.

### Required end-state

- COMSOL-like size semantics:
  - maximum element size
  - minimum element size
  - maximum element growth rate
  - curvature factor
  - narrow region resolution
- first-class universe/object/interface/transition semantics
- airbox grading that decays with distance from magnetic bodies
- boundary-layer / swept support where geometrically valid
- adaptive remeshing as a distinct workflow, not a vague preset
- shared-domain FEM as the only conforming solver mesh with universe present
- script round-trip for all first-class mesh semantics

### Required discipline

If a mesh control exists in UI but not in script export, Rust schema, and realized build report, it is **not done**.

---

## 16. Relaxation and time-integration doctrine

Relaxation is not just “run with a stop criterion”.

### Required end-state

- relax stages must have explicit:
  - algorithm
  - solver/integrator where applicable
  - dt policy
  - stop criteria
  - stop reason
- solver logs must state why a stage ended
- UI must display stage completion or failure clearly
- pseudo-time budgets must never depend on accidental low-level defaults like `dt_min`
- `llg_overdamped` should expose user-facing solver ergonomics comparable to mumax-style workflows
- minimizers and time integrators must not be conflated in the user model

### Anti-regression rule

A relax stage that ends without an explicit stop reason is a product bug.

---

## 17. Field-store doctrine

The browser must treat already-computed quantities as data, not as preview commands.

### Required end-state

- solver/runtime publishes hot fields continuously,
- API exposes a read-optimized thin status plus field catalog and field buffers,
- warm quantity switching is local and near-instant,
- geometry/topology revision is separate from field revision,
- statistics needed for legends/scales should be precomputed where possible,
- legacy bootstrap/poll/preview transports must not define the browser contract.

### Anti-regression rule

Quantity switching for already available data must not enqueue preview-control work unless truly necessary.

---

## 18. Frequency-domain and eigensolve doctrine

Frequency-domain work is a first-class product direction.

### Required long-term end-state

- canonical `eigenmodes` and `frequency_response` problem families,
- equilibrium import from time-domain results,
- matrix-free Krylov eigensolve,
- linear response solver,
- reduced-order modal response,
- first-class BCs for:
  - pinning,
  - periodic,
  - Floquet periodic,
  - EASA / surface anisotropy,
- explicit UI and Python contracts for those choices.

### Policy

Dense small-problem eigenpaths are allowed only as transitional tools.
They must not define the long-term product architecture.

---

## 19. Multiphysics doctrine

Coupling is allowed, but the micromagnetic contract remains primary.

Examples:

- magnetostatics,
- RF / antenna-driven response,
- STT / SOT,
- thermal noise,
- magnetoelasticity,
- future multiphysics couplings.

Rules:

1. coupling must be explicit in docs and API,
2. units must remain explicit and SI-clean,
3. coupled fields must still preserve one canonical provenance chain,
4. UI and script export must agree on coupling semantics.

---

## 20. Reference-solver policy

`external_solvers/` is for **learning**, not copying.

Use them to study:

- workflow patterns,
- modular decomposition,
- performance architecture,
- validation style,
- packaging strategy.

### Learn specifically from

- **mumax3 / mumax+**
  - GPU-first FDM
  - lightweight scripting ergonomics
  - pragmatic relax/minimize semantics
  - FFT-centered operator layout

- **BORIS**
  - modular multiphysics
  - CUDA decomposition
  - large-scale GPU runtime patterns

- **tetmag / tetrax**
  - FEM operator design
  - matrix-free ideas
  - frequency-domain architecture
  - demag/operator caching concepts

### Hard rule

Never paste code from external solvers into Fullmag.

---

## 21. Honesty doctrine

Fullmag documentation and status must remain honest.

### Always distinguish

- **target architecture**
- **implemented architecture**
- **bootstrap/transitional path**
- **reference-only path**
- **planned work**

Do not describe aspirational work as production-ready.
Do not hide known limitations behind vague wording.
Do not claim parity that has not been validated.

Honest docs build trust and make the roadmap actionable.

---

## 22. Modularity rules

Performance work does not justify monoliths.

### Required rules

1. Separate semantic layers from execution layers.
2. Separate backend policy from backend implementation.
3. Separate operator modules from solver shells.
4. Separate packaging from semantics.
5. Separate observability from execution.
6. Keep files reasonably bounded.
7. Prefer focused modules over god-files.
8. Split viewports into:
   - scene/model logic,
   - transport/state logic,
   - UI overlays and controls.
9. Keep one typed frontend API client and resource-hook layer; React components do not talk to the
   network directly.
10. Keep FDM/FEM differences inside capability guards and domain adapters, not duplicated control-room
   trees.

### File size rule

No single source file should exceed roughly **1000 lines** unless there is a very strong, documented reason.

When a file grows past that threshold, split it.

---

## 23. Repository map

| Path | Role |
|---|---|
| `packages/fullmag-py` | canonical public Python DSL |
| `crates/fullmag-ir` | typed canonical IR |
| `crates/fullmag-plan` | planner, capability resolution |
| `crates/fullmag-cli` | CLI launcher and orchestration |
| `crates/fullmag-api` | control-plane API |
| `crates/fullmag-runner` | runner and stage execution |
| `crates/fullmag-engine` | trusted CPU/reference solvers |
| `crates/fullmag-py-core` | private Python/Rust bridge |
| `apps/web` | control room / browser UX |
| `native/` | production native backends |
| `docs/` | specs, ADRs, physics notes |
| `.agents/` | agent workflows / skills |
| `.github/` | mirrored summaries and CI hints |

---

## 24. Canonical build and run entrypoints

Prefer `just` recipes when they exist.

### Canonical build entrypoints
- `just build fullmag`
- `just build fem-gpu-runtime-host`
- `just package fullmag`

### Canonical run entrypoints
- `just run ...`
- `just run-py-layer-hole`
- `just control-room`

`make` is a compatibility/developer fallback.
Raw `cargo`, `docker compose`, and similar commands are debugging tools, not the default user guidance.

---

## 25. Development workflow requirements

Every serious feature should follow this sequence:

1. update physics note,
2. update or add architecture/spec note if needed,
3. update Python/API surface,
4. update IR / planner / runtime contracts,
5. update live API / OpenAPI / capability / adapter contracts when control-room behavior changes,
6. update native backend behavior,
7. update session/live state if user-visible,
8. update UI and script export,
9. add tests,
10. update AGENTS/README/specs if project direction changed.

Skipping steps 3–7 and only “making the backend work” is not acceptable for user-facing features.

---

## 26. Definitions of done

A feature is only done when all applicable layers are done.

### 26.1 Physics/numerics feature done
- physics note updated,
- public Python surface defined,
- units and semantics stable,
- IR lowered correctly,
- planner understands support/limits,
- runtime carries the right state,
- native backend executes correctly,
- artifacts/provenance record it,
- docs explain it,
- tests cover it.

### 26.2 Mesh feature done
- UI edit path works,
- scene/script-builder round-trip works,
- Rust authoring schema matches TS schema,
- Python script export renders it,
- build report exposes effective targets,
- realized mesh matches intent,
- quality/reporting visible,
- acceptance cases pass.

### 26.3 Solver stage feature done
- lifecycle explicit,
- logs clear,
- stop reason explicit,
- UI stage tree reflects status,
- artifact/provenance records result,
- errors are visible without log spelunking.

### 26.4 Viewport feature done
- data transport correct,
- no semantic drift from solver state,
- performance acceptable,
- interaction documented,
- screenshot/capture path preserved,
- warnings and degraded states explicit.

### 26.5 Control-room API feature done
- thin status remains thin,
- revisions and generation ids are explicit,
- OpenAPI and shared types are updated,
- binary codecs cover heavy resources,
- one API client / resource-hook path is preserved,
- FDM/FEM differences stay inside capability/adapters,
- legacy bootstrap/poll/preview dependencies are retired or explicitly transitional.

---

## 27. Must-have test classes

Every major subsystem should have tests from the relevant groups below.

### Semantics / authoring
- Python ↔ IR round-trip
- UI scene/script-builder ↔ Python export round-trip
- unit consistency

### Planning / runtime
- capability checks
- backend resolution
- stage lifecycle
- command completion and rejection semantics

### Solver correctness
- reference parity
- invariants and conservation checks
- benchmark reproduction
- convergence studies

### Mesh
- per-object target effectiveness
- airbox grading
- interface refinement
- swept / boundary-layer validity
- shared-domain conformity

### UI / control room
- API contract coverage for status/domain/fields/scalars/display/commands
- binary codec tests and malformed-payload rejection
- cache invalidation by revision and generation
- capability/adapters coverage across FDM and FEM
- stage status updates
- quantity switching
- viewport revision handling
- artifact browsing
- warning surfaces

---

## 28. Legacy concepts to retire

The following stale concepts should be actively retired when encountered:

| Legacy concept | Replace with |
|---|---|
| anonymous final mesh blob | explicit universe/object/shared-domain mesh semantics |
| preview mutation as quantity switch | field-store data plane |
| monolithic bootstrap / poll session blob | thin status + on-demand resource families |
| hidden solver fallback | explicit requested vs resolved execution |
| UI-only mesh semantics | canonical script + IR + runtime contract |
| direct `fetch()` in React components | typed shared API client + resource hooks |
| FDM/FEM UI forks | capability guards + domain adapters + one UI tree |
| long-lived old/new API dual stack | one canonical resource-first stack after migration |
| dense eigensolver as default future path | matrix-free Krylov operator architecture |
| “relax = run with another stop” | explicit relax semantics and stop reason |
| monolithic viewport file | split model/hooks/overlays/scene |

---

## 29. Communication style for agents and contributors

When proposing or implementing changes:

- be explicit,
- be honest about what is implemented vs planned,
- call out unit systems,
- call out performance implications,
- call out round-trip implications,
- call out migration impact,
- call out missing tests,
- call out stale concepts being replaced.

Do not bury the most important architectural consequence in the middle of a long patch.

---

## 30. The standard for “good”

A good Fullmag change has these properties:

- improves the product, not just one codepath,
- preserves canonical semantics,
- makes runtime behavior more explicit,
- reduces drift between Python, UI, IR, and execution,
- strengthens correctness and provenance,
- improves performance without semantic shortcuts,
- leaves the repository more modular and easier to understand.

---

## 31. Final rule

When in doubt, ask:

> Does this make Fullmag a clearer, more correct, more explicit, more reproducible, and more performant micromagnetics application?

If not, stop and redesign.
