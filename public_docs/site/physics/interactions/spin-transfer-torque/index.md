---
title: Spin-transfer torque
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md
---

(public-docs-physics-interactions-stt)=
# Spin-transfer torque

Spin-transfer torque (STT) is a direct, non-conservative contribution to the LLG
right-hand side. It is not an energy term: no `E_stt` scalar is created and an STT
request must not be silently converted into a conservative relaxation interaction.

The current code has two API generations:

| API generation | Formula identity | Meaning |
|---|---|---|
| legacy `SlonczewskiSTT` / `ZhangLiSTT` | `slonczewski.legacy_fullmag.v0`, `zhang_li.legacy_fullmag.v0` | compatibility execution used by the existing FDM and native FEM lanes |
| canonical objects with `id`/`target` | `slonczewski.fullmag.v2`, `zhang_li.fullmag.v1` | oriented, versioned physical intent; still separately qualified from legacy execution |

The other two module types are intentionally separate: `InterfaceCppSTT` preserves
interface-local CPP intent, while `DriftDiffusionSpinTorque` references a solved
spin-transport module. The latter is not a replacement for the Zhang–Li model.
The SHE/transport owner is the sibling page
{doc}`../drift-diffusion-spin-torque/index`.

## Backend and qualification matrix

The matrix distinguishes implementation state from scientific qualification. A
native kernel, a passing source contract, and a serialized `ProblemIR` do not by
themselves establish CPU/GPU parity or a validated workload.

| Solver | Device | legacy Slonczewski/Zhang–Li | canonical v1/v2 | qualification boundary |
|---|---|---|---|---|
| FDM | CPU | reference executable | semantic-only | Rust `f64` reference and analytic tests cover the legacy evaluator; canonical signed-current workloads remain gated. |
| FDM | GPU | production executable | semantic-only | CUDA fused RHS exists for the legacy path; an executed-device parity run is still a separate gate. |
| FEM | CPU | production executable | semantic-only | Native MFEM direct-RHS path exists for legacy parameters; the Rust FEM reference runner is a different lane. |
| FEM | GPU | production executable | semantic-only | Native CUDA direct-torque dispatch exists for legacy parameters; source presence is not parity proof. |

(stt-problem-statement)=
## Physical problem

Let $\mathbf m=\mathbf M/M_s$ be the reduced magnetization. A conventional charge
current transfers angular momentum from a spin-polarised electron population to a
ferromagnet. CPP torque uses a fixed-layer polarization and acts locally through
the thickness model. CIP torque uses the current-driven derivative of $\mathbf m$.
Both are direct rates in $\mathrm{s^{-1}}$ and are evaluated at the magnetization
state of the current LLG stage.

STT is not the same as prescribed spin-orbit torque and neither is the same as a
solved spin Hall drift-diffusion problem. In particular, `SpinOrbitTorque` is a
deprecated compatibility alias for prescribed local SOT; it does not satisfy the
`transport.spin.direct_she` capability.

(stt-governing-equations)=
## Governing equations

The canonical Gilbert equation is

```{math}
:label: eq-stt-llg
\frac{\partial\mathbf m}{\partial t}
=-\gamma_0\,\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times\frac{\partial\mathbf m}{\partial t}
+\mathbf T_G,
\qquad
\gamma_0=\mu_0\gamma_e .
```

Every Gilbert source is transformed exactly once:

```{math}
:label: eq-stt-gilbert-conversion
\mathbf T_{\mathrm{explicit}}
=\frac{\mathbf T_G+\alpha\,\mathbf m\times\mathbf T_G}{1+\alpha^2}.
```

### Zhang–Li, canonical `zhang_li.fullmag.v1`

For signed conventional current density $\mathbf J_c$,

