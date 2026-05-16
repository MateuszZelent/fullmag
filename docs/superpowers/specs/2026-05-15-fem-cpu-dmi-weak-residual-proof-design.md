# FEM CPU DMI Weak-Residual Proof Design

## Goal

Add a CPU-only diagnostic fixture proving that the current Rust FEM reference DMI field path is still a strong-form P1 bootstrap and not the target weak-residual/mass-projection formulation.

## Scope

In scope:

- Rust FEM CPU reference tests in `crates/fullmag-engine/src/fem.rs`.
- Test-only helper code for evaluating documented interfacial and bulk DMI weak residual actions on a P1 tetra.
- Physics note and audit status update.

Out of scope:

- Native MFEM, CUDA, GPU state, GPU hot loops, and libCEED QFunctions.
- Public Python API, ProblemIR, planner, OpenAPI, or frontend changes.
- Replacing the DMI field used by the time integrator.

## Physics Contract

The fixture compares:

- current mass action from the existing field path:
  `-mu0 Ms sum_i volume_i H_DMI,i · v_i`;
- target weak residual action from the documented energy first variation.

For a free-boundary affine tetra fixture these values must differ, because the strong-form bootstrap does not encode the same natural-boundary weak residual.

## Implementation

Add two tests:

- `interfacial_dmi_strong_form_action_differs_from_target_weak_residual_on_free_tet`
- `bulk_dmi_strong_form_action_differs_from_target_weak_residual_on_free_tet`

Add small `#[cfg(test)]` helpers in the test module only:

- compute P1 gradients for nodal vector fields;
- compute centroid values;
- compute current strong-form field mass action;
- compute interfacial and bulk DMI weak residual action.

## Validation

Run the target tests first and observe RED. Then implement the helpers and observe GREEN:

```bash
cargo test -p fullmag-engine dmi_strong_form_action_differs_from_target_weak_residual -- --nocapture
```

Run the existing DMI suite to ensure no current DMI behavior was changed:

```bash
cargo test -p fullmag-engine dmi
```

Finish with formatting and whitespace checks:

```bash
cargo fmt --check -p fullmag-engine
git diff --check
```

## Risk

The fixture intentionally records a mismatch. It must not be misread as production closure for Etap 6. The audit should continue to state that weak-residual/mass-projection DMI remains open.
