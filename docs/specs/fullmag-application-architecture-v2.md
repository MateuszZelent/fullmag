# Fullmag Application Architecture v2

- Status: canonical target architecture
- Last updated: 2026-03-23

## 1. Why this document exists

Fullmag now needs one clear target application architecture instead of competing product theories.

This document is the canonical target contract for the whole application.

It does not claim every part is already implemented.
Current implementation reality must stay documented in capability/status docs and active plans.

Anything that conflicts with this document should be treated as drift unless explicitly marked as an
experiment.

---

## 2. Core diagnosis

The repository already has a real executable baseline, but the documentation and product model have
drifted.

What exists today is still narrower than the desired product shell:

- CPU/FDM reference execution exists for a narrow exchange-only slice,
- the browser is still not a real control room,
- there is still no session/run shell,
- launcher ownership is still not implemented the way the target product requires,
- the public model still needs the explicit `Study` layer.

That means the project needs one reset rule:

> We do not evolve “repo skeleton”, “solver architecture”, and “application architecture” as separate stories anymore.  
> We evolve one product contract with honest capability tiers.

---

## 3. Product definition

Fullmag is one application with four visible surfaces:

1. **Python authoring surface** — the only public way to describe the problem,
2. **local CLI launcher** — `fullmag script.py`,
3. **browser control room** — live and historical observability,
4. **native compute backends** — FDM and FEM execution engines.

The user story is:

- write one Python script,
- run it with `fullmag script.py`,
- watch the run live in the browser,
- or run headlessly from Jupyter / Python,
- with one physical model and one artifact/provenance model regardless of backend.

---

## 4. The single most important architectural correction

## Public local CLI must be Rust-hosted

The command:

```bash
fullmag script.py
```

should be implemented as a **Rust host binary** that loads Python-authored problems through a
spawned Python helper in the active user environment.

Reason:

- the user script is Python,
- Python remains the public authoring surface,
- Rust must still own validation, planning, session state, runner dispatch, API, artifacts, and
  provenance,
- spawning a Python helper preserves the user's Python environment without making embedded CPython
  the primary runtime path.

### Consequence

- **Rust owns the public local launcher.**
- **Python owns the authoring DSL and script-loading helper path.**
- standalone Rust internals and Python notebook use remain valid, but the normal local product flow
  is Rust-hosted `fullmag script.py`.

This resolves the biggest tension in the earlier architecture.

---

## 5. Canonical application layers

```text
User script / notebook
        |
        v
Rust host: fullmag script.py
        |
        +--> spawn Python helper in user env
        |         |
        |         +--> fullmag Python package
        |               - model DSL
        |               - script loader
        |               - ProblemIR serialization
        |
        v
Rust control plane
  - validation
  - normalization
  - capability checks
  - planning
  - session manager
  - runner dispatch
  - artifact/provenance
  - local API server
        |
        +--------------------+
        |                    |
        v                    v
   FDM native backend    FEM native backend
   (CUDA/C++)            (MFEM/libCEED/hypre)
        |
        +--------- shared artifacts ---------+
                          |
                          v
                   browser control room
```

---

## 6. One canonical user experience

## 6.1 Script mode with UI

```bash
fullmag my_problem.py
```

Behavior:

1. Rust receives the CLI request.
2. Rust spawns a Python helper in the active user environment.
3. The Python helper loads the script and returns canonical `ProblemIR`.
4. Rust validates and plans.
5. Rust creates a local session.
6. Rust starts execution.
7. Rust starts a local API server.
8. Rust opens the browser.
9. Browser shows `/runs/<session_id>` live.

## 6.2 Script mode without UI

```bash
fullmag my_problem.py --headless
```

Same plan and execution contract, but:

- no browser launch,
- no web UI required,
- API server optional,
- artifacts still written.

## 6.3 Notebook / Python library mode

```python
import fullmag as fm

problem = build_problem()
result = fm.Simulation(problem, backend="fdm", ui=False).run()
```

Same control plane, but no browser unless explicitly requested.

## 6.4 Future remote mode

```bash
fullmag submit my_problem.py --target cluster-a
```

This is the same application model with a different execution target.
Not a different product.

---

## 7. Canonical public Python API

The API must have **three** conceptual layers, not two.
This is the second major correction.

## 7.1 Model layer — what physical system exists?

```python
fm.Box
fm.Cylinder
fm.ImportedGeometry
fm.Material
fm.Region
fm.Ferromagnet
fm.Exchange
fm.Demag
fm.InterfacialDMI
fm.Zeeman
fm.Anisotropy       # later
fm.BoundaryCondition # later
```

