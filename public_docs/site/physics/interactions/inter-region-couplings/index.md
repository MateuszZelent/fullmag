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

For adjacent material regions with piecewise-constant exchange stiffnesses, the canonical
`harmonic_mean` intent is

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
operator is not the same as a surface energy. The current FDM CUDA realization is narrower than
the canonical equation: it rejects region-owned or cellwise $A$ fields and therefore cannot
derive distinct $A_a$ and $A_b$. Its executable `harmonic_mean` path has one uniform object
coefficient $A$, for which $A_{ab}^{\mathrm{harm}}=A$, and materializes $sA$. Heterogeneous
$A_a/A_b$ harmonic means remain non-executable and must fail closed.

(physics-inter-region-couplings-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $J_1,J_2$ | surface-coupling coefficients | $\mathrm{J\,m^{-2}}$ |
| $\mathbf m_a,\mathbf m_b$ | reduced magnetization on the two coupled sides | $1$ |
| $\sigma_{\mathrm{surf}}$ | local surface-coupling energy density | $\mathrm{J\,m^{-2}}$ |
| $E_{\mathrm{surf}}$ | integrated surface-coupling energy | $\mathrm J$ |
| $A_a,A_b,A_{ab}$ | canonical side coefficients and resulting exchange-link coefficient | $\mathrm{J\,m^{-1}}$ |
| $A_{ab}^{\mathrm{harm}}$ | canonical harmonic-mean link; current CUDA realizes only the uniform-$A$ reduction | $\mathrm{J\,m^{-1}}$ |
| $\Gamma_{ab}$ | coupled surface set | $1$ |
| $\mathrm dS$ | surface measure | $\mathrm{m^2}$ |
| $s$ | harmonic-mean scale | $1$ |

(physics-inter-region-couplings-discrete-realization)=
## Capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | all coupling IR variants | unsupported for enabled runtime coupling | none | ordinary exchange does not imply coupling support |
| FDM | GPU | all coupling IR variants | partial: explicit, disabled, and uniform-$A$ harmonic/scale region pairs | managed runtime evidence still required | region/cellwise $A$ fields and RKKY/interlayer surfaces are rejected or unsupported; the runtime LUT uses one uniform $A$ |
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
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    dt=1.0e-15,
    max_steps=500,
    tolT=1.0e-6,
)
```

The two region shapes are explicitly displaced; overlapping identical boxes must not be presented
as a left/right partition.

### Complete public parameter table

| Python parameter | Type | Default | SI unit | Validation and failure | Physical meaning | Backend support | ProblemIR destination |
|---|---|---|---:|---|---|---|---|
| `study.couplings.exchange.source` | object, object region, surface, or name | required | $1$ | must resolve to a non-empty endpoint; executable FDM CUDA exchange requires a region endpoint | first side of the directed coupling declaration | authoring all lanes; runtime capability-gated | `couplings[].source` |
| `study.couplings.exchange.target` | object, object region, surface, or name | required | $1$ | same endpoint validation as `source`; executable FDM CUDA exchange requires a region endpoint | second side of the coupling declaration | authoring all lanes; runtime capability-gated | `couplings[].target` |
| `study.couplings.exchange.mode` | `str` | `"harmonic_mean"` | $1$ | `"harmonic_mean"`, `"explicit"`, or `"disabled"` | selects the region-link coefficient rule | FDM CUDA supports explicit/disabled and only the uniform-$A$ harmonic reduction | `couplings[].parameters.mode` |
| `study.couplings.exchange.scale` | `float \| None` | `None` | $1$ | finite and non-negative; disabled mode accepts only `None` or `0.0` | multiplier for the canonical harmonic mean; CUDA currently applies it to one uniform object $A$ | FDM CUDA homogeneous-$A$ region exchange subset | `couplings[].parameters.scale` |
| `study.couplings.exchange.inter_exchange` | `float \| None` | `None` | $\mathrm{J\,m^{-1}}$ | finite; required by explicit mode and forbidden by harmonic-mean mode; current executable FDM CUDA planner additionally requires non-negative | explicitly authored region-link exchange stiffness | FDM CUDA region exchange subset | `couplings[].parameters.inter_exchange` |
| `study.couplings.exchange.coupling_id` | `str \| None` | `None` | $1$ | omitted value is generated deterministically; an authored empty value is rejected during lowering | stable coupling identity | authoring all lanes | `couplings[].coupling_id` |
| `study.couplings.exchange.enabled` | `bool` | `True` | $1$ | currently normalized with `bool(...)` during lowering rather than strictly type-checked | enables or disables the declaration | authoring all lanes; disabled is executable as a no-op | `couplings[].enabled` |
| `study.couplings.exchange.capability_policy` | `str` | `"require_runtime"` | $1$ | `"require_runtime"` or `"authored_only"`; strict executable planning rejects authored-only terms | separates executable intent from export-only intent | authoring all lanes | `couplings[].capability_policy` |
| `study.couplings.rkky.J1` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite; both endpoints must be surfaces | bilinear RKKY surface coefficient | authoring only; no executable lane | `couplings[].parameters.j1` |
| `study.couplings.interlayer_exchange.J1` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite; both endpoints must be surfaces | bilinear interlayer surface coefficient | authoring only; no executable lane | `couplings[].parameters.j1` |
| `study.couplings.interlayer_exchange.J2` | `float \| None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied; both endpoints must be surfaces | biquadratic interlayer surface coefficient | authoring only; no executable lane | `couplings[].parameters.j2` |

