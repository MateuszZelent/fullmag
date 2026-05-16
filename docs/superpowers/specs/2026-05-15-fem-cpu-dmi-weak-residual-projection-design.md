# FEM CPU DMI Weak-Residual Projection Design

- Status: approved for implementation
- Date: 2026-05-15
- Scope: Rust FEM CPU reference only
- Out of scope: native MFEM, libCEED, CUDA, GPU state, Python API, ProblemIR, planner, OpenAPI

## Goal

Replace the Rust FEM CPU reference DMI strong-form nodal averaging with the FEM contract required by `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md` and `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`: assemble the energy first-variation residual and recover the DMI field through a lumped mass projection.

## Architecture

`FemLlgProblem::dmi_fields_compute_into` remains the single CPU element loop used by both allocating observations and workspace hot paths. The loop will accumulate residual vectors for interfacial and bulk DMI directly into the existing temporary field buffers, then convert residuals into fields with:

```text
H_i = -g_i / (mu0 M_s V_i)
```

where `V_i` is the existing magnetic lumped nodal volume. This preserves the current no-extra-allocation hot path and the existing static-PBC class projection after field recovery.

## Interfacial DMI Residual

For interface normal `n`, use the energy density

```text
w = D [(m · n) div(m) - m · grad(m · n)].
```

At each P1 tetra, use exact centroid integration for the affine terms:

```text
dw/dm = D [n div(m) - grad(m · n)]
dw/dG_ab = D [(m · n) delta_ab - n_a m_b]
```

For node `i`, component `a`:

```text
g_i,a += volume * (dw/dm_a / 4 + sum_b dw/dG_a,b grad_phi_i,b)
```

## Bulk DMI Residual

Use the residual form:

```text
R = D integral [v · curl(m) + m · curl(v)] dV.
```

For node `i`, component `a`, accumulate the value part from `curl(m)` and the gradient part from `curl(phi_i e_a)`, evaluated with centroid `m`.

## Validation

The existing proof fixture tests become production equality tests:

- `interfacial_dmi_lumped_projection_matches_weak_residual_on_free_tet`
- `bulk_dmi_lumped_projection_matches_weak_residual_on_free_tet`

Both tests compute the field action:

```text
-mu0 M_s sum_i V_i H_i · v_i
```

and require it to match the analytical weak residual action for a non-uniform P1 tetra.

## Acceptance

- `cargo test -p fullmag-engine dmi_lumped_projection_matches_weak_residual -- --nocapture` passes after a verified RED failure.
- `cargo test -p fullmag-engine dmi` passes.
- `cargo fmt --check -p fullmag-engine` passes.
- `git diff --check` passes.
- `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md` records that CPU Rust reference DMI now uses weak-residual lumped projection, while native/GPU Etap 6 remains open.
