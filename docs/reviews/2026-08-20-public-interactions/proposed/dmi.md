---
title: Dzyaloshinskii–Moriya interactions — audited revision proposal
status: review-ready
doc_kind: audit-and-revision
targets:
  - public_docs/site/physics/interactions/dmi/index.md
  - public_docs/site/physics/interactions/dmi/interfacial.md
  - public_docs/site/physics/interactions/dmi/bulk.md
reviewed_revision: f79c65d43ef2ac550f89932b47940489f719acb0
---

# Dzyaloshinskii–Moriya interactions

## Audit verdict

| Area | Verdict |
|---|---|
| Interfacial DMI invariant and field | Correct for the declared sign convention. |
| Bulk DMI invariant and field | Correct for `w = D_b m·curl(m)`. |
| Natural boundary terms | Correctly derived on the detailed pages and appropriately separated from FDM stencil closure. |
| Root-page rendering | Defective: several LaTeX commands have lost their backslashes. |
| Examples | Detailed subtype pages activate DMI through `body.Dind`/`body.Dbulk`; the root page must not attribute a hand-written IR fragment to a shell that did not author those values. |
| Completeness | Needs surface-to-volume coefficient conversion, orientation transformations, and analytic chirality/pitch tests. |

## Required corrections

1. Repair all malformed root-page tokens such as `Omega_m`, `mathbf M`, `mathrm{J}`, and missing
   command backslashes; build with strict Sphinx warnings.
2. Make the detailed interfacial and bulk pages the equation owners. The root should compare the
   two symmetry classes and route users to the correct page.
3. State precisely how changing `D`, interface normal, outward boundary normal, or coordinate
   handedness changes chirality.
4. Distinguish the effective volume coefficient `D` in J/m² from an atomistic/interface surface
   constant `D_s` in J/m. For a uniformly distributed ultrathin ferromagnet of thickness `t_F`,
   document the modelling conversion `D = D_s / t_F` and its assumptions.
5. Keep material-owned routes (`Dind`, `Dbulk`, spatial fields) and explicit energy objects as
   alternative coefficient sources; never imply they are summed.
6. Generate all IR fragments from current serialization and execute both stage-first examples in
   CI.

# Interfacial DMI

Let `n_hat` be the interface-symmetry normal. FullMag uses

```math
w_i
=D\left[(m\cdot\hat n)\,\nabla\cdot m
-m\cdot\nabla(m\cdot\hat n)\right].
```

The volume field is

```math
H_i
=\frac{2D}{\mu_0M_s}
\left[\nabla(m\cdot\hat n)-(\nabla\cdot m)\hat n\right].
```

For `n_hat = z_hat` and in-plane derivatives,

```math
H_i=\frac{2D}{\mu_0M_s}
\begin{bmatrix}
\partial_xm_z\\
\partial_ym_z\\
-(\partial_xm_x+\partial_ym_y)
\end{bmatrix}.
```

If `nu` is the outward magnetic-boundary normal, exchange plus this DMI convention gives

```math
2A\,\partial_{\nu}m
+D\left[(\hat n\times\nu)\times m\right]=0.
```

The FEM weak form owns this natural term. Adding a second explicit copy would double-count the
boundary physics. A centred FDM missing-neighbour rule is a discrete closure and must not be
presented as an exact realization of this variational boundary condition.

# Bulk DMI

For isotropic cubic/B20-type DMI, FullMag uses

```math
w_b=D_b\,m\cdot(\nabla\times m),
\qquad
H_b=-\frac{2D_b}{\mu_0M_s}\nabla\times m.
```

The exchange-coupled natural boundary condition is

```math
2A\,\partial_{\nu}m+D_b(m\times\nu)=0.
```

The public page should state clearly that this is not a generic low-symmetry Lifshitz tensor and
is not interchangeable with interfacial DMI.

## Coefficient and orientation conventions

| Action | Interfacial DMI consequence | Bulk DMI consequence |
|---|---|---|
| `D -> -D` | reverses preferred Néel chirality | reverses preferred helical/Bloch chirality |
| `n_hat -> -n_hat` | equivalent to `D -> -D` for the invariant above | not applicable |
| reverse coordinate handedness | changes cross/curl orientation; provenance must record frame | changes curl orientation; provenance must record frame |
| `m -> -m` | energy density is unchanged | energy density is unchanged |