This layer describes only the system.
No runtime or backend details here.

## 7.2 Study layer — what computation are we asking for?

This is necessary because future FEM work will not be only time-domain LLG.
You already know you want future FEM eigenproblems.
Therefore Fullmag must not hardwire “problem = LLG time integration” into the root model.

```python
fm.TimeEvolution
fm.Relaxation
fm.Eigenmodes        # future
fm.StaticSolve       # future
```

### Phase-1 executable study

```python
fm.TimeEvolution(
    dynamics=fm.LLG(integrator="heun", fixed_timestep=1e-13),
    until=2e-9,
    outputs=[...],
)
```

### Future FEM study

```python
fm.Eigenmodes(
    count=10,
    target="lowest",
    operator="linearized_llg",
    outputs=[...],
)
```

## 7.3 Runtime layer — how do we execute it?

```python
fm.Simulation(
    problem,
    backend="fdm" | "fem" | "auto",
    mode="strict" | "extended" | "hybrid",
    precision="single" | "double",
    ui=True | False | "auto",
)
```

This split keeps the architecture future-proof:

- model = physical truth,
- study = requested computation,
- runtime = execution policy.

---

## 8. Canonical top-level Python shape

```python
import fullmag as fm

geom = fm.Box(size=(200e-9, 20e-9, 5e-9), name="strip")
mat = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.02)
mag = fm.Ferromagnet(
    name="strip",
    geometry=geom,
    material=mat,
    m0=fm.init.random(seed=42),
)

problem = fm.Problem(
    name="exchange_relax",
    magnets=[mag],
    energy=[fm.Exchange()],
    study=fm.TimeEvolution(
        dynamics=fm.LLG(integrator="heun", fixed_timestep=1e-13),
        until=2e-9,
        outputs=[
            fm.SaveField("m", every=1e-12),
            fm.SaveField("H_ex", every=1e-12),
            fm.SaveScalar("E_ex", every=1e-12),
        ],
    ),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2e-9, 2e-9, 2e-9)),
        fem=fm.FEM(mesh=None, hmax=2e-9, order=1),
    ),
)

fm.Simulation(problem, backend="fdm", precision="double", ui="auto").run()
```

### Compatibility note

For a transition period, the older shorthand:

```python
Problem(..., dynamics=..., outputs=...)
```

may be accepted and internally normalized to `study=TimeEvolution(...)`.
But canonical docs should move to `study=` immediately.

---

## 9. Public runtime contract

## 9.1 `Simulation.plan()`

Returns:

- normalized summary,
- capability status,
- chosen backend,
- exact reason if not executable,
- selected plan id / plan hash.

## 9.2 `Simulation.run()`

Returns a `Result` object with:

- `status`,
- `session_id`,
- `run_id`,
- `backend`,
- `mode`,
- `precision`,
- `plan_summary`,
- `artifacts`,
- `steps` or `scalar_trace`,
- `ui_url` when UI is enabled.

## 9.3 `Result` is application-level, not backend-level

The user should never receive raw CUDA pointers, MFEM objects, or backend-specific array structs.

---

## 10. Canonical IR stack

The IR must have three layers.

## 10.1 `ProblemIR`

Carries backend-neutral truth.

Sections:

- `ProblemMeta`
- `GeometryIR`
- `RegionIR`
- `MaterialIR`
- `MagnetIR`
- `EnergyTermsIR`
- `StudyIR`
- `SamplingIR`
- `BackendPolicyIR`
- `ValidationProfileIR`

## 10.2 `ExecutionPlanIR`

Carries backend-realized truth.

Sections:

- `CommonPlanMeta`
- `BackendPlanIR`
- `OutputPlanIR`
- `ProvenancePlanIR`
- `BudgetPlanIR`

## 10.3 `SessionStateIR`

Carries live execution truth.

Sections:

- `session_id`
- `run_id`
- `status`
- `progress`
- `current_step`
- `current_time`
- `latest_artifacts`
- `diagnostics`
- `logs`

This third layer is missing from older plans and is required if the browser is a real control room.

---

## 11. Capability model

Every feature must be tagged as exactly one of:

- `semantic_only`
- `planned`
- `internal_reference`
- `public_executable`

The same tags must appear consistently in:

- Python errors,
- CLI output,
- API responses,
- browser badges,
- docs.

