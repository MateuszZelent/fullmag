---
title: DMI validation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0404-interfacial-dmi.md
---

(public-docs-physics-interactions-dmi-validation)=
# DMI validation

This page summarises the validation strategy and current evidence for the Dzyaloshinskii–
Moriya interaction implementation across all solver/device lanes.

## Validation strategy

DMI validation relies on analytic checks, cross-backend comparison, and sign/symmetry
tests. Unlike exchange or demagnetization, DMI has no standard problem with a universally
accepted reference solution. The validation therefore focuses on:

1. **Zero-field test**: uniform magnetization produces zero DMI field and zero DMI energy.
2. **Sign reversal**: $D \to -D$ reverses the field and energy sign.
3. **Linear profile**: a linear $m_z(x,y)$ profile produces known field values that can
   be verified analytically.
4. **Chiral wall reflection**: reflecting a chiral domain wall changes the DMI energy sign.
5. **Variational consistency**: FEM residual matches the energy finite-difference derivative.
6. **Cross-backend parity**: FDM CPU vs FDM GPU, FEM CPU vs FEM GPU.
7. **Tilted normal**: FEM accepts arbitrary normalised normals; non-$+z$ FDM normals are
   rejected.

## Validation status by lane

| Lane | Evidence class | Current status |
|---|---|---|
| FDM CPU reference | Analytic stencil checks: zero-field, sign reversal, linear profile | Implemented and tested; not freshly executed for this revision |
| FDM GPU FP64 | Fused-kernel parity with CPU reference | Device-capable tests present |
| FDM GPU FP32 | FP64–FP32 Tier B parity | Device-capable tests present |
| FEM CPU MFEM | Residual consistency, energy derivative, tilted normal, `Dind_field` | Source contracts pass; managed runtime tests exist |
| FEM GPU CUDA | Element residual kernel parity with CPU residual | Device-capable contracts present |

## Interfacial DMI tests

The key analytic checks for interfacial DMI:

1. **Uniform $\mathbf{m}$**: for any constant $\mathbf{m}$, all spatial derivatives vanish,
   so $\mathbf{H}_{\mathrm{DMI}}=\mathbf{0}$ and $E_{\mathrm{DMI}}=0$. Violations indicate
   stencil boundary errors or quadrature contamination.

2. **Sign of $D$**: reversing $D$ must reverse the effective field direction and the energy
   sign for any non-uniform state.

3. **Linear $m_z$ gradient**: for $\mathbf{m}=(0,0,1)$ with a small $m_z(x)$ perturbation,
   the FDM and FEM fields must agree in sign and magnitude (up to discretization error).

4. **FEM residual derivative**: the FEM weak residual $R_{\mathrm{DMI}}(\mathbf{m};\mathbf{v})$
   must agree with the finite-difference approximation
   $[E(\mathbf{m}+\varepsilon\mathbf{v})-E(\mathbf{m}-\varepsilon\mathbf{v})]/(2\varepsilon)$
   to within quadrature tolerance.

## Bulk DMI tests

Bulk DMI tests follow the same structure with the appropriate energy density
$D\,\mathbf{m}\cdot(\nabla\times\mathbf{m})$:

1. **Uniform $\mathbf{m}$**: zero field and energy.
2. **Helical state**: for a helical magnetization
   $\mathbf{m}(x)=(\cos kx,\sin kx,0)$, the energy density is $Dk$ and the field is
   analytically known.
3. **Sign reversal**: $D\to -D$ reverses chirality preference.

## Known gaps

- No muMAG-style standard problem exists for DMI validation.
- FDM GPU device identity is not captured in current test evidence.
- FEM GPU mixed-P1 element qualification for DMI is incomplete.
- Cross-solver (FDM vs FEM) quantitative convergence comparison has not been published.

## Scientific bibliography

1. S. Rohart and A. Thiaville, "Skyrmion confinement in ultrathin film nanostructures in
   the presence of Dzyaloshinskii-Moriya interaction," *Physical Review B* **88**, 184422
   (2013). [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422).
2. FullMag internal notes: `docs/physics/0404-interfacial-dmi.md`,
   `docs/physics/0405-bulk-dmi.md`, `docs/physics/0812-fem-dmi-weak-residual-proof-fixture.md`.
