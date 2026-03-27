# Fullmag Self-Contained Production Distribution Plan

- Status: active productization plan
- Last updated: 2026-03-27
- Parent specs:
  - `docs/specs/fullmag-application-architecture-v2.md`
  - `docs/specs/runtime-distribution-and-managed-backends-v1.md`
  - `docs/specs/session-run-api-v1.md`
- Related plans:
  - `docs/plans/active/fullmag-local-launcher-and-live-ui-plan-2026-03-25.md`

## 1. Purpose

This plan defines how Fullmag reaches a real production distribution model where a Linux user can:

```bash
download -> unpack/install -> run fullmag my_problem.py
```

without requiring:

- Docker,
- Podman,
- manual CUDA toolkit installation,
- manual MFEM/libCEED/hypre installation,
- raw `cargo`,
- raw `pnpm`,
- repo checkout,
- developer-only bootstrap steps.

This is a user-distribution plan, not a developer-workflow plan.

Containers may still exist in CI and internal build/export pipelines, but they must not be part of
the normal end-user execution story.

---

## 2. Product rule for this plan

The production Linux workstation experience must be:

```bash
fullmag my_problem.py
```

with these guarantees:

1. one visible application and one launcher,
2. the browser control room works out of the box,
3. Python authoring works out of the box,
4. CPU execution works out of the box,
5. GPU execution does not require the user to know what runtime image or container to run,
6. heavy runtime assets may still be separate artifacts internally, but they must be resolved by
   Fullmag automatically.

For the user, “managed runtime” must mean:

- bundled with the application package, or
- auto-installed by the launcher into a Fullmag-owned runtime directory.

It must not mean:

- “please install Docker first”,
- “please run `docker compose` manually”,
- “please build the solver runtime yourself”.

---

## 3. Non-goals

This plan does not require:

- one giant statically linked binary containing every backend,
- no GPU driver dependency at all,
- first-class Windows packaging in phase 1,
- first-class macOS packaging in phase 1,
- solving current FEM GPU physics parity in this same document.

Important clarification:

- NVIDIA driver availability remains a host prerequisite for CUDA execution.
- That is acceptable.
- CUDA toolkit, MFEM, libCEED, hypre, Rust, Node, and build containers must not be user
  prerequisites.

---

## 4. Target production artifacts

## 4.1 Phase-1 official artifacts

The first production-grade Linux deliverables should be:

1. `fullmag-linux-x86_64-portable.tar.zst`
2. `fullmag-linux-x86_64.AppImage`

Both should contain the same application payload and runtime layout.

The tarball is the simplest reproducible packaging baseline.
The AppImage is the nicer desktop-facing distribution target.

## 4.2 Optional later artifacts

Later, after the portable layout stabilizes:

1. `.deb`
2. `.rpm`

These should be thin wrappers over the same already-stable runtime layout, not a separate product
branch.

---

## 5. Target package layout

The portable application layout should look like:

```text
fullmag/
  bin/
    fullmag
    fullmag-bin
    fullmag-api
  lib/
    ...
  python/
    bin/python3
    ...
  web/
    index.html
    _next/...
    assets/...
  runtimes/
    cpu-reference/
      bin/...
      manifest.json
      lib/...
    fdm-cuda/
      bin/fullmag-fdm-cuda-bin
      manifest.json
      lib/...
    fem-gpu/
      bin/fullmag-fem-gpu-bin
      manifest.json
      lib/...
  share/
    licenses/
    version.json
```

Key rules:

1. `bin/fullmag` remains the only public launcher.
2. `python/` is bundled and private to Fullmag.
3. `web/` contains prebuilt static control-room assets.
4. `runtimes/*` are runtime packs, not developer build outputs.
5. every runtime pack carries a manifest describing version, capabilities, ABI, and requirements.

---

## 6. Target runtime model

## 6.1 Workstation production runtime policy

For end-user Linux workstation builds, the preferred runtime form is:

- unpacked runtime packs on disk,
- resolved by the launcher locally,
- no OCI engine required on the user machine.

This is fully consistent with the existing runtime-distribution spec because that spec already
allows:

- bundled native libraries,
- prebuilt runtime tarballs,
- platform-specific runtime packages.

The current containerized runtime flow should therefore be treated as:

- an internal build/export mechanism,
- not the public workstation execution mechanism.

## 6.2 Runtime families

Initial production families:

1. `cpu-reference`
2. `fdm-cuda`
3. `fem-gpu`