No feature can be “sort of supported”.

---

## 12. Backend policy model

## 12.1 Backend-neutral user contract

The user picks a backend target:

- `auto`
- `fdm`
- `fem`
- later `hybrid`

## 12.2 Backend-specific knobs stay in explicit hint blocks

This is how you allow method-specific parameters without leaking implementation details everywhere.

### FDM hints

```python
fm.FDM(
    cell=(dx, dy, dz),
    pbc=(False, False, False),   # later
    demag_solver="fft",         # later
)
```

### FEM hints

```python
fm.FEM(
    mesh="track.msh" | None,
    hmax=2e-9,
    order=1,
    solver="cg",                # later
    preconditioner="amg",       # later
    eigen=None,                  # later
)
```

### Rule

Shared model semantics stay backend-neutral.
Backend specificity is allowed only inside explicit backend hint blocks or in explicit `extended` mode.

---

## 13. Session-oriented application architecture

This is the canonical runtime model.
Everything in the application should revolve around **sessions**.

A session owns:

- lifecycle state,
- normalized problem summary,
- plan summary,
- run state,
- event stream,
- logs,
- artifact index,
- provenance,
- cancellation state.

A session may be:

- `starting`
- `loading_script`
- `validating`
- `planning`
- `running`
- `completed`
- `failed`
- `cancelled`

This one abstraction unifies local CLI, Jupyter monitoring, and future remote execution.

---

## 14. Local API contract

The browser must consume a stable API instead of reading files ad hoc.

## 14.1 Session endpoints

```text
GET    /v1/sessions
POST   /v1/sessions
GET    /v1/sessions/:id
GET    /v1/sessions/:id/events
POST   /v1/sessions/:id/cancel
```

## 14.2 Run endpoints

```text
GET    /v1/runs/:id/summary
GET    /v1/runs/:id/metadata
GET    /v1/runs/:id/scalars
GET    /v1/runs/:id/fields/:name/latest
GET    /v1/runs/:id/fields/:name?step=N
GET    /v1/runs/:id/artifacts
GET    /v1/runs/:id/artifacts/:path
```

## 14.3 Compile / validate / plan endpoints

```text
POST   /v1/compile/script
POST   /v1/validate/script
POST   /v1/plan/script
```

## 14.4 Docs endpoints

```text
GET    /v1/docs/physics
GET    /v1/docs/physics/:slug
```

---

## 15. Event stream contract

The browser should subscribe to one event stream per session.

Event kinds:

- `session_state_changed`
- `plan_ready`
- `log_line`
- `step_stats`
- `snapshot_available`
- `artifact_written`
- `run_completed`
- `run_failed`

Heavy field payloads are **not** pushed through the event stream.
Only metadata and availability notices are streamed.
Field data is fetched on demand.

---

## 16. Frontend golden path

The browser is not an editor-first product.
It is a **run-first control room**.

## 16.1 Required routes

```text
/                   landing / status
/runs/[id]          live + historical run page
/docs/physics/[slug]
```

Everything else is secondary.

## 16.2 Phase-1 run page contents

The first real run page must show:

- session status,
- backend / mode / precision badges,
- problem summary,
- planner diagnostics,
- live `E_ex(t)` chart,
- live step/time counters,
- latest `m` snapshot viewer,
- latest `H_ex` snapshot selector,
- logs,
- artifact browser,
- provenance panel.

## 16.3 Editor is later

The browser editor is useful, but it is not the primary workflow.
User flow begins in terminal or notebook.

---

## 17. Artifact contract

Artifacts are part of the product, not a side effect.

Minimum required families:

- `metadata.json`
- `problem_ir.json`
- `execution_plan.json`
- `scalars.csv`
- `fields/m/...`
- `fields/H_ex/...`
- `logs.txt`

Every artifact set must carry:

- problem id,
- session id,
- run id,
- backend,
- mode,
- precision,
- solver revision,
- device info,
- source hash,
- plan hash.

---

## 18. Native backend contract

## 18.1 FDM backend

Production target:

- C++/CUDA
- GPU-first execution
- SoA field layout
- explicit precision `single` / `double`

## 18.2 FEM backend

Production target:

- MFEM + libCEED + hypre
- imported mesh first
- Box meshing second
- future eigenmode support

## 18.3 Stable backend interface

Rust speaks to native backends through a stable ABI boundary.

But the user never sees that ABI.

---

## 19. The 2000-LOC rule

You asked for a foundation “na 2000 linii kodu”.
The only realistic interpretation is:

