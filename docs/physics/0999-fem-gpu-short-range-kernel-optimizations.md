# FEM GPU. Short-Range Kernel Optimizations: Intermediate Reduction Gating, Explicit-RK FMA Exchange, Fused Effective-Field Accumulation, and Device AoS/SoA Pack-Unpack

Status `implemented / contract-tested / qualified on RTX 4080 SUPER` (see [2026-11-26-fem-pgbb-kernels-dr-ab.md](../audits/2026-11-26-fem-pgbb-kernels-dr-ab.md)). This note specifies four numerical and systems realization optimizations inside the strict device-resident FEM GPU short-range interaction and state-I/O pipeline:

1. **Intermediate RK reduction gating and lazy `h_drive` zeroing:** passing `nullptr` for unused intermediate-stage reduction outputs (`energy_out`, `block_sums`, `block_max_sigma`) in `rk_dmi_fields.cu`, `rk_anisotropy_field.cu`, `rk_magnetoelastic_field.cu`, and `rk_thermal_field.cu`, specializing the corresponding CUDA kernels via `template <bool ComputeEnergy>` / `template <bool ComputeMaxSigma>` (with deadlock-free predicated `cub::BlockReduce` for final DMI energy evaluation), and gating zero-drive `cudaMemsetAsync` via `FemGpuFieldBufferDeviceState::h_drive_zeroed` (default `false` after raw `cudaMalloc`).
2. **Dual-path sparse exchange accumulation:** dispatching hardware FP64 FMA graph-Laplacian accumulation (`Compensated = false`, ~6 FP64 operations/NNZ) on explicit Runge-Kutta dynamics stages while retaining software double-double (`gpu_relax_dd`, `Compensated = true`) for direct-minimizer relaxation (`PGBB`/`NCG`) and keeping `ExchangeDoubleDouble` untouched in polarized energy-difference kernels.
3. **Single-launch fused XYZ effective-field accumulation:** replacing up to 28 per-component kernel launches per RK stage in `rk_effective_field.cu` and `rk_oersted_field.cu` with one fused kernel `fullmag_cuda_accumulate_heff_fused_xyz` preserving exact IEEE-754 addition order and explicit non-contracted `__dmul_rn` / `__dadd_rn` Oersted scaling for bit-for-bit equality.
4. **Device-side AoS/SoA pack-unpack transfer replacement:** adding `fullmag_cuda_unpack_aos_to_soa`, `gpu_component_upload_aos_packed`, `gpu_state_upload_magnetization_aos_packed`, and `gpu_state_download_magnetization_aos_packed` reusing the persistent `packed_field_download.aos_device` buffer (0 B additional VRAM) and switching all production transfer sites in `state_io.cpp` and `stage_compute.cpp` off strided `cudaMemcpy2D`.

(problem-statement)=
## Scope

The physical definitions of Heisenberg exchange, interfacial/rotated/bulk Dzyaloshinskii-Moriya interaction (DMI), uniaxial/cubic magnetocrystalline anisotropy, prescribed-strain magnetoelasticity, Oersted fields, Brown stochastic thermal fields, and regional Zeeman drives belong to their canonical physics notes. This note records only the device-resident FEM GPU realization optimizations that reduce kernel launch count, eliminate dead intermediate reductions and atomic contention, cut explicit-RK FP64 ALU cost on low-FP64-ratio GPUs, and replace strided 8-byte `cudaMemcpy2D` transfers without altering the governing micromagnetic equations or breaking relaxation Armijo energy-derivative precision.

| Realization | Scope of this note | Evidence |
|---|---|---|
| FEM CPU | Unchanged; retains existing CPU MFEM field assembly, consistent-mass exchange projection, and host-resident state buffers | Source unchanged |
| FEM GPU | Template-gated intermediate RK reductions, deadlock-free `cub::BlockReduce` DMI energy, lazy `h_drive_zeroed` memset skip, dual-path FMA/DD sparse exchange, single-launch fused `H_eff`, and device-side AoS/SoA pack-unpack transfers | Qualified on RTX 4080 SUPER (SM `89-real`, Docker DEV): `fem_cuda_shortrange_kernels_contract` + `compute-sanitizer --tool memcheck` (0 errors), `fem_gpu_state_runtime_contract`, `fem_state_io_contract`, `fem_oersted_contract` PASS; `1.80×` RK4 E2E (`m_rel = 4.53e-16`), `8.02×` exchange FMA, `2.54×` DMI RK, `17.5×` fused `H_eff`, `13.93×` `state_io` (`40.5×` D2H / `6.30×` H2D); see `docs/audits/2026-11-26-fem-pgbb-kernels-dr-ab.md` |
| FDM CPU | Not applicable | FDM uses structured-grid finite-difference stencils and host arrays, not unstructured FEM CSR exchange, tetrahedral DMI, or SoA/AoS GPU transfer buffers |
| FDM GPU | Not applicable | FDM uses structured-grid CUDA stencil kernels and its own device memory layout, not the FEM GPU RK field pipeline |

(governing-equations)=
## Equations

