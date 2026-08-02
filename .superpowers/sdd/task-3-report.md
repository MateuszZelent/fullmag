# Slice 3 report — typed C ABI and native mesh core

## Scope

- One canonical, versioned `fullmag_fem_mesh_desc` boundary.
- Typed CSR cells and facets with immutable global ordinals and facet roles.
- Native validation and canonical runtime ownership only; no mixed-element
  MFEM/libCEED/CUDA physics in this slice.
- Existing tetrahedral physics remains explicitly gated until later CPU/GPU
  operator slices.

## Container-first baseline

The default Compose project could not allocate a new subnet:

```text
failed to create network fem-mixed-prism-pyramid_default:
all predefined address pools have been fully subnetted
```

No network was removed. The existing `fullmag_default` network was reused via
the same authoritative recipe:

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-time-domain-native-contract
```

Pre-change result: exit `0`; all recipe-owned native contracts built and ran.
The container mounted this worktree at `/workspace`; host `native/build` was
76 MiB after the run. Free filesystem space remained 3.7 GiB.

## TDD RED evidence

Rust ABI layout/wire-code test:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target \
  CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 \
  cargo test -p fullmag-fem-sys --lib \
  typed_mesh_v2_abi_layout_and_wire_codes_are_frozen
```

Expected RED: exit `101`, with missing
`FULLMAG_FEM_MESH_DESC_ABI_VERSION`, cell/facet/role wire constants, and all
typed descriptor fields. The old descriptor exposed only fixed
tetrahedron/triangle fields.

Container-owned C++ contract:

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-time-domain-native-contract
```

Expected RED: exit `2` while compiling `fem_mesh_contract.cpp`, with the old
ABI size/layout, missing typed buffers/runtime state, and missing generic
`element_topology` face/edge tables. The test is now part of this authoritative
recipe rather than an unexecuted standalone target.

## Design decision

The ABI boundary is an in-place, managed-runtime rebuild to mesh descriptor
version 2. There is no parallel v1 descriptor or legacy fixed-connectivity
field set. The descriptor starts with `abi_version` and `struct_size`, every
pointer has an explicit scalar length, and C/Rust freeze the exact 64-bit
layout. Native import validates the complete descriptor before copying into one
canonical typed runtime state. Mixed topology may cross and be validated by the
ABI/core, but current tetra-only physics rejects it at an explicit gate until
the later operator slices.

## Implementation status

- [x] Container-first baseline
- [x] Rust RED layout/wire-code test
- [x] C++ RED validation/copy/family-table tests
- [x] ABI and runner lowering implementation
- [x] Native typed import, validation, and topology tables
- [x] Managed manifest ABI fingerprint
- [x] Focused GREEN
- [x] Full container and Rust regression gates
- [x] Review — final independent verdict: Approved; no Critical, Important, or Minor findings

## Implemented contract

- `fullmag_fem_mesh_desc` is ABI v2 with an exact 232-byte LP64 C/Rust
  layout and pointer-plus-`uint64_t` length for every buffer.
- Cell wire values are tet4 `1`, prism6 `2`, pyramid5 `3`, and hex8 `4`;
  facet values are tri3 `1` and quad4 `2`; facet roles are exterior `1`,
  material interface `2`, and periodic seam `3`.
- Cells and facets cross the ABI as typed CSR connectivity with immutable
  global ordinals and markers. Native import validates ABI identity, spans,
  cardinality, CSR consistency, enum values, arity, indices, duplicate nodes,
  duplicate ordinals, finite coordinates, periodic-pair cardinality, and
  positive Jacobians at order-two validation points before copying.
- Empty optional spans are copied without null-pointer arithmetic. Derived
  runtime cardinalities are checked against the 32-bit native limit before
  conversion.
- The canonical native runtime state owns the typed buffers. Generic
  face/edge tables cover every supported cell family. The current physics
  path has one explicit tet4/tri3 fail-closed gate after typed import.
- The runner lowers canonical IR cell/facet types, roles, CSR offsets,
  markers, and global ordinals directly. The tet-only helper remains only in
  explicitly tet-only DG0/frequency-domain adapters.
- Managed schema-v2 manifests record and validate exactly:

  ```text
  mesh_desc_abi_version = 2
  mesh_desc_struct_size = 232
  mesh_desc_layout_fingerprint = fullmag:fem-mesh-desc:abi:v2:lp64:size232:typed-csr-global-ordinals
  ```

  Missing or stale values fail closed before a managed bundle is accepted.

## GREEN evidence

Focused manifest tests:

```bash
python3 -m pytest -q scripts/test_export_fem_gpu_runtime_copy_helpers.py
```

Result: exit `0`, `34 passed`.

Rust lowering/type check:

```bash
CARGO_TARGET_DIR=/tmp/fullmag-mixed-topology-target \
  cargo check -p fullmag-runner -p fullmag-fem-sys
