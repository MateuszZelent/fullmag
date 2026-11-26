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
exchange. Fullmag's public `CouplingRegistry` and `CouplingKindIR` contract exposes exactly three
coupling families—region `exchange`, `rkky`, and bilinear/biquadratic `interlayer_exchange`—and
their executable support is deliberately narrower than their IR vocabulary. Interlayer DMI and
general interfacial coupling families are not part of the current public Python/IR contract.

(physics-inter-region-couplings-problem-statement)=
## Physical problem

Inter-region couplings represent both discrete cell-to-cell exchange overrides ($A_{ab}$) across
adjacent `ObjectRegion` domains and opposing-surface bilinear/biquadratic RKKY interactions
($J_1, J_2$) across non-magnetic spacers.

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
:figclass: fm-physics-figure

Cell-link region exchange $A_{ab}$ across adjacent `ObjectRegion` cells (a) versus opposing-surface bilinear/biquadratic RKKY coupling $\sigma_{\mathrm{surf}}(\Delta\theta)$ (b), separating FDM-executable region exchange from `authored_only` surface couplings (Grünberg et al. 1986; Parkin et al. 1990; Bruno 1995; Suess et al. 2023).
```

(physics-inter-region-couplings-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $J_1,J_2$ | surface-coupling coefficients | $\mathrm{J\,m^{-2}}$ |
| $A_a,A_b,A_{ab}$ | exchange stiffness/link coefficient | $\mathrm{J\,m^{-1}}$ |
| $\Gamma_{ab}$ | coupled surface set | $\mathrm{m^2}$ |
| $\mathrm dS$ | surface measure | $\mathrm{m^2}$ |
| $s$ | harmonic-mean scale | $1$ |

(physics-inter-region-couplings-discrete-realization)=
## Capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `exchange`, `rkky`, `interlayer_exchange` | partial: region-to-region `exchange` via `materialize_region_exchange_couplings` (`ExchangeFaces` AoS path) | bounded planner/operator tests | persistent SoA fast path explicitly rejects `exchange_faces` via `soa_fast_path_rejection_reason`; multilayer FDM, `rkky`, and `interlayer_exchange` fail closed |
| FDM | GPU | same three IR variants | partial: region-to-region `exchange` via CUDA `face_xp/yp/zp` buffers | executed-device parity required | multilayer FDM, `rkky`, and `interlayer_exchange` fail closed |
| FEM | CPU | same three IR variants | unsupported | none | `crates/fullmag-plan/src/fem.rs` does not materialize region-exchange or surface trace couplings; all coupling kinds fail closed |
| FEM | GPU | same three IR variants | unsupported | none | no device surface or region-link materializer; fails closed |

(physics-inter-region-couplings-python-api)=
## Python API and stage-first example

### Public API parameters

| Python API | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR field |
|---|---|---|---|---|---|---|---|
| `study.couplings.exchange.mode` | `str` | `"harmonic_mean"` | — | `"harmonic_mean"`, `"explicit"`, or `"disabled"` | selects inter-region cell-face exchange rule | FDM CPU/GPU (single-layer), FEM unsupported | `couplings[].parameters.mode` |
| `study.couplings.exchange.scale` | `float \| None` | `None` | $1$ | non-negative float when `mode="harmonic_mean"` | dimensionless multiplier $s \ge 0$ on $A_{ab}^{\mathrm{harm}}$ | FDM CPU/GPU (single-layer), FEM unsupported | `couplings[].parameters.scale` |
| `study.couplings.exchange.inter_exchange` | `float \| None` | `None` | $\mathrm{J\,m^{-1}}$ | required non-negative float when `mode="explicit"` | explicit interface exchange stiffness $A_{ab}$ | FDM CPU/GPU (single-layer), FEM unsupported | `couplings[].parameters.inter_exchange` |
| `study.couplings.rkky.J1` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite float; `authored_only` in strict runtime | bilinear surface RKKY coupling constant $J_1$ | authoring/IR only (rejected at runtime on all lanes) | `couplings[].parameters.J1` |
| `study.couplings.interlayer_exchange.J1` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite float; `authored_only` in strict runtime | bilinear interlayer coupling constant $J_1$ | authoring/IR only (rejected at runtime on all lanes) | `couplings[].parameters.J1` |
| `study.couplings.interlayer_exchange.J2` | `float \| None` | `None` | $\mathrm{J\,m^{-2}}$ | optional finite float; `authored_only` in strict runtime | biquadratic interlayer coupling constant $J_2$ | authoring/IR only (rejected at runtime on all lanes) | `couplings[].parameters.J2` |
| `Coupling.capability_policy` | `str` | `"require_runtime"` | — | `"require_runtime"` or `"authored_only"` | controls whether non-executable IR entries reject at planning or remain schema-only | all lanes (planner gate) | `couplings[].capability_policy` |

### Stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("region_exchange_reference")
study.engine("fdm")
study.device("gpu", precision="double")
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

### Authored-only surface terms

`rkky` and `interlayer_exchange` terms carry `capability_policy="authored_only"` strictly for
`ProblemIR` export and schema inspection; with the default `capability_policy="require_runtime"`,
strict planning rejects them fail-closed on every lane.

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
## Validation boundary

Python (`packages/fullmag-py/src/fullmag/model/couplings.py`) validates endpoint kind, selector
names, mode/policy enums, and scalar consistency (with `coupling_id` uniqueness and canonical
identifiers checked during `to_ir()` lowering). The planner (`crates/fullmag-plan/src/fdm.rs`)
resolves region IDs, material coefficients, backend capability, and `ExchangeFaces` link
materialization before execution.

## Required numerical validation

- parallel/antiparallel/canted energy ordering for $J_1,J_2$;
- derivative of surface energy versus torque/field;
- disabled-link exact decoupling;
- harmonic versus explicit region-link coefficients;
- interface and surface-area convergence;
- endpoint orientation and face-pair symmetry;
- strict rejection on all unsupported lanes (FEM CPU/GPU, multilayer FDM, and surface couplings);
- verified CPU reference alongside any GPU surface-coupling implementation.

(physics-inter-region-couplings-limitations)=
## Limitations and roadmap

`rkky` and `interlayer_exchange` are presently representable in `ProblemIR`, not executable, and
interlayer DMI or general interface coupling classes do not exist in the current public API. Future
FEM support must define trace spaces, face pairing, quadrature, normal orientation, energy
reduction, and mesh convergence. Curved contacts and spacer-mediated transport need separate typed
geometry/physics contracts.

(physics-inter-region-couplings-scientific-bibliography)=
## Scientific bibliography

1. P. Grünberg, R. Schreiber, Y. Pang, M. B. Brodsky, and H. Sowers, “Layered Magnetic Structures: Evidence for Antiferromagnetic Coupling of Fe Layers across Cr Interlayers,” *Physical Review Letters* **57**(19), 2442–2445 (1986). [doi:10.1103/PhysRevLett.57.2442](https://doi.org/10.1103/PhysRevLett.57.2442).
2. S. S. P. Parkin, N. More, and K. P. Roche, “Oscillations in exchange coupling and magnetoresistance in metallic superlattice structures: Co/Ru, Co/Cr, and Fe/Cr,” *Physical Review Letters* **64**(19), 2304–2307 (1990). [doi:10.1103/PhysRevLett.64.2304](https://doi.org/10.1103/PhysRevLett.64.2304).
3. P. Bruno, “Theory of interlayer magnetic coupling,” *Physical Review B* **52**(1), 411–439 (1995). [doi:10.1103/PhysRevB.52.411](https://doi.org/10.1103/PhysRevB.52.411).
4. D. Suess, S. Koraltan, F. Slanovc, F. Bruckner, and C. Abert, “Accurate finite-difference micromagnetics of magnets including RKKY interaction: Analytical solution and comparison to standard micromagnetic codes,” *Physical Review B* **107**(10), 104424 (2023). [doi:10.1103/PhysRevB.107.104424](https://doi.org/10.1103/PhysRevB.107.104424) | [arXiv:2206.11063](https://arxiv.org/abs/2206.11063) (CC-BY).
5. L. Körber, A. Hempel, A. Otto, R. Gallardo, Y. Henry, J. Lindner, and A. Kákay, “Finite-element dynamic-matrix approach for propagating spin waves: Extension to mono- and multi-layers of arbitrary spacing and thickness,” *AIP Advances* **12**(11), 115206 (2022). [doi:10.1063/5.0107457](https://doi.org/10.1063/5.0107457) | [Open-access PDF (CC-BY)](https://pubs.aip.org/aip/adv/article-pdf/doi/10.1063/5.0107457/16475837/115206_1_online.pdf) | [arXiv:2207.01519](https://arxiv.org/abs/2207.01519).

(physics-inter-region-couplings-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored coupling kind (`exchange`, `rkky`, `interlayer_exchange`),
endpoint selectors, mode, coefficients, `capability_policy`, and execution request.
Resolved execution records the selected solver, device, precision, `ExchangeFaces` materialization, and
capability decision. Validation errors reject malformed endpoints, conflicting mode/parameter
combinations, duplicate `coupling_id` values, and non-finite coefficients before runtime.
Unsupported combinations (including `rkky` and `interlayer_exchange` under `require_runtime`,
multilayer FDM couplings, and any coupling on FEM CPU or FEM GPU) fail closed and are never
silently omitted or converted to another interaction.

(physics-inter-region-couplings-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability
limits stated on this page. Region-to-region `exchange` overrides act only across adjacent active
FDM faces sharing a cell boundary; non-adjacent regions produce no link unless a surface-coupling
operator is explicitly implemented and qualified.

(physics-inter-region-couplings-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization (`packages/fullmag-py/src/fullmag/model/couplings.py`,
`packages/fullmag-py/src/fullmag/world.py`), `ProblemIR` (`crates/fullmag-ir/src/model.rs`) owns
canonical intent, `crates/fullmag-plan/src/fdm.rs` (`materialize_region_exchange_couplings`) owns
FDM legality and face-override materialization, and backend kernels (`crates/fullmag-engine/src/fdm/cpu/fields.rs`
AoS reference and CUDA `face_xp/yp/zp` buffers) own numerical evaluation.

(physics-inter-region-couplings-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/couplings.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/couplings.py#L14) | `class CouplingEndpoint` | typed region or surface endpoint descriptor |
| [`packages/fullmag-py/src/fullmag/model/couplings.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/couplings.py#L48) | `class Coupling` | validated coupling record and `to_ir()` lowering |
| [`packages/fullmag-py/src/fullmag/model/couplings.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/couplings.py#L85) | `class CouplingRegistry` | public `exchange`, `rkky`, and `interlayer_exchange` registry |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6085) | `class StudyCouplingsHandle` | stage-first `study.couplings` facade |
| [`crates/fullmag-ir/src/model.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/model.rs#L621) | `CouplingIR` | canonical tagged coupling record |
| [`crates/fullmag-ir/src/model.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/model.rs#L635) | `CouplingKindIR` | canonical coupling-kind enum (`Exchange`, `Rkky`, `InterlayerExchange`) |
| [`crates/fullmag-ir/src/model.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/model.rs#L643) | `CouplingEndpointIR` | canonical region/surface endpoint IR enum |
| [`crates/fullmag-plan/src/fdm.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L1639) | `materialize_region_exchange_couplings` | FDM region-to-region exchange face materialization and capability gate |
| [`crates/fullmag-engine/src/fdm/cpu/fields.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields.rs#L367) | `soa_fast_path_rejection_reason` | routes `exchange_faces` overrides to AoS CPU reference path |