### 1. Graph-Laplacian sparse exchange field and roundoff envelope

For each active magnetic node $i \in \Omega_m$ with saturation magnetization $M_{s,i} > 0$, inverse lumped nodal volume $M_{\mathrm{lumped},i}^{-1} > 0$, and off-diagonal stiffness weights $K_{ij}$ satisfying the row-sum identity $\sum_{j} K_{ij} = 0$, both the compensated double-double path (`Compensated = true`) and the explicit-RK hardware FP64 FMA path (`Compensated = false`) evaluate the identical difference form:

```{math}
:label: eq-exchange-graph-laplacian
\mathbf{H}_{\mathrm{ex},i}
= -\frac{2}{\mu_0 M_{s,i} M_{\mathrm{lumped},i}}
  \sum_{j \neq i} K_{ij} \left(\mathbf{m}_j - \mathbf{m}_i\right)
```

For a uniform magnetization $\mathbf{m}_j = \mathbf{m}_i$ for all neighbors $j$, IEEE-754 floating-point subtraction satisfies $\mathrm{fl}(\mathbf{m}_j - \mathbf{m}_i) = \mathbf{0}$ identically, so the FMA recurrence $\mathrm{fma}(K_{ij}, \mathbf{m}_j - \mathbf{m}_i, \mathbf{s})$ produces exact zero on uniform states. For smooth textures with nodal degree $d_i$ and $\frac{1}{2} m_{i,\alpha} \le m_{j,\alpha} \le 2 m_{i,\alpha}$, Sterbenz's lemma guarantees exact neighbor differences and bounds the relative discrepancy between the fast FMA and compensated double-double sums by:

```{math}
:label: eq-exchange-fma-error-bound
\frac{\left\| \mathbf{H}_{\mathrm{ex},i}^{\mathrm{FMA}} - \mathbf{H}_{\mathrm{ex},i}^{\mathrm{DD}} \right\|_\infty}
     {\max\!\left(1,\, \left\|\mathbf{H}_{\mathrm{ex}}^{\mathrm{DD}}\right\|_\infty\right)}
\le d_{\max} \, \varepsilon_{\mathrm{mach}} \ll 10^{-13}
```

### 2. Predicated block-reduced DMI energy and intermediate reduction gating

For tetrahedral DMI weak-residual assembly over elements $e \in \{0, \dots, N_e - 1\}$, each thread evaluates an element activity predicate $\chi_e \in \{0, 1\}$ (requiring $e < N_e$, magnetic element mask active, non-degenerate Jacobian determinant $|\det J_e| > 10^{-30}$, and non-zero DMI coupling) so that every thread in a block of size $B = 256$ unconditionally participates in the collective block sum when energy output is requested (`energy_out != nullptr`):

```{math}
:label: eq-dmi-block-reduce-energy
E_{\mathrm{DMI}}
= \sum_{b=0}^{\lceil N_e / B \rceil - 1}
  \left(
    \sum_{t=0}^{B-1} \chi_{bB+t}\, w_{\mathrm{DMI}, bB+t}\, V_{bB+t}
  \right)
```

When `energy_out == nullptr` (all intermediate RK stages), `dmi_element_residual_kernel<false>` omits energy density evaluation, shared-memory reduction, and global `atomicAdd` entirely. Analogously, `uniaxial_anisotropy_field_energy_blocks_kernel<false>`, `cubic_anisotropy_field_energy_blocks_kernel<false>`, `magnetoelastic_field_energy_blocks_kernel<false>`, and `thermal_field_blocks_kernel<false>` elide `cub::BlockReduce` and global block-partial writes when their reduction pointer is `nullptr`.

### 3. Order-preserving fused effective-field composition

For each node $i \in \{0, \dots, N-1\}$, the single-launch kernel `fullmag_cuda_accumulate_heff_fused_xyz` evaluates the total effective field $\mathbf{H}_{\mathrm{eff},i}$ in the exact left-associative IEEE-754 order of the legacy 28-launch sequence, while materializing the time-scaled cylindrical Oersted field $\mathbf{H}_{\mathrm{oe},i} = s_{\mathrm{oe}}(t_{\mathrm{eval}}) \mathbf{H}_{\mathrm{oe,basis},i}$ via non-contracted `__dmul_rn` and `__dadd_rn`:

```{math}
:label: eq-heff-fused-order
\mathbf{H}_{\mathrm{eff},i}
= \left(\left(\left(\left(\left(\left(\left(\left(\left(
    \mathbf{H}_{\mathrm{ex},i} + \mathbf{H}_{\mathrm{demag},i}
  \right) + \mathbf{H}_{\mathrm{ext},i}\right)
  + \mathbf{H}_{\mathrm{drive},i}\right)
  + \mathbf{H}_{\mathrm{ani},i}\right)
  + \mathbf{H}_{\mathrm{cubic},i}\right)
  + \mathbf{H}_{\mathrm{dmi},i}\right)
  + \mathbf{H}_{\mathrm{bulk},i}\right)
  + \mathbf{H}_{\mathrm{oe},i}\right)
  + \mathbf{H}_{\mathrm{mel},i}\right)
  + \mathbf{H}_{\mathrm{therm},i}
```

