# Fullmag Application Architecture v1

- Status: canonical
- Last updated: 2026-03-23
- Owners: Fullmag core
- Related docs:
  - `docs/1_project_scope.md`
  - `docs/2_repo_blueprint.md`
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/exchange-only-full-solver-architecture-v1.md`
  - `docs/plans/active/frontend-architecture.md`
  - `docs/physics/README.md`

## 1. Purpose

This document is the **single canonical architecture document for the Fullmag application**.

It answers the product-level question:

> What is Fullmag as a complete application, how do its layers fit together, what are the
> non-negotiable architectural rules, and how do solver, control plane, frontend, artifacts,
> and documentation form one coherent system?

This document is intentionally broader than any one solver slice.

- `docs/specs/exchange-only-full-solver-architecture-v1.md` describes the first physically
  meaningful solver architecture.
- This document describes the **whole application concept** around that solver and future ones.

If a future plan or implementation detail conflicts with this document, this document should be
treated as the higher-level source of truth unless explicitly superseded.

## 2. Product Definition

Fullmag is a micromagnetics platform for describing **one physical problem** and executing it
through:

- FDM,
- FEM,
- hybrid execution.

The user should describe the same physical problem once, using a backend-neutral public interface,
and the system should:

1. preserve the physical meaning of that problem,
2. validate what is and is not executable,
3. lower it into backend-specific execution plans,
4. execute it through the selected backend,
5. produce coherent artifacts, provenance, diagnostics, and documentation.

Fullmag is therefore not only:

- a solver,
- a Python package,
- a CLI,
- a web dashboard,
- or a collection of backend experiments.

It is a **single application** with a shared physical contract across authoring, planning,
execution, observation, and publication-style documentation.

## 3. North Star

The north star of Fullmag is:

> A user writes one Python-authored micromagnetic problem and can inspect, validate, execute,
> compare, and document that same problem through a unified application surface, while preserving
> backend-neutral physical semantics and explicit provenance.

In practical terms, the application must eventually support:

- Python as the only public authoring layer,
- Rust as the control plane,
- native backends for heavy compute,
- a browser control room for live and historical inspection,
- publication-style physics documentation integrated into the product,
- reproducible artifacts and comparison across discretization backends.

## 4. Non-Negotiable Rules

### 4.1 Physics-first

The shared interface must describe the **physical problem**, not the storage layout.

This means the public layer can expose:

- geometry,
- regions,
- materials,
- magnets,
- energy terms,
- dynamics,
- outputs,
- discretization hints,
- execution policy.

Important clarification:

- regions define topology and domain structure,
- materials define base material identities,
- smooth spatial parameter variation must not be forced through artificial region fragmentation.

It must not expose backend-specific storage primitives as shared concepts, such as:

- direct cell indexing,
- raw CUDA arrays,
- MFEM spaces,
- backend-owned mesh internals.

### 4.2 Python is the only public scripting language

Fullmag uses an embedded Python DSL in the `fullmag` package.

There is:

- no separate text DSL,
- no frontend-owned scripting language,
- no AST parsing phase as a semantic contract,
- no source-code inference as the authoritative interpretation of a problem.

The authoritative chain is:

```text
Python objects -> canonical ProblemIR -> Rust validation/planning -> backend execution
```

### 4.3 Rust owns control-plane truth

Rust is the authoritative control plane for:

- validation,
- normalization,
- capability checking,
- planning,
- scheduling,
- execution orchestration,
- artifact metadata,
- provenance.

The frontend must consume this truth. It must not reinvent it.

### 4.4 Frontend is a control room, not a physics interpreter

The browser may display:

- normalized problem summary,
- planner diagnostics,
- run/session state,
- charts,
- fields,
- logs,
- documentation.

But all physics meaning, legal/executable status, and backend capability state must come from
backend-authored data.

### 4.5 Physics documentation is mandatory

Every physics-facing or numerics-facing feature must be documented first in `docs/physics/`
in publication style, then checked for completeness across:

- Python API,
- `ProblemIR`,
- planning,
- runner/backend,
- artifacts,
- comparison/validation,
- documentation/user surfaces.

This is a product rule, not only a docs rule.

### 4.6 One application, many execution modes

FDM, FEM, and hybrid are not separate products.

They are execution realizations of the same application contract.

That means:

- shared observable names,
- shared provenance concepts,
- shared capability language,
- shared compare layer,
- shared session/run concepts,
- shared frontend mental model.

## 5. Canonical User Experience

## 5.1 Primary local workflow

The primary workflow is local and CLI-driven:

```text
fullmag script.py
```

The intended behavior of this command is:

1. load the Python script,
2. build the Python problem graph,
3. serialize canonical `ProblemIR`,
4. validate and plan in Rust,
5. start the run,
6. start a local API/web session,
7. open the browser automatically,
8. show live execution state in the browser.

This makes the browser part of the normal local execution experience.

The browser is not only a later dashboard. It is a live control room.

## 5.2 Headless workflow

Fullmag must also support a non-UI execution mode:

```text
fullmag script.py --headless
```

In this mode:

- the same planning and execution contract applies,
- no browser is opened,
- no local UI server is required,
- artifacts and logs are still produced.

## 5.3 Future remote workflow

The remote or cluster workflow should reuse the same mental model:

```text
fullmag submit script.py --target cluster-a
```

The difference is not the product model, only the location of the control plane and workers.

## 6. Layered System Architecture

```text
Python script / notebook / generated template
                    |
                    v
          fullmag embedded Python DSL
                    |
                    v
       Python-built canonical ProblemIR
                    |
                    v
 Rust validation + normalization + capability checking
                    |
                    v
         ExecutionPlanIR / session orchestration
          |                    |                 |
          v                    v                 v
      FDM backend          FEM backend      Hybrid backend
          |                    |                 |
          +-----------> Common artifact model <+
                                |
                                v
                 Local/remote API + session event stream
                                |
                                v
                      Next.js browser control room
                                |
                                v
                   User inspection / compare / docs
