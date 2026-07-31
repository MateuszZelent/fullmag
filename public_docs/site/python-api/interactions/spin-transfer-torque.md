---
title: Spin-Transfer Torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0820-shared-spin-torque-family-and-stno-artifact-workflow.md
---

(stt-api-problem-statement)=
# Spin-Transfer Torque Python API

This page is the canonical Python authoring reference for the spin-transfer torque family. It
documents the constructors, SI parameters, canonical ProblemIR lowering, planner legality, and
backend realization boundaries. It does not redefine spin-orbit torque or self-consistent spin
transport as executable STT.

The family contains four STT classes:

1. SlonczewskiSTT for current-perpendicular-to-plane (CPP) torque.
2. ZhangLiSTT for current-in-plane (CIP) torque.
3. InterfaceCppSTT for interface-local CPP semantics, currently semantic-only.
4. DriftDiffusionSpinTorque for self-consistent spin-accumulation semantics, currently semantic-only.

SpinOrbitTorque is a separate interaction and has its own Python API page.

(stt-api-governing-equations)=
## Governing equations exposed by the API

STT is a direct torque contribution to the LLG right-hand side, not an energy term:

```{math}
:label: eq-stt-api-llg
\frac{\partial\mathbf m}{\partial t}
=
-\gamma_{\mu_0}\,\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times\frac{\partial\mathbf m}{\partial t}
+\boldsymbol{\tau}_{\mathrm{STT}}.
```

For SlonczewskiSTT, let J be the magnitude of the current-density vector, s_J the sign resolved
from current direction and fixed_layer_position, and q the polarization projection:

```{math}
:label: eq-stt-api-slonczewski-prefactor
\sigma_0
=
s_J\,
\frac{\hbar\,J\,\gamma_{\mu_0}}
{2e\mu_0M_s d},
\qquad
g(q)
=
\frac{P\Lambda^2}
{\Lambda^2+1+(\Lambda^2-1)q},
\qquad
q=\mathbf m\cdot\hat{\mathbf p}.
```

The direct CPP torque is:

```{math}
:label: eq-stt-api-slonczewski
\boldsymbol{\tau}_{\mathrm{Slonc}}
=
\frac{\sigma_0g(q)}{1+\alpha^2}
\left[
(1+\alpha\varepsilon')\,
\mathbf m\times(\mathbf m\times\hat{\mathbf p})
+(\varepsilon'-\alpha)\,
\mathbf m\times\hat{\mathbf p}
\right].
```

For ZhangLiSTT, the drift velocity and advective derivative are:

```{math}
:label: eq-stt-api-zhang-li-velocity
\mathbf u
=
\frac{P\mu_B}{eM_s(1+\beta^2)}\,\mathbf J,
\qquad
\mathbf v=(\mathbf u\cdot\nabla)\mathbf m,
\qquad
\mathbf v_\perp
=
-\mathbf m\times(\mathbf m\times\mathbf v).
```

The direct CIP torque is:

```{math}
:label: eq-stt-api-zhang-li
\boldsymbol{\tau}_{\mathrm{ZL}}
=
\frac{1}{1+\alpha^2}
\left[
(1+\alpha\beta)\mathbf v_\perp
+(\alpha-\beta)\mathbf m\times\mathbf v
\right].
```

The plus sign in the second term is the same as
-(beta-alpha) m cross v. It matches the scale used by the current FDM CPU and GPU
implementations. Neither torque contributes an E_stt energy scalar.

InterfaceCppSTT and DriftDiffusionSpinTorque have a canonical IR shape, but no executable
field equation is claimed for them. Their constructors preserve requested intent so that a
future planner can reject or qualify the model instead of silently replacing it with bulk torque.