where inactive terms (bit unset in `active_mask`) are skipped without reading their device pointers.

### 4. Contiguous device AoS/SoA transposition

Let $A \in \mathbb{R}^{3N}$ denote an Array-of-Structures vector buffer and $(X, Y, Z) \in (\mathbb{R}^N)^3$ its Structure-of-Arrays device representation. Device-side packing (`fullmag_cuda_pack_soa_to_aos`) and unpacking (`fullmag_cuda_unpack_aos_to_soa`) realize the exact bijection:

```{math}
:label: eq-aos-soa-bijection
A_{3i + 0} = X_i, \qquad A_{3i + 1} = Y_i, \qquad A_{3i + 2} = Z_i, \qquad i \in \{0, \dots, N-1\}
```

allowing every host-device transfer to execute as one contiguous `cudaMemcpyAsync` of $24N$ bytes on the explicit compute stream instead of three strided `cudaMemcpy2D` calls.

(symbols-and-si-units)=
## Symbols and SI units

| Token | Meaning | SI unit |
|---|---|---|
| $\mathbf{m}_i$ | Reduced unit-length magnetization at mesh node $i$ | $1$ |
| $M_{s,i}$ | Saturation magnetization at mesh node $i$ | $\mathrm{A\,m^{-1}}$ |
| $M_{\mathrm{lumped},i}$ | Lumped finite-element nodal volume at mesh node $i$ | $\mathrm{m^3}$ |
| $\mu_0$ | Vacuum magnetic permeability | $\mathrm{N\,A^{-2}}$ |
| $K_{ij}$ | Assembled scalar exchange stiffness entry between nodes $i$ and $j$ | $\mathrm{J}$ |
| $\mathbf{H}_{\mathrm{ex},i}$ | Discrete nodal exchange effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{ex},i}^{\mathrm{FMA}}$ | Exchange field evaluated with hardware FP64 FMA (`Compensated = false`) | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{ex},i}^{\mathrm{DD}}$ | Exchange field evaluated with software double-double (`Compensated = true`) | $\mathrm{A\,m^{-1}}$ |
| $d_{\max}$ | Maximum nodal adjacency degree in the FEM exchange CSR graph | $1$ |
| $\varepsilon_{\mathrm{mach}}$ | IEEE-754 binary64 machine epsilon ($2^{-52} \approx 2.22 \times 10^{-16}$) | $1$ |
| $N_e$ | Number of tetrahedral finite elements | $1$ |
| $B$ | CUDA thread-block size used by short-range reduction kernels ($256$) | $1$ |
| $\chi_e$ | Element activity predicate gating DMI assembly prior to collective block reduction | $1$ |
| $w_{\mathrm{DMI},e}$ | Element DMI energy density | $\mathrm{J\,m^{-3}}$ |
| $V_e$ | Tetrahedral element volume | $\mathrm{m^3}$ |
| $E_{\mathrm{DMI}}$ | Integrated interfacial or bulk DMI energy | $\mathrm{J}$ |
| $\mathbf{H}_{\mathrm{eff},i}$ | Total effective magnetic field at mesh node $i$ | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{demag},i}$ | Nodal demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{ext},i}$ | Uniform external Zeeman field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{drive},i}$ | Materialized regional time-dependent Zeeman drive field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{ani},i}$ | Uniaxial magnetocrystalline anisotropy field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{cubic},i}$ | Cubic magnetocrystalline anisotropy field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{dmi},i}$ | Interfacial (and optional rotated) DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{bulk},i}$ | Bulk DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{oe},i}$ | Realized Oersted magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{oe,basis},i}$ | Per-ampere cylindrical Oersted basis field | $\mathrm{m^{-1}}$ |
| $s_{\mathrm{oe}}(t_{\mathrm{eval}})$ | Time-dependent Oersted current scaling factor at stage evaluation time | $\mathrm{A}$ |
| $\mathbf{H}_{\mathrm{mel},i}$ | Prescribed-strain magnetoelastic effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf{H}_{\mathrm{therm},i}$ | Deterministic Brown stochastic thermal field | $\mathrm{A\,m^{-1}}$ |
| $N$ | Number of mesh nodes | $1$ |
| $A_{3i+c}$ | Interleaved Array-of-Structures vector component $c \in \{0,1,2\}$ at node $i$ | $\mathrm{A\,m^{-1}}$ |
| $X_i, Y_i, Z_i$ | Structure-of-Arrays device vector components at node $i$ | $\mathrm{A\,m^{-1}}$ |

(assumptions-and-validity)=
## Assumptions and validity