```{math}
:label: eq-stt-zhang-li-canonical
\mathbf u
=\frac{g\,\mu_B P}{2eM_s}\,\mathbf J_c,
\qquad
\mathbf v=(\mathbf u\cdot\nabla)\mathbf m,
\qquad
\mathbf T_{\mathrm{ZL},G}=-\mathbf v+\beta\,\mathbf m\times\mathbf v.
```

The canonical explicit contribution is

```{math}
:label: eq-stt-zhang-li-explicit
\mathbf T_{\mathrm{ZL},\mathrm{explicit}}
=\frac{-(1+\alpha\beta)\mathbf v_{\perp}
 +(\beta-\alpha)\mathbf m\times\mathbf v_{\perp}}
 {1+\alpha^2},
\qquad
\mathbf v_{\perp}=\mathbf v-\mathbf m(\mathbf m\cdot\mathbf v).
```

The legacy FDM evaluator retains its historical
$1/(1+\beta^2)$ drift factor and the historical elementary-charge literal. It is
versioned as `zhang_li.legacy_fullmag.v0`; the legacy factor must not be presented
as the canonical v1 formula.

### Slonczewski, canonical `slonczewski.fullmag.v2`

For stack normal $\mathbf n_{\mathrm{stack}}$ from fixed to free layer, use the
signed normal current $J_n=\mathbf J_c\cdot\mathbf n_{\mathrm{stack}}$ and
$q=\mathbf m\cdot\hat{\mathbf p}$:

```{math}
:label: eq-stt-slonczewski-canonical
\Omega_J=\frac{\gamma_e\hbar J_n}{eM_st_F},
\qquad
\varepsilon(q)=\frac{P\Lambda^2}
 {\Lambda^2+1+(\Lambda^2-1)q}.
```

With $\mathbf D=\mathbf m\times(\mathbf m\times\hat{\mathbf p})$ and
$\mathbf C=\mathbf m\times\hat{\mathbf p}$,

```{math}
:label: eq-stt-slonczewski-explicit
\mathbf T_{\mathrm{SL},\mathrm{explicit}}
=\frac{\Omega_J}{1+\alpha^2}
\left[(\varepsilon+\alpha\varepsilon')\mathbf D
 +(\varepsilon'-\alpha\varepsilon)\mathbf C\right].
```

`epsilon_prime` is independent of $\varepsilon(q)$; it must not be factored by
the angular efficiency. The `slonczewski_thin_layer_homogenized.v1` realization
uses $t_F$ volumetrically. The mutually exclusive
`slonczewski_interface_flux.v1` realization uses an oriented absorbed-spin-flux
surface functional and must not insert an artificial $1/t_F$ into its FEM weak form.

The legacy evaluator uses the explicitly versioned historical factor of two and
rounded charge literal. `fixed_layer_position` is a legacy migration input; the
canonical API uses the oriented `stack_normal` and must not apply the sign twice.

