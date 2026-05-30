# FEM Dzyaloshinskii-Moriya Interaction

- Status: native FEM CPU runtime validated; native FEM GPU source/enablement
  contract wired and live CUDA runtime smoke verified on 2026-05-29
- Last updated: 2026-05-29
- Implementation: `native/backends/fem/cpu/mfem/interactions/dmi.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/dmi_interfacial.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/dmi_bulk.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/dmi_workspace.hpp/.cpp`
- Test: `native/backends/fem/tests/dmi_contract.cpp`
- Residual helpers: `native/backends/fem/src/dmi_weak_residual.cpp`
- GPU implementation: `native/backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.*`,
  `native/backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.*`,
  `native/backends/fem/gpu/cuda/integrators/rk/rk_dmi_energy_reductions.*`
- Runner quantities/outputs: `H_dmi`, `H_dmi_bulk`, and `e_dmi`

## Pole

The native FEM CPU DMI modules own interfacial and bulk DMI for the MFEM
bridge. `dmi_interfacial.*` owns the interfacial path, `dmi_bulk.*` owns the
Bloch/bulk path, `dmi_workspace.*` owns shared element-loop scratch, and
`dmi.*` is only the umbrella public include surface. Both variants assemble a
weak residual over MFEM elements and recover an observable `H_DMI` field in
`A/m` with lumped-mass projection. The ordinary LLG RHS converts this field to
`dm/dt`; these modules do not apply gamma, damping, or direct-torque scaling.

For interfacial DMI the implemented energy density is:

```text
e_iDMI = D [(m.n) div(m) - (m.grad)(m.n)]
```

For bulk DMI the implemented energy density is:

```text
e_bulk = D m . curl(m)
```

## Energia

The module integrates the same quadrature expression used by the element loop
and returns energy in joules when requested by the caller. Field recovery uses:

```text
H_DMI = project_lumped(residual, Ms)
```

where `Ms` can be the scalar material fallback or a per-node `Ms_field`.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| interfacial DMI coefficient | `D_i` | current executable contract |
| bulk DMI coefficient | `D_b` | current executable contract |
| interface normal | `n` | unit vector |
| saturation magnetization | `Ms` | `A/m` |
| DMI field | `H_DMI` | `A/m` |
| DMI energy | `E_DMI` | `J` |

Public API: `Dind` / `InterfacialDMI(D=...)` is a surface DMI coefficient in `J/m^2`.
The native FEM path passes this coefficient through unchanged; it does not divide by film thickness
or reinterpret the value as a volumetric `J/m^3` coefficient. Users who want an
effective volumetric model must perform that conversion explicitly before
building the Fullmag material or energy term.

## Warunki brzegowe

The executable path is a weak-residual formulation. Natural boundary terms are
part of the variational residual rather than a post-hoc strong-form nodal
average. `fem_dmi_weak_residual` includes an explicit interfacial boundary-tilt
fixture: a uniform out-of-plane state has zero baseline energy but a non-zero
natural-boundary derivative for tangential tilt.

## Dyskretyzacja FEM

The MFEM path unpacks AoS magnetization to component grid functions, loops over
magnetic elements and quadrature points, assembles interfacial or bulk DMI
residuals, projects the residual with lumped mass and `Ms`, and lets the bridge
apply any periodic output projection and energy aggregation.

Bulk DMI projects periodic input magnetization before assembly and now lives in
`dmi_bulk.*`. The bridge still owns higher-level orchestration. Element-loop
scratch lifetime and per-element MFEM buffers are isolated in
`dmi_workspace.*`; interfacial residual and energy assembly live in
`dmi_interfacial.*`.

## Capability and runtime status

- Active DMI requires `FULLMAG_HAS_MFEM_STACK`.
- Local non-MFEM builds verify disabled behavior and explicit environment
  errors, but do not compile the MFEM element-loop branch.
- Interfacial and bulk DMI are separate entry points. Interfacial DMI is
  isolated in `dmi_interfacial.*`, bulk DMI is isolated in `dmi_bulk.*`, and
  both paths share `dmi_workspace.*` for private element-loop scratch.
- Public unit semantics for interfacial thin-film DMI are pinned by a repo
  contract: the public `Dind` / `InterfacialDMI(D=...)` value is a surface
  `J/m^2` coefficient passed unchanged to native FEM.
- Native CPU runtime smoke covers a non-uniform tetrahedron with active
  interfacial and bulk DMI, checking finite non-zero `e_dmi` and non-zero
  `H_dmi` / `H_dmi_bulk` readback.
- Native GPU has source-level contracts for device DMI field/energy kernels and
  an enablement-gate runtime smoke:
  `native_fem_gpu_dmi_step_exposes_fields_and_energy_when_cuda_is_available`.
  This test executes the same non-uniform DMI step on a CUDA-enabled host and
  checks `e_dmi`, `H_dmi`, and `H_dmi_bulk`. On hosts without CUDA/MFEM GPU
  access it skips explicitly, so local host success alone is not a full CUDA
  runtime proof.

## Testy

Current gates:

- `fem_dmi_contract` checks that disabled interfacial and bulk DMI return zero
  field/energy, that active DMI reports a clear MFEM-stack requirement in a
  non-MFEM build, that interfacial DMI ownership stays in
  `dmi_interfacial.*`, that bulk DMI ownership stays in `dmi_bulk.*`, and that
  DMI workspace ownership stays in `dmi_workspace.*`. It also checks top-level
  source contracts for `dmi.cpp`, `dmi_interfacial.cpp`, `dmi_bulk.cpp`, and
  `dmi_workspace.cpp` so source files keep their ownership boundaries visible.
- `fem_dmi_weak_residual` checks the interfacial and bulk weak-residual
  directional-derivative fixtures, including a tilted interfacial `dmi_n_hat`
  fixture that proves non-default normal vectors are used in the residual. It
  also covers interfacial domain-wall handedness, interfacial boundary tilt,
  and bulk spiral-pitch handedness/sign.
- `cargo test -p fullmag-runner --features fem-gpu dmi -- --test-threads=1`
  covers runner DMI quantity activation, field snapshot readback, CPU native DMI
  runtime, GPU DMI runtime smoke wiring, and FEM eigen bulk-DMI non-reciprocity.
- `scripts/verify_fem_gpu_enablement.sh` runs the native GPU DMI runtime smoke
  in the `fem-gpu` Docker environment after NVIDIA visibility and existing
  exchange-only GPU smoke checks. This full script passed on a CUDA-visible
  `fem-gpu` Docker run on 2026-05-29.
- `test_fem_dmi_docs_pin_public_surface_unit_policy` pins the public unit
  policy: `Dind` / `InterfacialDMI(D=...)` is passed as a surface `J/m^2`
  coefficient with no implicit film-thickness division.