- **Final-step energy independence:** All accepted-step RK energies are reduced independently in `rk_dmi_energy_reductions.cu`, `rk_anisotropy_energy_reductions.cu`, and `rk_magnetoelastic_energy_reductions.cu` with non-null reduction buffers. Intermediate RK stage reductions into `gpu.reductions.scalar_workspace` were never read; gating them with `nullptr` introduces zero mathematical approximation.
- **Deadlock freedom in `dmi_element_residual_kernel<true>`:** Because `cub::BlockReduce` executes block-wide `__syncthreads()` barriers, all four early-return guards (`e >= element_count`, nonmagnetic element mask, degenerate tetrahedron Jacobian, and zero DMI coupling) are converted into a predicated `bool active` mask so every thread in every block reaches `BlockReduce::Sum` unconditionally.
- **Uninitialized VRAM safety for `h_drive_zeroed`:** `gpu_field_buffers_allocate` allocates `fields.h_drive` via raw `cudaMalloc` without zeroing it. Therefore `FemGpuFieldBufferDeviceState::h_drive_zeroed` defaults strictly to `false` and is reset to `false` in `gpu_field_buffers_allocate`, `gpu_field_buffers_free`, `gpu_regional_field_drive_destroy`, and whenever `regional_drive_count > 0`. It transitions to `true` only after all three components of `h_drive` are explicitly zeroed by `cudaMemset` or `cudaMemsetAsync`.
- **Precision separation between RK and relaxation:** Direct-minimizer Armijo energy-increment contracts (`relaxation_energy_derivative_contract.cpp`) verify $\langle \mathbf{g}, \delta \mathbf{m} \rangle = \Delta E$ to $10^{-15}$ and require compensated accumulation. Accordingly, `gpu_rk_compute_effective_field_for_magnetization_fresh_demag` (the sole effective-field entry point for `pgbb.cpp`, `nonlinear_cg.cpp`, and `direct_energy_increment.cpp`) retains `compensated_accumulation = true`, and `exchange_energy_difference_kernel` retains `ExchangeDoubleDouble` unchanged. Only explicit RK dynamics (`gpu_rk_compute_rhs_for_magnetization` and `gpu_rk_compute_effective_field_for_magnetization`) uses `compensated_accumulation = false`.
- **No FP contraction drift in fused `H_eff`:** CUDA compiles with `-fmad=true` by default; `accumulate_heff_fused_xyz_kernel` explicitly calls `__dmul_rn` and `__dadd_rn` for scaled cylindrical Oersted fields so `nvcc` cannot fuse `h_oe_scale * h_oe_src + sx` into a single FMA that would differ by 1 ULP from the split `scale_field` + `add_scaled_field_inplace` path.
- **Stream ordering for packed transfers:** `fullmag_cuda_pack_soa_to_aos` and `fullmag_cuda_unpack_aos_to_soa` require a non-default stream (`stream != nullptr`), and `recover_device_demag_visual_field` enqueues pack + `cudaMemcpyAsync` on the exact same `raw_stream` used by `recover_device_demag_full_domain_field_device`, eliminating both the redundant pre-copy `cudaStreamSynchronize` and any data race.

(python-api)=
## Python API

No new public Python parameters are introduced. All four optimizations activate transparently for existing FEM GPU explicit Runge-Kutta dynamics (`heun`, `rk4`, `rk23`, `rk45`) and observable/magnetization I/O while preserving identical public study definitions.

```python
# %% Study, FEM engine, strict double-precision GPU execution
import fullmag as fm

study = fm.study("fem_gpu_shortrange_kernels_example")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.interactive(False)

# %% Magnetic film geometry, material, and initial texture
film = study.geometry(fm.Box(size=(120e-9, 60e-9, 4e-9)), name="film")
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.Ku = 5.0e5
film.u = (0.0, 0.0, 1.0)
film.Dind = 2.0e-3
film.m = fm.texture.uniform((0.6, 0.8, 0.0))
film.mesh(maximum_element_size=6e-9, order=1)

# %% External field and explicit RK4 dynamics stage exercising short-range kernels
study.b_ext(0.05, 0.0, 0.0)
study.build_domain_mesh()
study.solver(fix_dt=1e-13, integrator="rk4")
study.stages.add_run(duration=5e-12, name="rk4_shortrange")
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| StudyBuilder.solver.integrator | str | None | $1$ | heun, rk4, rk23, or rk45 for explicit RK dynamics | Explicit Runge-Kutta time integrator consuming gated short-range kernels, FMA exchange, and fused H_eff on FEM GPU | FEM CPU/GPU | solver.integrator |
| StudyBuilder.solver.fix_dt | float | None | $\mathrm{s}$ | positive finite value when fixed stepping is selected | Fixed explicit Runge-Kutta timestep | FEM CPU/GPU | solver.fix_dt |

(problem-ir)=
## ProblemIR

These optimizations are internal FEM GPU realization improvements and add no new fields to `ProblemIR`. The canonical explicit RK solver fragment lowered from the example remains:

```json
{"integrator": "rk4", "fix_dt": 1e-13}
```

(round-trip-and-failure-semantics)=
## Round trip and failure semantics

- **Requested intent** is preserved identically across Python export/import round trips: the user specifies physical interactions (exchange, DMI, uniaxial/cubic anisotropy, magnetoelasticity, Oersted, thermal, regional drives) and an explicit RK integrator or direct minimizer without backend-internal flags.
- **Resolved execution** automatically selects:
  - `ComputeEnergy = false` / `ComputeMaxSigma = false` on all intermediate RK stage evaluations, and `ComputeEnergy = true` on accepted-step energy reductions;
  - `Compensated = false` hardware FP64 FMA graph-Laplacian exchange on explicit RK stages and `Compensated = true` double-double exchange on PGBB/NCG relaxation (`gpu_rk_compute_effective_field_for_magnetization_fresh_demag`);
  - single-launch `fullmag_cuda_accumulate_heff_fused_xyz` on every `gpu_rk_accumulate_effective_field` call;
  - contiguous device pack/unpack transfers on `compute_stream` whenever `compute_stream != nullptr` and persistent `packed_field_download.aos_device` matches `lifecycle.dof_len`.
- **Validation errors**: `fullmag_cuda_unpack_aos_to_soa` and `gpu_component_upload_aos_packed` fail closed with `cudaErrorInvalidValue` / `false` when passed `raw_stream == nullptr`, null pointers, or mismatched scratch capacity, without charging transfer-audit counters. Missing Oersted device buffers fail closed in `gpu_rk_prepare_oersted_heff_term` before kernel launch.
- **Unsupported combinations**:
  - Direct-minimizer relaxation (`pgbb`, `nonlinear_cg`) is intentionally excluded from `Compensated = false` exchange to guarantee $10^{-15}$ Armijo energy-derivative consistency.
  - Non-CUDA builds (`FULLMAG_HAS_CUDA_RUNTIME = 0`) compile cleanly with explicit `#else` guards returning `false` if a packed GPU upload/download is requested on an allocated state without CUDA support.
  - Minimal unit-test fixtures that construct a `Context` with `compute_stream == nullptr` retain the legacy `gpu_state_{upload,download}_*` facade fallback cleanly.

