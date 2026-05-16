# Native FEM DMI Weak-Residual Design

- Status: approved for implementation
- Date: 2026-05-15
- Scope: native CPU/MFEM interfacial and bulk DMI field recovery
- Out of scope: Python API, ProblemIR, planner, OpenAPI, UI, libCEED/CUDA
  QFunctions, consistent mass projection, PBC device path

## Goal

Replace the native FEM DMI strong-form/nodal averaging bootstrap with the FEM
weak-residual plus lumped-projection baseline already proven in the Rust CPU
reference.

## Architecture

Add a small native helper with no MFEM dependency:

```text
native/backends/fem/include/dmi_weak_residual.hpp
native/backends/fem/src/dmi_weak_residual.cpp
```

The helper owns only the DMI math:

- compute interfacial residual contribution from `m_q`, `grad_m`, `phi`,
  `grad_phi`, `D`, and `n_hat`,
- compute bulk residual contribution from the same element data,
- project node residuals into observable fields with
  `H_i = -g_i / (mu0 Ms_i M_lumped_i)`.

`mfem_bridge.cpp` remains responsible for MFEM element traversal, coefficient
lookup, magnetic masks, energy accumulation, periodic projection, and output
field storage.

## Data Flow

For each magnetic element:

1. unpack current magnetization into MFEM GridFunctions,
2. evaluate `m_q`, `grad_m`, shape values, and physical shape gradients,
3. compute `D` from the existing uniform/per-node coefficient policy,
4. call the helper to accumulate residual contributions into a node residual
   buffer,
5. after all elements, project the residual buffer to `h_dmi_xyz` or
   `h_bulk_dmi_xyz` using `ctx.mfem_lumped_mass` and node-local `Ms`,
6. apply the existing periodic class projection if configured.

## Error Handling

The native path must fail clearly when:

- MFEM context is not ready,
- FE space or mesh is missing,
- lumped mass is unavailable or has a size mismatch,
- node indices are outside `ctx.n_nodes`.

No fallback to the old strong-form field is allowed.

## Tests

TDD order:

1. Add `native/backends/fem/tests/dmi_weak_residual.cpp` that references the
   new helper before it exists. RED must fail at compile time.
2. Implement the helper and run the native formula executable.
3. Refactor `mfem_bridge.cpp` to use the helper.
4. Run existing Rust DMI oracle tests and source checks.

## Completeness Checklist

- [x] Physics note `0813` exists and defines equations, units, projection, and
  limits.
- [x] Native helper has RED/GREEN formula tests for interfacial and bulk DMI.
- [x] Native MFEM DMI field paths assemble residuals and project by lumped
  mass.
- [x] Existing observable/API names remain unchanged.
- [x] Audit report records native DMI status as improved but GPU QFunction as
  still open.