(stt-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf m$ | reduced magnetization $\mathbf M/M_s$ | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf T_G$, $\mathbf T_{\mathrm{explicit}}$ | Gilbert and explicit direct torque rates | $\mathrm{s^{-1}}$ |
| $\mathbf J_c$, $J_n$ | conventional and stack-normal current density | $\mathrm{A\,m^{-2}}$ |
| $\hat{\mathbf p}$ | fixed-layer polarization direction | $1$ |
| $\mathbf n_{\mathrm{stack}}$ | oriented fixed-to-free stack normal | $1$ |
| $P$ | spin polarization efficiency | $1$ |
| $\Lambda$ | Slonczewski asymmetry parameter | $1$ |
| $\varepsilon(q)$ | angular Slonczewski efficiency | $1$ |
| $\varepsilon'$ | independent field-like CPP coefficient | $1$ |
| $q$ | polarization projection $\mathbf m\cdot\hat{\mathbf p}$ | $1$ |
| $\mathbf D$ | double-cross CPP basis vector | $1$ |
| $\mathbf C$ | cross-product CPP basis vector | $1$ |
| $\beta$ | Zhang–Li non-adiabaticity | $1$ |
| $g$ | effective Landé factor in canonical Zhang–Li | $1$ |
| $\mathbf u$ | Zhang–Li drift velocity | $\mathrm{m\,s^{-1}}$ |
| $\mathbf v$, $\mathbf v_\perp$ | advective derivative and tangent projection | $\mathrm{s^{-1}}$ |
| $\gamma_e$, $\gamma_0$ | angular gyromagnetic magnitude and reduced constant | $\mathrm{s^{-1}\,T^{-1}}$, $\mathrm{m\,(A\,s)^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $t_F$ | free-layer thickness used by homogenized CPP | $\mathrm{m}$ |
| $\Omega_J$ | signed CPP torque-frequency scale | $\mathrm{s^{-1}}$ |
| $\hbar$, $e$, $\mu_0$, $\mu_B$ | reduced Planck constant, positive charge, vacuum permeability, Bohr magneton | $\mathrm{J\,s}$, $\mathrm C$, $\mathrm{N\,A^{-2}}$, $\mathrm{J\,T^{-1}}$ |

(stt-assumptions-and-validity)=
## Assumptions and validity limits

- All constructor values are SI values; no nanometre or CGS conversion is performed.
- $|\mathbf m|=1$ is the micromagnetic state constraint.
- Legacy source binding requires exactly one of `current_density` and `current_source`.
- Canonical v1/v2 requires an explicit target and orientation; thin-layer and interface-flux
  realizations are mutually exclusive.
- FDM Zhang–Li uses signed one-sided upwind differences for each nonzero component of
  $\mathbf u$ and honors the configured axis periodicity. Native FEM Zhang–Li uses P1
  tetrahedral gradients and node-weight accumulation.
- STT has no energy accumulator, no self-consistent spin accumulation, and no implicit
  interface transparency model in the legacy constructors.
- A source-level or compiled GPU implementation is not an executed-device qualification.

(stt-python-api)=
## Python API and copyable authoring fragment

The public `study(...).stages` builder is the required simulation workflow, but it does not
yet expose a stage-level STT registration method. The following keeps the runnable stage shell
separate from the object-level canonical fragment; it does not pretend that a disconnected
object is an executable simulation.

```python
# %% Stage-first simulation shell
import fullmag as fm

nm = 1.0e-9
study = fm.study("stt-stage-boundary")
study.engine("fdm")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(100 * nm, 40 * nm, 4 * nm), name="free_layer")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_run(stage_id="run", until=1.0e-12)

# %% Canonical object fragment (inspectable before stage registration exists)
stt = fm.ZhangLiSTT(current_density=(5.0e11, 0.0, 0.0), degree=0.4, beta=0.02)
stt_ir = stt.to_ir_module()
assert stt_ir["kind"] == "zhang_li"
assert stt_ir["beta"] == 0.02
```

### Exhaustive parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `SlonczewskiSTT.current_density` | `Sequence[float] or None` | `None` | $\mathrm{A\,m^{-2}}$ | length three; exclusive with `current_source` | inline CPP current | legacy FDM/FEM lanes; canonical lane gated | `spin_torque_modules[].current_density` |
| `SlonczewskiSTT.current_source` | `str or None` | `None` | $1$ | non-empty; exclusive with density | named `CurrentTransport` source | planner-resolved prescribed source | `spin_torque_modules[].current_source` |
| `SlonczewskiSTT.spin_polarization` | `Sequence[float]` | `(0,0,1)` | $1$ | finite vector; canonical path normalizes | fixed-layer polarization | FDM/FEM legacy and canonical intent | `spin_torque_modules[].spin_polarization` |
| `SlonczewskiSTT.degree` | `float` | `0.4` | $1$ | $0<P\leq1$ | $P$ | all lanes at validation level | `spin_torque_modules[].degree` |
| `SlonczewskiSTT.lambda_asymmetry` | `float` | `1.0` | $1$ | $\Lambda\geq1$ | $\Lambda$ | all lanes at validation level | `spin_torque_modules[].lambda_asymmetry` |
| `SlonczewskiSTT.epsilon_prime` | `float` | `0.0` | $1$ | finite | independent field-like CPP coefficient | all lanes at validation level | `spin_torque_modules[].epsilon_prime` |
| `SlonczewskiSTT.free_layer_thickness_m` | `float or None` | `None` | $\mathrm m$ | positive when supplied; required by canonical thin-layer | $t_F$ | legacy FDM/FEM; canonical gated | `spin_torque_modules[].free_layer_thickness_m` |
| `SlonczewskiSTT.fixed_layer_position` | `str or None` | `top` | $1$ | `top` or `bottom`; legacy only | migration sign convention | legacy compatibility | `spin_torque_modules[].fixed_layer_position` |
| `SlonczewskiSTT.id` | `str or None` | `None` | $1$ | required with canonical target/orientation | stable module identity | canonical intent | `spin_torque_modules[].id` |
| `SlonczewskiSTT.target` | `RegionRef or None` | `None` | $1$ | required by canonical form | magnetic target region | canonical intent | `spin_torque_modules[].target` |
| `SlonczewskiSTT.stack_normal` | `Sequence[float] or None` | `None` | $1$ | non-zero unit axis; canonical only | fixed-to-free orientation | canonical intent | `spin_torque_modules[].stack_normal` |
| `SlonczewskiSTT.interface_id` | `str or None` | `None` | $1$ | mutually exclusive with thin-layer thickness | interface-flux realization key | canonical intent | `spin_torque_modules[].realization.interface_id` |
| `ZhangLiSTT.current_density` | `Sequence[float] or None` | `None` | $\mathrm{A\,m^{-2}}$ | length three; exclusive with source | signed CIP current | legacy FDM/FEM lanes; canonical gated | `spin_torque_modules[].current_density` |
| `ZhangLiSTT.current_source` | `str or None` | `None` | $1$ | non-empty; exclusive with density | named CIP source | planner-resolved prescribed source | `spin_torque_modules[].current_source` |
| `ZhangLiSTT.degree` | `float` | `0.4` | $1$ | $0<P\leq1$ | spin polarization | all lanes at validation level | `spin_torque_modules[].degree` |
| `ZhangLiSTT.beta` | `float` | `0.0` | $1$ | $\beta\geq0$ | non-adiabaticity | FDM/FEM legacy and canonical intent | `spin_torque_modules[].beta` |
| `ZhangLiSTT.xi` | `float or None` | `None` | $1$ | alias; conflicting non-zero `beta` rejected | compatibility spelling of $\beta$ | Python normalization only | `spin_torque_modules[].beta` |
| `ZhangLiSTT.id` | `str or None` | `None` | $1$ | required by canonical form | stable module identity | canonical intent | `spin_torque_modules[].id` |
| `ZhangLiSTT.target` | `RegionRef or None` | `None` | $1$ | required by canonical form | magnetic target | canonical intent | `spin_torque_modules[].target` |
| `ZhangLiSTT.lande_g` | `float or None` | `None` | $1$ | positive; canonical only | effective Landé factor $g$ | canonical intent | `spin_torque_modules[].lande_g` |
| `InterfaceCppSTT.interface_normal` | `Sequence[float]` | `(0,0,1)` | $1$ | length three; finite | interface orientation | semantic-only | `spin_torque_modules[].interface_normal` |
| `DriftDiffusionSpinTorque.solve_id` | `str` | required | $1$ | non-empty | solved spin-transport reference | semantic/reference boundary | `spin_torque_modules[].solve_id` |
| `DriftDiffusionSpinTorque.target` | `RegionRef` | required | $1$ | valid region reference | torque target | semantic/reference boundary | `spin_torque_modules[].target` |

Other `InterfaceCppSTT` fields retain the same `current_*`, `spin_polarization`, `degree`,
`lambda_asymmetry`, and `epsilon_prime` meanings above. `DriftDiffusionSpinTorque` is the
canonical two-field reference object exported from `fullmag.model.spin_transport`; its full
transport parameters are documented on the SHE page.

(stt-problem-ir)=
## Python-to-`ProblemIR` representation

Legacy Zhang–Li lowering preserves the executable compatibility identity:

```json
{
  "kind": "zhang_li",
  "formula_version": "zhang_li.legacy_fullmag.v0",
  "current_density": [500000000000.0, 0.0, 0.0],
  "degree": 0.4,
  "beta": 0.02
}
```

Canonical Slonczewski lowering adds `schema_version`, `id`, `target`, `stack_normal`, and one
of `thin_layer_homogenized` or `interface_flux` realizations. `xi` is normalized to `beta`;
it is never serialized as an independent physical coefficient. The current source remains a
separate `current_modules[]` record.

(stt-round-trip-and-failure-semantics)=
## Round-trip, planning, and failure semantics

Requested intent contains the authored class, formula version, source binding, orientation,
target, and every SI parameter. Resolved execution adds solver/device lane, precision,
resolved current, mesh-gradient/operator version, and runtime provenance. Export must preserve
legacy versus canonical identity and must not replace interface or drift-diffusion intent with
bulk torque.

Validation errors cover both/neither current binding, malformed vectors, invalid $P/\Lambda/\beta$,
non-positive thickness, conflicting `beta`/`xi`, incomplete canonical identity, and conflicting
thin-layer/interface-flux parameters. Unsupported combinations include multiple executable
modules where the planner permits one, semantic-only interface/drift-diffusion modules in an
executable STT lane, and unresolved current sources. These are fail-closed errors, not CPU
fallbacks.

(stt-discrete-realization)=
## Discrete realization by solver and device

### FDM CPU

The reference path computes per-active-cell direct torque. Zhang–Li uses signed one-sided
differences in each current component and the configured periodic boundary policy. Slonczewski
uses the angular efficiency, current sign, polarization cross products, and thickness. AoS and
persistent SoA functions are separate zero-allocation realizations of the same legacy formula.

### FDM GPU

The fused CUDA RK RHS carries the direct-torque parameters through stage evaluation. FP64 and
FP32 are distinct precision realizations; a source declaration is not an executed-device parity
result.

### FEM CPU

The native MFEM path imports a resolved STT plan. Slonczewski is node-local; Zhang–Li evaluates
P1 tetrahedral gradients and accumulates node-weighted direct RHS contributions. This is not the
Rust reference-engine path.

### FEM GPU

The native CUDA dispatcher `gpu_rk_add_direct_torques` invokes dedicated Slonczewski and
Zhang–Li kernels. Geometry, thickness, mask, stage time, and device identity are part of the
qualification contract.

(stt-implementation-mapping)=
## Implementation mapping

| Layer | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SlonczewskiSTT` | legacy and canonical CPP validation/lowering | Python |
| Python | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class ZhangLiSTT` | CIP validation, `xi` alias, lowering | Python |
| IR/planner | `crates/fullmag-ir/src/validation.rs` | `validate_spin_torque_modules` | binding and domain validation | IR |
| planner | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_legacy_spin_torque` | source resolution and lane policy | planner |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_stt_torque` | CPP direct torque | FDM CPU |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_stt_torque` | CIP direct torque | FDM CPU |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_slonczewski_scales` | formula-versioned Gilbert coefficients | FDM CPU |
| FDM CPU | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_zhang_li_scales` | Gilbert coefficients | FDM CPU |
| FEM CPU | `backends/fem/cpu/mfem/interactions/stt.cpp` | `initialize_stt_plan_fields` | native plan import | FEM CPU |
| FEM CPU | `backends/fem/cpu/mfem/interactions/stt_slonczewski.cpp` | `add_slonczewski_stt_rhs_aos` | nodewise CPP RHS | FEM CPU |
| FEM CPU | `backends/fem/cpu/mfem/interactions/stt_zhang_li.cpp` | `tetrahedron_gradients` | P1 gradient geometry | FEM CPU |
| FEM GPU | `backends/fem/gpu/cuda/integrators/rk/rk_direct_torques.cu` | `gpu_rk_add_direct_torques` | direct-torque dispatch | FEM GPU |
| FEM GPU | `backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu` | `fullmag_cuda_add_slonczewski_stt_rhs` | CPP CUDA kernel | FEM GPU |
| FEM GPU | `backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu` | `fullmag_cuda_add_zhang_li_stt_rhs` | CIP CUDA kernel | FEM GPU |

(stt-validation)=
## Validation status

Python/IR tests cover canonical tags, source binding, alias normalization, and failure cases.
Native CPU tests cover the legacy sign/magnitude and Gilbert projections. Native CUDA/FEM
contracts cover source and dispatch boundaries. No current page claim should be read as a
validated workload until a managed run records device identity, stage-time data, and the
same-parameter CPU/GPU comparison.

(stt-limitations)=
## Limitations

- Canonical v1/v2 formula lanes are not promoted by legacy execution evidence.
- Only the planner-supported single-module executable subset may run in one legacy request.
- Interface-local CPP and solved spin-transport torque require their dedicated contracts.
- STT does not solve charge transport, spin accumulation, spin-memory loss, or inverse SHE.
- `SpinOrbitTorque` is prescribed SOT, not SHE drift-diffusion.

(stt-scientific-bibliography)=
## Scientific bibliography

1. J. C. Slonczewski, “Current-driven excitation of magnetic multilayers,” *Journal of
   Magnetism and Magnetic Materials* **159**, L1 (1996),
   [doi:10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).
2. S. Zhang and Z. Li, “Roles of nonequilibrium conduction electrons on the magnetization
   dynamics of ferromagnets,” *Physical Review Letters* **93**, 127204 (2004),
   [doi:10.1103/PhysRevLett.93.127204](https://doi.org/10.1103/PhysRevLett.93.127204).
3. Fullmag normative owner: `docs/physics/0960-spin-torque-sign-units-and-prescribed-sot.md`.

(stt-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Lane |
|---|---|---|---|
| CPP constructor and lowering | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SlonczewskiSTT` | Python |
| CIP constructor and lowering | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class ZhangLiSTT` | Python |
| planner validation | `crates/fullmag-ir/src/validation.rs` | `validate_spin_torque_modules` | IR |
| planner resolution | `crates/fullmag-plan/src/spin_torque.rs` | `resolve_legacy_spin_torque` | planner |
| CPP formula | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `slonczewski_stt_torque` | FDM CPU |
| CIP formula | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_stt_torque` | FDM CPU |
| CPP Gilbert factors | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_slonczewski_scales` | FDM CPU |
| CIP Gilbert factors | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `gilbert_zhang_li_scales` | FDM CPU |
| FEM plan import | `backends/fem/cpu/mfem/interactions/stt.cpp` | `initialize_stt_plan_fields` | FEM CPU |
| FEM CPP | `backends/fem/cpu/mfem/interactions/stt_slonczewski.cpp` | `add_slonczewski_stt_rhs_aos` | FEM CPU |
| FEM CIP geometry | `backends/fem/cpu/mfem/interactions/stt_zhang_li.cpp` | `tetrahedron_gradients` | FEM CPU |
| FEM GPU dispatcher | `backends/fem/gpu/cuda/integrators/rk/rk_direct_torques.cu` | `gpu_rk_add_direct_torques` | FEM GPU |
| FEM GPU CPP | `backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu` | `fullmag_cuda_add_slonczewski_stt_rhs` | FEM GPU |
| FEM GPU CIP | `backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu` | `fullmag_cuda_add_zhang_li_stt_rhs` | FEM GPU |