(discrete-realization)=
## Discrete realization and residency

1. **Intermediate reduction gating (`rk_dmi_fields.cu`, `dmi_kernels.cu`, `rk_anisotropy_field.cu`, `anisotropy_kernels.cu`, `rk_magnetoelastic_field.cu`, `magnetoelastic_kernels.cu`, `rk_thermal_field.cu`, `thermal_kernels.cu`):** Each intermediate RK field helper passes `nullptr` instead of `gpu.reductions.scalar_workspace`. The kernel wrappers dispatch `template <bool ComputeEnergy>` (`<true>` vs `<false>`) or `template <bool ComputeMaxSigma>` at launch time so the `<false>` specialization eliminates energy arithmetic, shared memory, `__syncthreads()`, and global reduction writes. Final DMI energy evaluation (`ComputeEnergy = true`) aggregates per-thread energies via `cub::BlockReduce<double, 256>` and issues at most one `dmi_atomic_add_double` per block.
2. **Lazy `h_drive` zeroing (`field_buffer_state.hpp`, `field_buffer_memory.cpp`, `regional_field_kernels.cu`):** `fields.h_drive_zeroed` begins `false` after `gpu_field_buffers_allocate` and resets to `false` on `gpu_field_buffers_free`, `gpu_regional_field_drive_destroy`, and active regional-drive uploads. When `regional_drive_count == 0`, the first call to `gpu_regional_field_drive_materialize_and_accumulate` (or a zero-drive `gpu_regional_field_drive_upload`) clears `h_drive.{x,y,z}` and sets `h_drive_zeroed = true`; all subsequent RK stages return immediately with 0 `cudaMemsetAsync` calls.
3. **Dual-path sparse exchange (`exchange_kernels.{hpp,cu}`, `rk_exchange_dispatch.{hpp,cu}`, `rk_rhs_runtime.cu`):** `legacy_sparse_exchange_kernel`, `legacy_sparse_exchange_xyz_kernel`, and `periodic_reduced_exchange_kernel` are templated on `bool Compensated` and preload `m[row]` into registers prior to the CSR loop. Trailing default `bool compensated_accumulation = true` preserves backward compatibility for direct callers and relaxation while `rk_rhs_runtime.cu` routes explicit RK stages to `false`.
4. **Fused `H_eff` (`vector_field_kernels.{hpp,cu}`, `rk_oersted_field.{hpp,cu}`, `rk_effective_field.cu`):** `rk_effective_field.cu` calls `gpu_regional_field_drive_materialize_and_accumulate(..., false)`, populates `FemGpuHeffAccumulateTerms` (delegating Oersted buffer validation and scaling to `gpu_rk_prepare_oersted_heff_term`), and launches `fullmag_cuda_accumulate_heff_fused_xyz` once for all three Cartesian components. Existing `gpu_rk_accumulate_oersted_field`, `fullmag_cuda_accumulate_heff`, and `fullmag_cuda_add_field_inplace` remain exported for contract compatibility.
5. **Packed AoS/SoA transfers (`transfer_kernels.{hpp,cu}`, `component_transfer.{hpp,cpp}`, `gpu_state.{hpp,cpp}`, `state_io.cpp`, `stage_compute.cpp`):** `gpu_component_upload_aos_packed` copies host AoS data into the existing persistent `state.packed_field_download.aos_device` buffer via `cudaMemcpyAsync(H2D)`, launches `fullmag_cuda_unpack_aos_to_soa` on the same stream, synchronizes once, and audits `3 * N * sizeof(double)` bytes. All five GPU transfer sites in `state_io.cpp` (`copy_torque_observable_f64`, `context_sync_gpu_magnetization_to_host`, `context_copy_field_f64`, `context_copy_linearization_field_f64`, `context_upload_magnetization_f64`) and `recover_device_demag_visual_field` in `stage_compute.cpp` route through the packed path.

