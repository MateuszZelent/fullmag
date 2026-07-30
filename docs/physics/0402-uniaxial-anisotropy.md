# Uniaxial magnetocrystalline anisotropy

- Status: implementation-aligned reference note
- Owners: FullMag physics and backend team
- Last updated: 2026-07-30
- Related ADRs: none
- Related specs: `public_docs/site/physics/interactions/anisotropy/uniaxial.md`

## 1. Problem statement

Uniaxial magnetocrystalline anisotropy assigns a preferred direction to the reduced
magnetization. FullMag supports first- and second-order constants `Ku1` and `Ku2`, expressed in
J/m^3, and an easy-axis vector. The public legacy `UniaxialAnisotropy` object is migrated to
material parameters before canonical lowering; the native backends consume the material form.

## 2. Physical model

Let `u` be the normalized easy-axis direction and `q = m.u`. The implemented energy density is

\[
w_{\mathrm u} = -K_{u1}q^2-K_{u2}q^4.
\]

This is equivalent for the effective field to the common `K_u1(1-q^2)+K_u2(1-q^4)` convention,
but differs by the orientation-independent constant `K_u1+K_u2`. FullMag's reported anisotropy
energy follows the negative-power convention above and must not be silently shifted when comparing
outputs.

The effective field is

\[
\mathbf H_{\mathrm u} =
\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0 M_s}\,\mathbf u.
\]

Positive `Ku1` makes `u` an easy axis; negative `Ku1` makes the plane normal to `u` favorable.
`Ku2` changes the angular landscape independently of the first-order sign.

## 3. Numerical interpretation

### 3.1 FDM

FDM computes the dot product at each active cell, normalizes the configured axis, adds the local
field to `H_eff`, and integrates the energy density with the Cartesian cell volume. CPU reference
and CUDA lanes use the same SI expressions. CUDA FP32 and FP64 have separate arithmetic and
reduction paths; multilayer CUDA uses a dedicated layer-local kernel.

### 3.2 FEM

FEM imports scalar or spatial `Ku1`, `Ku2`, `Ms`, and the axis. CPU evaluates the nodal field and
lumped energy, with an element-quadrature path for spatial material fields. GPU keeps material,
axis, magnetization, and lumped-mass arrays on device, computes field/energy blocks, and reduces
the result on device. Missing required device buffers are errors, not CPU fallback.

### 3.3 Hybrid

No alternate physical definition exists for a hybrid execution. Provenance must record the
resolved material fields, normalized axis, solver lane, precision, and energy convention.

## 4. API, IR, and planner impact

`Material` is the canonical public owner of anisotropy coefficients. The compatibility
`UniaxialAnisotropy` term is accepted only when it can be migrated to one material target without
conflict. The resulting material IR contains `uniaxial_anisotropy`, `uniaxial_anisotropy_k2`, and
`anisotropy_axis`; spatial overrides are stored in `ku_field` and `ku2_field` where supported.
FDM and FEM planners validate axis and material compatibility separately.

## 5. Validation strategy

- Verify the axis-parallel, axis-perpendicular, and sign cases analytically.
- Verify first- and second-order field derivatives against finite differences of the implemented
  negative-power energy.
- Verify Python migration, conflict errors, exact material IR, and script round-trip.
- Compare FDM CPU/CUDA and FEM CPU/CUDA field and energy values with precision-specific tolerances.
- Verify spatial fields, non-magnetic masks, and device fail-closed behavior.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [ ] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

The public material axis is one vector per material. Per-node axis fields are an internal FEM
realization and are not currently a public `Material` parameter. The compatibility energy object
requires a single material target. Current GPU source implementation still requires executed
device qualification before a production parity claim.

## 8. References

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag Python and backend source mappings listed in the publication page.
