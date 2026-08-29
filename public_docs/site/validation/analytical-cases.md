---
title: Analytical Cases
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-analytical-cases)=
# Analytical Cases

Analytical validation compares FullMag against closed-form micromagnetics results rather than
another solver. The cases below mirror the physical models behind the FEM/FDM terminals; the
public page states which ones have current executed evidence and which remain scripted but
runtime-open.

## Exchange sinusoidal mode

A $180^\circ$-mode sinusoidal magnetization has a closed-form exchange field,
$\mathbf{H}_{\mathrm{ex}} = \frac{2 A_{\mathrm{ex}}}{\mu_0 M_s} \nabla^2 \mathbf{m}$, and an
exchange energy converging to $A_{\mathrm{ex}} k^2 V$. The acceptance gate is scripted in
`tests/fem_exchange_validation/sinusoidal_mode.py` and requires a MFEM/libCEED runtime for the full
refinement sweep.

- **Criterion** — recovered $H_{\mathrm{ex}}$ agrees with the analytic Laplacian within 25% on the
  finest mesh and the energy converges to $A_{\mathrm{ex}} k^2 V$ under refinement.
- **Status** — scripted; the representative finest-mesh stage materializes and runs on the managed
  CPU path, while the full sweep is runtime-open.

## Uniformly magnetized sphere

A uniformly magnetized sphere produces the demagnetizing field
$\mathbf{H}_{\mathrm{demag}} = -\frac{M_s}{3} \mathbf{m}$ inside the body. The gate is
`tests/fem_demag_validation/sphere_validation.py`.

- **Criterion** — interior $H_{\mathrm{demag}} \approx -M_s/3$.
- **Status** — scripted; requires the MFEM/libCEED/hypre runtime.

## Osborn ellipsoid demagnetization factors

For an ellipsoid magnetized uniformly along a principal axis, the demagnetization factors follow
Osborn's closed form. The gate is `tests/fem_demag_validation/ellipsoid_validation.py`.

- **Criterion** — per-axis demagnetization factors agree with Osborn within 10% and sum to 1 within
  0.15 per shape.
- **Status** — scripted; requires the MFEM/libCEED/hypre runtime.

## Macrospin LLG checkpoints

Two damping-only macrospin checks constrain the LLG right-hand side:

- the damping-only macrospin energy decreases under relaxation
  (`fem_llg_rhs_contract`);
- the directed STT current-perpendicular macrospin torque reproduces the expected precession
  direction (`fem_stt_contract`).

Also the contracted Poisson demagnetization sign uses the uniformly magnetized sphere. DMI sign,
chirality, boundary-tilt, and thermal variance (Brown scaling with $1/dt$) have both local weak
residual contract gates and separate MFEM-visible runtime gates.

## Evidence boundary

Local contract executables (no MFEM host) are valid source/unit/sign regression gates but are not
runtime qualification. A row is qualified only when the executable runtime case passes in the
matching MFEM/CUDA environment; the individual solver pages record which acceptance commands they
cover.
## Control Room crosswalk

Validation pages are `inspection-only` in Control Room. The UI may expose runtime metadata, fields, tables, or reports for inspection, but it does not create a qualification claim. `TODO: frontend support` applies to validation workflow authoring and report publication unless a specific control is named. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Validation is not a standalone Python constructor unless the linked case page names one. Reproduce the exact case, inputs, device, precision, and receipt described by the page; use the referenced API pages for callable signatures.

## Physics and bibliography scope

The page either states the governing benchmark model or delegates it to the linked physics/numerical-methods page. Any missing derivation is a documented boundary, not an implicit equation. Bibliography and source evidence remain the authoritative references listed by the validation case.
## Source-code index

- No standalone implementation function is introduced by this validation page. Source evidence is the exact API, managed recipe, runtime manifest, and receipt named by the validation case.

