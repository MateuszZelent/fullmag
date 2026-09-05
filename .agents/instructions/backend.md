# Backend, build i wykonanie Fullmag

Wiążące rozwinięcie [AGENTS.md](../../AGENTS.md). Czytaj sekcje dotyczące zadania. Zachowano numerację kontraktów dla łatwego wyszukiwania; ścieżki w backtickach są względem repozytorium. Zasady procesu i uprawnień określa główny AGENTS.md.

## 11. Backend authority policy

`docs/architecture/backend-golden-masterplan.md` is the canonical backend
architecture source. It governs solver lanes, runtime ownership, source layout,
production physics validation, and backend-related agent instructions. Lower
level ADRs, physics notes, specs, skills, and implementation reports must align
with it or explicitly supersede a scoped part of it.

Before backend work, identify the solver lane:

1. FDM CPU
2. FDM GPU
3. FEM CPU
4. FEM GPU

The lanes share physics contracts, units, public quantity semantics,
provenance vocabulary, and validation targets. They do not share hidden runtime
state, hot loops, device residency, fallback behavior, or backend-specific
implementation details.

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
| Production CPU | MFEM/hypre/libCEED | authoritative CPU production path |
| Production GPU | MFEM/hypre/libCEED/CUDA | authoritative GPU production path |

FEM is not a standalone in-house FEM numerical stack. Fullmag's production FEM
architecture means MFEM/hypre/libCEED integration with explicit CPU and GPU
execution lanes under the current `backends/fem` tree after the controlled
relocation from `native/backends/fem`. Production FEM must not move into
`crates`. Historical docs or aliases that describe another destination are
transitional references only; the current compiled FEM backend tree is the
strategic implementation spine.

FEM demag is a model family, not one Poisson implementation. Keep Poisson
airbox Dirichlet/Robin, PBC-reduced Poisson, FEM/BEM Fredkin-Koehler, future
BEM/FMM, and mapped-exterior strategies separated by model, mesh requirements,
boundary semantics, runtime realization, provenance, and validation.

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
- state shape must be canonical and transport-friendly,
- charts must be revision-driven, memoized where model building is non-trivial, and quiet when idle,
- chart datasets must have bounded memory behavior through pagination, decimation, virtualization, or explicit sample budgets.

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

## 24. Canonical build and run entrypoints

Prefer `just` recipes when they exist.
For build tasks, the repository `justfile` is the first place to look. If a
managed/container recipe exists, use that recipe as the default build path
instead of assembling an equivalent-looking host-side `cargo`, `cmake`, Docker,
or shell command. Host-only commands are diagnostics unless the user explicitly
asks for them.

For FEM/MFEM/CUDA/hypre/libCEED work, the canonical build and runtime proof is
container-backed `just`, not host-only build commands. Treat the container
recipe as the default build path for native FEM work, not as an optional final
check. Before choosing build commands, inspect the repo `justfile` and use the
matching managed/container recipe when one exists. Use recipes such as `just
rebuild-fem-runtime`, `just ensure-managed-fem-runtime`, `just fem-gpu-headless
...`, or the managed run recipes before calling native FEM runtime work
complete. Raw host `cargo`, `cmake`, or native binaries are useful as fast smoke
checks only.
For native FEM build tasks, do not start by typing a lower-level `cargo`,
`cmake`, `docker`, or binary command and then validate later in the container.
Start in the container-backed `just` route. Use host commands only after that
route is identified, and label them as diagnostics.
Do not replace these recipes with an equivalent-looking host build when judging
FEM runtime readiness.
If a matching `just` recipe is missing, state that explicitly before using a
host-side diagnostic command. Do not silently promote the diagnostic path into
the build path.

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

## Reguły z korekt projektu