Target meaning:

- `cpu-reference` is always present in the base package,
- `fdm-cuda` should be present in GPU-capable production bundles,
- `fem-gpu` should be present in full GPU production bundles once numerically production-ready.

## 6.2.1 Runtime family is not the same as execution engine

We need to separate four concepts clearly:

1. public launcher command,
2. runtime family,
3. execution engine capability,
4. worker binary.

### Public launcher

This remains exactly one public entrypoint:

```bash
fullmag my_problem.py
```

### Runtime family

This is the installable/bundled runtime pack:

- `cpu-reference`
- `fdm-cuda`
- `fem-gpu`

### Execution engine capability

This is the concrete resolved execution tuple:

- backend: `fdm` / `fem`
- device: `cpu` / `gpu`
- precision: `single` / `double`
- execution mode: `strict` / `extended` / `hybrid`

Examples:

- `fdm + cpu + double + strict`
- `fem + cpu + double + strict`
- `fdm + gpu + double + strict`
- `fdm + gpu + single + strict`
- `fem + gpu + double + strict`

### Worker binary

This is the actual executable used to run the solver implementation for the selected runtime pack.

The important consequence is:

- users choose a problem and optionally a policy,
- the launcher resolves an engine capability,
- the launcher then chooses a runtime family and worker binary that can execute it.

Users should not choose worker binaries directly.

## 6.2.2 Practical engine matrix

The intended production matrix should be:

| Requested intent | Resolved runtime family | Worker location | Initial public status |
| --- | --- | --- | --- |
| `fdm + cpu + double` | `cpu-reference` | base launcher/runtime | public |
| `fem + cpu + double` | `cpu-reference` | base launcher/runtime | public |
| `fdm + gpu + double` | `fdm-cuda` | `runtimes/fdm-cuda/bin/...` | public target |
| `fdm + gpu + single` | `fdm-cuda` | `runtimes/fdm-cuda/bin/...` | gated until parity |
| `fem + gpu + double` | `fem-gpu` | `runtimes/fem-gpu/bin/...` | gated until production-ready |
| `fem + gpu + single` | `fem-gpu` | `runtimes/fem-gpu/bin/...` | deferred |

Key design decision:

- we should not make one end-user package per precision,
- precision is an engine capability exposed by a runtime pack,
- not a separate user-facing application.

So:

- `fdm-cuda` is one runtime family,
- it may advertise only `double` at first,
- later the same family may advertise `single` and `double`.

Likewise:

- `fem-gpu` is one runtime family,
- it should not fork into separate “FEM single app” and “FEM double app”.

## 6.2.3 Do we want everything in one binary?

No, not in the sense of one giant ELF containing every control-plane and solver realization.

Yes, in the sense of one public launcher command and one user-visible application.

The practical production model should be:

### Base application binaries

- `bin/fullmag` — public wrapper / launcher
- `bin/fullmag-bin` — main control-plane binary
- `bin/fullmag-api` — local API / static-web server

### Runtime worker binaries

- `runtimes/fdm-cuda/bin/fullmag-fdm-cuda-bin`
- `runtimes/fem-gpu/bin/fullmag-fem-gpu-bin`

The `cpu-reference` family may remain inside the base control-plane binary if that keeps the base
artifact simpler.

This is the recommended split because:

1. CPU baseline stays simple and always available,
2. heavy solver stacks stay isolated,
3. runtime packs remain replaceable and diagnosable,
4. launcher/runtime selection remains explicit,
5. we avoid one giant binary with every heavy dependency glued together.

## 6.2.4 Precision handling policy

Precision is part of execution policy and provenance.

It should flow as:

1. script or CLI requests precision,
2. planner validates semantic executability,
3. launcher/runtime resolver checks runtime-manifest support,
4. selected worker receives the requested precision explicitly,
5. session/run metadata records both requested and resolved precision.

Important production rule:

- `single` must not silently downshift to `double`,
- `double` must not silently downshift to `single`,
- unsupported precision must fail explicitly with a product-facing error.

## 6.2.5 Recommended runtime-manifest shape

Each runtime family should advertise supported engine capabilities explicitly, for example:

```json
{
  "family": "fdm-cuda",
  "version": "0.1.0",
  "worker": "bin/fullmag-fdm-cuda-bin",
  "engines": [
    {
      "backend": "fdm",
      "device": "gpu",
      "mode": "strict",
      "precision": "double",
      "public": true
    },
    {
      "backend": "fdm",
      "device": "gpu",
      "mode": "strict",
      "precision": "single",
      "public": false
    }
  ]
}
```

