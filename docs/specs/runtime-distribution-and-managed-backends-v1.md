# Runtime Distribution and Managed Backends v1

- Status: draft stable distribution/runtime contract
- Last updated: 2026-03-27
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`

## 1. Purpose

This document defines how Fullmag is packaged and delivered as **one official application** while
still depending on heavyweight backend runtimes such as:

- CUDA FDM
- MFEM + libCEED + hypre FEM GPU

It exists to prevent a drift where:

- the architecture says “one product”,
- but implementation details quietly turn that into multiple unrelated tools.

The goal is one product contract with managed runtimes behind it.

---

## 2. Scope

This spec covers:

- official user-facing launcher shape,
- distribution model on Linux,
- separation between launcher package and managed runtime packs,
- relocatable workstation runtime packs with colocated shared libraries,
- containerized backend runtimes,
- runtime selection and fallback behavior,
- provenance requirements related to runtime resolution.

This spec does **not** define:

- `ProblemIR`,
- session/run resource schemas,
- native backend C ABI details,
- exact field/artifact formats,
- physics semantics of FDM or FEM.

Cluster/HPC execution details are defined in:

- `docs/specs/hpc-cluster-execution-v1.md`

---

## 3. Core product rule

Fullmag must feel like **one application** to the user.

That means:

- one public command: `fullmag`
- one canonical browser control room
- one Python authoring surface
- one session/run model
- one artifact/provenance model

It does **not** mean every backend must be statically bundled into one giant executable.

The product boundary is:

- one launcher contract,
- possibly multiple managed runtimes.

---

## 4. Official user experience

The canonical local Linux workflow is:

```bash
fullmag my_problem.py
```

The user should not need to think in terms of:

- CUDA toolkits,
- MFEM builds,
- libCEED versions,
- hypre installs,
- container images,
- ABI seams.

Those remain internal runtime management concerns.

On HPC systems, the canonical launcher UX may be even simpler:

```bash
fullmag task1.py --headless
```

where job placement is handled by an external dispatch system such as Microlab.

### 4.1 Headless mode

```bash
fullmag my_problem.py --headless
```

Same runtime selection contract, without browser launch.

### 4.2 Runtime management UX

The official launcher is expected to grow explicit runtime-management commands such as:

```bash
fullmag runtime list
fullmag runtime doctor
fullmag runtime install fem-gpu
fullmag runtime remove fem-gpu
```

These commands are part of the intended product contract even if some are not yet fully
implemented.

They are most relevant for workstation/dev-managed environments.

On HPC systems with an external dispatch/runtime manager, Fullmag may simply consume a pre-provided
runtime without exposing installation flows to the end user.

---

## 5. Packaging model

## 5.1 Launcher package

The launcher package is the user-facing Fullmag application shell.

On Linux, preferred forms are:

- `AppImage`
- `.deb`
- `.rpm`

The launcher package owns:

- CLI parsing and UX,
- Python helper spawning,
- session manager,
- local API bootstrap,
- browser opening,
- control-room asset serving,
- runtime discovery,
- runtime selection,
- runtime diagnostics,
- artifact/provenance bookkeeping.

## 5.2 Managed runtime packs

Heavy backend stacks should be packaged as managed runtimes, not assumed to exist on the host.

Initial runtime families:

- `cpu-reference`
- `fdm-cuda`
- `fem-gpu`

Each runtime pack may be delivered as:

- bundled native libraries,
- OCI/container images,
- prebuilt runtime tarballs,
- platform-specific runtime packages.

The packaging mechanism may vary, but the launcher contract must stay the same.

For workstation production builds, the preferred form is:

- unpacked runtime packs on disk,
- with colocated shared libraries under a Fullmag-owned directory,
- resolved by the launcher with no host CUDA toolkit requirement.

---

## 6. Why heavyweight backends are not plain host dependencies

The FEM GPU stack is intentionally treated differently from the control-plane shell because it is:

- large,
- toolchain-sensitive,
- CUDA-sensitive,
- not realistic to support as an ad-hoc manual host install for normal users.

The same logic applies, to a lesser extent, to advanced CUDA FDM stacks.

Therefore:

- the host OS may carry the launcher,
- the heavy solver runtime may live in a managed runtime pack,
- on workstations that pack should usually be a relocatable on-disk runtime,
- on CI/HPC it may additionally be represented as a container/runtime image.

This is still one application.

---

## 7. Canonical runtime split

## 7.1 Bundled or lightweight components

These may be shipped directly with the host-side application package:

- Rust control plane,
- Python helper bridge,
- browser/control-room assets,
- CPU reference backends,
- small support libraries.

## 7.2 Managed heavy runtimes

These should be treated as managed runtimes:

- CUDA FDM backend,
- MFEM + libCEED + hypre FEM GPU backend.

This split is canonical because it preserves product simplicity without pretending HPC stacks are
desktop-trivial dependencies.

For workstation packaging, a managed runtime pack should normally contain:

- its worker binary,
- its backend-native shared libraries,
- its CUDA user-space shared libraries when required,
- its own manifest and diagnostics metadata.

The user must not be required to install `/usr/local/cuda`, MFEM, libCEED, or hypre manually.

## 7.3 CUDA user-space library policy

For Linux workstation production bundles, the CUDA policy is:

1. Bundle CUDA user-space libraries required by the selected runtime family inside the runtime pack.
2. Bundle backend-specific libraries such as MFEM/libCEED/hypre artifacts inside that same runtime
   pack when they are runtime dependencies.
3. Do not require `LD_LIBRARY_PATH` for normal execution.
4. Do not require a system CUDA toolkit layout such as `/usr/local/cuda`.
5. Do not bundle NVIDIA driver-owned libraries.

In practice this means:

- `runtimes/fdm-cuda/lib/` should carry libraries such as `libcudart.so*`, `libcufft.so*`, and any
  other non-driver CUDA DSOs actually linked by the FDM worker,
- `runtimes/fem-gpu/lib/` should carry the required CUDA user-space DSOs plus MFEM/libCEED/hypre
  runtime DSOs,
- `libcuda.so.1`, `libnvidia-ml.so.1`, kernel modules, and other host driver components remain
  host-provided and must not be bundled by Fullmag.

This keeps the product self-contained while preserving the only acceptable host prerequisite for GPU
execution: a compatible NVIDIA driver.

## 7.4 ELF linkage policy for relocatable runtimes

Relocatable runtime packs must resolve their dependencies relative to their own install root.

Therefore:

1. Every worker binary must use `$ORIGIN`-relative `RUNPATH` or `RPATH`.
2. Every bundled shared object that depends on sibling bundled libraries must also carry its own
   relative `RUNPATH` or `RPATH`.
3. We must not rely on repo-relative paths or developer-machine linker cache state.

Typical layout:

- worker binary: `runtimes/<family>/bin/...`
- runtime libraries: `runtimes/<family>/lib/...`
- shared base libraries: `lib/...`

Typical search rules:

- worker binary resolves `../lib` within its runtime pack first,
- then may resolve shared base libraries from the application-level `lib/`,
- bundled DSOs resolve their sibling libraries from their own directory first.

The release pipeline may use linker flags and/or post-processing tools such as `patchelf`, but the
product rule is the outcome, not the tool:

- extracted artifacts must run after moving the install directory,
- `ldd` must not report unexpected `not found` entries on supported hosts.

---

## 8. Containerized runtimes

Containerized runtimes remain first-class in Fullmag.

They are not a temporary workaround.

They are the preferred build/export and HPC form for heavyweight backend stacks.

They are not the default workstation end-user runtime form.

### 8.1 Current canonical runtime container

The production-style FEM GPU runtime container is:

- `docker/fem-gpu/Dockerfile`

and is exposed through:

- `compose.yaml` service `fem-gpu`
- `make fem-gpu-build`
- `make fem-gpu-shell`
- `make fem-gpu-check`
- `make fem-gpu-test`

This runtime image is intended to carry:

- CUDA toolkit,
- MFEM,
- libCEED,
- hypre,
- Rust toolchain needed for native backend verification.

For HPC deployment, this runtime family should also be representable as:

- Apptainer / Singularity image,
- site-approved OCI-compatible runtime,
- or a cluster-managed runtime pack resolved by the launcher.

### 8.2 Container responsibilities

The managed runtime container owns:

- backend-native build dependencies,
- solver-library installation,
- backend-native smoke/parity validation,
- repeatable runtime environment for local and CI execution.

The launcher still owns:

- user interaction,
- session creation,
- problem loading,
- backend selection,
- node-local runtime invocation,
- provenance.

---

## 9. Runtime selection policy

The launcher must select a runtime based on:

- requested backend,
- problem requirements,
- available runtimes,
- hardware availability,
- runtime health.

The canonical behavior is:

1. prefer the requested executable backend if healthy,
2. fall back only when that fallback is scientifically honest,
3. record the actual resolved runtime in provenance,
4. surface the runtime decision to the user in CLI/UI.

### 9.1 Example

If the user requests FEM GPU but the managed `fem-gpu` runtime is unavailable:

- the launcher may fall back to CPU reference only if that fallback is semantically valid for the
  problem,
- the control room and metadata must clearly show the resolved runtime,
- the user must not be misled into thinking the GPU backend actually ran.

---

## 10. Provenance requirements

Every completed run must record runtime provenance sufficient to explain execution.

Minimum required runtime provenance fields:

- launcher version
- resolved backend
- resolved execution mode
- resolved precision
- runtime family
- runtime image or runtime package identifier when applicable
- CUDA driver/runtime version when applicable
- device name / compute capability when applicable
- MFEM/libCEED/hypre build identifiers when applicable

This information must be accessible through run metadata and artifacts.

---

## 11. Official Linux distribution model

The canonical Linux story is:

1. user installs the Fullmag launcher package,
2. user optionally installs heavyweight runtimes through the launcher or bundled setup tools,
3. user runs `fullmag my_problem.py`,
4. launcher resolves the correct runtime,
5. control room opens as part of one product workflow.

The user should not need to manually invoke container engines in the normal product flow.

If containers are used internally, the launcher should manage them.

---

## 12. Non-goals

This spec does **not** require:

- one monolithic statically linked solver binary,
- shipping MFEM/libCEED/hypre inside every minimal desktop build,
- exposing container/runtime internals as part of the public user model.

---

## 13. Current state vs target state

Current state:

- the repository has a `dev` container,
- the repository now also has a dedicated `fem-gpu` runtime container path,
- the runtime-management UX in the launcher is still incomplete,
- runtime installation/update/remove flows are not yet fully productized.

Target state:

- launcher-level runtime management commands exist,
- heavy runtimes are installable and diagnosable through Fullmag itself,
- official Linux packaging presents one application with managed runtimes underneath.

---

## 14. Acceptance criteria for this contract

This contract is satisfied when:

- the official docs describe one launcher and managed runtimes consistently,
- the product does not rely on undocumented manual MFEM host setup,
- heavyweight runtime paths are reproducible in managed containers or equivalent packs,
- CLI/UI/provenance all report resolved runtimes honestly,
- users can run Fullmag without learning backend toolchain internals.
