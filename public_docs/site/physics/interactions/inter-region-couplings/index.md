---
title: Inter-region couplings
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-inter-region-couplings)=
# Inter-region couplings

Inter-region couplings model the magnetic interaction between distinct magnetic bodies or
regions that are not connected by the exchange stiffness within a single continuous mesh.
They are essential for multilayer stacks, synthetic antiferromagnets, and hybrid
multi-magnet problems.

(irc-problem-statement)=
## Physical problem

When two magnetic layers (or distinct mesh regions) are separated by a non-magnetic spacer,
the exchange stiffness $A$ does not provide a direct coupling. Instead, the interaction
is mediated by:

- **RKKY coupling**: indirect exchange through conduction electrons in a metallic spacer,
  characterised by bilinear coupling $J_1$ (and optionally biquadratic $J_2$).
- **Interlayer exchange coupling**: direct exchange at an interface, characterised by
  coupling constants $J_1$, $J_2$.
- **Exchange coupling across region boundaries**: harmonic-mean or explicit exchange
  across internal mesh-region interfaces within a single body.

(irc-governing-equations)=
## Governing equations

### Bilinear RKKY / interlayer exchange

The surface energy density for bilinear interlayer coupling between magnetizations
$\mathbf{m}_1$ and $\mathbf{m}_2$ at opposing surfaces is

```{math}
:label: eq-irc-bilinear
\sigma_{\mathrm{IEC}}
=
-J_1(\mathbf{m}_1\cdot\mathbf{m}_2)
-J_2(\mathbf{m}_1\cdot\mathbf{m}_2)^2,
```

where $J_1$ in $\mathrm{J\,m^{-2}}$ is the bilinear coupling and $J_2$ is the biquadratic
coupling. Positive $J_1$ favours parallel alignment (ferromagnetic coupling); negative
$J_1$ favours antiparallel alignment (antiferromagnetic coupling).

### Exchange across regions

For two mesh regions sharing an internal boundary, the exchange coupling uses either:

- **Harmonic-mean mode**: $A_{\mathrm{eff}} = 2A_1A_2/(A_1+A_2)$, the harmonic mean of
  the exchange stiffnesses on either side.
- **Explicit mode**: a user-specified `inter_exchange` constant in $\mathrm{J\,m^{-1}}$.
- **Disabled mode**: no exchange across the region boundary.

(irc-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $J_1$ | bilinear interlayer coupling | $\mathrm{J\,m^{-2}}$ |
| $J_2$ | biquadratic interlayer coupling | $\mathrm{J\,m^{-2}}$ |
| $A_{\mathrm{eff}}$ | effective inter-region exchange | $\mathrm{J\,m^{-1}}$ |
| $\mathbf{m}_1,\mathbf{m}_2$ | magnetizations at opposing surfaces | $1$ |

(irc-python-api)=
## Python authoring and canonical ProblemIR

FullMag provides three coupling types through the `CouplingRegistry`:

```python
import fullmag as fm

# Exchange coupling across regions (harmonic mean)
problem.couplings.exchange(
    source=magnet1,
    target=magnet2,
    mode="harmonic_mean",
)

# RKKY coupling (surface-to-surface)
problem.couplings.rkky(
    source=fm.CouplingEndpoint.surface("layer1", "top"),
    target=fm.CouplingEndpoint.surface("layer2", "bottom"),
    J1=-1e-4,  # antiferromagnetic, J/m²
)

# Interlayer exchange (surface-to-surface)
problem.couplings.interlayer_exchange(
    source=fm.CouplingEndpoint.surface("layer1", "top"),
    target=fm.CouplingEndpoint.surface("layer2", "bottom"),
    J1=1e-3,     # J/m² bilinear
    J2=-1e-5,    # J/m² biquadratic (optional)
)
```

### Parameter reference

| Method | Required | Type | SI unit | Description |
|---|---|---|---:|---|
| `exchange` | `mode` | `str` | — | `"harmonic_mean"`, `"explicit"`, or `"disabled"` |
| `exchange` | `inter_exchange` | `float` | $\mathrm{J\,m^{-1}}$ | required for `"explicit"` mode |
| `rkky` | `J1` | `float` | $\mathrm{J\,m^{-2}}$ | bilinear coupling constant |
| `interlayer_exchange` | `J1` | `float` | $\mathrm{J\,m^{-2}}$ | bilinear coupling |
| `interlayer_exchange` | `J2` | `float` or `None` | $\mathrm{J\,m^{-2}}$ | biquadratic (optional) |

### Endpoint types

| Endpoint | Resolution | Typical usage |
|---|---|---|
| `CouplingEndpoint.object(name)` | entire object | intra-body exchange |
| `CouplingEndpoint.region(object, region_id)` | named sub-region | multi-region single body |
| `CouplingEndpoint.surface(object, selector)` | named surface face | surface-to-surface interlayer coupling |

(irc-validation)=
## Validation status

| Lane | Status |
|---|---|
| FDM CPU | Exchange across regions implemented; RKKY/interlayer exchange in progress |
| FDM GPU | Follows CPU reference |
| FEM CPU | Exchange across regions via reduced space; interlayer coupling deferred |
| FEM GPU | Follows CPU reference |

(irc-limitations)=
## Known limitations

- RKKY and interlayer exchange couplings require surface endpoints with matching face
  selectors (`"top"`, `"bottom"`, etc.).
- Self-consistent spacer transport is not implemented.
- Multi-surface coupling (>2 layers) requires explicit pairwise coupling declarations.
- Capability policy `"require_runtime"` will reject unsupported coupling kinds at
  plan time.

(irc-scientific-bibliography)=
## Scientific bibliography

1. P. Grünberg, R. Schreiber, Y. Pang, M. B. Brodsky, and H. Sowers, "Layered magnetic
   structures: evidence for antiferromagnetic coupling of Fe layers across Cr interlayers,"
   *Physical Review Letters* **57**, 2442 (1986).
   [doi:10.1103/PhysRevLett.57.2442](https://doi.org/10.1103/PhysRevLett.57.2442).
2. S. S. P. Parkin, N. More, and K. P. Roche, "Oscillations in exchange coupling and
   magnetoresistance in metallic superlattice structures: Co/Ru, Co/Cr, and Fe/Cr,"
   *Physical Review Letters* **64**, 2304 (1990).
   [doi:10.1103/PhysRevLett.64.2304](https://doi.org/10.1103/PhysRevLett.64.2304).

(irc-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Coupling registry | `packages/fullmag-py/src/fullmag/model/couplings.py` | `class CouplingRegistry` | authoring and IR | Python |
| Coupling endpoint | `packages/fullmag-py/src/fullmag/model/couplings.py` | `class CouplingEndpoint` | endpoint resolution | Python |
| Exchange mode | `packages/fullmag-py/src/fullmag/model/couplings.py` | `exchange` method | mode validation | Python |
| RKKY | `packages/fullmag-py/src/fullmag/model/couplings.py` | `rkky` method | surface coupling | Python |
| Interlayer exchange | `packages/fullmag-py/src/fullmag/model/couplings.py` | `interlayer_exchange` method | surface coupling | Python |