The `public` gate is important because a capability may exist technically before it is promoted as
product-executable.

## 6.2.6 Shared-library packaging policy

For workstation production bundles, we should prefer colocated shared libraries over trying to
force everything into one giant binary.

The practical policy should be:

1. base control-plane binaries live in `bin/`,
2. base shared libraries live in `lib/`,
3. each heavy runtime family carries its own `bin/` and `lib/`,
4. CUDA user-space libraries required by a GPU runtime live inside that runtime pack,
5. the launcher resolves workers and libraries relative to the install root,
6. no normal execution path depends on host `LD_LIBRARY_PATH` or `/usr/local/cuda`.

This is the right production compromise because it gives us:

- one public application,
- diagnosable runtime packs,
- relocatable installs,
- predictable `ldd` behavior,
- no requirement for a host CUDA toolkit.

## 6.3 Runtime resolution behavior

At runtime the launcher should:

1. inspect requested execution policy from script and CLI overrides,
2. inspect bundled/installed runtime manifests,
3. resolve to the best matching runtime,
4. emit the requested and resolved runtime in session metadata,
5. fail with a clear product error if a requested path is not installed.

The practical resolver order should be:

1. resolve `backend/device/mode/precision` intent,
2. map `auto` to a concrete backend through planning,
3. enumerate installed runtime manifests,
4. filter runtimes by exact engine-capability match,
5. reject runtimes that are installed but not public-enabled for that capability,
6. select the preferred runtime family for that capability,
7. spawn the matching worker binary.

For example:

- `backend=fdm, device=gpu, precision=double`:
  - prefer `fdm-cuda`
- `backend=fem, device=cpu, precision=double`:
  - resolve into `cpu-reference`
- `backend=fem, device=gpu, precision=double`:
  - require `fem-gpu`
- `backend=fdm, device=gpu, precision=single`:
  - fail unless `fdm-cuda` manifest advertises that engine as `public: true`

The launcher must never expose:

- container names,
- Docker image references,
- internal export scripts,
- build-system paths.

---

## 7. What must be bundled

## 7.1 Mandatory in the base package

The base package must contain:

1. launcher binary and wrapper,
2. local API binary,
3. static web control-room assets,
4. private Python runtime,
5. Python Fullmag package payload,
6. CPU runtime,
7. provenance/version metadata,
8. runtime manifests,
9. license payloads for bundled third-party components.

## 7.2 Private Python runtime

If the user is supposed to “just run” a Python-authored simulation, Fullmag must not depend on the
system Python for the primary production path.

Therefore the production bundle should ship a private Python runtime, for example based on:

- `python-build-standalone`, or
- an equivalent redistributable CPython layout.

The bundled launcher should set:

- `FULLMAG_PYTHON`,
- `PYTHONPATH`,
- any Fullmag-specific runtime env,

without user intervention.

## 7.3 Static web shell

The production package must not depend on:

- `pnpm`,
- `node`,
- Next.js dev server

at runtime.

The control room should be delivered as prebuilt static assets served by the host-side launcher/API.

The existing `web-build-static` direction is the correct basis for this.

## 7.4 CUDA user-space library bundling

We need to be explicit here because this is one of the easiest places for a fake “portable”
package to fail in practice.

Production rule:

- GPU runtime packs must ship the CUDA user-space shared libraries they actually need.

That means:

- `fdm-cuda` bundles libraries such as `libcudart.so*`, `libcufft.so*`, and any other non-driver
  CUDA DSOs linked by the FDM worker,
- `fem-gpu` bundles the required CUDA user-space DSOs together with MFEM/libCEED/hypre runtime
  DSOs,
- the package must not assume a host-side CUDA toolkit install.

Equally important:

- Fullmag must not bundle `libcuda.so.1`,
- Fullmag must not bundle `libnvidia-ml.so.1`,
- Fullmag must not bundle kernel driver components.

Those belong to the host NVIDIA driver and remain the only acceptable external prerequisite for GPU
execution.

## 7.5 ELF `RUNPATH` / relocatability policy

To avoid `ldd` failures after unpacking or moving the install directory, every production artifact
must be made relocatable at the ELF level.

Required rules:

1. each worker binary in `runtimes/<family>/bin/` must resolve its runtime-pack `lib/` via
   `$ORIGIN`-relative `RUNPATH` or `RPATH`,