```

Result: exit `0`; only three pre-existing runner dead-code warnings. The
owned target was later removed to recover 1.5 GiB while the disk was tight.

Authoritative time-domain/native/ABI gate:

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-time-domain-native-contract
```

Result: exit `0`. All recipe-owned native targets built and ran, including
`fem_mesh_contract` and the relaxation energy derivative matrix. The recipe
also links `fullmag-fem-sys` against the container-built `libfullmag_fem` and
the complete managed dependency stack; all `31` Rust sys tests passed,
including `typed_mesh_v2_abi_layout_and_wire_codes_are_frozen`.

Material regression gate:

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-material-element-ms-contract
```

Result: exit `0`; all 14 recipe targets built and ran.

Managed demag gate:

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-demag-poisson-contract
```

Result: exit `0`. The recipe rebuilt and exported the real managed FEM
runtime, wrote the schema-v2 manifest, accepted it with the fail-closed bundle
validator, and passed the focused Poisson/FEM-BEM/CUDA demag and periodic
contracts. During the first rebuild it exposed a Slice-2 Rust shadowing error
in DMI payload construction; the input/output locals were renamed
`tet_elements`/`dmi_elements`, the runner then compiled in the production
release build, and a whole-runner scan found no analogous shadowing pair.

## Final scans

- No legacy fixed-connectivity mesh descriptor fields remain in the C ABI,
  Rust sys binding, runner descriptor construction, or canonical native mesh
  core.
- Remaining `element_markers`/`boundary_markers` search hits are canonical
  upstream IR or regional field-target vocabulary, not legacy ABI fields.
- ABI version and fingerprint match in the public C header, Rust sys binding,
  manifest builder, manifest validator, and tests.
- No commit was created; the diff remains available for controller review.

## Review remediation

The follow-up review required the typed boundary to prove geometry, ABI
identity, overflow handling, and runner ownership rather than only preserving
the happy-path layout. The remediation adds:

- finite nonzero tri3 surface-area validation;
- quad4 boundary-edge, diagonal-orientation, and bilinear 2x2 Gauss-point
  surface-Jacobian validation, with rejected collinear/collapsed/folded
  fixtures and an accepted warped fixture;
- exact per-family face and edge table assertions for tet4, prism6, pyramid5,
  and hex8;
- a near-`UINT32_MAX` derived-cardinality rejection before any coordinate
  access, with node-coordinate indexing promoted to `size_t` before
  multiplication;
- an end-to-end `backend_create` mixed-mesh test proving rejection occurs at
  the explicit tetra-only physics gate after typed import;
- compile-time C++ and Rust size/offset assertions for the descriptor and ABI
  query structures;
- one exported `fullmag_fem_get_mesh_abi_layout` query whose version, size,
  all 30 field offsets, and fingerprint are produced by the built native
  library;
- manifest construction and validation that query the selected/bundled
  `libfullmag_fem` in an isolated subprocess and fail closed on loader, symbol,
  query, binary-hash, or manifest mismatch;
- an owned runner packing object and a container test that dereferences every
  cell, facet, role, marker, ordinal, and periodic buffer while the owner is
  alive.

Remediation verification completed before the final managed rebuild:

```bash
python3 -m pytest -q scripts/test_export_fem_gpu_runtime_copy_helpers.py
```

