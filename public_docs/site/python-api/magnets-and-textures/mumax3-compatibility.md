---
title: Mumax3 Texture Compatibility
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0531-versioned-magnetic-preset-textures.md
---

(public-docs-python-api-mumax3-texture-compatibility)=
# Mumax3 Texture Compatibility

(mumax3-problem-statement)=
## Physical problem

Fullmag exposes the analytic initial-magnetization configurations listed in the pinned Mumax3
submodule revision `f656494b29516bead825b444b1f0b38c6e6c7dbf`, subject to the explicit exceptions
below. The names refer to the public Python factories and the
version-2 canonical Rust sampler used by both FEM and FDM planning. The canonical
physics contract is `docs/physics/0531-versioned-magnetic-preset-textures.md`.

| Mumax3 configuration | Fullmag factory | Status |
|---|---|---|
| `Uniform` | `fm.texture.uniform(...)` | implemented |
| `RandomMag` | `fm.texture.random(...)` | deterministic seed required by the public Fullmag API |
| `RandomMagSeed` | `fm.texture.random_seeded(...)` | implemented |
| `Vortex` | `fm.texture.vortex(...)` | implemented with explicit physical core radius |
| `Antivortex` | `fm.texture.antivortex(...)` | implemented |
| `NeelSkyrmion` | `fm.texture.neel_skyrmion(...)` | implemented with explicit radius and wall width |
| `BlochSkyrmion` | `fm.texture.bloch_skyrmion(...)` | implemented with explicit radius and wall width |
| `TwoDomain` | `fm.texture.two_domain(...)` | implemented; sharp and smooth modes are available |
| `VortexWall` | `fm.texture.vortex_wall(...)` | implemented; wall half-width and core radius are explicit |
| `Helical` | `fm.texture.helical(...)` | implemented with SI wavevector |
| `Conical` | `fm.texture.conical(...)` | implemented with SI wavevector |
| `HopfionCompactSupport` | `fm.texture.hopfion_compact_support(...)` | exact compact-support profile |
| `CurrentMag` | stage continuation or checkpoint restore | runtime state transfer, not an analytic preset |
| `Radial` | none | not present in the pinned Mumax3 `engine/config.go`; unsupported in Fullmag |

Fullmag additionally provides `antiskyrmion`, `skyrmionium`, `bimeron`, `domain_wall`,
and a stereographic `hopfion` initializer. These are Fullmag extensions rather than named
Mumax3 `Config` constructors.

(mumax3-governing-equations)=
## Governing equations

## Mumax3-compatible vortex wall

The complete stage-first Python scenario below constructs
`fm.texture.vortex_wall(wall_half_width=25e-9, left_mx=1, right_mx=-1,
circulation=1, core_polarity=1, core_radius=2e-9)`.

For local coordinate $u$, Fullmag returns the normalized left domain for
$u<-w$, the normalized right domain for $u>w$, and its version-2 vortex profile in
the central interval. Mumax3 derives $w$ from half the simulation width; Fullmag makes
that physical scale explicit so the same texture is reproducible for FEM and FDM meshes.
When `circulation` is omitted, Fullmag derives its sign from `left_mx * right_mx`, matching
the domain orientation; an explicit `-1` or `1` overrides that compatibility default.
Upstream `VortexWall` returns raw vectors `(mleft, 0, 0)` and `(mright, 0, 0)`, after which
`magnetization.SetArray` normalizes the field. Therefore every finite nonzero authored magnitude
reduces to its sign; preserving `0.5` as a final x component would not match Mumax3. Fullmag rejects
zero explicitly because its canonical reduced-magnetization field must be unit length.

```{math}
:label: mumax3-vortex-wall-profile

\mathbf m(u,v)=
\begin{cases}
\operatorname{sgn}(m_{x,L})\mathbf e_u, & u < -w,\\
\mathbf m_{\mathrm{vortex}}(u,v), & -w\leq u\leq w,\\
\operatorname{sgn}(m_{x,R})\mathbf e_u, & u > w.
\end{cases}
```

## Compact-support hopfion

The same executable scenario constructs
`fm.texture.hopfion_compact_support(major_radius=20e-9, minor_radius=8e-9)`.

