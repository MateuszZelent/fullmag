---
title: Inter-region couplings
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-inter-region-couplings)=
# Inter-region couplings

Inter-region couplings connect named regions or opposing surfaces beyond ordinary homogeneous
exchange. Fullmag authors region exchange, RKKY, and bilinear/biquadratic interlayer exchange, but
their executable support is deliberately narrower than their IR vocabulary.

(physics-inter-region-couplings-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(physics-inter-region-couplings-governing-equations)=
## Governing equations

For opposing surfaces,

```{math}
:label: eq-public-inter-region-couplings-coupling-surface-energy
\sigma_{\mathrm{surf}}
=
-J_1\,\mathbf m_a\cdot\mathbf m_b
-J_2(\mathbf m_a\cdot\mathbf m_b)^2,
\qquad
E_{\mathrm{surf}}=\int_{\Gamma_{ab}}\sigma_{\mathrm{surf}}\,\mathrm dS .
```

With this sign convention, positive $J_1$ favors parallel alignment. The sign and magnitude of
$J_2$ control whether collinear or canted configurations are favored and must be interpreted
from the full polynomial.

For adjacent material regions, the default exchange link is

```{math}
:label: eq-public-inter-region-couplings-coupling-harmonic
A_{ab}^{\mathrm{harm}}
=
\frac{2A_aA_b}{A_a+A_b},
\qquad
A_{ab}=sA_{ab}^{\mathrm{harm}},
\quad s\ge0.
```

An explicit mode uses authored $A_{ab}$; a disabled mode sets the link to zero. This cell-link
operator is not the same as a surface energy.

```{figure} /_static/diagrams/inter-region-couplings-exchange-rkky.svg
:alt: Two-panel diagram comparing (a) cell-to-cell harmonic, scaled-harmonic, explicit, and disabled region exchange A_ab across adjacent ObjectRegion cells (executable on FDM GPU CUDA and FDM CPU AoS reference, unsupported on FEM), against (b) surface RKKY and interlayer exchange energy -J_1(m_a.m_b) - J_2(m_a.m_b)^2 across FM, AFM, 90-degree, and canted regimes (authored_only IR rejected in strict runtime on all lanes).
:width: 100%
:name: fig-inter-region-couplings-exchange-rkky
:class: fm-physics-figure

Cell-link region exchange $A_{ab}$ across adjacent `ObjectRegion` cells (a) versus opposing-surface bilinear/biquadratic RKKY coupling $\sigma_{\mathrm{surf}}(\Delta\theta)$ (b), separating FDM-executable region exchange from `authored_only` surface couplings (Grünberg et al. 1986; Parkin et al. 1990; Bruno 1995; Suess et al. 2023).
```

(physics-inter-region-couplings-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $J_1,J_2$ | surface-coupling coefficients | $\mathrm{J\,m^{-2}}$ |
| $A_a,A_b,A_{ab}$ | exchange stiffness/link coefficient | $\mathrm{J\,m^{-1}}$ |
| $\Gamma_{ab}$ | coupled surface set | not applicable |
| $\mathrm dS$ | surface measure | $\mathrm{m^2}$ |
| $s$ | harmonic-mean scale | $1$ |

(physics-inter-region-couplings-discrete-realization)=
## Capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | all coupling IR variants | partial: region-to-region exchange via AoS reference (`ExchangeFaces`) | bounded planner/operator tests | persistent SoA fast path rejects `exchange_faces`; RKKY/interlayer unsupported |
| FDM | GPU | all coupling IR variants | partial: region-to-region exchange via CUDA `face_xp/yp/zp` buffers | managed runtime evidence still required | multilayer FDM and RKKY/interlayer surfaces unsupported |
| FEM | CPU | all coupling IR variants | unsupported | none | region-exchange and surface trace quadrature operators not implemented |
| FEM | GPU | all coupling IR variants | unsupported | none | no device surface or region-link materializer |

Front matter must therefore be `partial`, not `implemented`.

(physics-inter-region-couplings-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("region_exchange_reference")
study.engine("fdm")
study.device("cuda", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

left = body.add_region("left", fm.Box(20 * nm, 20 * nm, 4 * nm).translate((-10 * nm, 0.0, 0.0)))
right = body.add_region("right", fm.Box(20 * nm, 20 * nm, 4 * nm).translate((10 * nm, 0.0, 0.0)))
study.couplings.exchange(source=left, target=right, mode="explicit", inter_exchange=13.0e-12)
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", dt=5.0e-13, max_steps=500, tolT=1.0e-6)
```

The two region shapes are explicitly displaced; overlapping identical boxes must not be presented
as a left/right partition.

### Authored-only surface term

RKKY/interlayer terms should use `capability_policy="authored_only"` only for export/inspection.
They are not executable in strict planning at this revision. Documentation must not place an
authored-only term in a run stage and imply runtime support.

(physics-inter-region-couplings-problem-ir)=
## ProblemIR

```json
{
  "coupling_id": "exchange:bilayer_left:bilayer_right",
  "kind": "exchange",
  "source": {"kind": "region", "object": "bilayer", "region_id": "bilayer:left"},
  "target": {"kind": "region", "object": "bilayer", "region_id": "bilayer:right"},
  "enabled": true,
  "parameters": {
    "kind": "exchange",
    "mode": "explicit",
    "inter_exchange": 1.3e-11
  },
  "capability_policy": "require_runtime"
}
```

(physics-inter-region-couplings-validation)=
## Validation boundary and source-map correction

Python owns endpoint kind, selector names, mode/policy enums, and scalar consistency. Planner owns
resolved region IDs, material coefficients, backend capability, and link materialization.
`coupling_id` should be validated in `__post_init__`, not delayed until `to_ir()`.

The current source map has an empty public constructor/parameter inventory despite a substantial
public table. Regenerate it from the actual `CouplingRegistry` API and current audited revision.

## Required numerical validation

- parallel/antiparallel/canted energy ordering for $J_1,J_2$;
- derivative of surface energy versus torque/field;
- disabled-link exact decoupling;
- harmonic versus explicit region-link coefficients;
- interface and surface-area convergence;
- endpoint orientation and face-pair symmetry;
- strict rejection on all unsupported lanes;
- future CPU reference before GPU-only surface coupling is promoted.

(physics-inter-region-couplings-limitations)=
## Limitations and roadmap

RKKY and interlayer exchange are presently representable, not executable. Future FEM support must
define trace spaces, face pairing, quadrature, normal orientation, energy reduction, and mesh
convergence. Curved contacts and spacer-mediated transport need separate typed geometry/physics
contracts.

(physics-inter-region-couplings-scientific-bibliography)=
## Scientific bibliography

1. P. Grünberg, R. Schreiber, Y. Pang, M. B. Brodsky, and H. Sowers, “Layered Magnetic Structures: Evidence for Antiferromagnetic Coupling of Fe Layers across Cr Interlayers,” *Physical Review Letters* **57**(19), 2442–2445 (1986). [doi:10.1103/PhysRevLett.57.2442](https://doi.org/10.1103/PhysRevLett.57.2442).
2. S. S. P. Parkin, N. More, and K. P. Roche, “Oscillations in exchange coupling and magnetoresistance in metallic superlattice structures: Co/Ru, Co/Cr, and Fe/Cr,” *Physical Review Letters* **64**(19), 2304–2307 (1990). [doi:10.1103/PhysRevLett.64.2304](https://doi.org/10.1103/PhysRevLett.64.2304).
3. P. Bruno, “Theory of interlayer magnetic coupling,” *Physical Review B* **52**(1), 411–439 (1995). [doi:10.1103/PhysRevB.52.411](https://doi.org/10.1103/PhysRevB.52.411).
4. D. Suess, S. Koraltan, F. Slanovc, F. Bruckner, and C. Abert, “Accurate finite-difference micromagnetics of magnets including RKKY interaction: Analytical solution and comparison to standard micromagnetic codes,” *Physical Review B* **107**(10), 104424 (2023). [doi:10.1103/PhysRevB.107.104424](https://doi.org/10.1103/PhysRevB.107.104424) | [arXiv:2206.11063](https://arxiv.org/abs/2206.11063) (CC-BY).
5. L. Körber, A. Hempel, A. Otto, R. Gallardo, Y. Henry, J. Lindner, and A. Kákay, “Finite-element dynamic-matrix approach for propagating spin waves: Extension to mono- and multi-layers of arbitrary spacing and thickness,” *AIP Advances* **12**(11), 115206 (2022). [doi:10.1063/5.0107457](https://doi.org/10.1063/5.0107457) | [Open-access PDF (CC-BY)](https://pubs.aip.org/aip/adv/article-pdf/doi/10.1063/5.0107457/16475837/115206_1_online.pdf) | [arXiv:2207.01519](https://arxiv.org/abs/2207.01519).

(physics-inter-region-couplings-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-inter-region-couplings-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(physics-inter-region-couplings-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(physics-inter-region-couplings-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/couplings.py` | `CouplingRegistry, Coupling` | public endpoint and parameter validation |
| `packages/fullmag-py/src/fullmag/world.py` | `StudyCouplingsHandle` | stage-first coupling facade |
| `crates/fullmag-plan/src/fdm.rs` | `region coupling planning` | FDM capability and region resolution |
| `crates/fullmag-engine/src` | `materialize_region_exchange_couplings` | FDM CPU/GPU link overrides (`ExchangeFaces`) |
| `crates/fullmag-ir/src` | `CouplingKindIR/CouplingEndpointIR` | tagged canonical schema |