> 2000 lines for the **application shell**, not for the full solver kernels.

The shell includes:

- Python launcher,
- Python runtime wrapper,
- Rust session manager,
- Rust runner dispatch,
- local API,
- browser run page,
- artifact adapter.

It explicitly excludes:

- CUDA kernels,
- MFEM backend internals,
- full compare tooling,
- advanced viewers,
- editor UX,
- remote cluster stack.

## 19.1 Suggested LOC budget

### Python package — ~450 LOC

- `cli.py` — 120
- `runtime/simulation.py` — 130
- `runtime/loader.py` — 80
- `model/study.py` — 120

### Rust core — ~900 LOC

- `session.rs` — 250
- `runner.rs` — 250
- `api.rs` — 250
- `artifacts.rs` — 150

### Web — ~650 LOC

- `/runs/[id]/page.tsx` — 180
- `SessionStatusCard.tsx` — 70
- `ScalarChart.tsx` — 90
- `FieldViewer.tsx` — 120
- `ArtifactBrowser.tsx` — 90
- `api.ts` + `session-events.ts` — 100

Total: ~2000 LOC for the application shell.

This shell is the base camp. Heavy numerics live underneath it.

---

## 20. What is canonical in Phase 0 of the reset

The first coherent, honest product slice is:

- one Python-authored problem,
- one `fullmag script.py` launcher,
- optional browser control room,
- session API,
- artifact writing,
- one public executable path,
- explicit capability reporting for everything else.

That executable path should be:

> `Box + Exchange + TimeEvolution(LLG-Heun) + FDM + GPU double`

If GPU double is not ready yet, temporarily:

> `Box + Exchange + TimeEvolution(LLG-Heun) + FDM + CPU reference`

but only as a staging milestone, not the product identity.

---

## 21. What changes in the current document set

## 21.1 Keep

- application architecture doc,
- problem IR spec,
- capability matrix,
- geometry policy,
- magnetization init policy,
- output naming policy,
- physics notes.

## 21.2 Merge / demote

- frontend architecture should become a subordinate implementation plan, not a parallel product theory,
- phase rollout documents should be implementation plans, not architecture truth,
- status reports should remain reports, not design authorities.

## 21.3 Add one missing canonical spec

Create:

```text
docs/specs/session-run-api-v1.md
```

This is currently the missing hinge between solver and browser.

---

## 22. Migration from the current public repo

## Step 1 — stop the drift

Freeze one new canonical document:

- `docs/specs/fullmag-application-architecture-v2.md`

and state clearly that it supersedes older conflicting plans.

## Step 2 — make the public launcher Python-first

Add:

- `packages/fullmag-py/src/fullmag/cli.py`
- console entrypoint `fullmag`

Keep Rust CLI only for dev/internal commands.

## Step 3 — add `Study` to the Python model

Implement:

- `TimeEvolution`
- future stub `Eigenmodes`

Normalize old API to new internal shape.

## Step 4 — implement session API before a rich frontend

Build:

- local session manager,
- `/v1/sessions/*`,
- `/v1/runs/*`,
- SSE stream.

## Step 5 — build `/runs/[id]`

Not editor-first.
Run page first.

## Step 6 — plug in the real executable backend

- first CPU reference if needed,
- then CUDA FDM,
- then FEM.

## Step 7 — only then expand browser editing and comparison

This ordering is non-negotiable if the product is to stay coherent.

---

## 23. Non-negotiable rules going forward

1. One public authoring language: Python.
2. One public local launcher: `fullmag script.py`.
3. One runtime abstraction: session.
4. One semantic contract: `ProblemIR`.
5. One execution contract: `ExecutionPlanIR`.
6. One browser role: control room.
7. One artifact/provenance model across backends.
8. One capability language everywhere.
9. Backend-specific features only in explicit backend hint blocks or explicit study types.
10. No new physics or numerics without a physics note.

---

## 24. Final formulation

The target application contract is:

> Fullmag is a micromagnetics application in which one Python-authored script defines a physical
> model and a study, the Rust-hosted `fullmag` launcher turns that into a session, Rust owns
> validation/planning/execution truth, the browser is the live control room, and FDM/FEM are
> backend realizations of one artifact and provenance contract.

And the most important practical interpretation is:

> Build the first 2000 lines as the **application shell** that makes `fullmag script.py` and notebook execution feel like one coherent product.  
> Then grow the GPU FDM backend and later FEM underneath that shell.