```

## 7. Source-of-Truth Hierarchy

The application must preserve a strict source-of-truth hierarchy.

### 7.1 Authoring truth

- Public authoring truth: Python script building `fullmag` objects.

### 7.2 Semantic truth

- Canonical semantic truth: `ProblemIR`.

### 7.3 Execution truth

- Backend-lowered execution truth: `ExecutionPlanIR` plus runtime session state.

### 7.4 Result truth

- Artifact truth: metadata, field snapshots, scalar tables, logs, provenance.

### 7.5 Documentation truth

- Physics truth in prose: `docs/physics/`.
- Application architecture truth: this document.
- Repository/workspace layout truth: `docs/2_repo_blueprint.md`.

The frontend must never skip this hierarchy and infer semantics directly from source text.

## 8. Application Subsystems

## 8.1 Python package

The `fullmag` package is the only public authoring SDK.

It has two layers:

- `fullmag.model`
- `fullmag.runtime`

### Model layer responsibilities

- express the physical problem,
- provide typed object construction,
- serialize canonical `ProblemIR`,
- remain backend-neutral.

### Runtime layer responsibilities

- loading scripts,
- constructing `Simulation`,
- choosing backend/mode/precision policy,
- delegating execution to Rust-backed runtime surfaces.

The runtime layer may feel imperative to the user, but it must still preserve the backend-neutral
problem model.

## 8.2 Canonical IR

`ProblemIR` is the system boundary between authoring and control plane.

It must preserve:

- physical meaning,
- naming,
- units,
- execution policy,
- provenance inputs,
- future extensibility.

It must not become:

- backend scratch storage,
- GPU layout storage,
- implicit execution cache.

`ExecutionPlanIR` is the next boundary:

- it expresses how a requested problem will be realized numerically,
- it may contain backend-specific plan details,
- but it must still remain interpretable and auditable.

## 8.3 Planner and capability layer

The planner answers:

1. is this problem legal?
2. is it executable for the requested backend/mode?
3. which execution plan is chosen?
4. what approximations or restrictions apply?

The capability system must classify features honestly, using states such as:

- semantic-only,
- internal-reference,
- public-executable,
- planned,
- unsupported.

This capability language must remain aligned across:

- docs,
- API responses,
- CLI messages,
- browser UI.

## 8.4 Runner and session manager

Execution should be modeled around **sessions** and **runs**.

A session owns:

- lifecycle state,
- logs,
- planner diagnostics,
- run metadata,
- live event stream,
- links to artifacts.

The runner owns:

- actual backend execution,
- step evolution,
- snapshot scheduling,
- artifact emission,
- final status.

The session manager is what allows the same run to be:

- observed live in the browser,
- examined later as a finished run,
- reused for local and future remote targets.

## 8.5 API layer

The API layer is not optional glue.
It is the public control-plane surface for:

- local browser integration,
- future remote execution,
- run/session inspection,
- compile/validate/plan endpoints,
- artifact access.

At minimum, the architecture requires:

- session endpoints,
- live event streaming,
- run metadata access,
- artifact access,
- compile/validate/plan endpoints for browser tooling.

## 8.6 Frontend

The frontend is a browser control room built in Next.js.

Its responsibilities are:

- live run observability,
- historical run browsing,
- field visualization,
- scalar charting,
- planner/status display,
- physics-doc rendering,
- later editor/template UX,
- later compare workflows.

Its first required product slice is **live run visibility** for the current executable solver path.

The frontend is therefore downstream of the solver and control-plane contracts, but it is also a
first-class part of the product experience.

## 8.7 Native backends

Heavy compute belongs to native backends behind stable C ABI seams.

Current and target backend roles:

- FDM:
  - current honest baseline: CPU reference engine,
  - target production path: CUDA/C++.
- FEM:
  - target path: MFEM + libCEED + hypre behind native interfaces.
- Hybrid:
  - future coupled execution mode using projections and split operators.

The shared application contract must stay stable while backend internals evolve.

## 9. Frontend Architecture Position

The frontend architecture is a subordinate application architecture, not a separate product theory.

Its canonical product role is:

> the live and historical control room for Fullmag sessions and artifacts.

The browser should eventually support:

- automatic launch from local CLI runs,
- live charting and field viewing,
- artifact browsing,
- physics-document rendering,
- later browser-side editing and submission,
- later compare tools.

The browser must not require:

- browser-side physics parsing,
- browser-side Python execution,
- browser-side capability logic independent of Rust.

## 10. Artifact and Provenance Model

Artifacts are part of the core application contract.

Every meaningful run must publish enough information to support:

- reproduction,
- inspection,
- compare workflows,
- frontend rendering,
- scientific reporting.

The application-level artifact families are:

- metadata
- scalar diagnostics
- field snapshots
- logs
- plan/provenance payloads
- later mesh/geometry payloads
- later compare outputs

At the application level, artifacts must always preserve:

- problem identity,
- plan identity,
- backend identity,
- mode,
- precision,
- solver/version provenance,
- sampling context.

Canonical artifact-container policy:

- `.zarr` is the primary native container for time-sampled run data:
  - chunked field snapshots,
  - scalar traces,
  - append-friendly live or incremental output.
- `.h5` / HDF5 is the canonical portable container for packaged scientific results and export.
- OVF / OVF2 compatibility is a first-class interoperability requirement:
  - regular-grid FDM field snapshots must be exportable to OVF without semantic loss,
  - Fullmag should be able to import and export OVF-compatible field snapshots for OOMMF/MuMax
    workflows,
  - FEM field snapshots may expose an OVF-compatible view when the target data model is representable
    as sampled vector values, but OVF is not the canonical raw container for FEM run state because
    Fullmag must also preserve mesh topology and finite-element metadata.
- JSON may still be used for lightweight metadata/manifests.

Important clarification:

- the current JSON/CSV artifact writer is a bootstrap implementation only,
- JSON/CSV must not be treated as the long-term canonical format for sampled scientific outputs,
- the long-term product contract is that sampled outputs should be representable in `.zarr` and
  `.h5`,
- OVF remains an interchange/export contract, not the native multi-time-step storage contract.

The storage implementation may evolve, but the product contract around provenance, naming, and
scientific usability must not weaken.

## 11. Documentation Architecture

Fullmag has three documentation layers:

### 11.1 Application architecture

This document.

### 11.2 Stable subsystem and policy specs

Examples:

- `problem-ir-v0`
- capability matrix
- geometry policy
- output naming policy
- exchange boundary policy
- frontend architecture

### 11.3 Physics publication notes

These live in `docs/physics/` and document:

- physical equations,
- units,
- discretization implications,
- software consequences,
- validation strategy,
- limitations.

The frontend should render the physics notes directly so that implementation and user-facing
reference stay aligned.

## 12. Repository Shape

The repository is one monorepo that owns:

- public Python package,
- Rust control plane,
- native backend seams,
- web app,
- specifications,
- plans,
- physics documentation.

See `docs/2_repo_blueprint.md` for the detailed repository structure.

The important architectural point is not the folder names themselves, but that all these pieces are
developed against one shared source-of-truth stack.

## 13. Current Honest State

As of this revision, the application is in an early but coherent bootstrap state.

Publicly executable today:

- Python-authored problem definition,
- Python package entrypoint for script-driven runs,
- `ProblemIR` serialization,
- Rust validation/planning,
- narrow FDM execution slice:
  - `Box`
  - `Exchange`
  - `LLG(heun)`
  - `fdm/strict`
  - current CPU reference execution

Architecturally defined but not yet fully productized:

- live browser control room,
- local API session flow launched by `fullmag script.py`,
- CUDA FDM production backend,
- FEM execution backend,
- cross-backend compare tooling.

This is acceptable because the architecture is already explicit about what is real and what remains
planned.

## 14. Implementation Priorities Implied by This Architecture

The current priority order should be:

1. preserve the physics-first contract,
2. preserve Python -> `ProblemIR` -> Rust as the only semantic path,
3. build the local session/API/browser loop for live runs,
4. replace CPU FDM reference execution with calibrated CUDA FDM production execution,
5. strengthen artifacts and comparison tooling,
6. then grow FEM execution and later hybrid execution.

This ordering keeps the application coherent while growing real capability.

## 15. Canonical Reading Order

When someone needs to understand Fullmag quickly, the reading order should be:

1. `docs/specs/fullmag-application-architecture-v1.md`
2. `docs/1_project_scope.md`
3. `docs/2_repo_blueprint.md`
4. `docs/specs/problem-ir-v0.md`
5. `docs/specs/capability-matrix-v0.md`
6. relevant `docs/physics/` notes
7. relevant active plans

## 16. Change Policy

Any major application decision should update this document if it changes one of:

- product north star,
- source-of-truth hierarchy,
- main user workflow,
- role of the frontend,
- role of the CLI,
- role of `ProblemIR`,
- backend ownership boundaries,
- documentation architecture,
- implementation priority order.

If those things change and this document does not, the architecture is no longer honest.
