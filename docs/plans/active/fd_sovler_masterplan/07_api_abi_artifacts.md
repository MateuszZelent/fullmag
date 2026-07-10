---
title: Frequency-domain public API, native ABI and artifact boundary
version: target v6 contract over current native ABI v12
date: 2026-07-10
status: normative target with explicit current ABI gaps
---

# API, ABI and artifact boundary

## 1. Scope and source of truth

The public contract is physics-first:

```text
Python DSL / UI -> ProblemIR -> planner -> runner materialization
  -> native C ABI -> FEM engine -> artifacts -> OpenAPI resources -> UI
```

The C ABI is an internal compiled-backend boundary. It must not redefine
public physics, infer missing intent, or expose a legacy lane as if it were a
resolved engine. The current ABI version is
`FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION = 12u`. The target stable ABI
described below is not yet fully implemented; every missing rule is
`contract_gap`.

## 2. Current ABI surfaces

| Surface | Current request/version fields | Result and release | Current role |
|---|---|---|---|
| Production driven response | `fullmag_fem_frequency_domain_driven_response_request`; tail fields `abi_version`, `reserved_contract_flags`, `struct_size` | `fullmag_fem_frequency_domain_solve_result`; release with `fullmag_fem_frequency_domain_solve_result_release()` | executable validation/CPU/GPU lane entry point |
| Modal contract | `FullmagFemModalEigenRequest.abi_version`; nested `FullmagFemLinearizedOperatorRequest.abi_version`; no public `struct_size` | `FullmagFemFrequencyDomainResult`; destroy with `fullmag_fem_frequency_domain_result_destroy()` | modal validation/selected-spectrum and Poisson-airbox contract entry point |
| Driven compatibility contract | `FullmagFemDrivenResponseRequest.abi_version`; nested operator version; no public `struct_size` | `FullmagFemFrequencyDomainResult`; same destroy function | compact compatibility/contract path, not the production request |
| Internal C++ modal request | `ModalEigenRequest.abi_version`, `.struct_size` | C++ `FrequencyDomainContractResult` copied into the public result | internal shape; its `struct_size` is not exposed by `FullmagFemModalEigenRequest` |
| Internal C++ driven request | `DrivenFrequencyResponseSolveRequest.abi_version`, `.struct_size` | `DrivenFrequencyResponseSolveResult`; internal idempotent release | implementation shape behind the production C request |

The coexistence of two driven request families and two result families is
current reality. They must not be presented as one already-stable target ABI.

## 3. Current versus target ABI

| Topic | Current ABI v12 behavior | Target stable behavior | Status |
|---|---|---|---|
| Version negotiation | Production driven accepts `abi_version` 0, 9 or 12. Modal/compact driven require exact v12. | Every public frequency-domain request/result starts with a common version/size header and follows one compatibility policy. | `contract_gap` |
| Size negotiation | Production driven accepts `struct_size=0` or exactly `sizeof(current request)`; it does not accept a known shorter prefix. Modal public request has no `struct_size`. | Caller sets the bytes it provides; callee reads only fields whose complete extent is within `struct_size`, requires a documented minimum prefix, defaults absent tail fields, and rejects impossible/interior sizes. | `contract_gap` |
| Enums | Public enums exist, but several C++ enums rely on declaration order and not every public concept is carried. | Every FFI enum is a fixed `uint32_t` value with `0=unspecified` only where compatibility requires it; unknown values reject. | partial |
| Booleans | C uses `int`; C++ uses `bool`; Rust normalizes through `i32`. | Public FFI booleans are fixed-width integers and accept only `0` or `1`; C++ `bool` never crosses the ABI. | partial |
| Pointer lengths | Many arrays have counts, including v12 tail value counts. Legacy/compact structs still use `int` lengths and some strict checks are skipped for version/size zero. | Every pointer has an adjacent fixed-width count and one nullability rule; overflow is checked before multiplication. | partial |
| Requested/resolved execution | Production driven carries broad `requested_execution_lane`; modal carries no device/lane/precision. | Request carries requested device/precision/mode/method; result names one resolved engine, residency and fallback. | `contract_gap` |
| Device pointers | Current numerical input pointers are host pointers; device work is hidden behind native contexts/callback `user_data`. | Host and device views are different tagged types; address space, owner, stream/context and synchronization contract are explicit. | `contract_gap` |
| Result lifetime | Native results allocate C strings and provide release/destroy functions. The production driven Rust wrapper uses RAII release. | All wrappers copy or borrow under one documented policy and always call the matching idempotent release exactly once. | partial |
| Modal Rust result cleanup | The wrapper copies result strings, then clears raw pointers before RAII destruction. | Copy strings, leave native pointers owned by the result guard, and destroy them after the copy. | `contract_gap` |
| Error contract | Status enums and JSON/string fields exist, but error shape varies by entry point. | One status vocabulary and one diagnostics envelope with stable reason, requested/resolved execution and partial-artifact state. | partial |

## 4. Target version and size negotiation

