---
title: Dzyaloshinskii–Moriya interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0404-interfacial-dmi.md
---

(public-docs-physics-interactions-dmi-root)=
# Dzyaloshinskii–Moriya interaction

The Dzyaloshinskii–Moriya interaction (DMI) is an antisymmetric exchange coupling that
arises from spin-orbit coupling in systems with broken inversion symmetry. It favours
non-collinear spin textures (spin spirals, magnetic skyrmions) with a definite chirality.

FullMag implements two DMI families, each with independent energy conventions, Python
constructors, ProblemIR representations, and solver realizations:

1. **Interfacial DMI** — arising at heavy-metal / ferromagnet interfaces in thin-film
   heterostructures, with a preferred interface-normal direction.
2. **Bulk DMI** — arising in non-centrosymmetric bulk crystals (e.g. B20 compounds like
   MnSi, FeGe), isotropic in the crystal.

## Shared physics

Both DMI variants contribute an antisymmetric first-order spatial derivative coupling to the
micromagnetic energy. The essential distinction is the symmetry of the Lifshitz invariant:

| Variant | Symmetry | Lifshitz invariant class | Physical systems |
|---|---|---|---|
| Interfacial | $C_{nv}$ | $m_z\nabla\cdot\mathbf{m}-\mathbf{m}\cdot\nabla m_z$ | Pt/Co, Ta/CoFeB, Ir/Fe |
| Bulk | $T$, $O$ | $\mathbf{m}\cdot(\nabla\times\mathbf{m})$ | MnSi, FeGe, Cu₂OSeO₃ |

The DMI constant $D$ has SI unit $\mathrm{J\,m^{-2}}$ in FullMag. Its sign determines the
chirality of the favoured spin texture. Positive $D$ for interfacial DMI favours
Néel-type skyrmions with outward radial magnetization; negative $D$ reverses the chirality.

## DMI-modified boundary conditions

When DMI is active, the natural (variational) boundary condition on the magnetic surface
$\partial\Omega_m$ is no longer the standard exchange Neumann condition
$A\partial_n\mathbf{m}=\mathbf{0}$. The combined exchange-plus-DMI surface term introduces
a DMI contribution to the boundary condition. This is documented in
{doc}`boundary-conditions`.

## Backend support matrix

| Lane | Interfacial DMI | Bulk DMI |
|---|---|---|
| FDM CPU (reference) | ✓ (canonical $+z$ normal only) | ✓ |
| FDM GPU CUDA FP64 | ✓ (fused kernel) | ✓ (fused kernel) |
| FDM GPU CUDA FP32 | ✓ (fused kernel) | ✓ (fused kernel) |
| FEM CPU MFEM | ✓ (general normal, `Dind_field`) | ✓ |
| FEM GPU CUDA | ✓ (element residual kernel) | ✓ (element residual kernel) |

:::{admonition} Interface-normal restriction
:class: warning

The FDM implementation restricts the interfacial DMI normal to the canonical
$\hat{\mathbf{z}}$ direction. Non-$z$ normals are rejected by the planner. The FEM
implementation supports arbitrary normalised normals, including tilted interfaces.
:::

```{toctree}
:maxdepth: 1

interfacial
bulk
boundary-conditions
validation
```

## Scientific bibliography

1. I. E. Dzyaloshinskii, "A thermodynamic theory of 'weak' ferromagnetism of
   antiferromagnetics," *J. Phys. Chem. Solids* **4**, 241 (1958).
   [doi:10.1016/0022-3697(58)90076-3](https://doi.org/10.1016/0022-3697(58)90076-3).
2. T. Moriya, "Anisotropic superexchange interaction and weak ferromagnetism," *Physical
   Review* **120**(1), 91 (1960).
   [doi:10.1103/PhysRev.120.91](https://doi.org/10.1103/PhysRev.120.91).
3. S. Rohart and A. Thiaville, "Skyrmion confinement in ultrathin film nanostructures in
   the presence of Dzyaloshinskii-Moriya interaction," *Physical Review B* **88**, 184422
   (2013). [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422).
4. A. N. Bogdanov and U. K. Rößler, "Chiral symmetry breaking in magnetic thin films and
   multilayers," *Physical Review Letters* **87**, 037203 (2001).
   [doi:10.1103/PhysRevLett.87.037203](https://doi.org/10.1103/PhysRevLett.87.037203).
