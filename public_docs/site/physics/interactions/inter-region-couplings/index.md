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
| FDM | CPU | all coupling IR variants | unsupported for enabled runtime coupling | none | ordinary exchange does not imply coupling support |
| FDM | GPU | all coupling IR variants | partial: region-to-region exchange only | managed runtime evidence still required | RKKY/interlayer surfaces are not materialized |
| FEM | CPU | all coupling IR variants | unsupported | none | surface trace/quadrature operator not implemented |
| FEM | GPU | all coupling IR variants | unsupported | none | no device surface or region materializer |

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

1. P. Grünberg et al., *Physical Review Letters* **57**, 2442 (1986).
2. S. S. P. Parkin, N. More, and K. P. Roche, *Physical Review Letters* **64**, 2304 (1990).
3. NIST reference material on interlayer exchange coupling benchmarks.

(physics-inter-region-couplings-source-code-index)=

## Control Room crosswalk

This is a navigation page; the selected interaction or foundation is configured by its linked Python API and object/stage editor. The category itself has no standalone control. frontend support is not implemented applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-inter-region-couplings-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(physics-inter-region-couplings-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/couplings.py` | `CouplingRegistry, Coupling` | public endpoint and parameter validation |
| `packages/fullmag-py/src/fullmag/world.py` | `StudyCouplingsHandle` | stage-first coupling facade |
| `crates/fullmag-plan/src/fdm.rs` | `region coupling planning` | FDM capability and region resolution |
| `crates/fullmag-engine/src` | `materialize_region_exchange_couplings` | FDM GPU link overrides |
| `crates/fullmag-ir/src` | `CouplingKindIR/CouplingEndpointIR` | tagged canonical schema |

(physics-inter-region-couplings-round-trip-and-failure-semantics)=