(implementation-mapping)=
## Implementation mapping

- `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu::gpu_rk_compute_dmi_field_contributions` passes `energy_out = nullptr` on intermediate RK stages.
- `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu::fullmag_cuda_dmi_field_energy` dispatches predicated `dmi_element_residual_kernel<ComputeEnergy>` implementing {eq}`eq-dmi-block-reduce-energy`.
- `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp::fullmag_cuda_uniaxial_anisotropy_field_energy_blocks` and `fullmag_cuda_cubic_anisotropy_field_energy_blocks` gate per-block energy reductions on `block_sums != nullptr`.
- `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp::fullmag_cuda_magnetoelastic_field_energy_blocks` gates prescribed-strain energy reduction on `block_sums != nullptr`.
- `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.hpp::fullmag_cuda_thermal_field_blocks` gates max-sigma reduction on `block_max_sigma != nullptr`.
- `backends/fem/gpu/cuda/fields/field_buffer_memory.cpp::gpu_field_buffers_allocate` initializes `h_drive_zeroed = false` after raw `cudaMalloc`.
- `backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cuh::gpu_regional_field_drive_materialize_and_accumulate` enforces lazy one-time zeroing of `h_drive` when `regional_drive_count == 0`.
- `backends/fem/gpu/cuda/exchange/exchange_kernels.hpp::fullmag_cuda_legacy_sparse_exchange_xyz` and `fullmag_cuda_periodic_reduced_exchange_xyz` implement {eq}`eq-exchange-graph-laplacian` and {eq}`eq-exchange-fma-error-bound` via `template <bool Compensated>`.
- `backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp::gpu_rk_compute_legacy_sparse_exchange` forwards `compensated_accumulation` into all sparse exchange wrappers.
- `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu::gpu_rk_compute_rhs_for_magnetization` and `gpu_rk_compute_effective_field_for_magnetization_fresh_demag` separate RK (`Compensated = false`) from relaxation (`Compensated = true`).
- `backends/fem/gpu/cuda/fields/vector_field_kernels.hpp::fullmag_cuda_accumulate_heff_fused_xyz` implements the single-launch order-preserving sum {eq}`eq-heff-fused-order`.
- `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu::gpu_rk_accumulate_effective_field` and `backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.hpp::gpu_rk_prepare_oersted_heff_term` assemble `FemGpuHeffAccumulateTerms` and issue one kernel launch per stage.
- `backends/fem/gpu/cuda/transfer/transfer_kernels.hpp::fullmag_cuda_unpack_aos_to_soa` and `backends/fem/gpu/cuda/transfer/component_transfer.hpp::gpu_component_upload_aos_packed` implement the device bijection {eq}`eq-aos-soa-bijection`.
- `backends/fem/gpu/cuda/state/gpu_state.hpp::gpu_state_upload_magnetization_aos_packed` and `gpu_state_download_magnetization_aos_packed`, together with `backends/fem/cpu/mfem/runtime/state_io.cpp::context_copy_field_f64`, `context_upload_magnetization_f64`, and `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp::recover_device_demag_visual_field`, route production transfers through packed contiguous copies.

(validation)=
## Validation

**Plan.** Verification combines targeted CUDA/source contract tests and Phase 2 Docker DEV RTX 4080 SUPER A/B benchmarks:

1. **Null-reduction gating and deadlock-free DMI `BlockReduce` (`cuda_shortrange_kernels_contract.cpp`):** Execute DMI (307 disjoint tetrahedra mixing active, air, degenerate, and zero-$D$ elements inside partial and full 256-thread blocks), uniaxial/cubic anisotropy, uniform/per-node magnetoelastic, and Brown thermal kernels with `nullptr` vs non-null reduction outputs; assert bit-for-bit field equality (`memcmp == 0`) and CPU reference DMI energy parity $\le 10^{-13}$.
2. **Lazy `h_drive` zeroing (`cuda_shortrange_kernels_contract.cpp`):** Verify `h_drive_zeroed == false` immediately after allocation, sentinel wipe on first zero-drive call, verified skip of `cudaMemsetAsync` on second call, and clean `0 -> 1 -> 0` and destroy transitions.
3. **Dual-path exchange parity (`cuda_shortrange_kernels_contract.cpp`, `relaxation_energy_derivative_contract.cpp`):** Verify exact `0.0` on uniform $\mathbf{m} = (0.6, 0.8, 0.0)$ and relative difference $\le 10^{-13}$ against double-double on a 3D vortex texture across `legacy_sparse_exchange_xyz`, `legacy_sparse_exchange`, and `periodic_reduced_exchange_xyz`, while keeping relaxation Armijo derivative tests unchanged.
4. **Fused `H_eff` bitwise parity (`cuda_shortrange_kernels_contract.cpp`, `source_facade_cuda_kernels_contract.cpp`, `oersted_contract.cpp`):** Verify `memcmp == 0` for `h_eff.{x,y,z}` and `h_oe.{x,y,z}` on `N = 1031` nodes across all 10 interaction terms (with scaled Oersted `2.75`), base-only subset, and explicit Oersted subset.
5. **Packed AoS/SoA transfer round-trip (`cuda_shortrange_kernels_contract.cpp`, `gpu_state_runtime_contract.cpp`, `state_io_contract.cpp`):** Verify bit-exact round-trip for $N \in \{1, 3, 257, 1031\}$, null-stream rejection, exact $24N$-byte H2D/D2H audit accounting, and removal of redundant pre-copy synchronization in `stage_compute.cpp`.

