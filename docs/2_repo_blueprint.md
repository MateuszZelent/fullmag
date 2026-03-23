# Repo blueprint

## Authoring model

Fullmag uses an embedded Python DSL as the only public scripting surface.
There is no separate text DSL, no AST parsing phase, and no source-code inference.

The canonical bootstrap flow is:

1. Author a Python script or notebook with `import fullmag as fm`.
2. Build a declarative object graph describing the physical problem.
3. Serialize that object graph into canonical `ProblemIR`.
4. Deserialize and validate the IR in Rust.
5. Run capability checks and lower into an execution-plan summary.
6. Dispatch to FDM, FEM, or hybrid backends later in the stack.

## Top-level layout

- `packages/fullmag-py` — public embedded Python DSL and runtime helpers.
- `crates/fullmag-ir` — typed canonical IR plus validation and planning summaries.
- `crates/fullmag-cli` — bootstrap CLI for validating and planning Python-built IR.
- `crates/fullmag-api` — control-plane HTTP API.
- `crates/fullmag-py-core` — private PyO3 bridge for Python/Rust validation helpers.
- `apps/web` — script editor, jobs, logs, and artifact UI.
- `native/` — backend ABI and native implementation seams.
- `external_solvers/` — **reference solver codebases** (gitignored, read-only): mumax3, mumax+, BORIS, tetmag, tetrax.
- `docs/specs` — canonical architecture and IR specs.
- `docs/physics` — publication-style physics documentation and validation notes.

## Python package split

The Python package is intentionally split into:

- `fullmag.model` — declarative problem description
- `fullmag.runtime` — loading, simulation, result, and runner helpers

Bootstrap MVP classes:

- model: `Problem`, `ImportedGeometry`, `Material`, `Region`, `Ferromagnet`
- energy: `Exchange`, `Demag`, `InterfacialDMI`, `Zeeman`
- dynamics: `LLG`
- outputs: `SaveField`, `SaveScalar`
- hints: `DiscretizationHints`, `FDM`, `FEM`, `Hybrid`
- runtime: `Simulation`, `Result`, `BackendTarget`, `ExecutionMode`

## Guardrails

- Python describes physics and configuration, never backend storage layout.
- `ProblemIR` is the execution contract, not the Python source text.
- Any physics-facing change must carry a `docs/physics/` update.
- `docs/physics/` notes are auto-rendered into frontend documentation — no separate doc-writing step.
- `.agents` is canonical for skills and workflows; `.github` mirrors it.