Result: exit `0`, `34 passed`.

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-time-domain-native-contract
```

Result: exit `0`; all native targets passed and `fullmag-fem-sys` passed
`31/31` tests.

```bash
COMPOSE_PROJECT_NAME=fullmag just verify-fem-mesh-runner-abi-contract
```

Result: exit `0`; the focused Runner -> ABI ownership test passed (`1/1`,
`782` filtered tests).

### Driver-independent ABI identity

The first post-review managed export exposed a loader dependency that the
initial `ctypes` query had hidden: the manifest is intentionally built in a
plain network-isolated container without an NVIDIA driver mount, while the
complete GPU service resolves `libcuda.so.1` through NVIDIA runtime injection.
Exact diagnostics against the built library showed the service resolving
`libcuda.so.1`, CUDA, MFEM, HYPRE, and libCEED correctly, but the plain manifest
container could not `dlopen` the same library.

The final fail-closed design does not weaken the query and does not introduce
Python mesh-layout constants or a sidecar. The same `libfullmag_fem.so`
contains one exported immutable `fullmag_fem_mesh_abi_record_v1` in the
`.fullmag_fem_abi` ELF section. The record contains a long magic, record
version/size, endian tag, reserved-zero fields, the query-layout version/size,
mesh descriptor version/size, every one of the 30 field offsets, and the fixed
fingerprint. The runtime query copies the layout from this exact record.
Builder and validator parse the actual library bytes and require exactly one
magic, in-bounds fixed-size data, supported little-endian/version/size values,
zero reserved fields, and NUL-terminated zero-filled strings.

Direct artifact evidence:

```bash
python3 scripts/query_fem_mesh_abi.py native/build/backends/fem/libfullmag_fem.so.0
readelf -S native/build/backends/fem/libfullmag_fem.so.0 | rg fullmag_fem_abi
nm -D native/build/backends/fem/libfullmag_fem.so.0 \
  | rg 'fullmag_fem_mesh_abi_record_v1|fullmag_fem_get_mesh_abi_layout'
```

Result: the parser returned ABI v2, size 232, all 30 expected offsets, and the
canonical fingerprint; `.fullmag_fem_abi` was present; both the immutable
record and runtime-query symbols were exported.

### Isolated managed qualification

The first managed rebuild shared the Compose `fullmag_target-cache` with a
concurrent build from another worktree. That produced stale cross-worktree
Rust metadata: the current Runner saw the previous `MeshIR` shape and failed
with missing `FemConnectivityIR`, `FemCellTypeIR`, `cells`, and `facets`. No
shared cache was cleaned or modified in response.

All authoritative retries used:

```bash
COMPOSE_FILE=compose.yaml:/tmp/fullmag-fem-mixed-prism-compose-overlay.yaml
COMPOSE_PROJECT_NAME=fem-mixed-prism-remediation
```

Resolved Compose configuration was checked before execution:

- `/workspace` binds this exact worktree;
- `/workspace/target` is the task-owned
  `fullmag-fem-mixed-prism-target-cache` volume;
- cargo registry and pnpm use the existing external `fullmag_cargo-cache` and
  `fullmag_pnpm-store` volumes;
- the default network is the existing external `fullmag_default` network.

During disk-pressure recovery, the reproducible 2.8 GiB worktree-local
`target/` cache was removed after checking that the host path was not itself a
mount. This was still unsafe while a container used the bind-mounted worktree:
the deletion removed the nested-volume mountpoint pathname and interrupted one
retry with `getcwd`/`cd ... /workspace/target: No such file or directory`.
The empty host mountpoint was restored. Before retry, in-container `stat` and
`docker inspect` proved that `/workspace/target` was again mounted from
`fullmag-fem-mixed-prism-target-cache`. The mountpoint was then preserved for
all active Compose runs. The controller added the corresponding durable
Project Learning to `AGENTS.md`; that controller-owned change is part of the
final review scope and must not be reverted.

Final managed qualification:

```bash
COMPOSE_FILE=compose.yaml:/tmp/fullmag-fem-mixed-prism-compose-overlay.yaml \
COMPOSE_PROJECT_NAME=fem-mixed-prism-remediation \
just verify-fem-demag-poisson-contract
```

Result: exit `0`. The release build completed in 15m19s, the plain GPU-less
manifest container successfully parsed the embedded ELF record, staging and
published-bundle validators both accepted the exact binary/manifest identity,
and all focused Poisson, FEM-BEM, CUDA demag, and periodic contracts passed.
The published variant hash was
`candidate-sm89-fda735d7c7b50b543e12cd5e5c74e57c394da705a53cf55ce033c9be013bbaf2`.

Final regression reruns:

```bash
COMPOSE_FILE=compose.yaml:/tmp/fullmag-fem-mixed-prism-compose-overlay.yaml \
COMPOSE_PROJECT_NAME=fem-mixed-prism-remediation \
just verify-fem-material-element-ms-contract
```

Result: exit `0`; all 14 material/runtime targets built and ran.

```bash
COMPOSE_FILE=compose.yaml:/tmp/fullmag-fem-mixed-prism-compose-overlay.yaml \
COMPOSE_PROJECT_NAME=fem-mixed-prism-remediation \
just verify-fem-mesh-runner-abi-contract
```

Result: exit `0`; final Runner -> ABI ownership test passed (`1/1`, `782`
filtered tests).

After all gates completed and no task container remained active, the unused
task-owned `fullmag-fem-mixed-prism-target-cache` volume (970.2 MiB) was
removed to recover disk space. The shared `fullmag_target-cache` was never
cleaned, removed, or otherwise modified by this remediation.

## Final review remediation (2026-07-28)

The post-remediation review required the binary ABI identity path to fail
closed without scanning arbitrary library bytes. The final implementation now
uses `scripts/query_fem_mesh_abi.py` as the single common builder/validator
consumer expectation. It requires exactly mesh ABI v2, descriptor size 232,
all 30 exact field offsets, and the canonical fingerprint. Its bounded ELF64
little-endian parser reads the section table and string table with checked
ranges, requires exactly one `.fullmag_fem_abi` `PROGBITS` section of size 416
and alignment 8, and parses the immutable record only from that section.

Focused parser proof:

```bash
python3 -m pytest -q \
  scripts/test_query_fem_mesh_abi.py \
  scripts/test_export_fem_gpu_runtime_copy_helpers.py