2. each bundled shared object in `runtimes/<family>/lib/` must also carry a relative search path
   for sibling bundled DSOs,
3. base binaries in `bin/` must resolve `lib/` relative to their own location,
4. packaging must not rely on repo-local paths, builder machine linker cache state, or user-set
   `LD_LIBRARY_PATH`.

Recommended search layout:

- base binaries: `$ORIGIN/../lib`
- runtime workers: `$ORIGIN/../lib:$ORIGIN/../../../lib`
- runtime DSOs: `$ORIGIN:$ORIGIN/../../lib`

Exact values may be refined per runtime family, but the product rule is fixed:

- extracted bundles must still run after moving the install tree,
- `ldd` must not show unexpected `not found` dependencies on supported machines.

---

## 8. What must not be required from the user

The following must be removed from the production user path:

1. `docker compose`
2. `make install-cli`
3. `just build fullmag`
4. `scripts/export_fem_gpu_runtime.sh`
5. manually exporting `PYTHONPATH`
6. manually setting `LD_LIBRARY_PATH`
7. checking out the repository just to run Fullmag

Those are packager/dev flows only.

---

## 9. Production build pipeline model

## 9.1 Build-time vs runtime separation

We should make a hard distinction between:

- build pipeline dependencies,
- end-user runtime dependencies.

Build pipeline dependencies may still include:

- Docker/OCI,
- Rust nightly,
- Node/pnpm,
- CUDA build images,
- MFEM/libCEED/hypre toolchains.

End-user runtime dependencies should be reduced to:

- Linux,
- glibc baseline compatible with chosen packaging target,
- browser available on the host,
- NVIDIA driver only when GPU runtime is selected.

## 9.2 Canonical build stages

The release pipeline should become:

1. build static web assets,
2. build host launcher binaries,
3. build/export runtime packs,
4. assemble portable filesystem layout,
5. run smoke tests against assembled artifact,
6. produce tarball,
7. optionally wrap as AppImage,
8. publish checksums and provenance manifest.

## 9.3 Canonical artifact assembly command

We should add an explicit packager command such as:

```bash
just package fullmag-portable
```

which creates the full self-contained artifact, not merely the current staging directory.

The current `just package fullmag` is only a partial staging step.

---

## 10. Required implementation workstreams

## 10.1 Workstream A — Stable portable layout

Deliverables:

1. define canonical install tree under `.fullmag/dist/fullmag-linux-x86_64/`,
2. move from staging layout to release layout,
3. add machine-readable `version.json` and runtime manifests,
4. ensure launcher resolves everything relative to its own install root.

Acceptance:

- package can be moved to another directory and still works,
- package does not depend on repo-relative paths.

## 10.2 Workstream B — Bundled Python runtime

Deliverables:

1. choose redistributable CPython packaging strategy,
2. package Fullmag Python DSL into the portable artifact,
3. update launcher to prefer bundled Python in production mode,
4. verify script execution without host Python.

Acceptance:

- `fullmag my_problem.py` works on a clean host without system Python tooling.

## 10.3 Workstream C — Static control-room packaging

Deliverables:

1. make `apps/web` production build emit fully relocatable assets,
2. serve them from `fullmag-api` or launcher-owned static server,
3. remove runtime dependency on `next dev`,
4. keep local-live session UX unchanged.

Acceptance:

- package starts control room with no Node runtime installed on host.

## 10.4 Workstream D — Runtime pack manifests and resolver

Deliverables:

1. define `runtime manifest` schema,
2. attach manifest to each runtime pack,
3. implement launcher-side runtime discovery,
4. implement compatibility checks:
   - runtime family,
   - version,
   - ABI contract,
   - GPU requirement,
   - driver requirement hints,
   - bundled dependency completeness,
   - relative `RUNPATH` correctness.

Acceptance:

- launcher resolves runtimes locally with no special scripts.

## 10.5 Workstream E — Replace container-first user path

Deliverables:

1. treat `export_fem_gpu_runtime.sh` as internal build/export tool only,
2. ensure released runtime pack is consumed directly by launcher,
3. remove any user-facing documentation that tells users to run containers manually,
4. retain container flow only for CI/packaging/debug.

Acceptance:

- public workstation docs never require Docker for normal use.

## 10.6 Workstream F — Real packaging outputs

Deliverables:

1. tarball packager,
2. AppImage packager,
3. checksum/signature generation,
4. release smoke tests on extracted artifact,
5. release metadata describing included runtimes,
6. packaged-ELF linkage verification for base and runtime worker binaries.