**Evidence status (qualified on RTX 4080 SUPER, SM `89-real`, Docker DEV, `311062d617` vs `9ab99132d5`, `docs/audits/2026-11-26-fem-pgbb-kernels-dr-ab.md`):**
- **Contract & memory safety:** `fem_cuda_shortrange_kernels_contract` (**PASS**, `compute-sanitizer --tool memcheck` **0 errors**, 0-ULP bitwise parity verified for cubic anisotropy and magnetoelasticity via explicit non-contracted `__dmul_rn`/`__dadd_rn`/`__dsub_rn`), `fem_gpu_state_runtime_contract`, `fem_state_io_contract`, `fem_oersted_contract`, and `fem_relaxation_energy_derivative_contract` all **PASS**; non-MFEM CI build **10/10 PASS**.
- **Full 50-step RK4 E2E (`33,150` nodes / `180,000` TET4, Exchange + iDMI + bDMI + Uniaxial + Cubic + MEL + Zeeman, `regional_drive_count = 0`):** **`277.463 ms`** vs `498.562 ms` (**`1.80×`**); trajectory parity `ΔE_tot = ΔE_ex = ΔE_ani = ΔE_mel = 0.0`, `ΔE_dmi = 1.622e-15`, `max_rel(m) = 4.531e-16`, `max_rel(H_eff) = 1.648e-15` (`<< 1e-13`).
- **`state_io` 20× `copy_field_f64` (`10× M + 10× H_eff`):** **`5.284 ms`** vs `73.621 ms` (**`13.93×`**, exceeding `>= 5×` gate).
- **CUDA-event kernel microbenchmarks (100 repeats):** DMI RK `energy_out = nullptr` **`2.54×`** (`0.3095 ms` vs `0.7873 ms`) and `cub::BlockReduce` **`2.17×`** (`0.3632 ms`); Exchange RK FMA **`8.02×`** (`0.0517 ms` vs `0.4144 ms`); Fused `H_eff` (`21 → 1` launches) **`17.5×`** (`0.0130 ms` vs `0.2275 ms`); packed transfers **`40.5×`** D2H (`0.1944 ms` vs `7.8800 ms`) and **`6.30×`** H2D (`0.1729 ms` vs `1.0896 ms`).

(limitations)=
## Limitations

- The fast FP64 FMA exchange kernel (`Compensated = false`) is intentionally restricted to explicit RK stages and must not replace compensated double-double accumulation in PGBB/NCG relaxation or polarized energy-difference evaluations where $10^{-15}$ Armijo cancellation bounds are required.
- Final DMI energy evaluation still issues one FP64 `atomicAdd` per element block ($\lceil N_e / 256 \rceil$ atomics rather than $N_e$); this path runs only once per accepted step during final observable statistics, not on intermediate RK stages.
- `api.cpp` (`device_apply_demag_tangent_with_potential`) now also routes `delta_H_demag` through `gpu_state_download_component_aos_packed` (removing the redundant pre-copy stream sync) when `compute_stream` and persistent AoS scratch are active.
- Legacy `fullmag_cuda_upload_aos_to_soa` and `fullmag_cuda_download_soa_to_aos` remain exported as streamless compatibility fallbacks for unit tests that do not construct a `compute_stream`.

(scientific-bibliography)=
## Bibliography