```

Result: exit `0`, `46 passed`. The 12 direct ELF tests cover the exact valid
record, unrelated duplicate magic outside the section, old ABI v1, wrong
descriptor size, one wrong offset, wrong fingerprint, missing/duplicate
sections, corrupt record magic, wrong ELF class/endian, truncated input,
out-of-bounds section-name data, and invalid section type/alignment.

The query layout and immutable record now have complete compile-time
size/alignment/member-offset assertions in production C++, the native C++
contract, and Rust. The Runner ownership test directly verifies ABI
version/size, `nodes_xyz`, every typed CSR pointer and length, and null/zero
semantics for every empty packed buffer. Its recipe performs CMake configure
before building, so it no longer assumes an existing `native/build`.

```bash
COMPOSE_FILE=compose.yaml:/tmp/fullmag-fem-mixed-prism-compose-overlay.yaml \
COMPOSE_PROJECT_NAME=fem-mixed-prism-remediation \
just verify-fem-mesh-runner-abi-contract
```

Result: exit `0`; Runner test `1/1` passed (`782` filtered).

```bash
COMPOSE_FILE=compose.yaml:/tmp/fullmag-fem-mixed-prism-compose-overlay.yaml \
COMPOSE_PROJECT_NAME=fem-mixed-prism-remediation \
just verify-fem-time-domain-native-contract
```

Result: exit `0`; all requested native contracts passed and
`fullmag-fem-sys` passed `31/31` tests.

The first final managed rebuild completed its release build and container-side
export, then host publication failed with `No space left on device`. After
confirming the active runtime symlink and absence of task-volume containers,
two obsolete task-owned runtime variants (`571ee...` and later `fda735...`)
were removed one at a time. The active runtime and the task-owned release
cache were preserved; the shared `fullmag_target-cache` remained untouched.

The cached retry completed successfully:

```bash
COMPOSE_FILE=compose.yaml:/tmp/fullmag-fem-mixed-prism-compose-overlay.yaml \
COMPOSE_PROJECT_NAME=fem-mixed-prism-remediation \
just verify-fem-demag-poisson-contract
```

Result: exit `0`. The GPU-less manifest builder and both staging/published
validators accepted the real ELF section record; all focused Poisson,
FEM-BEM, CUDA demag, and periodic contracts passed. The final active variant
is `candidate-sm89-66284f27700bbb78d00d656ad6548a8e9eb7e3e6fb6ffaa4952503f2a642d6d9`.

Direct published-binary proof returned ABI v2, size 232, all expected offsets,
and the canonical fingerprint. `readelf -SW` reported one
`.fullmag_fem_abi` `PROGBITS` section with size `0x1a0` and alignment 8.

```bash
COMPOSE_FILE=compose.yaml:/tmp/fullmag-fem-mixed-prism-compose-overlay.yaml \
COMPOSE_PROJECT_NAME=fem-mixed-prism-remediation \
just verify-fem-material-element-ms-contract
```

Result: exit `0`; all 14 material/runtime targets built and ran.

Final source hygiene: `git diff --check` exited `0`. No commit or staging was
created.

---

# Task 3 — retained charts during background refresh

## Scope

Added the `ChartDataPresentationState` reducer and changed chart presentation
only. The table resource hook remains the HTTP v2 snapshot owner; the view now
receives a read-only status/error/revision projection solely to distinguish the
retained revision from the requested refresh revision. No endpoint, polling,
resource authority, or Task 2 semantics changed.

The brief's listed components did not include the owners of the raw refresh
metadata. The minimal forwarding path is therefore:

`useAnalysisTableData` resource result -> analysis controller -> module/view ->
`AnalysisTableSurface`.

## RED

The required three-file command failed as intended before implementation:

- `chartPresentationState.test.ts` could not import the missing reducer;
- the 100-rerender canvas regression had no refresh presentation contract;
- `EChartsSurface` rendered `Loading chart renderer` with usable data and
  `Loading table samples` during refresh.

Result: 3 failed files, 3 failed tests, 10 passed tests.

## GREEN

```text
env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run \
  src/shared/analysis-charts/chartPresentationState.test.ts \
  src/shared/analysis-charts/EChartsCanvasSurface.test.tsx \
  src/shared/analysis-charts/ChartSection.test.tsx \
  src/modules/analysis-plots/components/EChartsSurface.test.tsx \
  src/shared/analysis-charts/ChartLegend.rowsBinary.integration.test.tsx
