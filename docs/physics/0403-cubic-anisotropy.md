# Cubic magnetocrystalline anisotropy

- Status: implementation-aligned reference note
- Owners: FullMag physics and backend team
- Last updated: 2026-07-30
- Related ADRs: none
- Related specs: `public_docs/site/physics/interactions/anisotropy/cubic.md`

## 1. Problem statement

Cubic anisotropy couples magnetization direction to a crystal frame. FullMag exposes three
energy-density constants `Kc1`, `Kc2`, and `Kc3`, plus two crystal axes. The third axis is the
cross product of the first two in the native realization. The compatibility
`CubicAnisotropy` object is migrated to material fields before canonical ProblemIR lowering,
using the same one-material conflict policy as uniaxial anisotropy.

## 2. Physical model

For orthonormal crystal axes `c1`, `c2`, `c3=c1×c2`, let `alpha_a=m.c_a`. The implemented density
is

\[
w_c=K_{c1}(\alpha_1^2\alpha_2^2+\alpha_2^2\alpha_3^2+\alpha_3^2\alpha_1^2)
 +K_{c2}\alpha_1^2\alpha_2^2\alpha_3^2
 +K_{c3}(\alpha_1^2\alpha_2^2+\alpha_2^2\alpha_3^2+\alpha_3^2\alpha_1^2)^2.
\]

The field is the negative variational derivative divided by `mu0 Ms`; the native CPU/GPU
implementations evaluate the corresponding crystal-frame polynomial derivatives.

## 3. Numerical interpretation

FDM normalizes each supplied axis before constructing `c3` and evaluates the cell-local polynomial
in CPU/CUDA precision. FEM plan validation requires finite, normalized, mutually orthogonal axes;
FEM CPU and GPU use `c3=c1×c2` and support scalar/spatial Kc values. Device paths fail closed
when required material arrays are absent.

## 4. API, IR, and planner impact

`Material.Kc1`, `Kc2`, `Kc3`, `anisC1`, and `anisC2` are canonical. The compatibility
`CubicAnisotropy` term migrates to those fields only for one material target. Material IR stores
`cubic_anisotropy_kc1`, `cubic_anisotropy_kc2`, `cubic_anisotropy_kc3`,
`cubic_anisotropy_axis1`, and `cubic_anisotropy_axis2`, with optional `kc1_field`, `kc2_field`,
and `kc3_field` overrides.

## 5. Validation strategy

Verify axis-frame orthonormality, crystal-direction energy values, analytic field derivatives,
compatibility migration/conflict errors, scalar/spatial material fields, FDM/FEM parity, and
precision-specific GPU reductions. Report the FEM strict-axis policy separately from FDM axis
normalization behavior.

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

The public contract exposes two axes, from which the third is derived. Arbitrary non-orthogonal
crystal frames are not a valid FEM execution request. Current CUDA source evidence still requires
executed-device qualification for production parity claims.

## 8. References

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag source mappings listed in the publication page.