`rkky(...)` and `interlayer_exchange(...)` share the endpoint, `coupling_id`, `enabled`, and
`capability_policy` semantics shown above. Their endpoint resolver accepts surface objects, but
the public bounding-face selectors are limited to `top`, `bottom`, `left`, `right`, `front`, and
`back`.

### Authored-only surface term

RKKY/interlayer terms should use `capability_policy="authored_only"` only for export/inspection.
They are not executable in strict planning at this revision. Documentation must not place an
authored-only term in a run stage and imply runtime support.

(physics-inter-region-couplings-problem-ir)=
## ProblemIR

```json
{
  "coupling_id": "exchange:film_r1:film_r2",
  "kind": "exchange",
  "source": {"kind": "region", "object": "film", "region_id": "film:r1"},
  "target": {"kind": "region", "object": "film", "region_id": "film:r2"},
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

Python owns endpoint kind, selector names, mode/policy enums, and scalar consistency. Planner owns
resolved region IDs, backend capability, and link materialization. On the current FDM CUDA path,
the planner does not resolve separate $A_a/A_b$ values: it emits explicit overrides or a scaled
uniform object coefficient, while validation rejects cellwise/region-owned $A$ fields.
`coupling_id` should be validated in `__post_init__`, not delayed until `to_ir()`.
The adjacent source map traces the public registry and study facade through canonical IR,
capability resolution, FDM CUDA materialization, and focused round-trip/planner tests.

## Required numerical validation

- parallel/antiparallel/canted energy ordering for $J_1,J_2$;
- derivative of surface energy versus torque/field;
- disabled-link exact decoupling;
- uniform-$A$ harmonic/scale versus explicit region-link coefficients;
- fail-closed rejection of heterogeneous region/cellwise $A$ on FDM CUDA until a coefficient-aware LUT is implemented;
- interface and surface-area convergence;
- endpoint orientation and face-pair symmetry;
- strict rejection on all unsupported lanes;
- future CPU reference before GPU-only surface coupling is promoted.

(physics-inter-region-couplings-limitations)=
## Limitations and roadmap

RKKY and interlayer exchange are presently representable, not executable. Future FEM support must
define trace spaces, face pairing, quadrature, normal orientation, energy reduction, and mesh
convergence. Curved contacts and spacer-mediated transport need separate typed geometry/physics
contracts. The FDM CUDA harmonic-mean mode is not a heterogeneous-material implementation: its LUT
uses the single uniform exchange stiffness stored by the native context. Distinct region $A$
coefficients require future coefficient-aware materialization and remain fail-closed.

(physics-inter-region-couplings-scientific-bibliography)=
## Scientific bibliography

1. P. Grünberg et al., *Physical Review Letters* **57**, 2442 (1986).
2. S. S. P. Parkin, N. More, and K. P. Roche, *Physical Review Letters* **64**, 2304 (1990).
3. NIST reference material on interlayer exchange coupling benchmarks.

(physics-inter-region-couplings-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/couplings.py` | `class CouplingRegistry` | public endpoint, parameter validation, and lowering |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyCouplingsHandle` | stage-first coupling facade |
| `crates/fullmag-plan/src/validate.rs` | `region_coupling_is_executable_for_backend` | exact executable capability boundary |
| `crates/fullmag-plan/src/fdm.rs` | `materialize_region_exchange_couplings` | FDM CUDA region-link materialization |
| `backends/fdm/api/c_api.cpp` | `fullmag_fdm_backend_create` | native LUT construction from uniform `ctx->A`, scale, and explicit pair overrides |
| `packages/fullmag-py/tests/test_api.py` | `test_class_api_exchange_coupling_lowers_to_ir` | Python-to-IR exchange regression |
| `crates/fullmag-plan/src/tests.rs` | `explicit_exchange_coupling_blocks_until_runtime_materialization_exists` | unsupported-lane rejection regression |

(physics-inter-region-couplings-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-inter-region-couplings-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(physics-inter-region-couplings-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.