```

Result: 5 files passed, 23 tests passed. The canvas test rerenders a retained
chart 100 times and verifies one ECharts owner, stable bounds, and no loading
overlay. Header tests verify `Updating` with both revisions and retained stale
data with its error text.

```text
corepack pnpm --dir apps/control-room typecheck
git diff --check
```

Both passed.

## Behavior

- Only an absent payload is allowed to show initial loading or a no-payload
  error.
- `refreshing` keeps the existing canvas and reports static `Updating` with
  the visible and requested revisions.
- A failed refresh keeps the canvas and reports the error beside the visible
  revision.
- `paused` retains the visible revision and adds no activity animation.

## Follow-up — empty and unsupported table states

The presentation projection now carries explicit semantic metadata rather than
inferring emptiness from a decoded object. A valid `ChartTableWindow` with
`rowCount: 0` projects as `empty` and renders `No table samples`; a non-empty
retained window still projects as `refreshing` during a background refresh and
keeps its canvas. `unsupported` is a distinct projection state with a supplied
reason, so `AnalysisTableSurface` does not collapse it into `idle`.

### RED

Before the fix, the focused test command failed with three regressions:

- an explicitly empty zero-row payload derived `ready`;
- an `unsupported` snapshot derived `empty`;
- the table surface rendered `No table samples` instead of the explicit
  unsupported reason.

### GREEN

Focused tests: `chartPresentationState`, `EChartsCanvasSurface`, `ChartSection`,
`EChartsSurface`, `ChartLegend.rowsBinary.integration`, and
`AnalysisTableSurface` all passed: 6 files, 27 tests.

The state-matrix tests cover both explicit states and the surface tests assert
the visible empty and unsupported messages. The Control Room typecheck and
`git diff --check` both passed. No resource hook, endpoint, polling policy, or
resource ownership changed.

## Follow-up — semantic unsupported precedence

The semantic table state now crosses the actual control-room path:

`published table schema -> useAnalysisTableData -> controller -> module -> view -> AnalysisTableSurface`.

An explicitly published empty schema means scalar table samples are not
available from the active runtime, so the hook supplies a semantic
`unsupported` reason. The controller publishes that semantic status and reason
separately from the raw `tableRowsRefresh` resource result. The surface gives
the semantic `unsupported` state precedence over a raw `ready`/`loading`/
`stale` resource status; all other states keep using the raw refresh metadata.

### RED and GREEN

The real view-path regression mounted `AnalysisPlotsView` with semantic
`tableRowsStatus="unsupported"`, its explicit reason, and
`tableRowsRefresh.status="ready"`. Before the change it showed the retained
ready chart and omitted the reason. It now shows the semantic unsupported
message.

Focused verification passed: 8 files, 92 tests, including the raw-refresh
precedence regression and the empty-schema reason owner test. Control Room
typecheck and `git diff --check` also passed.
