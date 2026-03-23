# Project scope

Canonical application architecture:

- `docs/specs/fullmag-application-architecture-v2.md`

## Mission

Fullmag aims to describe one physical micromagnetic problem and make that problem executable through:

- FDM plans,
- FEM plans,
- hybrid plans.

The public interface must remain backend-neutral. Users should express geometry, materials, magnets, energy terms, dynamics, outputs, and discretization hints without leaking grid or FEM implementation detail into the shared layer.

## Foundation decision

The public scripting surface is an embedded Python DSL in the `fullmag` package.

This means:

- users write ordinary Python scripts and notebooks,
- Python objects build a declarative problem graph,
- the graph serializes into canonical `ProblemIR`,
- Rust validates, normalizes, and plans that IR,
- native backends remain behind Rust and C ABI seams.
- the public local product workflow is still `fullmag script.py`, hosted by Rust and fed by a
  Python helper in the user's environment.

There is no separate text DSL, no AST parsing phase, and no source-code inference.

## Layered architecture

```text
Python script / notebook / generated template
                |
                v
Rust host: fullmag script.py
                |
                +--> Python helper -> fullmag embedded Python DSL -> ProblemIR
                |
                v
Rust validation + normalization + planning + session runtime
      |                |                |
      v                v                v
   FDM plan         FEM plan        Hybrid plan
      |                |                |
      v                v                v
 CUDA/C++ core   MFEM/libCEED/hypre   coupling runtime
```

## Public Python model

The public API is split into three layers.

### Model layer

This layer answers: what physical problem are we solving?

- `Problem`
- `ImportedGeometry`
- `Material`
- `Region`
- `Ferromagnet`
- `Exchange`
- `Demag`
- `InterfacialDMI`
- `Zeeman`
- `LLG`
- `SaveField`
- `SaveScalar`
- `DiscretizationHints`
- `FDM`
- `FEM`
- `Hybrid`

### Study layer

This layer answers: what computation are we asking for?

- `TimeEvolution`
- `Relaxation`
- `Eigenmodes` later
- `StaticSolve` later

### Runtime layer

This layer answers: how and where do we plan or run it?

- `Simulation`
- `Result`
- `BackendTarget`
- `ExecutionMode`
- session-aware execution behavior defined by `docs/specs/session-run-api-v1.md`

## Execution semantics

Execution modes are first-class and cannot be implicit:

- `strict` — only backend-neutral semantics allowed
- `extended` — backend-specific features allowed explicitly
- `hybrid` — explicit coupled FDM/FEM planning

The current bootstrap contract is:

- `backend="hybrid"` requires `mode="hybrid"`
- `mode="hybrid"` requires `backend="hybrid"`
- `backend="auto"` resolves to a planning default in Rust, not in Python source text

## Typed ProblemIR

The canonical IR is organized around these sections:

- `ProblemMeta`
- `GeometryIR`
- `RegionIR`
- `MaterialIR`
- `MagnetIR`
- `EnergyTermsIR`
- `DynamicsIR`
- `SamplingIR`
- `BackendPolicyIR`
- `ValidationProfileIR`

`ProblemMeta` must preserve reproducibility for Python-authored runs:

- script language
- script source
- API version
- serializer version
- entrypoint kind
- source hash
- runtime metadata
- backend revision
- seeds

## Native/backend boundaries

- Rust remains the control plane.
- C++/CUDA remains the heavy FDM compute layer.
- MFEM + libCEED + hypre remain the intended FEM path.
- Rust communicates with native backends through stable C ABI boundaries.
- session lifecycle and browser-facing runtime state are part of Rust control-plane ownership.

## Web role

Next.js remains a control room, not a physics engine.

The web app should eventually handle:

- Python script editing,
- template generation,
- job submission,
- logs,
- artifacts,
- backend comparison,
- **auto-generated documentation** from `docs/physics/` notes.

It must not become a second source of solver semantics.

### Primary user experience

The primary frontend experience is a local control room launched from the CLI:

```text
fullmag script.py
```

In the intended product flow, this command should:

- load the Python script,
- build and validate `ProblemIR`,
- start the run,
- start a local API/web session,
- open the browser automatically to the live run page.

That means the browser is not only a post-run dashboard. It is the main live observability surface for local execution, while Python remains the only public scripting interface.

### Auto-documentation pipeline

`docs/physics/` notes are the single source of truth for physics documentation. The frontend should automatically render them into user-facing reference pages. This means every new physics feature documented through the `physics-publication` skill automatically becomes visible in the web UI without extra writing effort.

## Foundation milestone scope

Before deep backend work, the repository must keep these foundations stable:

1. The Python package exists and is testable.
2. `ProblemIR` is typed and validated in Rust.
3. Physics-first documentation is a hard gate.
4. Skills, prompts, README, AGENTS, CLI, and web copy are aligned.
5. Containerized verification covers Rust, Python, repo consistency, and smoke flow.
6. `docs/physics/` notes feed into auto-generated frontend documentation.