For $\psi=\operatorname{atan2}(y,x)$, the toroidal radial coordinate is
$a_H=x\cos\psi+y\sin\psi-R$ and $\rho=\sqrt{z^2+a_H^2}$; the interior profile is

```{math}
:label: mumax3-compact-hopfion-profile

\Phi=-\operatorname{atan2}(z,a_H)+\psi,\qquad
\Theta=\pi\exp\!\left(1-\frac{1}{1-(\rho/r)^2}\right),\qquad
\mathbf m=(\cos\Phi\sin\Theta,\sin\Phi\sin\Theta,\cos\Theta).
```

The implemented toroidal profile is exactly uniform $+\hat{\mathbf z}$ for
$\rho\geq r$, including the support boundary. At the torus centreline,
the magnetization is $-\hat{\mathbf z}$. The profile is three-dimensional and therefore
requires `mapping.projection="object_local"`.

(mumax3-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization | $1$ |
| $u$ | first local wall coordinate | $\mathrm{m}$ |
| $v$ | second local wall coordinate | $\mathrm{m}$ |
| $w$ | vortex-wall half-width | $\mathrm{m}$ |
| $m_{x,L}$ | left-domain authored component | $1$ |
| $m_{x,R}$ | right-domain authored component | $1$ |
| $\mathbf e_u$ | first axis of the selected right-handed plane | $1$ |
| $R$ | hopfion major radius | $\mathrm{m}$ |
| $r$ | hopfion minor radius and support radius | $\mathrm{m}$ |
| $a_H$ | toroidal radial coordinate relative to the centreline | $\mathrm{m}$ |
| $\rho$ | distance from the torus centreline | $\mathrm{m}$ |
| $\psi$ | spatial azimuth | $\mathrm{rad}$ |
| $\Phi$ | hopfion magnetization azimuth | $\mathrm{rad}$ |
| $\Theta$ | hopfion polar profile | $\mathrm{rad}$ |

(mumax3-assumptions-and-validity)=
## Assumptions and validity

Both profiles define reduced initial magnetization, not an energy term, equilibrium
solution, or time integrator. Lengths are authored in SI metres and must remain
independent of mesh resolution. The vortex-wall exterior uses only the sign of each
nonzero authored domain component because the resolved magnetization is normalized.
The compact-hopfion denominator is evaluated only for $\rho<r$; the support boundary
belongs to the exact uniform exterior.

(mumax3-python-api)=
## Python API and parameters

```python
# %%
import fullmag as fm

# %%
wall = fm.texture.vortex_wall(
    wall_half_width=25e-9,
    left_mx=1.0,
    right_mx=-1.0,
    circulation=1,
    core_polarity=1,
    core_radius=2e-9,
)
compact_hopfion = fm.texture.hopfion_compact_support(
    major_radius=20e-9,
    minor_radius=8e-9,
)

study = fm.study("mumax3_texture_compatibility")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(200e-9, 100e-9, 10e-9))
study.objects.mesh.defaults(cell_size=(4e-9, 4e-9, 5e-9))
film = study.geometry(
    fm.Box(size=(160e-9, 80e-9, 5e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = wall
# To initialize a three-dimensional object instead, assign compact_hopfion.
study.demag(realization="fdm_convolution")
study.stages.add_save_state(
    artifact_name="initial-m.zarr",
    format="zarr",
    dataset="m",
)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `texture.vortex_wall.wall_half_width` | float | required | $\mathrm{m}$ | finite and > 0 | central vortex-strip half-width | FDM/FEM via planner materialization | preset_params.wall_half_width |
| `texture.vortex_wall.left_mx` | float | 1.0 | $1$ | finite and nonzero | left-domain sign | FDM/FEM via planner materialization | preset_params.left_mx |
| `texture.vortex_wall.right_mx` | float | -1.0 | $1$ | finite and nonzero | right-domain sign | FDM/FEM via planner materialization | preset_params.right_mx |
| `texture.vortex_wall.circulation` | int \| None | sign(left_mx * right_mx) | $1$ | -1 or 1 after default resolution | central-vortex circulation; omitted value follows the domain-sign product | FDM/FEM via planner materialization | preset_params.circulation |
| `texture.vortex_wall.core_polarity` | int | 1 | $1$ | -1 or 1 | central-vortex core polarity | FDM/FEM via planner materialization | preset_params.core_polarity |
| `texture.vortex_wall.core_radius` | float | 1e-9 | $\mathrm{m}$ | finite and > 0 | central-vortex core radius | FDM/FEM via planner materialization | preset_params.core_radius |
| `texture.vortex_wall.plane` | str | xy | $1$ | xy, xz or yz | right-handed local frame | FDM/FEM via planner materialization | preset_params.plane |
| `texture.vortex_wall.preset_version` | int | 2 | $1$ | exactly 2 | selects the version-2 profile | FDM/FEM via planner materialization | preset_version |
| `texture.hopfion_compact_support.major_radius` | float | required | $\mathrm{m}$ | finite and > 0 | torus major radius | FDM/FEM via planner materialization | preset_params.major_radius |
| `texture.hopfion_compact_support.minor_radius` | float | required | $\mathrm{m}$ | finite, > 0 and <= major_radius | cross-section and compact-support radius | FDM/FEM via planner materialization | preset_params.minor_radius |
| `texture.hopfion_compact_support.preset_version` | int | 2 | $1$ | exactly 2 | selects the version-2 profile | FDM/FEM via planner materialization | preset_version |

(mumax3-problem-ir)=
## ProblemIR lowering

Both factories lower to `kind="preset_texture"`, `preset_version=2`, the listed
`preset_params`, a versioned mapping descriptor, and a texture transform. The Python
factory names are authoring helpers; the canonical serialized names are `vortex_wall`
and `hopfion_compact_support`. Browser authoring lowers to the same descriptors. Its
Python export uses the generic `fm.PresetTexture(...)` form so `ui_label`, mapping,
transform, preview metadata, and every authored parameter round-trip unchanged; a
factory-authored texture without extra metadata may use the shorter factory call.

(mumax3-round-trip-and-failure-semantics)=
## Round-trip, provenance, and failure semantics

The requested intent preserves the preset kind, version, authored SI parameters,
mapping, and transform. Resolved execution records the selected solver, device,
precision, and materialization path without rewriting those semantics. Validation errors
reject invalid scales, signs, planes, mappings, or versions before sampling.
Unsupported combinations, including a three-dimensional hopfion without
`object_local` projection, fail explicitly instead of falling back to another preset or
uniform magnetization. Python, UI, ProblemIR, session state, and exported Python must
round-trip every authored parameter unchanged.

(mumax3-discrete-realization)=
## Discrete realization and backend semantics

| Solver | Device | Realization | Qualification status |
|---|---|---|---|
| FDM | CPU | planner sampling at active cell centres | source and shared Rust/Python fixture evidence |
| FDM | GPU | consumes the shared planner-materialized initial field | semantic parity; GPU runtime qualification remains separate |
| FEM | CPU | planner sampling at magnetic mesh points | source and shared Rust/Python fixture evidence |
| FEM | GPU | consumes the shared planner-materialized initial field | semantic parity; GPU runtime qualification remains separate |

The planner samples the same version-2 descriptor at FDM cell centres or FEM magnetic
mesh points. CPU and GPU lanes consume that materialized vector field; there is no
backend-specific reinterpretation of either profile. The preset descriptor, requested
version, mapping, transform, resolved solver, device, and precision remain part of the
ProblemIR and execution provenance. These initial conditions do not claim an equilibrium
state or qualify later LLG dynamics.

Invalid scales, signs, planes, mappings, or versions fail before materialization. There
is no fallback to a different preset or to a uniform state. `CurrentMag` remains runtime
state transfer rather than an analytic preset because its value depends on a resolved
mesh and session state.

(mumax3-implementation-mapping)=
## Implementation mapping

- Rust evaluator: `crates/fullmag-plan/src/magnetization_textures_v2.rs`, symbols
  `vortex_wall` and `hopfion_compact_support`.
- Python factories and reference evaluator:
  `packages/fullmag-py/src/fullmag/init/textures.py` and `preset_eval_v2.py`.
- Rust/Python parity: the shared 1000-point fixture
  `crates/fullmag-plan/tests/fixtures/magnetization_textures_v2_parity.json`, consumed by
  `crates/fullmag-plan/tests/magnetization_textures_v2_parity.rs` and
  `packages/fullmag-py/tests/test_preset_texture_v2_parity.py`.
- Browser registry and round-trip:
  `apps/control-room/src/shared/domain/magnetization-texture/texturePresets.ts` and
  `ObjectMagneticTexturePanelModel.mumax3.test.ts`.

The compatibility equations are mapped directly to the immutable upstream Mumax3 submodule file
`external_solvers/3/engine/config.go` at `f656494b29516bead825b444b1f0b38c6e6c7dbf` and compared by the shared Rust/Python fixture named above. Fullmag replaces Mumax3's mesh-derived vortex core and world-derived
wall half-width with explicit SI parameters; this is a deliberate reproducibility
adaptation, not bitwise sampling parity.

(mumax3-validation)=
## Validation

Rust contract tests check both uniform wall domains, the central vortex core, exact
compact-support boundary values, exterior values, and unit norm. Python tests check
factory validation and component parity. Control Room tests check registry completeness,
default hydration, serialization, and version preservation. Public examples and the
scientific source-map validator run in CI. GPU runtime qualification remains separate
because the planner materializes the shared field before device execution.

(mumax3-limitations)=
## Limitations and deferred qualification

“Mumax3-compatible” means matching the analytic family and parameter signs while making
mesh-derived lengths explicit. It does not promise bitwise equality with Mumax3's
grid-dependent vortex core, automatic world-size lookup, random-number stream, or later
solver trajectory. The profiles are initial conditions and require an independent
relaxation or dynamics qualification for a scientific study.

(mumax3-scientific-bibliography)=
## Scientific bibliography

1. Mumax3, `engine/config.go`, `VortexWall` and `HopfionCompactSupport`,
   <https://github.com/mumax/3/blob/f656494b29516bead825b444b1f0b38c6e6c7dbf/engine/config.go>.
2. A. Vansteenkiste et al., *The design and verification of MuMax3*, AIP Advances 4,
   107133 (2014), <https://doi.org/10.1063/1.4899186>.

## Current magnetization

Mumax3 `CurrentMag()` snapshots the current mesh magnetization and exposes it as another
configuration. Fullmag represents the same operation through explicit runtime state:
stage-to-stage continuation, interactive-session state, and checkpoint restore. It is
intentionally not presented as an analytic texture preset because its value depends on a
specific resolved mesh and simulation state.

(mumax3-source-code-index)=

## Control Room crosswalk

Status: The exposed texture families are partial; unlisted presets remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Magnetization` | `partial` | Apply magnetization draft; authored object state is revised |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Magnetization` | `not implemented` | Python-only until implemented |

frontend support is not implemented for texture presets and arguments not exposed by ObjectMagneticTexturePanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx (ObjectMagneticTexturePanel)`.

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

## Source-code index

| Source ID | Repository path | Stable symbol | Evidence |
|---|---|---|---|
| rust-vortex-wall | crates/fullmag-plan/src/magnetization_textures_v2.rs | vortex_wall | mumax_vortex_wall_has_domains_and_vortex_core |
| rust-compact-hopfion | crates/fullmag-plan/src/magnetization_textures_v2.rs | hopfion_compact_support | mumax_compact_hopfion_is_exactly_uniform_outside_support |
| python-vortex-wall | packages/fullmag-py/src/fullmag/init/preset_eval_v2.py | _vortex_wall | test_mumax_vortex_wall_factory_and_profile |
| python-compact-hopfion | packages/fullmag-py/src/fullmag/init/preset_eval_v2.py | _hopfion_compact_support | test_mumax_compact_hopfion_factory_and_support_boundary |
| python-vortex-wall-factory | packages/fullmag-py/src/fullmag/init/textures.py | vortex_wall | test_mumax_vortex_wall_factory_and_profile |
| python-compact-hopfion-factory | packages/fullmag-py/src/fullmag/init/textures.py | hopfion_compact_support | test_mumax_compact_hopfion_factory_and_support_boundary |
| mumax3-vortex-wall | external_solvers/3/engine/config.go | func VortexWall | pinned submodule f656494b29516bead825b444b1f0b38c6e6c7dbf + independent parity fixtures |
| mumax3-compact-hopfion | external_solvers/3/engine/config.go | func HopfionCompactSupport | pinned submodule f656494b29516bead825b444b1f0b38c6e6c7dbf + independent parity fixtures |