Every new or migrated public request/result begins with this prefix:

```c
typedef struct {
    uint32_t abi_version;
    uint32_t reserved_contract_flags;
    uint64_t struct_size;
} fullmag_fem_frequency_domain_abi_header;
```

Rules:

1. Callers zero-initialize the complete local struct, set `abi_version` to a
   supported version, and set `struct_size` to `sizeof(the caller's struct)`.
2. `abi_version=0` and `struct_size=0` remain legacy compatibility only on the
   already-shipped production driven entry point. New entry points reject zero.
3. The callee validates `struct_size >= minimum_size_for(abi_version)` and
   reads a field only when `offsetof(field)+sizeof(field) <= struct_size`.
4. Missing known tail fields receive documented defaults. A callee never reads
   beyond caller-provided bytes and never guesses an older layout from content.
5. A larger size with a known version is accepted only when the known prefix is
   layout-compatible; unknown tail bytes are ignored.
6. An unknown enum, nonzero reserved flag, impossible size, overflowed extent
   or version/layout mismatch returns `validation_error` with a stable reason.
7. ABI layout tests use `fullmag_fem_get_frequency_domain_abi_layout()` or its
   successor to compare sizes and offsets across C, C++ and Rust.

Version increments are required for incompatible layout or semantic changes.
Adding an optional tail field under a size-negotiated version is allowed only
when its zero value has the documented old behavior.

## 5. Enums and FFI-normalized booleans

Current public enum values that remain stable include:

```text
status: ok=0, unavailable=1, validation_error=2, operator_error=3,
        solve_error=4, artifact_error=5, interrupted=6
study:  response=1, eigenmodes=2
lane:   validation=0, production_cpu=1, production_gpu=2
phase:  exp_i_omega_t=0, exp_minus_i_omega_t=1
drive:  unspecified=0, dynamic_field_phasor_a_per_m=1, tangent_rhs=2,
        cartesian_torque_phasor=3, stt_current_phasor=4,
        coupled_external_provider=5
```

The lane enum is compatibility routing, not engine selection. The target
engine ID is a string/enum owned by `FrequencySolvePlanner` and returned in
diagnostics/artifacts.

All ABI boolean fields use one of:

```text
0 = false
1 = true
other = validation_error
```

Rust converts to/from `i32` at the FFI boundary. Native C++ converts to `bool`
only after validation. Public structs never contain C++ `bool`.

## 6. Pointer, length and nullability rules

For every `(pointer,count)` pair:

```text
count == 0  -> pointer may be null; callee must not dereference it
count > 0   -> pointer must be non-null and readable/writable as declared
```

The callee validates element-count multiplication and shape products before
forming spans. The v12 tail counts such as
`mfem_equilibrium_m_value_count`, `mfem_drive_real_value_count`,
`mfem_drive_imag_value_count` and coupled-block value counts are mandatory
when the corresponding strict v12 feature is enabled.

Additional rules:

- `const char *` inputs are borrowed UTF-8 NUL-terminated strings. Null means
  absent only for fields explicitly documented optional; an empty required
  string is invalid.
- Callback function pointers may be null. A non-null callback's `user_data`
  remains caller-owned and valid until the solve returns.
- The callee does not retain request pointers, spans, strings, callbacks or
  `user_data` after the synchronous call returns.
- Output buffers supplied by the caller remain caller-owned.
- Native result strings are callee-owned until the matching release/destroy.
- A direct device pointer is invalid on the current ABI. Device memory is
  reachable only through a separately owned native context/callback contract.

## 7. Real/imaginary layout and node ordering

The physical and internal layouts are different and must never share one
ambiguous field name.

| Payload | Current exact layout | Required metadata |
|---|---|---|
| `mfem_equilibrium_m` | host AoS `[mx0,my0,mz0,mx1,my1,mz1,...]`, length `3*node_count` | magnetic node ordering and mesh/FE-space identity |
| `mfem_h_ext_a_per_m` | Cartesian `[Hx,Hy,Hz]` | A/m |
| `mfem_drive_real`, `mfem_drive_imag` | tangent order `[u0,v0,u1,v1,...]`, each length `tangent_dof_count=2*magnetic_node_count`; current runner materialization places tangent-coordinate physical-field components here, while production solvers consume the buffers as `b` | `drive_kind`, physical-field versus tangent-RHS units, and projection provenance; integrating `project_dynamic_field_drive_to_tangent_rhs()` exactly once is a current `contract_gap` |
| coupled block drive | `[q,phi]` block order defined by the supplied coupled operator; real and imaginary buffers have equal count | q/phi offsets, gauge/eta presence and FE ordering |
| modal dense matrices | current row-major arrays where the field name says `_row_major`; CSR uses `row_offsets`, `column_indices`, `values` | dimensions, scalar mode and block dictionary |
| Floquet pairs | pair ID, node A/B, optional translation and phase | node ordering, `phase=-k dot translation`, magnetic versus scalar space |
| artifact XYZ complex fields | logical Zarr `[node,component,complex]`; compatibility binary `x_re,x_im,y_re,y_im,z_re,z_im,...` | mesh ID, FE space, basis, component order, units and revision |