For a surface constant `D_s` in J/m distributed uniformly through a magnetic layer of thickness
`t_F`, the common thin-film reduction is

```math
D = \frac{D_s}{t_F}.
```

This conversion assumes a uniform through-thickness mode and does not replace a resolved
interface model.

## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| `D`, `D_b` | effective micromagnetic DMI coefficients | J/m² |
| `D_s` | surface/interface DMI constant before thickness reduction | J/m |
| `t_F` | magnetic-layer thickness | m |
| `A` | exchange stiffness | J/m |
| `n_hat`, `nu` | interface and outward boundary unit normals | 1 |
| `H_i`, `H_b` | DMI effective fields | A/m |
| `w_i`, `w_b` | DMI energy densities | J/m³ |

## Stage-first interfacial example

```python
# %% Interfacial DMI through the material-owned body route
import fullmag as fm

nm = 1.0e-9
study = fm.study("interfacial_dmi_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 1 * nm))

film = study.geometry(fm.Box(128 * nm, 128 * nm, 1 * nm), name="film")
film.Ms = 5.8e5
film.Aex = 15.0e-12
film.Dind = 3.0e-3
film.alpha = 0.3
film.m = fm.texture.neel_skyrmion(
    radius=24 * nm,
    wall_width=8 * nm,
    chirality=1,
    core_polarity=-1,
)

study.exchange()
study.demag()
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=2_000,
    tolT=1.0e-6,
)
```

FDM currently has a restricted interfacial-normal contract. The page must name the accepted
orientation exactly and fail closed for unsupported rotations.

## Stage-first bulk example

```python
# %% Fully periodic bulk-DMI helix
import math
import fullmag as fm

nm = 1.0e-9
period = 40 * nm
q = 2.0 * math.pi / period

study = fm.study("bulk_dmi_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
study.pbc(x=True, y=True, z=True)

crystal = study.geometry(fm.Box(80 * nm, 16 * nm, 16 * nm), name="crystal")
crystal.Ms = 3.84e5
crystal.Aex = 8.78e-12
crystal.Dbulk = 1.58e-3
crystal.alpha = 0.02
crystal.m = fm.texture.helical(
    wavevector=(q, 0.0, 0.0),
    e1=(0.0, 1.0, 0.0),
    e2=(0.0, 0.0, 1.0),
)

study.exchange()
study.demag(enabled=False)
study.stages.add_run(stage_id="measure", until=1.0e-12)
```

The example must preserve the explicit all-axis PBC requirement in both requested intent and
resolved provenance.

## Required validation suite

1. **Variational derivative:** compare DMI energy finite differences with the documented field and
   weak residual.
2. **One-dimensional cycloid/helix:** for exchange plus the stated DMI convention, verify
   `|q| = |D|/(2A)` and period `L = 4*pi*A/|D|` in the idealized no-anisotropy/no-demag case.
3. **Chirality reversal:** verify the transformations in the table above.
4. **Natural boundary:** use a FEM strip/disk edge-canting problem and refine the boundary mesh.
5. **FDM closure:** publish a separate convergence comparison against the variational FEM boundary
   problem; do not infer equivalence from matching bulk stencils.
6. **PBC bulk mode:** evaluate the exact discrete curl eigenvalue and convergence with cell size.
7. **Normal rotation:** test general FEM interface normals and reject unsupported FDM normals.
8. **CPU/GPU:** compare field, energy, chirality sign, and boundary/PBC behaviour.
9. **Spatial D fields:** verify cardinality, interpolation, discontinuity, and material-route
   precedence.

## Recommended extensions

- general Lifshitz-invariant/tensor DMI with explicit crystal symmetry and frame;
- multiple interfaces with independently oriented normals and thickness-localized coefficients;
- dedicated exchange–DMI boundary-condition diagnostics;
- coefficient import utilities that require the source convention and thickness;
- skyrmion/domain-wall chirality tutorials with topological and energetic observables.

## Bibliography

- A. Fert and P. M. Levy, *Phys. Rev. Lett.* **44**, 1538 (1980).
- A. N. Bogdanov and D. A. Yablonskii, *Sov. Phys. JETP* **68**, 101 (1989).
- S. Rohart and A. Thiaville, *Phys. Rev. B* **88**, 184422 (2013), DOI
  `10.1103/PhysRevB.88.184422`.
- A. Bogdanov and A. Hubert, *J. Magn. Magn. Mater.* **138**, 255–269 (1994).