- The canonical durable build-storage root for the dedicated Linux managed runner is `/zfn2/mateuszz/git/fullmag`; all heavy Linux build artifacts and backing images must be stored below this path. Do not describe `/mnt/fullmag-zfn2-native` or `/tmp/fullmag-zfn2-build` as storage roots: they are only transient mounted views of ext4 images physically stored under `/zfn2/mateuszz/git/fullmag/build-volumes/`. Never infer the real Linux/WSL mount permissions from an ordinary sandboxed Codex command: the sandbox can remount out-of-workspace paths read-only, so audit `/zfn2` and `/mnt/fullmag-zfn2-native` with an approved host-level command before declaring a storage blocker. Never build directly on the CIFS filesystem. Cargo uses `/tmp/fullmag-zfn2-build/cargo-targets/<task>` with `CARGO_INCREMENTAL=0`, backed by `/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-cargo.ext4` mounted through `fuse2fs -o rw,noatime,fakeroot`; freshly linked Cargo build scripts can fail with `EINVAL` on direct CIFS. Managed CMake/native container builds use task-specific trees through the kernel-mounted `/mnt/fullmag-zfn2-native`, backed by `/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4`, and bind that mounted view into the repository `just` container; Docker cannot bind the user-only FUSE mount. After a Linux/WSL restart, restore the native mount with `wsl.exe -d Ubuntu2 -u root -- mount -o loop,rw,noatime /zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4 /mnt/fullmag-zfn2-native` (create the mount point first if absent). Do not fill the workspace or ordinary `/tmp` storage with multi-gigabyte build trees; small final link outputs may use `/tmp` only when required. This Linux-runner storage policy does not apply to the Windows-first launcher: Windows uses external `FULLMAG_WINDOWS_*_ROOT` paths and Docker Desktop for FEM, without an interactive WSL dependency. It does not replace the mandatory container-backed `just` route for native FEM/MFEM/CUDA/hypre/libCEED verification.
- Na Windowsie checkout repozytorium nie może być magazynem buildów, cache ani przeglądarek: `CARGO_TARGET_DIR`, pnpm store/home i `PLAYWRIGHT_BROWSERS_PATH` muszą wskazywać bezwzględne ścieżki poza repo. Domyślne `fullmag-cache`, `fullmag-build` i `fullmag-tmp` leżą w katalogu głównym dysku zawierającego repo, a zmienne `FULLMAG_WINDOWS_*_ROOT` mogą wskazać inny dysk. Nie używaj `target`, `cargo-targets`, `pnpm-store`, `pnpm-home`, `playwright-browsers`, `build-contract-wave2` ani `antenna-audit-target` jako lokalnych ścieżek roboczych w checkoutcie.
- Natywny tryb Windows `just fullmag ...` musi używać `scripts/windows/run_fullmag.ps1`; Windows jest wykrywany automatycznie, a `windows=True` pozostaje tylko aliasem zgodności. Launcher izoluje Cargo, Rustup, pnpm, npm, uv, pip, Python, TEMP/TMP, CUDA i Playwright poza repo oraz nie uruchamia MSI ani Dockera.
- Windowsowy FEM CPU/GPU musi przechodzić przez kanoniczny `scripts/windows/run_fullmag_fem.ps1` (implementacja Docker Desktop; `scripts/windows/run_fullmag_docker.ps1` jest bezpośrednim aliasem dla wywołań wymagających tej nazwy) i `compose.windows.yaml` z bind mountami poza repo; launchery nie mogą wywoływać `wsl.exe`, używać ścieżek WSL/Linuxowego checkoutu ani named volumes dla buildów/cache, ani dopuszczać do cichego CPU fallbacku. `run_fullmag_wsl.ps1` pozostaje wyłącznie historycznym aliasem zgodności.
- FEM time-integration performance gates must cover every supported explicit RK integrator, not only Heun.
- When FEM CPU and FEM GPU work are split between agents, each agent must stay within its explicitly assigned lane. A CPU-assigned agent must not create GPU hot-loop or GPU-state artifacts, and vice versa.
- FEM/MFEM backend work must split by explicit subsystem/operator contracts before folder moves; do not add new cross-cutting state to `Context` or new physics to `mfem_bridge.cpp`.
- FEM CPU and FEM GPU implementations must share backend-neutral physics contracts while using separate MFEM/hypre/libCEED runtime realizations; do not duplicate equations, signs, units, or observable semantics per device.
- Any FEM/MFEM solver rebuild or refactor must preserve the opt-in solver profiler contract: `set_solver_profile`, `/v2/sessions/current/diagnostics/solver-profile`, bounded `SolverProfileState`, stable phase IDs, disabled-by-default behavior, and no profiler sample allocation/logging when disabled.
- FEM/MFEM/CUDA/hypre/libCEED builds and runtime verification must use the container-backed `just` recipes (`just rebuild-fem-runtime`, `just ensure-managed-fem-runtime`, `just fem-gpu-headless ...`, `just verify-fem-relaxation-runtime`, or managed run recipes). The container path is the default build path for native FEM work, not only a final smoke test. Always inspect/use the repo `justfile` before inventing host-side build commands or direct `docker compose` invocations. Host-side `cargo`/`cmake` checks are only auxiliary smoke tests and must not be reported as final FEM GPU verification.
- Before deleting any shared Cargo target cache, obtain an explicit no-active-process confirmation from every running agent that may use it immediately before deletion; a process-list snapshot alone is insufficient.
- Managed FEM runtime prune dry-runs use exactly `FULLMAG_RUNTIME_DRY_RUN=1`; verify the supported variable from `scripts/prune_managed_fem_runtimes.sh` before invocation, and never run the script without dry-run mode until the user explicitly approves deletion.
- Ordinary `fullmag x.py` launches without `--output-dir` must replace only the auto-derived sibling `x.zarr` bundle and write final and per-stage scientific artifacts there; never auto-delete an explicit output path or hide the only result under `.fullmag` session history.
- Never delete a worktree `target/` directory while a Docker Compose container bind-mounts that worktree, even when `/workspace/target` is overmounted by a named volume; stop the container and verify its mounts first.
- For SP4 mixed-prism qualification, preserve the stricter relaxation threshold `tolT=1e-6 T` (`tolA=0.7957747154594767 A/m`); do not restore the legacy `7.957747 A/m` threshold during tolerance-unit migrations.
- FDM GPU launcher resolution must honor `runtime_device_override` and route to the managed CUDA runtime when local FDM CUDA is unavailable; never report or execute a silent CPU fallback for a forced GPU request.
- Never instantiate the internal FDM `Context` from a public contract executable unless that target uses exactly the same CUDA feature macros as `fullmag_fdm`; prefer a typed public ABI getter for runtime identity tests.