The target ABI carries an explicit node-ordering/FE-space identity or a digest
that is checked against `LinearizationState.v6` and
`periodic_mesh_certificate.v6`. Pointer length alone cannot prove ordering.

## 8. Host/device ownership and synchronization

Current v12 request pointers are host-accessible for the duration of the call.
A label such as `production_gpu` does not change their address space and does
not prove device-resident Krylov.

The target resolved result records:

```text
operator_residency = host | device | mixed
vector_residency = host | device | mixed
krylov_residency = host | device | mixed
preconditioner_residency = host | device | mixed
hot_loop_h2d_bytes
hot_loop_d2h_bytes
hot_loop_host_sync_count
```

Device-resident claims require no per-iteration vector/matrix migration.
Bounded control-scalar reductions are reported separately. Callback-owned
device contexts must remain alive and synchronized under the callback's own
contract until the native solve returns.

## 9. Result allocation, release and diagnostics lifetime

### Production driven result

`fullmag_fem_frequency_domain_solve_result` owns its four allocated strings:

```text
error_message
diagnostics_json
result_json
artifact_manifest_path
```

Call `fullmag_fem_frequency_domain_solve_result_release(&result)` exactly once
after the last read. The current implementation is idempotent and clears the
struct, so cleanup after partial initialization is valid. Rust uses
`NativeDrivenFrequencyResponseFfiResult` as the RAII owner and copies strings
before the guard is dropped.

### Modal/compact contract result

`FullmagFemFrequencyDomainResult` owns the same four allocated strings and is
released with `fullmag_fem_frequency_domain_result_destroy(&result)`. The
destroy function is idempotent and clears the struct.

The Rust wrapper must copy the strings while the guard is alive, then allow the
guard to call destroy. Clearing raw pointers before destroy leaks ownership and
is a current `contract_gap`.

### Error and callback strings

- Result strings remain valid until release/destroy.
- `progress_json` passed to a callback is borrowed only for that callback
  invocation; the receiver copies it if it needs persistence.
- Fixed callback error buffers are caller-provided for the duration of one
  callback call.
- `diagnostics_json` is the machine-readable explanation. `error_message` is
  concise human-readable context and does not replace a stable reason code.

## 10. Error and fallback semantics

Transport return and solve status are separate:

- a nonzero C function return means the ABI call itself failed before a valid
  owned result was transferred;
- a zero C function return may still carry `validation_error`, `unavailable`,
  `operator_error`, `solve_error`, `artifact_error` or `interrupted` in the
  result status;
- callers always release a successfully transferred result, regardless of its
  solve status.

Diagnostics for unavailable/rejected execution include:

```text
status
complete
reason or unsupported_reason
requested_execution
resolved_execution
fallback_used
partial_artifacts_available
```

Forced GPU, explicit precision and explicit solver method never silently
fallback. Validation/dense, CPU, K0, open-boundary, no-demag, synthetic or
postsolve-phase paths cannot replace a different requested physical operator.

## 11. Public artifact and resource boundary

The native ABI returns only control-plane JSON/string summaries and an
artifact-manifest path. Large modal and response arrays are published as Zarr
or another specified data-plane store and discovered through:

```text
frequency_domain/manifest.v1.json
OpenAPI /v2/sessions/current/analysis/frequency-domain/...
/v2/sessions/current/data/fields/{field_id}/samples/vector
ControlRoomApi.analysis.frequencyDomain
useFrequencyDomain*Resource hooks
```

The hardened manifest requirements live in
`docs/specs/frequency-domain-artifacts-v2.md`. ABI fields and artifacts use the
same requested/resolved execution, phase, equilibrium/certificate, assembly,
BC/gauge, spectral shift, residual and fallback meanings. Artifact publication
must fail if those meanings disagree with native diagnostics.

## 12. Backward compatibility and migration

1. Keep the current production driven v12 entry point and its v9/zero legacy
   acceptance while existing callers migrate.
2. Treat zero version/size as legacy, report that fact in diagnostics, and do
   not enable tail-dependent features without their validated lengths.
3. Add size headers to modal and compact driven requests in a new ABI version;
   do not reinterpret their current layout in place.
4. Keep both release functions until all callers use one consolidated result
   family.
5. Preserve current numeric enum values. New enum values append; they never
   renumber old values.
6. Preserve current ABI lane names as compatibility input, but resolve them to
   one target engine in diagnostics.
7. Reject mixed-version nested requests unless the version contract explicitly
   permits that pair.
8. Maintain C/C++/Rust size-and-offset tests and add allocation/release tests
   for success, every failure status and partial initialization.

The target stable ABI is complete only after all request families implement
the same negotiation, ownership, status and requested/resolved semantics. Until
then, documentation and artifacts must retain the current-vs-target boundary.