Acceptance:

- a tester can download one artifact and run it on a clean Linux machine.

---

## 11. Product SKUs

We should stop pretending one artifact will fit every operational case equally well.

Recommended initial workstation SKUs:

## 11.1 `fullmag-linux-x86_64-cpu`

Contains:

- launcher,
- API,
- web,
- Python runtime,
- CPU backend.

Pros:

- smallest,
- easiest to validate,
- first artifact to ship.

## 11.2 `fullmag-linux-x86_64-gpu`

Contains:

- everything from CPU SKU,
- CUDA FDM runtime,
- optionally FEM GPU runtime once production-ready.

Pros:

- closest to “download and run” for serious users.

Constraint:

- still depends on compatible NVIDIA driver from host.

## 11.3 Future optional split

If artifact size becomes unacceptable:

- keep one launcher artifact,
- allow additional runtime packs downloaded by `fullmag runtime install ...`.

This is still acceptable as long as:

- the launcher owns the install,
- the user does not need Docker,
- the UX remains productized.

---

## 12. Minimum viable production target

The first honest production target should be:

1. Linux x86_64 portable tarball,
2. bundled Python runtime,
3. bundled static web shell,
4. bundled CPU runtime,
5. optional bundled CUDA FDM runtime,
6. no Docker required on user machine,
7. no repo checkout required,
8. no build tools required.

This is the narrowest target that truly satisfies:

- download,
- run,
- observe in browser,
- execute a real script.

---

## 13. Acceptance criteria

We should not call this “production distribution” until all of the following are true.

## 13.1 Clean-machine CPU acceptance

On a clean Linux machine:

1. unpack artifact,
2. add `bin/` to `PATH`,
3. run `fullmag examples/exchange_relax.py`,
4. control room opens,
5. run completes,
6. no missing system build tools are required.

## 13.2 Clean-machine GPU acceptance

On a clean Linux machine with NVIDIA driver:

1. unpack artifact,
2. run a CUDA-capable FDM example,
3. launcher resolves GPU runtime automatically,
4. control room opens before compute,
5. run completes,
6. no Docker or CUDA toolkit install is required.

## 13.3 Relocatability acceptance

1. move install directory,
2. rerun the same command,
3. application still works.

## 13.4 Provenance acceptance

Session/run metadata must record:

1. requested execution policy,
2. resolved runtime family,
3. runtime pack version,
4. launcher version,
5. artifact build id.

## 13.5 Linkage acceptance

For every release candidate artifact:

1. `ldd bin/fullmag-bin` must show no unexpected `not found` dependencies,
2. `ldd bin/fullmag-api` must show no unexpected `not found` dependencies,
3. `ldd runtimes/fdm-cuda/bin/fullmag-fdm-cuda-bin` must resolve all bundled CUDA user-space
   dependencies from the extracted artifact on a supported GPU host,
4. `ldd runtimes/fem-gpu/bin/fullmag-fem-gpu-bin` must resolve all bundled MFEM/libCEED/hypre and
   CUDA user-space dependencies from the extracted artifact on a supported GPU host,
5. `readelf -d` on packaged workers must show relative `RUNPATH` or `RPATH` entries rooted at
   `$ORIGIN`,
6. no production run requires the user to set `LD_LIBRARY_PATH`.

`libcuda.so.1` remains the one expected host-provided dependency for CUDA execution and should be
validated via GPU-host smoke tests, not solved by bundling the driver into the artifact.

---

## 14. Immediate repo actions

The next concrete repo tasks should be:

1. add a new release-oriented packager that assembles a relocatable portable layout instead of only
   `.fullmag/dist/fullmag-host`,
2. define and implement runtime manifests for `cpu-reference`, `fdm-cuda`, and exported `fem-gpu`,
3. bundle a private Python runtime into the portable artifact,
4. make static web assets part of the release layout and serve them without Node at runtime,
5. add ELF-linkage checks (`ldd` + `readelf`) for packaged base/runtime binaries,
6. add smoke tests that run against the packaged artifact, not just the repo-local launcher.

---

## 15. Recommendation

The repo should explicitly adopt this rule:

- containers are allowed in build/export and CI,
- containers are not part of the default end-user runtime story.

That gives us both:

1. sane, reproducible heavy-backend builds,
2. a real product that can be downloaded and run directly.

This is the correct path if Fullmag is meant to be shipped as an actual application rather than a
developer environment.