- P. H. Sterbenz, *Floating-Point Computation*, Prentice-Hall (1974), ISBN 978-0-13-322495-5 (exact floating-point subtraction of nearby operands).
- N. J. Higham, *Accuracy and Stability of Numerical Algorithms*, 2nd ed., SIAM (2002), [doi:10.1137/1.9780898718027](https://doi.org/10.1137/1.9780898718027) (IEEE-754 summation and fused multiply-add error analysis).
- IEEE Std 754-2019, *IEEE Standard for Floating-Point Arithmetic*, [doi:10.1109/IEEESTD.2019.8766229](https://doi.org/10.1109/IEEESTD.2019.8766229).
- W. F. Brown, Jr., "Thermal Fluctuations of a Single-Domain Particle", *Physical Review* 130 (1963) 1677–1686, [doi:10.1103/PhysRev.130.1677](https://doi.org/10.1103/PhysRev.130.1677).
- S. Rohart and A. Thiaville, "Skyrmion confinement in ultrathin film nanostructures in the presence of Dzyaloshinskii-Moriya interaction", *Physical Review B* 88 (2013) 184422, [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422).

(source-code-index)=
## Source-code index

| Path | Symbol | Responsibility | Lane and evidence |
|---|---|---|---|
| `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu` | `gpu_rk_compute_dmi_field_contributions` | Passes `energy_out = nullptr` for intermediate RK DMI field launches | FEM GPU; source and CUDA contract test |
| `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `fullmag_cuda_dmi_field_energy` | Dispatches predicated `dmi_element_residual_kernel<ComputeEnergy>` with deadlock-free `cub::BlockReduce` | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp` | `fullmag_cuda_uniaxial_anisotropy_field_energy_blocks` | Uniaxial anisotropy field kernel gating energy reduction on `block_sums != nullptr` | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp` | `fullmag_cuda_cubic_anisotropy_field_energy_blocks` | Cubic anisotropy field kernel gating energy reduction on `block_sums != nullptr` | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp` | `fullmag_cuda_magnetoelastic_field_energy_blocks` | Magnetoelastic field kernel gating energy reduction on `block_sums != nullptr` | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/interactions/thermal/thermal_kernels.hpp` | `fullmag_cuda_thermal_field_blocks` | Brown thermal field kernel gating max-sigma reduction on `block_max_sigma != nullptr` | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/fields/field_buffer_memory.cpp` | `gpu_field_buffers_allocate` | Allocates device field buffers and initializes `h_drive_zeroed = false` | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cuh` | `gpu_regional_field_drive_materialize_and_accumulate` | Lazy one-time zeroing of `h_drive` when `regional_drive_count == 0` | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/exchange/exchange_kernels.hpp` | `fullmag_cuda_legacy_sparse_exchange_xyz` | Dual-path FP64 FMA vs compensated DD legacy sparse XYZ exchange | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/exchange/exchange_kernels.hpp` | `fullmag_cuda_periodic_reduced_exchange_xyz` | Dual-path FP64 FMA vs compensated DD periodic-reduced XYZ exchange | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp` | `gpu_rk_compute_legacy_sparse_exchange` | Dispatches sparse exchange with `compensated_accumulation` control | FEM GPU; source and CUDA contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu` | `gpu_rk_compute_rhs_for_magnetization` | Routes explicit RK RHS exchange stages to fast FP64 FMA (`compensated_exchange = false`) | FEM GPU; source contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu` | `gpu_rk_compute_effective_field_for_magnetization_fresh_demag` | Preserves compensated DD exchange (`compensated_exchange = true`) for relaxation consumers | FEM GPU; source contract test |
| `backends/fem/gpu/cuda/fields/vector_field_kernels.hpp` | `fullmag_cuda_accumulate_heff_fused_xyz` | Single-launch order-preserving XYZ effective-field accumulation kernel | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_effective_field.cu` | `gpu_rk_accumulate_effective_field` | Populates `FemGpuHeffAccumulateTerms` and launches fused `H_eff` once per stage | FEM GPU; source and CUDA contract test |
| `backends/fem/gpu/cuda/integrators/rk/rk_oersted_field.hpp` | `gpu_rk_prepare_oersted_heff_term` | Prepares validated Oersted pointers and time scale for fused `H_eff` | FEM GPU; source contract test |
| `backends/fem/gpu/cuda/transfer/transfer_kernels.hpp` | `fullmag_cuda_unpack_aos_to_soa` | Device AoS-to-SoA unpack kernel on an explicit CUDA stream | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/transfer/component_transfer.hpp` | `gpu_component_upload_aos_packed` | Contiguous `cudaMemcpyAsync` H2D upload plus device unpack using persistent scratch | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/state/gpu_state.hpp` | `gpu_state_upload_magnetization_aos_packed` | Packed magnetization upload reusing `packed_field_download.aos_device` | FEM GPU; CUDA contract test |
| `backends/fem/gpu/cuda/state/gpu_state.hpp` | `gpu_state_download_magnetization_aos_packed` | Packed magnetization download reusing `packed_field_download.aos_device` | FEM GPU; CUDA contract test |
| `backends/fem/cpu/mfem/runtime/state_io.cpp` | `context_copy_field_f64` | Routes GPU observable field copies through packed AoS download on `compute_stream` | FEM GPU; source contract test |
| `backends/fem/cpu/mfem/runtime/state_io.cpp` | `context_upload_magnetization_f64` | Routes GPU magnetization uploads through packed AoS upload on `compute_stream` | FEM GPU; source contract test |
| `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` | `recover_device_demag_visual_field` | Streams visual demag recovery directly into packed AoS download without pre-copy sync | FEM GPU; source contract test |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Public Python stage-first study builder lowered unchanged to FEM GPU explicit RK | FEM CPU/GPU; unchanged |