(stt-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol{\tau}_{\mathrm{STT}}$ | direct STT contribution to the magnetization derivative | $\mathrm{s^{-1}}$ |
| $\boldsymbol{\tau}_{\mathrm{Slonc}}$ | Slonczewski CPP torque | $\mathrm{s^{-1}}$ |
| $\boldsymbol{\tau}_{\mathrm{ZL}}$ | Zhang-Li CIP torque | $\mathrm{s^{-1}}$ |
| $\mathbf J$ | charge-current density vector | $\mathrm{A\,m^{-2}}$ |
| $J$ | current-density magnitude | $\mathrm{A\,m^{-2}}$ |
| $s_J$ | current-sign factor | $1$ |
| $P$ | spin-polarization degree | $1$ |
| $\Lambda$ | Slonczewski asymmetry parameter | $1$ |
| $\varepsilon'$ | secondary field-like CPP coefficient | $1$ |
| $\beta$ | Zhang-Li non-adiabaticity parameter | $1$ |
| $\hat{\mathbf p}$ | fixed-layer polarization direction | $1$ |
| $\mathbf u$ | Zhang-Li drift velocity | $\mathrm{m\,s^{-1}}$ |
| $\mathbf v$ | advective magnetization derivative | $\mathrm{s^{-1}}$ |
| $\mathbf v_\perp$ | tangent-plane projection of $\mathbf v$ | $\mathrm{s^{-1}}$ |
| $\mu_B$ | Bohr magneton | $\mathrm{J\,T^{-1}}$ |
| $\gamma_{\mu_0}$ | reduced gyromagnetic constant used by LLG | $\mathrm{m\,(A\,s)^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $d$ | free-layer thickness in the CPP prefactor | $\mathrm{m}$ |
| $\sigma_0$ | signed CPP prefactor before angular efficiency | $\mathrm{s^{-1}}$ |
| $g(q)$ | angular Slonczewski efficiency | $1$ |
| $q$ | polarization projection | $1$ |
| $\hbar$ | reduced Planck constant | $\mathrm{J\,s}$ |
| $e$ | elementary charge magnitude | $\mathrm{C}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\ell_{\mathrm{sf}}$ | semantic spin-diffusion length | $\mathrm{m}$ |
| $\mathbf n_I$ | interface normal | $1$ |

(stt-api-assumptions-and-validity)=
## Assumptions and validity limits

- All values are authored in SI units. The constructors do not convert from nanometres or CGS.
- The reduced magnetization is expected to satisfy norm one.
- Each source-bindable torque must receive exactly one binding: current_density or current_source.
- SlonczewskiSTT uses CPP current magnitude, polarization direction, asymmetry, field-like
  coefficient, thickness, and stack-position sign.
- ZhangLiSTT uses vector current density and a drift derivative. xi is an alias for beta;
  conflicting nonzero values are rejected.
- InterfaceCppSTT and DriftDiffusionSpinTorque are serializable semantic requests, not
  executable native solver terms in the current planner.
- CurrentTransport with prescribed_density is the executable named-source model. ohmic_poisson
  remains semantic-only in the current public planner.
- STT is non-conservative. Lowering does not create an E_stt energy observable or make
  conservative relaxation legal.
- Native qualification is lane-specific. A Python object or compiled kernel is not parity proof.

(stt-api-python-api)=
## Complete Python API reference

### SlonczewskiSTT

```python
# %% Slonczewski source-bound problem
import json
import fullmag as fm

nm = 1.0e-9
material = fm.Material(
    name="CoFeB",
    Ms=1.2e6,
    A=15.0e-12,
    alpha=0.01,
)
magnet = fm.Ferromagnet(
    name="free_layer",
    geometry=fm.Box(size=(100 * nm, 100 * nm, 2 * nm), name="free_layer"),
    material=material,
    m0=fm.texture.uniform((1.0, 0.0, 0.0)),
)
drive = fm.CurrentTransport(
    name="cpp_drive",
    model="prescribed_density",
    current_density=(0.0, 0.0, 1.0e10),
    solve_region="free_layer",
)
problem = fm.Problem(
    name="stt_api_slonczewski",
    magnets=[magnet],
    energy=[fm.Exchange(), fm.Demag()],
    spin_torques=[
        fm.SlonczewskiSTT(
            current_source="cpp_drive",
            spin_polarization=(1.0, 0.0, 0.0),
            degree=0.4,
            lambda_asymmetry=1.0,
            epsilon_prime=0.0,
            free_layer_thickness_m=2.0 * nm,
            fixed_layer_position="top",
        ),
    ],
    current_modules=[drive],
    study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
)
problem_ir = problem.to_ir(include_geometry_assets=False)
assert problem_ir["spin_torque_modules"] == [{
    "kind": "slonczewski",
    "current_source": "cpp_drive",
    "spin_polarization": [1.0, 0.0, 0.0],
    "degree": 0.4,
    "lambda_asymmetry": 1.0,
    "epsilon_prime": 0.0,
    "free_layer_thickness_m": 2.0 * nm,
    "fixed_layer_position": "top",
}]
assert problem_ir["current_modules"][0]["model"] == "prescribed_density"
assert problem_ir["current_modules"][0]["current_density"] == [0.0, 0.0, 1.0e10]
print(json.dumps(problem_ir, indent=2))
```

### ZhangLiSTT

```python
# %% Zhang-Li direct-density object
import fullmag as fm

term = fm.ZhangLiSTT(
    current_density=(5.0e11, 0.0, 0.0),
    degree=0.4,
    beta=0.02,
)
assert term.to_ir_module() == {
    "kind": "zhang_li",
    "current_density": [5.0e11, 0.0, 0.0],
    "degree": 0.4,
    "beta": 0.02,
}
assert term.to_ir_fields() == {
    "current_density": [5.0e11, 0.0, 0.0],
    "stt_degree": 0.4,
    "stt_beta": 0.02,
}
print(term.to_ir_module())
```

### Semantic-only variants

The following objects intentionally lower to canonical IR even though the current planner
rejects them as semantic-only:

```python
# %% Semantic STT variants
import fullmag as fm

interface_term = fm.InterfaceCppSTT(
    current_density=(0.0, 0.0, 1.0e10),
    spin_polarization=(0.0, 0.0, 1.0),
    interface_normal=(0.0, 0.0, 1.0),
    degree=0.4,
    lambda_asymmetry=1.0,
    epsilon_prime=0.0,
)
drift_term = fm.DriftDiffusionSpinTorque(
    current_source="cpp_drive",
    spin_polarization=(0.0, 0.0, 1.0),
    degree=0.4,
    beta=0.02,
    spin_diffusion_length_m=5.0e-9,
)
assert interface_term.to_ir_module()["kind"] == "interface_cpp"
assert drift_term.to_ir_module()["kind"] == "drift_diffusion"
print(interface_term.to_ir_module())
print(drift_term.to_ir_module())
```

STT constructors do not accept a time-envelope parameter. TimeEvolution controls the
integration timeline, while the executable source is resolved as a prescribed static density.
STT is not a magnetic energy term, so SaveScalar("E_stt", every=period) is not a valid output.
The API does not invent a new energy quantity.

(stt-api-parameter-reference)=
### Exhaustive parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| SlonczewskiSTT.current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | exactly three values when supplied; mutually exclusive with current_source | inline CPP charge-current density | FDM CPU/GPU and native FEM lanes subject to qualification | spin_torque_modules[].current_density |
| SlonczewskiSTT.current_source | str or None | None | $1$ | non-empty and must name CurrentTransport; mutually exclusive with current_density | named CPP current source | FDM CPU/GPU and native FEM lanes for prescribed density | spin_torque_modules[].current_source |
| SlonczewskiSTT.spin_polarization | Sequence[float] | (0, 0, 1) | $1$ | exactly three values; finite values required by IR | fixed-layer polarization direction | FDM CPU/GPU and native FEM STT paths | spin_torque_modules[].spin_polarization |
| SlonczewskiSTT.degree | float | 0.4 | $1$ | strictly in (0,1] | polarization efficiency P | FDM CPU/GPU and native FEM STT paths | spin_torque_modules[].degree |
| SlonczewskiSTT.lambda_asymmetry | float | 1.0 | $1$ | greater than or equal to 1 | angular asymmetry Lambda | FDM CPU/GPU and native FEM STT paths | spin_torque_modules[].lambda_asymmetry |
| SlonczewskiSTT.epsilon_prime | float | 0.0 | $1$ | finite in native plan | secondary field-like CPP coefficient | FDM CPU/GPU and native FEM STT paths | spin_torque_modules[].epsilon_prime |
| SlonczewskiSTT.free_layer_thickness_m | float or None | None | $\mathrm{m}$ | positive when supplied | free-layer thickness d | FDM CPU/GPU and FEM native path | spin_torque_modules[].free_layer_thickness_m |
| SlonczewskiSTT.fixed_layer_position | str | top | $1$ | exactly top or bottom after normalization | stack orientation and current sign | FDM CPU/GPU and native FEM STT paths | spin_torque_modules[].fixed_layer_position |
| ZhangLiSTT.current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | exactly three values when supplied; mutually exclusive with current_source | inline CIP charge-current density | FDM CPU/GPU and native FEM lanes subject to qualification | spin_torque_modules[].current_density |
| ZhangLiSTT.current_source | str or None | None | $1$ | non-empty and must name CurrentTransport; mutually exclusive with current_density | named CIP current source | FDM CPU/GPU and native FEM lanes for prescribed density | spin_torque_modules[].current_source |
| ZhangLiSTT.degree | float | 0.4 | $1$ | strictly in (0,1] | polarization efficiency P | FDM CPU/GPU and native FEM STT paths | spin_torque_modules[].degree |
| ZhangLiSTT.beta | float | 0.0 | $1$ | greater than or equal to 0 | non-adiabaticity beta | FDM CPU/GPU and native FEM STT paths | spin_torque_modules[].beta |
| ZhangLiSTT.xi | float or None | None | $1$ | alias for beta; conflicting nonzero values rejected | compatibility spelling of beta | Python normalization only; resolved lanes use beta | spin_torque_modules[].beta |
| InterfaceCppSTT.current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | exactly three values when supplied; mutually exclusive with current_source | requested interface-local CPP current | semantic-only on current planner lanes | spin_torque_modules[].current_density |
| InterfaceCppSTT.current_source | str or None | None | $1$ | non-empty and must name CurrentTransport | requested interface-local current source | semantic-only on current planner lanes | spin_torque_modules[].current_source |
| InterfaceCppSTT.spin_polarization | Sequence[float] | (0, 0, 1) | $1$ | exactly three values; finite values required by IR | interface-local polarization direction | semantic-only on current planner lanes | spin_torque_modules[].spin_polarization |
| InterfaceCppSTT.interface_normal | Sequence[float] | (0, 0, 1) | $1$ | exactly three values; finite values required by IR | interface normal n_I | semantic-only on current planner lanes | spin_torque_modules[].interface_normal |
| InterfaceCppSTT.degree | float | 0.4 | $1$ | strictly in (0,1] | interface polarization efficiency | semantic-only on current planner lanes | spin_torque_modules[].degree |
| InterfaceCppSTT.lambda_asymmetry | float | 1.0 | $1$ | greater than or equal to 1 | interface angular asymmetry | semantic-only on current planner lanes | spin_torque_modules[].lambda_asymmetry |
| InterfaceCppSTT.epsilon_prime | float | 0.0 | $1$ | finite in native plan | interface field-like coefficient | semantic-only on current planner lanes | spin_torque_modules[].epsilon_prime |
| DriftDiffusionSpinTorque.current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | exactly three values when supplied; mutually exclusive with current_source | requested source current | semantic-only on current planner lanes | spin_torque_modules[].current_density |
| DriftDiffusionSpinTorque.current_source | str or None | None | $1$ | non-empty and must name CurrentTransport | named drift-diffusion source | semantic-only on current planner lanes | spin_torque_modules[].current_source |
| DriftDiffusionSpinTorque.spin_polarization | Sequence[float] | (0, 0, 1) | $1$ | exactly three values; finite values required by IR | spin-injection polarization | semantic-only on current planner lanes | spin_torque_modules[].spin_polarization |
| DriftDiffusionSpinTorque.degree | float | 0.4 | $1$ | strictly in (0,1] | spin-injection efficiency | semantic-only on current planner lanes | spin_torque_modules[].degree |
| DriftDiffusionSpinTorque.beta | float | 0.0 | $1$ | greater than or equal to 0 | non-adiabaticity parameter | semantic-only on current planner lanes | spin_torque_modules[].beta |
| DriftDiffusionSpinTorque.spin_diffusion_length_m | float | 5e-9 | $\mathrm{m}$ | strictly positive | spin-diffusion length ell_sf | semantic-only on current planner lanes | spin_torque_modules[].spin_diffusion_length_m |
| CurrentTransport.name | str | required | $1$ | non-empty and unique among current modules | source reference key | FDM/FEM planner source resolution | current_modules[].name |
| CurrentTransport.model | str | prescribed_density | $1$ | exactly prescribed_density or ohmic_poisson | current transport model | prescribed density executable; Ohmic-Poisson semantic-only | current_modules[].model |
| CurrentTransport.current_density | Sequence[float] or None | None | $\mathrm{A\,m^{-2}}$ | required for prescribed density; forbidden for Ohmic-Poisson; exactly three values | prescribed current vector | FDM/FEM source-bound paths for prescribed density | current_modules[].current_density |
| CurrentTransport.solve_region | str or None | None | $1$ | non-empty when supplied; required by some source-bound planners | source region identifier | lane-dependent source resolution | current_modules[].solve_region |
| CurrentTransport.conductivity_s_per_m | float or None | None | $\mathrm{S\,m^{-1}}$ | positive when supplied | conductivity metadata for future transport solve | serialized metadata; not Ohmic execution proof | current_modules[].conductivity_s_per_m |

(stt-api-problem-ir)=
## Canonical ProblemIR lowering

The canonical module is stored under spin_torque_modules. A legacy single-module spin_torque
authoring path may additionally emit flattened runner fields, but those fields are an execution
bridge and are not a second physical source of truth.

The source-bound example lowers to:

```json
{
  "spin_torque_modules": [
    {
      "kind": "slonczewski",
      "current_source": "cpp_drive",
      "spin_polarization": [1.0, 0.0, 0.0],
      "degree": 0.4,
      "lambda_asymmetry": 1.0,
      "epsilon_prime": 0.0,
      "free_layer_thickness_m": 2.0e-9,
      "fixed_layer_position": "top"
    }
  ],
  "current_modules": [
    {
      "kind": "current_transport",
      "name": "cpp_drive",
      "model": "prescribed_density",
      "current_density": [0.0, 0.0, 1.0e10],
      "solve_region": "free_layer"
    }
  ]
}
```

A direct Zhang-Li object lowers to:

```json
{
  "kind": "zhang_li",
  "current_density": [5.0e11, 0.0, 0.0],
  "degree": 0.4,
  "beta": 0.02
}
```

A semantic interface object lowers to the same canonical variant identity but has no executable
native realization:

```json
{
  "kind": "interface_cpp",
  "current_density": [0.0, 0.0, 1.0e10],
  "spin_polarization": [0.0, 0.0, 1.0],
  "interface_normal": [0.0, 0.0, 1.0],
  "degree": 0.4,
  "lambda_asymmetry": 1.0,
  "epsilon_prime": 0.0
}
```

| Python authoring value | Canonical IR destination | Normalization and consequence |
|---|---|---|
| SlonczewskiSTT | spin_torque_modules[].kind | lowers to slonczewski and preserves CPP parameters |
| ZhangLiSTT | spin_torque_modules[].kind | lowers to zhang_li and stores resolved beta; xi is not retained |
| InterfaceCppSTT | spin_torque_modules[].kind | lowers to interface_cpp and remains semantic-only |
| DriftDiffusionSpinTorque | spin_torque_modules[].kind | lowers to drift_diffusion and remains semantic-only |
| current_density | spin_torque_modules[].current_density | normalizes a three-component tuple to a JSON array |
| current_source | spin_torque_modules[].current_source | preserves a named reference; source data remains in current_modules |
| CurrentTransport | current_modules[] | creates a separate source record |
| spin_torques=[module_list] | spin_torque_modules[] | preserves module order; planner supports one executable module |
| legacy spin_torque=term | legacy flat fields and canonical module | compatibility bridge; cannot represent multiple modules |

(stt-api-round-trip-and-failure-semantics)=
## Round-trip, planning, and failure semantics

Requested intent is the Python class, SI parameters, current binding, current-transport record,
and authored study. Resolved execution records solver/device, precision, current source, legacy
bridge fields, direct-RHS implementation, mesh-gradient policy, and qualification evidence.
Export must preserve semantic-only variants instead of replacing them with executable bulk torque.

Validation errors occur before native execution:

| Stage | Failure | Required behavior |
|---|---|---|
| Python constructor | both or neither current binding, malformed vector, invalid degree, asymmetry, beta, thickness, or position | raise deterministic TypeError or ValueError |
| Python alias normalization | conflicting nonzero beta and xi | reject instead of choosing one |
| Problem construction | missing source or duplicate current-module name | reject the inconsistent object graph |
| ProblemIR validation | non-finite vectors, invalid domains, or invalid source reference | fail in validate_spin_torque_modules |
| Planner | multiple modules, interface_cpp, drift_diffusion, Ohmic-Poisson source, or unsupported lane | return explicit capability error |
| Runtime | missing direct torque, failed device launch, or mismatched resolved lane | fail the run and preserve provenance |

Unsupported combinations are not silently converted into a CPU fallback. A to_ir_module success
proves representability only; it does not prove FDM, FEM, CPU, or GPU execution is legal. The
current planner resolves prescribed-density sources and rejects ohmic_poisson as semantic-only.

(stt-api-discrete-realization)=
## Discrete realization and backend matrix

The four solver/device lanes share Python and IR but not the numerical path.

### FDM CPU

The CPU reference evaluates direct torques per active cell. The Zhang-Li functions compute a
sign-directed one-sided difference for each nonzero component of u and apply explicit Gilbert
factors. The Slonczewski functions evaluate angular efficiency, polarization cross products,
current sign, and CPP thickness. Allocating AoS and persistent SoA paths are separate
implementations with the same intended physics.

### FDM GPU

The CUDA fused RK kernel applies Zhang-Li and Slonczewski contributions at stage time. FP64 and
FP32 kernels carry the same named parameters with different precision. Active masks and boundary
policies are native GPU behavior; CPU tests do not prove executed-device parity. The public
multilayer FDM planner has an explicit STT rejection boundary.

### FEM CPU

The native FEM CPU path imports the resolved plan, prepares Zhang-Li workspace, and dispatches
the Slonczewski or Zhang-Li direct RHS. Zhang-Li uses tetrahedral P1 gradients and node-weight
accumulation; Slonczewski uses nodewise torque with resolved thickness and normalized
polarization. This native path is distinct from the Rust reference engine.

### FEM GPU

The native FEM CUDA path dispatches direct-torque stages through gpu_rk_add_direct_torques,
which calls dedicated Slonczewski and Zhang-Li kernels. The GPU path consumes mesh geometry
for the Zhang-Li gradient and requires explicit or resolved thickness for Slonczewski.
Device identity, stage-time execution, and field parity remain qualification gates.

| Solver | CPU | GPU |
|---|---|---|
| FDM | direct cell torque; FP64 reference AoS and SoA paths | fused CUDA FP64 and FP32 stage RHS; multilayer public path has an explicit planner boundary |
| FEM | native MFEM direct-RHS realization, separate from Rust reference engine | native CUDA direct-torque kernels with geometry and thickness gates |

(stt-api-implementation-mapping)=
## Implementation mapping

The documentation uses repository path plus stable symbol rather than line numbers. This remains
valid when implementation files grow or functions move.

| API or claim | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Slonczewski constructor and IR | packages/fullmag-py/src/fullmag/model/spin_torque.py | class SlonczewskiSTT | validates CPP parameters and lowers canonical module |
| Zhang-Li constructor and IR | packages/fullmag-py/src/fullmag/model/spin_torque.py | class ZhangLiSTT | validates CIP parameters and xi alias |
| interface semantic variant | packages/fullmag-py/src/fullmag/model/spin_torque.py | class InterfaceCppSTT | preserves interface-local intent |
| drift-diffusion semantic variant | packages/fullmag-py/src/fullmag/model/spin_torque.py | class DriftDiffusionSpinTorque | preserves spin-diffusion intent |
| current source constructor | packages/fullmag-py/src/fullmag/model/current_transport.py | class CurrentTransport | validates source model and lowers current IR |
| ProblemIR validation | crates/fullmag-ir/src/validation.rs | validate_spin_torque_modules | validates bindings and parameter domains |
| planner STT resolution | crates/fullmag-plan/src/spin_torque.rs | resolve_legacy_spin_torque | resolves one executable STT module |
| planner SOT separation | crates/fullmag-plan/src/spin_torque.rs | resolve_sot_fields | keeps SOT outside STT bridge |
| FDM CPU Zhang-Li AoS | crates/fullmag-engine/src/fdm/cpu/fields.rs | zhang_li_stt_torque_add_into | direct CIP torque |
| FDM CPU Zhang-Li SoA | crates/fullmag-engine/src/fdm/cpu/fields.rs | zhang_li_stt_torque_add_into_soa | persistent direct CIP torque |
| FDM CPU Slonczewski AoS | crates/fullmag-engine/src/fdm/cpu/fields.rs | slonczewski_stt_torque_add_into | direct CPP torque |
| FDM CPU Slonczewski SoA | crates/fullmag-engine/src/fdm/cpu/fields.rs | slonczewski_stt_torque_add_into_soa | persistent direct CPP torque |
| FDM CPU Gilbert factors | crates/fullmag-engine/src/fdm/cpu/fields.rs | gilbert_slonczewski_scales | CPP Gilbert conversion |
| FDM CPU Gilbert factors | crates/fullmag-engine/src/fdm/cpu/fields.rs | gilbert_zhang_li_scales | CIP Gilbert conversion |
| FDM GPU fused RHS | backends/fdm/gpu/cuda/integrators/llg_fp64.cu | llg_rhs_fp64_kernel | direct torque in FP64 stage RHS |
| FEM CPU plan import | backends/fem/cpu/mfem/interactions/stt.cpp | initialize_stt_plan_fields | imports and validates native plan |
| FEM CPU Slonczewski | backends/fem/cpu/mfem/interactions/stt_slonczewski.cpp | add_slonczewski_stt_rhs_aos | nodewise CPP torque |
| FEM CPU Zhang-Li geometry | backends/fem/cpu/mfem/interactions/stt_zhang_li.cpp | tetrahedron_gradients | P1-gradient geometry used by the CIP torque |
| FEM GPU dispatcher | backends/fem/gpu/cuda/integrators/rk/rk_direct_torques.cu | gpu_rk_add_direct_torques | dispatches direct-torque kernels |
| FEM GPU Slonczewski | backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu | fullmag_cuda_add_slonczewski_stt_rhs | CUDA CPP kernel |
| FEM GPU Zhang-Li | backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu | fullmag_cuda_add_zhang_li_stt_rhs | CUDA CIP kernel |

(stt-api-validation)=
## Validation evidence and required checks

The contract is checked at different levels:

1. Python blocks are parsed and executed against the repository DSL. Assertions verify canonical
   module records, source records, compatibility fields, and semantic variants.
2. The adjacent source map verifies labelled equations, SI rows, exhaustive parameters, unique
   source declarations, backend matrix, and source-code index.
3. ProblemIR tests reject malformed bindings, invalid domains, semantic-only misuse, and
   legacy/canonical disagreement.
4. Planner tests verify single-module resolution, named-source density resolution, multiple-module
   rejection, and SOT separation.
5. Native FDM CPU tests cover direct torque formulas and Gilbert factors; native CUDA and FEM tests
   cover source contracts and kernel/planner boundaries. Device-capable tests do not alone prove an
   executed GPU run.
6. Managed runtime evidence must record device identity and compare CPU/GPU fields or observables
   under the same physical parameters before a lane is called qualified.

The status remains partial: Python/IR contracts and native mappings exist, while current-revision
executed-device parity and complete qualification evidence are not asserted here.

(stt-api-limitations)=
## Limitations

- STT is non-conservative and has no E_stt energy observable.
- Only one executable spin-torque module is supported by the current planner at a time.
- InterfaceCppSTT and DriftDiffusionSpinTorque are semantic-only.
- CurrentTransport with ohmic_poisson is representable but planner-rejected.
- The public multilayer FDM path has an explicit STT rejection boundary.
- CPU/GPU implementation presence is not executed-device qualification.
- SpinOrbitTorque is intentionally documented as a separate interaction.

(stt-api-scientific-bibliography)=
## Scientific bibliography

1. J. C. Slonczewski, “Current-driven excitation of magnetic multilayers,” Journal of Magnetism
   and Magnetic Materials 159, L1 (1996), [doi:10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).
2. S. Zhang and Z. Li, “Roles of nonequilibrium conduction electrons on the magnetization
   dynamics of ferromagnets,” Physical Review Letters 93, 127204 (2004),
   [doi:10.1103/PhysRevLett.93.127204](https://doi.org/10.1103/PhysRevLett.93.127204).
3. J. Xiao, A. Zangwill, and M. D. Stiles, “Boltzmann test of Slonczewski's theory of spin-transfer
   torque,” Physical Review B 70, 172405 (2004), [doi:10.1103/PhysRevB.70.172405](https://doi.org/10.1103/PhysRevB.70.172405).
4. Fullmag implementation owner: {doc}`../../physics/interactions/spin-transfer-torque/index`.
5. Fullmag physical note: docs/physics/0820-shared-spin-torque-family-and-stno-artifact-workflow.md.

(stt-api-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Lane | Evidence status |
|---|---|---|---|---|
| Slonczewski constructor and IR | packages/fullmag-py/src/fullmag/model/spin_torque.py | class SlonczewskiSTT | Python/IR | source mapped |
| Zhang-Li constructor and IR | packages/fullmag-py/src/fullmag/model/spin_torque.py | class ZhangLiSTT | Python/IR | source mapped |
| interface semantic variant | packages/fullmag-py/src/fullmag/model/spin_torque.py | class InterfaceCppSTT | Python/IR | source mapped |
| drift-diffusion semantic variant | packages/fullmag-py/src/fullmag/model/spin_torque.py | class DriftDiffusionSpinTorque | Python/IR | source mapped |
| current source constructor | packages/fullmag-py/src/fullmag/model/current_transport.py | class CurrentTransport | Python/IR | source mapped |
| ProblemIR validation | crates/fullmag-ir/src/validation.rs | validate_spin_torque_modules | IR | source mapped |
| planner STT resolution | crates/fullmag-plan/src/spin_torque.rs | resolve_legacy_spin_torque | planner | source mapped |
| planner SOT separation | crates/fullmag-plan/src/spin_torque.rs | resolve_sot_fields | planner | source mapped |
| FDM CPU Zhang-Li AoS | crates/fullmag-engine/src/fdm/cpu/fields.rs | zhang_li_stt_torque_add_into | FDM CPU | source mapped |
| FDM CPU Zhang-Li SoA | crates/fullmag-engine/src/fdm/cpu/fields.rs | zhang_li_stt_torque_add_into_soa | FDM CPU | source mapped |
| FDM CPU Slonczewski AoS | crates/fullmag-engine/src/fdm/cpu/fields.rs | slonczewski_stt_torque_add_into | FDM CPU | source mapped |
| FDM CPU Slonczewski SoA | crates/fullmag-engine/src/fdm/cpu/fields.rs | slonczewski_stt_torque_add_into_soa | FDM CPU | source mapped |
| FDM CPU Gilbert factors | crates/fullmag-engine/src/fdm/cpu/fields.rs | gilbert_slonczewski_scales | FDM CPU | source mapped |
| FDM CPU Gilbert factors | crates/fullmag-engine/src/fdm/cpu/fields.rs | gilbert_zhang_li_scales | FDM CPU | source mapped |
| FDM GPU fused RHS | backends/fdm/gpu/cuda/integrators/llg_fp64.cu | llg_rhs_fp64_kernel | FDM GPU | source mapped |
| FEM CPU plan import | backends/fem/cpu/mfem/interactions/stt.cpp | initialize_stt_plan_fields | FEM CPU | source mapped |
| FEM CPU Slonczewski | backends/fem/cpu/mfem/interactions/stt_slonczewski.cpp | add_slonczewski_stt_rhs_aos | FEM CPU | source mapped |
| FEM CPU Zhang-Li geometry | backends/fem/cpu/mfem/interactions/stt_zhang_li.cpp | tetrahedron_gradients | FEM CPU | source mapped |
| FEM GPU dispatcher | backends/fem/gpu/cuda/integrators/rk/rk_direct_torques.cu | gpu_rk_add_direct_torques | FEM GPU | source mapped |
| FEM GPU Slonczewski | backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu | fullmag_cuda_add_slonczewski_stt_rhs | FEM GPU | source mapped |
| FEM GPU Zhang-Li | backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu | fullmag_cuda_add_zhang_li_stt_rhs | FEM GPU | source mapped |
