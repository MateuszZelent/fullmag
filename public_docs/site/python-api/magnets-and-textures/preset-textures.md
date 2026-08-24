---
title: Preset Textures
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-magnets-and-textures-preset-textures)=
# Preset Textures

(python-api-magnets-and-textures-preset-textures-problem-statement)=
## Contract

Preset textures are analytic **initial conditions** for the reduced magnetization
$\mathbf m=\mathbf M/M_\mathrm s$. Fullmag currently exposes the following public factories:

| Public factory | Serialized `preset_kind` | Version-2 role |
|---|---|---|
| `fm.texture.uniform(...)` | `uniform` | constant normalized direction; canonical parameter reference is on the [Uniform Texture](uniform-texture.md) page |
| `fm.texture.random(...)` | `random` | deterministic coordinate-hashed random unit vectors |
| `fm.texture.random_seeded(...)` | `random` | public alias of `random` |
| `fm.texture.vortex(...)` | `vortex` | regularized vortex with winding $+1$ |
| `fm.texture.antivortex(...)` | `antivortex` | regularized antivortex with winding $-1$ |
| `fm.texture.bloch_skyrmion(...)` | `bloch_skyrmion` | axisymmetric skyrmion with fixed Bloch helicity |
| `fm.texture.neel_skyrmion(...)` | `neel_skyrmion` | axisymmetric skyrmion with chirality-selected radial helicity |
| `fm.texture.antiskyrmion(...)` | `antiskyrmion` | skyrmion profile with opposite azimuthal winding |
| `fm.texture.skyrmionium(...)` | `skyrmionium` | normalized 2-pi target state with equal centre and far-field backgrounds |
| `fm.texture.hopfion(...)` | `hopfion` | three-dimensional unit-vector Hopf-map initializer |
| `fm.texture.bimeron(...)` | `bimeron` | in-plane skyrmion analogue represented as a meron pair |
| `fm.texture.domain_wall(...)` | `domain_wall` | smooth Bloch or Neel wall between antiparallel domains |
| `fm.texture.two_domain(...)` | `two_domain` | sharp or smooth two-domain initializer |
| `fm.texture.helical(...)` | `helical` | planar spin spiral with a physical wavevector |
| `fm.texture.conical(...)` | `conical` | conical spin spiral with a physical wavevector |

The descriptor is sampled only when the final FDM grid or FEM mesh is known. It does not add an
energy, torque, boundary condition, frozen-spin constraint, or guarantee that the authored state is
a stationary solution. Relaxation can translate, deform, split, annihilate, or completely erase a
preset.

### Backend support and qualification

| Solver | Device | Discrete sampling location | Implementation status | Qualification statement |
|---|---|---|---|---|
| FDM | CPU | active cell centres | implemented in the planner | analytic sampling and tests are present; scientific convergence remains problem-dependent |
| FDM | GPU | active cell centres | implemented through the same planner-materialized initial vector | there is no separate device-side texture kernel; texture tests do not independently qualify the later GPU solve |
| FEM | CPU | magnetic mesh nodes | implemented in the mesh/planner path | air and nonmagnetic nodes are excluded from texture sampling |
| FEM | GPU | magnetic mesh nodes | implemented through the same planner-materialized initial vector | there is no separate device-side texture kernel; texture tests do not independently qualify the later GPU solve |

`preset_version=2` is the current public Python default. A serialized `ProblemIR` payload that omits
`preset_version` still defaults to version 1 so that old studies are not silently reinterpreted.

(python-api-magnets-and-textures-preset-textures-governing-equations)=
## Governing equations

### Coordinate, mapping, plane, and transform pipeline

For each active sample, the planner first selects $\mathbf x_\mathrm s$ from the object-space or
world-space point according to `mapping.space`. Version 2 then applies the inverse texture transform:

```{math}
:label: preset-texture-local-coordinate

\mathbf x_{\mathrm{loc}}
=
\mathbf x_{\mathrm p}
+
\mathbf S^{-1}
\mathcal R_q^{-1}
\left(
\mathbf x_{\mathrm s}-\mathbf t-\mathbf x_{\mathrm p}
\right).
```

Here `translation` and `pivot` are lengths, `scale` is dimensionless and component-wise, and the
quaternion is normalized before use. Every scale component and the quaternion norm must exceed
$10^{-14}$ in the canonical Rust v2 evaluator. The planner validates the descriptor once and
materializes a prepared transform containing the normalized forward/inverse quaternion and
reciprocal scale. FDM cells and FEM nodes therefore use the same affine map without repeating
normalization for every sample. After the local profile has been evaluated, the magnetization
vector is embedded in the selected plane and rotated forward by $\mathcal R_q$. Translation,
pivot, and scale affect coordinates; only the quaternion rotates spin components.

The implemented right-handed frames are:

| `plane` / planar projection | $\mathbf e_u$ | $\mathbf e_v$ | $\mathbf e_n=\mathbf e_u\times\mathbf e_v$ |
|---|---|---|---|
| `xy` / `planar_xy` | $+\hat{\mathbf x}$ | $+\hat{\mathbf y}$ | $+\hat{\mathbf z}$ |
| `xz` / `planar_xz` | $+\hat{\mathbf x}$ | $+\hat{\mathbf z}$ | $-\hat{\mathbf y}$ |
| `yz` / `planar_yz` | $+\hat{\mathbf y}$ | $+\hat{\mathbf z}$ | $+\hat{\mathbf x}$ |

For the planar presets, the local coordinates are

```{math}
:label: preset-texture-plane-frame

u=\mathbf e_u\cdot\mathbf x_{\mathrm{loc}},
\qquad
v=\mathbf e_v\cdot\mathbf x_{\mathrm{loc}},
\qquad
r=\sqrt{u^2+v^2},
\qquad
\phi=\operatorname{atan2}(v,u).
```

An explicit preset `plane` and a planar mapping projection must identify the same plane; version 2
rejects a conflict. In the canonical Rust v2 sampler, planar projection is currently applied only to
`vortex`, `antivortex`, the skyrmion family, `skyrmionium`, `bimeron`, `domain_wall`, and
`two_domain`. `uniform`, `random`, `helical`, and `conical` retain transformed Cartesian
coordinates. `hopfion` is intrinsically three-dimensional and rejects planar projection.

Inactive FDM cells are written as `[0, 0, 0]`. Version-2 parameters and transforms are validated
before iterating over samples, so malformed input is rejected even for an empty or entirely inactive
sample set.

### Uniform

After validation, the authored direction is normalized once:

```{math}
:label: preset-texture-uniform-v2

\mathbf m(\mathbf x)
=
\frac{\mathbf m_0}{\lVert\mathbf m_0\rVert}.
```

The detailed public parameter contract is owned by the [Uniform Texture](uniform-texture.md) page.

### Deterministic random texture

Version 2 hashes the seed and the exact IEEE-754 bit patterns of the three local coordinates with
SplitMix64. Two 53-bit uniform variates are converted to a point uniformly distributed on the unit
sphere:

```{math}
:label: preset-texture-random-v2

\zeta=2u_2-1,
\qquad
\varphi_{\mathrm r}=2\pi u_1,
\qquad
\mathbf m
=
\begin{pmatrix}
\sqrt{1-\zeta^2}\cos\varphi_{\mathrm r}\\
\sqrt{1-\zeta^2}\sin\varphi_{\mathrm r}\\
\zeta
\end{pmatrix}.
```

The public factories require `seed`. A hand-authored version-2 parameter map that omits it is
interpreted with the backend default `seed=1`. The result is deterministic for the same seed,
coordinates, version, and floating-point bit pattern. A mesh change changes the sampled
coordinates and therefore changes the random field.

### Vortex and antivortex

For `vortex`, $Q_\mathrm v=+1$; for `antivortex`, $Q_\mathrm v=-1$. Version 2 uses a Gaussian
normal core:

```{math}
:label: preset-texture-vortex-v2

g(r)=\exp\!\left[-\left(\frac{r}{r_\mathrm c}\right)^2\right],
\qquad
\psi=Q_\mathrm v\phi+c\frac{\pi}{2},
\qquad
\mathbf m_{\mathrm{local}}
=
\begin{pmatrix}
\sqrt{1-g^2}\cos\psi\\
\sqrt{1-g^2}\sin\psi\\
p g
\end{pmatrix}.
```

The square-root argument is evaluated as `max(0, 1 - g*g)` to suppress a negative value caused by
roundoff at the core. `circulation` is $c\in\{-1,+1\}$, `core_polarity` is
$p\in\{-1,+1\}$, and an omitted `core_radius` is evaluated as
$r_\mathrm c=10^{-9}\,\mathrm{m}$ by the version-2 backend. The factory omits this default
from `preset_params`; consequently the evaluator default is part of the versioned contract.

### Bloch and Neel skyrmions

The overflow-resistant version-2 radial profile is equivalent to

```{math}
:label: preset-texture-skyrmion-v2

\theta(0)=\pi,
\qquad
\theta(r>0)
=
2\arctan\!\left[
\frac{\sinh(R/\Delta)}{\sinh(r/\Delta)}
\right],
\qquad
\psi=\phi+c\gamma,
\qquad
\mathbf m_{\mathrm{local}}
=
\begin{pmatrix}
\sin\theta\cos\psi\\
\sin\theta\sin\psi\\
-p\cos\theta
\end{pmatrix}.
```

The implementation returns $\theta=\pi$ directly for $r\le 10^{-14}\,\mathrm{m}$, evaluates the
hyperbolic-sine ratio in logarithmic form elsewhere, and saturates the logarithmic ratio outside
$[-40,40]$. The chirality convention is now explicit: Bloch walls use
$\gamma=c\pi/2$, while Neel walls use $\gamma=0$ for $c=+1$ and $\gamma=\pi$ for $c=-1$.
Consequently `chirality` reverses the radial Neel-wall direction instead of being a no-op. In
version 2, `core_polarity=p` is the actual sign of the normal component at $r=0$.

### Bimeron: implemented field, topology, and exact core geometry

A bimeron is commonly interpreted as an in-plane skyrmion analogue composed of two merons.
Fullmag uses that physical interpretation but implements a specific analytic initializer; it is not
claimed to be an exact minimizer for a particular Hamiltonian.

With $Q_\mathrm v\in\{-1,+1\}$, helicity $\eta$, and
$s_\mathrm{bg}\in\{-1,+1\}$, the exact version-2 local field is

```{math}
:label: preset-texture-bimeron-v2

\theta(r)
=
\arcsin\!\left[
\tanh\!\left(\frac{r-R}{\Delta}\right)
\right]
+
\arcsin\!\left[
\tanh\!\left(\frac{r+R}{\Delta}\right)
\right],
\qquad
\chi=Q_\mathrm v\phi+\eta,
\qquad
\mathbf m_{\mathrm{local}}
=
-s_\mathrm{bg}
\begin{pmatrix}
\cos\theta\\
\sin\theta\sin\chi\\
\sin\theta\cos\chi
\end{pmatrix}.
```

This field is analytically normalized because
$\cos^2\theta+\sin^2\theta(\sin^2\chi+\cos^2\chi)=1$. At the origin,
$\theta(0)=0$; as $r\rightarrow\infty$, $\theta\rightarrow\pi$. Therefore

- at the centre: $\mathbf m=-s_\mathrm{bg}\mathbf e_u$;
- in the far field: $\mathbf m=+s_\mathrm{bg}\mathbf e_u$;
- changing `helicity_rad` rotates the meron pair without changing its continuum charge;
- changing `vorticity` reverses the winding;
- changing `background_sign` globally reverses the field.

For the documented right-handed $(u,v)$ orientation and the convention

```{math}
:label: preset-texture-bimeron-charge

Q
=
\frac{1}{4\pi}
\int
\mathbf m\cdot
\left(
\frac{\partial\mathbf m}{\partial u}
\times
\frac{\partial\mathbf m}{\partial v}
\right)
\,\mathrm du\,\mathrm dv
=
\frac{s_\mathrm{bg}Q_\mathrm v}{2}
\int_0^\infty
\theta'(r)\sin\theta(r)\,\mathrm dr
=
s_\mathrm{bg}Q_\mathrm v,
```

provided that the continuum plane reaches the uniform far field. On a finite or coarsely discretized
sample, a numerically integrated charge need not be exactly integer.

A crucial implementation detail is that `radius=R` is a **nominal profile scale**, not generally the
exact radius of the two points with $|m_n|=1$. Those points satisfy $\theta=\pi/2$, hence

```{math}
:label: preset-texture-bimeron-core-radius

r_\mathrm{core}
=
\Delta\,\operatorname{asinh}
\left[
\cosh\!\left(\frac{R}{\Delta}\right)
\right].
```

The result follows by rewriting each profile term as
$\arcsin[\tanh((r\pm R)/\Delta)]=2\arctan\{\exp[(r\pm R)/\Delta]\}-\pi/2$.
Setting $\theta=\pi/2$ then reduces the profile equation to
$\sinh(r_\mathrm{core}/\Delta)=\cosh(R/\Delta)$.
For $R/\Delta\gg1$, $r_\mathrm{core}\simeq R$; otherwise the difference is material:

| $R/\Delta$ | $r_\mathrm{core}/\Delta$ | Relative offset from $R$ |
|---:|---:|---:|
| 1 | 1.218425 | 21.84% |
| 2 | 2.035362 | 1.77% |
| 3 | 3.004933 | 0.16% |
| 5 | 5.000091 | 0.0018% |

At $r=r_\mathrm{core}$, the negative-normal core lies where
$Q_\mathrm v\phi+\eta=0\pmod{2\pi}$, and the positive-normal core lies at the antipodal
phase $Q_\mathrm v\phi+\eta=\pi\pmod{2\pi}$. Their normal components are
$-s_\mathrm{bg}$ and $+s_\mathrm{bg}$, respectively.

The implementation uses only `tanh` and `asin` for this profile, so it avoids a direct exponential
overflow for very small `wall_width`. It still requires a positive finite width.

### Smooth Bloch or Neel domain wall

Let $s$ be the coordinate selected by `normal_axis`, $s_0$ the centre offset, and
$\xi=(s-s_0)/w$. Version 2 requires the normalized right domain to be antiparallel to the normalized
left domain and uses

```{math}
:label: preset-texture-domain-wall-v2

\xi=\frac{s-s_0}{w},
\qquad
\mathbf m
=
\operatorname{normalize}
\left[
-\tanh(\xi)\,\mathbf m_{\mathrm L}
+
\operatorname{sech}(\xi)\,\mathbf m_{\mathrm W}
\right].
```

Thus $\mathbf m\rightarrow\mathbf m_\mathrm L$ for $\xi\rightarrow-\infty$ and
$\mathbf m\rightarrow\mathbf m_\mathrm R=-\mathbf m_\mathrm L$ for
$\xi\rightarrow+\infty$. `wall_center_direction` is either explicit or deterministically derived. For a Neel wall the first
candidate is the wall-normal axis projected orthogonally to $\mathbf m_\mathrm L$; for a Bloch wall
it is the cross product of the wall-normal axis and $\mathbf m_\mathrm L$. A deterministic Cartesian
helper supplies a tangent when that candidate degenerates. The final direction is normalized and
must be orthogonal to the domain direction within $10^{-10}$. For numerical stability, the Rust
evaluator sets `sech(xi)=0` when $|\xi|>350$.

### Two-domain initializer

In sharp mode, the implementation returns $\mathbf m_\mathrm L$ for $s<0$,
$\mathbf m_\mathrm R$ for $s>0$, and $\mathbf m_\mathrm W$ exactly at $s=0$.
In smooth mode,

```{math}
:label: preset-texture-two-domain-v2

\tau(s)
=
\frac{1}{2}
\left[
\tanh\!\left(\frac{s}{w}\right)+1
\right],
\qquad
\mathbf m
=
\begin{cases}
\operatorname{normalize}
\left[
(1-\tau)\mathbf m_{\mathrm L}+\tau\mathbf m_{\mathrm R}
\right],
&
\left\lVert
(1-\tau)\mathbf m_{\mathrm L}+\tau\mathbf m_{\mathrm R}
\right\rVert>10^{-14},\\
\mathbf m_{\mathrm W},
&
\text{otherwise}.
\end{cases}
```

When `sharp=None`, the factory chooses sharp mode if `wall_width is None`, otherwise smooth mode.
There is currently no `center_offset` parameter for this preset.

### Helical texture

Version 2 preserves the magnitude and SI unit of the authored wavevector:

```{math}
:label: preset-texture-helical-v2

\varphi
=
\mathbf q\cdot\mathbf x_{\mathrm{loc}}+\varphi_0,
\qquad
\mathbf m
=
\mathbf e_1\cos\varphi
+
\mathbf e_2\sin\varphi.
```

The evaluator normalizes $\mathbf e_1$ and $\mathbf e_2$ separately and requires
$|\mathbf e_1\cdot\mathbf e_2|\le 10^{-12}$. Consequently the period along $\mathbf q$ is
$2\pi/\lVert\mathbf q\rVert$.

### Conical texture

For a normalized cone axis $\mathbf a$, the implementation selects $+\hat{\mathbf x}$ as helper
when $|a_x|<0.9$ and $+\hat{\mathbf y}$ otherwise. It normalizes the cross product of
$\mathbf a$ with that selected helper to obtain $\mathbf e_1$, then sets
$\mathbf e_2=\mathbf a\times\mathbf e_1$. It evaluates

```{math}
:label: preset-texture-conical-v2

\varphi
=
\mathbf q\cdot\mathbf x_{\mathrm{loc}}+\varphi_0,
\qquad
\mathbf m
=
\mathbf a\cos\beta
+
\left(
\mathbf e_1\cos\varphi
+
\mathbf e_2\sin\varphi
\right)
\sin\beta.
```

The cone angle must lie in $[0,\pi]$. The authored `cone_axis` is normalized and the physical
wavevector magnitude is retained.


### Antiskyrmion

`fm.texture.antiskyrmion(...)` uses the same overflow-resistant radial profile as the skyrmion,
but reverses the azimuthal winding:

\[
\psi=-\phi+\gamma_c,\qquad
\mathbf m_\mathrm{local}=
(\sin\theta\cos\psi,\ \sin\theta\sin\psi,\ -p\cos\theta).
\]

The implemented v2 preset is a Neel-type antiskyrmion ansatz. `chirality=+1` gives
$\gamma_c=0$ and `chirality=-1` gives $\gamma_c=\pi$. It is sampled identically on FDM cell
centres and FEM magnetic nodes.

| Python parameter | Meaning |
|---|---|
| `texture.antiskyrmion.radius` | nominal radial scale in metres |
| `texture.antiskyrmion.wall_width` | radial transition width in metres |
| `texture.antiskyrmion.chirality` | radial wall orientation, -1 or +1 |
| `texture.antiskyrmion.core_polarity` | normal core sign, -1 or +1 |
| `texture.antiskyrmion.plane` | right-handed `xy`, `xz`, or `yz` frame |
| `texture.antiskyrmion.preset_version` | must be 2 |

### Skyrmionium

`fm.texture.skyrmionium(...)` is a normalized two-wall, 2-pi target-state initializer. Defining

\[
a(s)=\arccos[-\tanh(s)],\qquad
\theta(r)=a\!\left(\frac{r-R_\mathrm{in}}{\Delta}\right)
+a\!\left(\frac{r-R_\mathrm{out}}{\Delta}\right),
\]

the local field is

\[
\mathbf m_\mathrm{local}=
(\sin\theta\cos\psi,\ \sin\theta\sin\psi,\ s_\mathrm{bg}\cos\theta).
\]

The centre and far field have the same background orientation; the annulus between the two walls
is reversed. The continuum target has zero net skyrmion number when the full far field is included.

| Python parameter | Meaning |
|---|---|
| `texture.skyrmionium.inner_radius` | inner wall radius in metres |
| `texture.skyrmionium.outer_radius` | outer wall radius in metres; greater than the inner radius |
| `texture.skyrmionium.wall_width` | common positive wall width in metres |
| `texture.skyrmionium.kind` | `neel` or `bloch` |
| `texture.skyrmionium.chirality` | wall orientation, -1 or +1 |
| `texture.skyrmionium.background_sign` | common centre/far-field normal sign |
| `texture.skyrmionium.plane` | right-handed `xy`, `xz`, or `yz` frame |
| `texture.skyrmionium.preset_version` | must be 2 |

### Hopfion

`fm.texture.hopfion(...)` is a three-dimensional Hopf-map initializer. With normalized coordinates
$X=x/R$, $Y=qy/R$, $Z=z/(R a_z)$, $\rho^2=X^2+Y^2+Z^2$, and $d=1+\rho^2$,

\[
z_1=\frac{2(X+iY)}{d},\qquad
z_2=\frac{2Z+i(\rho^2-1)}{d},
\]

\[
\mathbf h=
\left(2\operatorname{Re}(z_1\overline{z_2}),
2\operatorname{Im}(z_1\overline{z_2}),
|z_1|^2-|z_2|^2\right),\qquad
\mathbf m=-s_\mathrm{bg}\,\mathcal R_z(\varphi_0)\mathbf h.
\]

The field is normalized analytically and renormalized once numerically to suppress roundoff.
`hopf_charge=-1` reflects the second stereographic coordinate and reverses the texture orientation.
The profile requires `mapping.projection="object_local"`; orient it in space with the texture
quaternion transform.

| Python parameter | Meaning |
|---|---|
| `texture.hopfion.radius` | isotropic Hopf-map scale in metres |
| `texture.hopfion.hopf_charge` | orientation sign, -1 or +1 |
| `texture.hopfion.background_sign` | sign of the uniform far-field axis |
| `texture.hopfion.axial_scale` | positive dimensionless z-axis scale |
| `texture.hopfion.phase_rad` | global target-space phase in radians |
| `texture.hopfion.preset_version` | must be 2 |

### Version 1 compatibility

Version 1 remains executable only to reproduce historical studies. It is not a less strict spelling
of version 2.

| Aspect | Version 1 | Version 2 |
|---|---|---|
| Python default | opt-in | default for all public factories |
| Missing `preset_version` in serialized IR | selected by the IR default | never inferred |
| Validation | permissive legacy coercions and fallbacks | finite, sign, plane, basis, and transform checks |
| Texture rotation | transforms sample coordinates but does not consistently rotate output spin vectors | transforms coordinates and forward-rotates output vectors |
| Vortex/antivortex | circulation and winding are partially conflated | winding is fixed by preset kind and circulation is an independent sign |
| Skyrmion polarity | historical sign convention | `core_polarity` is the actual normal core sign |
| Helical/conical wavevector | magnitude is normalized away in the legacy evaluator | physical $\mathrm{m^{-1}}$ magnitude sets the period |
| Domain wall | legacy interpolation with an ad hoc Bloch tangent contribution | antiparallel-domain contract with explicit or derived wall-centre direction |
| Mapping clamp | clamp/repeat/mirror is applied by the legacy sampler | canonical Rust v2 currently does not apply `clamp_mode` |
| Bimeron | same radial ansatz, legacy transform and validation semantics | strict signs/plane/transform semantics and right-handed output embedding |

(python-api-magnets-and-textures-preset-textures-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization vector | $1$ |
| $\mathbf x_{\mathrm s}$ | sample point selected in object or world space | $\mathrm{m}$ |
| $\mathbf x_{\mathrm{loc}}$ | texture-local sample coordinate | $\mathrm{m}$ |
| $\mathbf x_{\mathrm p}$ | texture-transform pivot | $\mathrm{m}$ |
| $\mathbf t$ | texture translation | $\mathrm{m}$ |
| $\mathbf S$ | diagonal coordinate-scale operator | $1$ |
| $\mathcal R_q$ | active rotation represented by the normalized quaternion q | $1$ |
| $\mathbf e_u$ | first axis of the right-handed texture-plane frame | $1$ |
| $\mathbf e_v$ | second axis of the right-handed texture-plane frame | $1$ |
| $\mathbf e_n$ | normal of the right-handed texture-plane frame | $1$ |
| $u$ | first local planar coordinate | $\mathrm{m}$ |
| $v$ | second local planar coordinate | $\mathrm{m}$ |
| $r$ | local radial coordinate | $\mathrm{m}$ |
| $\phi$ | local spatial azimuth | $\mathrm{rad}$ |
| $u_1$ | first deterministic uniform variate derived from SplitMix64 | $1$ |
| $u_2$ | second deterministic uniform variate derived from SplitMix64 | $1$ |
| $\zeta$ | sampled cosine of the random polar angle | $1$ |
| $g$ | Gaussian vortex-core amplitude | $1$ |
| $r_{\mathrm c}$ | vortex core radius | $\mathrm{m}$ |
| $Q_{\mathrm v}$ | vorticity or winding sign | $1$ |
| $c$ | circulation or chirality sign, according to the preset | $1$ |
| $p$ | normal-core polarity sign | $1$ |
| $\theta$ | radial polar profile angle | $\mathrm{rad}$ |
| $R$ | nominal radial profile scale | $\mathrm{m}$ |
| $\Delta$ | radial transition width | $\mathrm{m}$ |
| $\gamma$ | fixed skyrmion helicity: 0 for Neel and pi/2 for Bloch | $\mathrm{rad}$ |
| $\chi$ | bimeron azimuthal phase | $\mathrm{rad}$ |
| $\eta$ | bimeron helicity | $\mathrm{rad}$ |
| $s_{\mathrm{bg}}$ | bimeron background-orientation sign | $1$ |
| $Q$ | continuum topological charge in the oriented local plane | $1$ |
| $r_{\mathrm{core}}$ | exact radius of the two fully normal bimeron cores | $\mathrm{m}$ |
| $s$ | coordinate along the selected wall-normal axis | $\mathrm{m}$ |
| $s_0$ | domain-wall centre offset | $\mathrm{m}$ |
| $w$ | domain-wall or smooth two-domain width | $\mathrm{m}$ |
| $\xi$ | dimensionless wall coordinate | $1$ |
| $\mathbf m_{\mathrm L}$ | negative-side domain direction | $1$ |
| $\mathbf m_{\mathrm R}$ | positive-side domain direction | $1$ |
| $\mathbf m_{\mathrm W}$ | wall-centre or zero-mixture fallback direction | $1$ |
| $\tau$ | smooth two-domain interpolation weight | $1$ |
| $\mathbf q$ | physical helical or conical wavevector | $\mathrm{m^{-1}}$ |
| $\varphi$ | helical or conical phase | $\mathrm{rad}$ |
| $\varphi_0$ | authored phase offset | $\mathrm{rad}$ |
| $\mathbf e_1$ | first spin-plane basis vector | $1$ |
| $\mathbf e_2$ | second spin-plane basis vector | $1$ |
| $\mathbf a$ | normalized conical-state axis | $1$ |
| $\beta$ | conical-state angle | $\mathrm{rad}$ |
| $\mathbf M$ | magnetization field | $\mathrm{A\,m^{-1}}$ |
| $M_{\mathrm s}$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m_0$ | authored nonzero uniform direction before normalization | $1$ |
| $m_n$ | component of reduced magnetization along the local plane normal | $1$ |
| $\psi$ | in-plane spin phase of a vortex or skyrmion | $\mathrm{rad}$ |
| $\varphi_{\mathrm r}$ | random-texture spherical azimuth | $\mathrm{rad}$ |
| $\ell$ | shortest physical profile length used in a resolution study | $\mathrm{m}$ |

(python-api-magnets-and-textures-preset-textures-assumptions-and-validity)=
## Assumptions and validity

1. Every preset defines reduced magnetization, so its output is dimensionless. Length parameters and
   sample coordinates are in metres; wavevectors are in inverse metres; authored angles are in
   radians unless a `_deg` convenience method is used.
2. A planar analytic preset assumes a right-handed local frame. In particular, the `xz` normal is
   $-\hat{\mathbf y}$, not $+\hat{\mathbf y}$.
3. `radius`, `wall_width`, and `core_radius` are profile parameters, not mesh-resolution guarantees.
   Resolve the shortest transition with enough FDM cells or FEM elements and perform a convergence
   study for energy, charge, core position, and relaxation outcome.
4. `random` is reproducible only for the same version, seed, point coordinates, and floating-point
   representation. It is not indexed by cell number or FEM node number.
5. A preset supplies only $\mathbf m(t=0)$. Physical persistence requires a compatible geometry,
   material model, interactions, boundary conditions, and numerical resolution.
6. The specific bimeron ansatz is a Fullmag initializer consistent with the documented topology and
   meron-pair interpretation. It is not asserted to solve the Euler-Lagrange equations of every
   easy-plane, frustrated, or DMI Hamiltonian.
7. `mapping.clamp_mode` is serialized by the public API, but the canonical Rust version-2 analytic
   sampler currently ignores it. The fresh Python default is `none`; omitted legacy IR defaults to
   `clamp`.
8. The full Python pre-sampling helper is a secondary path with different implementation thresholds
   and partial clamp behavior. Planner execution should be treated as canonical for FDM/FEM studies.

(python-api-magnets-and-textures-preset-textures-python-api)=
## Python API

### Complete factory parameter inventory

The table below is generated against the public signatures and is owned by this page. The uniform
factory has a separate canonical parameter table on the [Uniform Texture](uniform-texture.md) page.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `texture.random.seed` | `int` | `required` | $1$ | non-negative integer; bool rejected by v2 | deterministic seed for coordinate-hashed unit vectors | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.seed` |
| `texture.random.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.random_seeded.seed` | `int` | `required` | $1$ | non-negative integer; bool rejected by v2 | deterministic seed for coordinate-hashed unit vectors | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.seed` |
| `texture.random_seeded.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.vortex.circulation` | `int` | `1` | $1$ | -1 or +1 in v2 | sign of the in-plane circulation offset | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.circulation` |
| `texture.vortex.core_polarity` | `int` | `1` | $1$ | -1 or +1 in v2 | sign of the regularized normal core | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.core_polarity` |
| `texture.vortex.core_radius` | `float \| None` | `None` | $\mathrm{m}$ | None or finite and positive; v2 evaluator default is 1e-9 m | Gaussian core length | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.core_radius` |
| `texture.vortex.plane` | `str` | `"xy"` | $1$ | "xy", "xz", or "yz" | right-handed local texture plane | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.plane` |
| `texture.vortex.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.antivortex.circulation` | `int` | `1` | $1$ | -1 or +1 in v2 | sign of the in-plane circulation offset | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.circulation` |
| `texture.antivortex.core_polarity` | `int` | `1` | $1$ | -1 or +1 in v2 | sign of the regularized normal core | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.core_polarity` |
| `texture.antivortex.core_radius` | `float \| None` | `None` | $\mathrm{m}$ | None or finite and positive; v2 evaluator default is 1e-9 m | Gaussian core length | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.core_radius` |
| `texture.antivortex.plane` | `str` | `"xy"` | $1$ | "xy", "xz", or "yz" | right-handed local texture plane | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.plane` |
| `texture.antivortex.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.bloch_skyrmion.radius` | `float` | `required` | $\mathrm{m}$ | finite and positive in v2 | radial profile scale R | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.radius` |
| `texture.bloch_skyrmion.wall_width` | `float` | `required` | $\mathrm{m}$ | finite and positive in v2 | radial transition width Delta | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wall_width` |
| `texture.bloch_skyrmion.chirality` | `int` | `1` | $1$ | -1 or +1 in v2 | multiplies the fixed helicity \pi/2 | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.chirality` |
| `texture.bloch_skyrmion.core_polarity` | `int` | `-1` | $1$ | -1 or +1 in v2 | actual normal-axis sign at r=0 in v2 | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.core_polarity` |
| `texture.bloch_skyrmion.plane` | `str` | `"xy"` | $1$ | "xy", "xz", or "yz" | right-handed local texture plane | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.plane` |
| `texture.bloch_skyrmion.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.neel_skyrmion.radius` | `float` | `required` | $\mathrm{m}$ | finite and positive in v2 | radial profile scale R | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.radius` |
| `texture.neel_skyrmion.wall_width` | `float` | `required` | $\mathrm{m}$ | finite and positive in v2 | radial transition width Delta | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wall_width` |
| `texture.neel_skyrmion.chirality` | `int` | `1` | $1$ | -1 or +1 in v2 | multiplies the fixed helicity 0 | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.chirality` |
| `texture.neel_skyrmion.core_polarity` | `int` | `-1` | $1$ | -1 or +1 in v2 | actual normal-axis sign at r=0 in v2 | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.core_polarity` |
| `texture.neel_skyrmion.plane` | `str` | `"xy"` | $1$ | "xy", "xz", or "yz" | right-handed local texture plane | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.plane` |
| `texture.neel_skyrmion.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.bimeron.radius` | `float` | `required` | $\mathrm{m}$ | finite and positive | nominal radial transition scale R; not the exact meron-core radius | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.radius` |
| `texture.bimeron.wall_width` | `float` | `required` | $\mathrm{m}$ | finite and positive | transition width Delta | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wall_width` |
| `texture.bimeron.vorticity` | `int` | `1` | $1$ | -1 or +1; bool rejected | azimuthal winding Q_v | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.vorticity` |
| `texture.bimeron.helicity_rad` | `float` | `0.0` | $\mathrm{rad}$ | finite | rotates the meron pair in the local plane | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.helicity_rad` |
| `texture.bimeron.background_sign` | `int` | `1` | $1$ | -1 or +1; bool rejected | global orientation sign s_bg | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.background_sign` |
| `texture.bimeron.plane` | `str` | `"xy"` | $1$ | "xy", "xz", or "yz" | right-handed local texture plane | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.plane` |
| `texture.bimeron.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.domain_wall.width` | `float` | `required` | $\mathrm{m}$ | finite and positive in v2 | one-dimensional wall scale w | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.width` |
| `texture.domain_wall.kind` | `str` | `"neel"` | $1$ | "neel" or "bloch" | selects the derived wall-centre direction | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.kind` |
| `texture.domain_wall.center_offset` | `float` | `0.0` | $\mathrm{m}$ | finite | wall-centre coordinate along normal_axis | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.center_offset` |
| `texture.domain_wall.normal_axis` | `str` | `"x"` | $1$ | "x", "y", or "z" | Cartesian coordinate normal to the wall | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.normal_axis` |
| `texture.domain_wall.left` | `Sequence[float]` | `(1, 0, 0)` | $1$ | finite nonzero 3-vector; normalized in v2 | magnetization as xi tends to negative infinity | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.left` |
| `texture.domain_wall.right` | `Sequence[float]` | `(-1, 0, 0)` | $1$ | finite nonzero 3-vector antiparallel to left in v2 | magnetization as xi tends to positive infinity | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.right` |
| `texture.domain_wall.wall_center_direction` | `Sequence[float] \| None` | `None` | $1$ | None or finite nonzero 3-vector orthogonal to left | magnetization direction at the wall centre | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wall_center_direction` |
| `texture.domain_wall.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.two_domain.left` | `Sequence[float]` | `required` | $1$ | finite nonzero 3-vector; normalized in v2 | negative-side domain direction | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.left` |
| `texture.two_domain.right` | `Sequence[float]` | `required` | $1$ | finite nonzero 3-vector; normalized in v2 | positive-side domain direction | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.right` |
| `texture.two_domain.wall` | `Sequence[float]` | `required` | $1$ | finite nonzero 3-vector; normalized in v2 | fallback or exact interface direction | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wall` |
| `texture.two_domain.normal_axis` | `str` | `"x"` | $1$ | "x", "y", or "z" | Cartesian coordinate separating the domains | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.normal_axis` |
| `texture.two_domain.wall_width` | `float \| None` | `None` | $\mathrm{m}$ | required finite positive value for smooth mode; forbidden for sharp mode | smooth transition width | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wall_width` |
| `texture.two_domain.sharp` | `bool \| None` | `None` | $1$ | bool or None; None infers sharp when wall_width is None | selects discontinuous or tanh interpolation | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.sharp` |
| `texture.two_domain.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.helical.wavevector` | `Sequence[float]` | `required` | $\mathrm{m^{-1}}$ | finite nonzero 3-vector in v2 | physical wavevector q | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wavevector` |
| `texture.helical.e1` | `Sequence[float]` | `(1, 0, 0)` | $1$ | finite nonzero 3-vector; normalized in v2 | first spin-plane basis vector | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.e1` |
| `texture.helical.e2` | `Sequence[float]` | `(0, 1, 0)` | $1$ | finite nonzero 3-vector orthogonal to e1 in v2 | second spin-plane basis vector | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.e2` |
| `texture.helical.phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | finite in v2 | phase offset | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.phase_rad` |
| `texture.helical.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.conical.wavevector` | `Sequence[float]` | `required` | $\mathrm{m^{-1}}$ | finite nonzero 3-vector in v2 | physical wavevector q | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wavevector` |
| `texture.conical.cone_axis` | `Sequence[float]` | `(0, 0, 1)` | $1$ | finite nonzero 3-vector; normalized in v2 | cone axis a | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.cone_axis` |
| `texture.conical.cone_angle_rad` | `float` | `pi/4` | $\mathrm{rad}$ | finite and in [0, pi] in v2 | cone angle beta | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.cone_angle_rad` |
| `texture.conical.phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | finite in v2 | phase offset | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.phase_rad` |
| `texture.conical.preset_version` | `int` | `2` | $1$ | exactly 1 or 2; bool rejected | selects the serialized evaluator contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |

#### Advanced version-2 preset parameters

These rows complete the canonical Python-to-`ProblemIR` contract for the antiskyrmion, skyrmionium, and hopfion factories.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `texture.antiskyrmion.radius` | `float` | `required` | $\mathrm{m}$ | finite and positive | nominal radial profile scale | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.radius` |
| `texture.antiskyrmion.wall_width` | `float` | `required` | $\mathrm{m}$ | finite and positive | radial transition width | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wall_width` |
| `texture.antiskyrmion.chirality` | `int` | `1` | $1$ | -1 or +1 | Neel wall orientation | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.chirality` |
| `texture.antiskyrmion.core_polarity` | `int` | `-1` | $1$ | -1 or +1 | normal core sign | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.core_polarity` |
| `texture.antiskyrmion.plane` | `str` | `"xy"` | $1$ | "xy", "xz", or "yz" | right-handed texture plane | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.plane` |
| `texture.antiskyrmion.preset_version` | `int` | `2` | $1$ | exactly 2 | selects the v2 antiskyrmion contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.skyrmionium.inner_radius` | `float` | `required` | $\mathrm{m}$ | finite and positive | inner radial wall position | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.inner_radius` |
| `texture.skyrmionium.outer_radius` | `float` | `required` | $\mathrm{m}$ | finite, positive, and greater than inner_radius | outer radial wall position | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.outer_radius` |
| `texture.skyrmionium.wall_width` | `float` | `required` | $\mathrm{m}$ | finite and positive | common radial wall width | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.wall_width` |
| `texture.skyrmionium.kind` | `str` | `"neel"` | $1$ | "neel" or "bloch" | wall helicity family | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.kind` |
| `texture.skyrmionium.chirality` | `int` | `1` | $1$ | -1 or +1 | wall orientation | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.chirality` |
| `texture.skyrmionium.background_sign` | `int` | `1` | $1$ | -1 or +1 | common centre and far-field normal sign | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.background_sign` |
| `texture.skyrmionium.plane` | `str` | `"xy"` | $1$ | "xy", "xz", or "yz" | right-handed texture plane | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.plane` |
| `texture.skyrmionium.preset_version` | `int` | `2` | $1$ | exactly 2 | selects the v2 skyrmionium contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |
| `texture.hopfion.radius` | `float` | `required` | $\mathrm{m}$ | finite and positive | Hopf-map spatial scale | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.radius` |
| `texture.hopfion.hopf_charge` | `int` | `1` | $1$ | -1 or +1 | Hopf-map orientation sign | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.hopf_charge` |
| `texture.hopfion.background_sign` | `int` | `1` | $1$ | -1 or +1 | uniform far-field axis sign | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.background_sign` |
| `texture.hopfion.axial_scale` | `float` | `1.0` | $1$ | finite and positive | dimensionless z-axis scale | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.axial_scale` |
| `texture.hopfion.phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | finite | global target-space phase | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_params.phase_rad` |
| `texture.hopfion.preset_version` | `int` | `2` | $1$ | exactly 2 | selects the v2 hopfion contract | FDM/FEM; CPU/GPU via planner materialization | `initial_magnetization.preset_version` |

### Mapping and transform methods

| Public method or field | Default / operation | Exact implemented behavior |
|---|---|---|
| `TextureMapping.space` | `object` | public type admits `object` or `world`; v2 chooses object coordinates only for case-insensitive `object` |
| `TextureMapping.projection` | `object_local` | accepted IR values are `object_local`, `planar_xy`, `planar_xz`, and `planar_yz`; conflicts with an explicit preset plane are rejected |
| `TextureMapping.clamp_mode` | `none` in fresh Python descriptors | serializes `clamp`, `repeat`, `mirror`, or `none`; canonical Rust v2 does not currently apply it |
| `PresetTexture.with_mapping(...)` | preserves omitted fields | its public `clamp_mode` argument exposes `clamp`, `repeat`, or `mirror`; it cannot explicitly reset an already changed value to `none` |
| `PresetTexture.translate(dx, dy, dz)` | additive | adds to the stored translation |
| `PresetTexture.rotate_x/y/z(angle_rad)` | quaternion left multiplication | composes an active rotation and normalizes the accumulated quaternion |
| `PresetTexture.rotate_x/y/z_deg(angle_deg)` | degree convenience | converts degrees to radians, then uses the corresponding quaternion operation |
| `PresetTexture.scale(sx, sy, sz)` | component-wise multiplication | multiplies the existing coordinate scale; v2 planner rejection occurs if any final component has magnitude at most $10^{-14}$ |
| `PresetTexture.with_pivot(pivot)` | replacement | stores a three-component texture-transform pivot |
| `PresetTexture.to_ir()` | serialization | emits kind, preset kind/version/params, mapping, transform, UI label, and preview proxy |

The Python transform helpers use a $10^{-30}$ fallback when constructing degenerate quaternions,
whereas the canonical Rust v2 evaluator rejects a final quaternion norm at or below $10^{-14}$.
Therefore successful object construction does not imply successful planner validation.

### Complete stage-first bimeron example

```python
# %% Imports and units
import fullmag as fm

nm = 1.0e-9

# %% Study, grid, geometry, and material
study = fm.study("bimeron_initial_state")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))

film = study.geometry(fm.Box(300 * nm, 160 * nm, 4 * nm), name="film")
film.Ms = 8.0e5
film.Aex = 13.0e-12
film.alpha = 0.05

# %% Versioned analytic initial condition
film.m = fm.texture.bimeron(
    radius=45 * nm,
    wall_width=8 * nm,
    vorticity=1,
    helicity_rad=0.0,
    background_sign=1,
    plane="xy",
    preset_version=2,
)

# %% Physics and ordered stage
study.exchange()
study.demag()
study.tableautosave(
    1.0e-12,
    quantities=["t", "step", "mx", "my", "mz", "E_total"],
)
study.stages.add_minimize(
    method="bb",
    max_steps=4000,
    tolA=1.0e-5,
)
```

This example materializes and minimizes the authored field; it does not claim that this material and
geometry stabilize a bimeron.

### Inspecting the exact serialized descriptor

```python
# %% Object-level ProblemIR fragment
import json
from fullmag import texture

nm = 1.0e-9
initial = texture.bimeron(
    radius=45 * nm,
    wall_width=8 * nm,
    vorticity=-1,
    helicity_rad=0.25,
    background_sign=1,
    plane="xy",
    preset_version=2,
).with_mapping(
    space="object",
    projection="planar_xy",
)

print(json.dumps(initial.to_ir(), indent=2))
```

(python-api-magnets-and-textures-preset-textures-problem-ir)=
## ProblemIR

The object-level result of the preceding construction has this canonical shape:

```json
{
  "kind": "preset_texture",
  "preset_kind": "bimeron",
  "preset_version": 2,
  "preset_params": {
    "plane": "xy",
    "radius": 4.5000000000000006e-08,
    "wall_width": 8e-09,
    "vorticity": -1,
    "helicity_rad": 0.25,
    "background_sign": 1
  },
  "mapping": {
    "space": "object",
    "projection": "planar_xy",
    "clamp_mode": "none"
  },
  "texture_transform": {
    "translation": [0.0, 0.0, 0.0],
    "rotation_quat": [0.0, 0.0, 0.0, 1.0],
    "scale": [1.0, 1.0, 1.0],
    "pivot": [0.0, 0.0, 0.0]
  },
  "ui_label": null,
  "preview_proxy": "disc"
}
```

The initializer is stored under `magnets[].initial_magnetization`. Public factories normalize or
validate selected parameters before serialization; the planner validates the complete descriptor,
mapping, transform, and sample points again. `ui_label` and `preview_proxy` are authoring metadata
and do not alter the numerical field.

Python-created descriptors explicitly write `preset_version=2` and
`mapping.clamp_mode="none"`. Historical serialized data can omit both; the Rust IR defaults are
version 1 and `clamp`, respectively. This asymmetry is deliberate compatibility behavior and must be
preserved in provenance.

(python-api-magnets-and-textures-preset-textures-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** consists of the authored preset kind, exact version, parameter payload,
mapping, and texture transform. Serialization retains these fields rather than replacing an old
version with a new formula.

**Resolved execution** is the concrete vector array sampled on the final point ordering. The
resolved plan may also contain an active mask, FDM region override masks, or only the magnetic
subset of an FEM shared-domain mesh. Those arrays are execution products, not rewrites of the
requested descriptor.

**Validation errors** are fail-closed for unsupported versions, non-finite values, invalid signs,
unknown planes or axes, degenerate vectors, non-orthogonal bases, conflicting preset plane and
mapping projection, zero transform scale, zero quaternion, and preset-specific invalid
combinations.

**Unsupported combinations** are not silently converted to a different preset. Important current
boundaries are:

- canonical Rust v2 ignores `clamp_mode`;
- planar projection does not remap `uniform`, `random`, `helical`, or `conical`;
- `two_domain` has no centre offset;
- public `with_mapping` cannot explicitly select `none` after another clamp value;
- Python reference/pre-sampling helpers do not expose the entire canonical Rust mapping and active
  mask contract through one native call;
- texture sampling evidence is not a device-runtime qualification of the subsequent CPU or GPU
  solver.

(python-api-magnets-and-textures-preset-textures-discrete-realization)=
## Discrete realization

### FDM

The planner enumerates cell centres in `z`, `y`, `x` loops with flat index
`x + nx * (y + ny * z)`. World coordinates are
`origin + (index + 0.5) * cell_size`. Object coordinates are formed by subtracting the owning
top-level geometry translation. The active geometry mask is passed to the versioned sampler;
inactive cells receive zero vectors.

The base magnet texture is sampled once on the resolved grid. Enabled region texture overrides are
sampled on the same point array and replace base vectors only where the resolved numeric region mask
wins. CPU and GPU FDM lanes consume this planner-materialized initial vector.

### FEM

The mesh path samples the versioned preset at magnetic nodes. Shared-domain air nodes are not
magnetization degrees of freedom and are excluded. The planner receives world coordinates and, when
available, corresponding object coordinates; the current helper falls back to world coordinates if
an object-coordinate array is absent. CPU and GPU FEM lanes consume the same planner-materialized
initial vector.


### Region-owned texture realization and clipping

Object-region textures use the same analytic descriptor and transform pipeline as object-level
textures, but ownership is resolved before the sampled vectors are merged. For every FDM cell or
FEM magnetic node, Fullmag first determines the unique winning enabled region using the declared
priority. Equal highest priorities fail closed. The writable selection is

```{math}
\Omega_{\mathrm{write}}
=
\Omega_{\mathrm{magnetic\ owner}}
\cap
\Omega_{\mathrm{winning\ region}}.
```

The texture transform is evaluated only as a coordinate map inside this selection. Translation,
rotation, pivot, and scale can move or reshape the visible analytic profile, but they cannot move
the region boundary and cannot write outside `\Omega_{\mathrm{write}}`. A profile translated partly
or completely beyond its region is therefore clipped at the region boundary; cells or nodes outside
the region retain the object-level initial state or the winning texture of another region.

FDM uses the final active-cell mask and numeric winning-region mask in both single-grid and
multilayer plans. FEM evaluates region predicates on the final magnetic P1 nodes of the merged or
shared-domain mesh and applies the same priority rule. At a shared FEM interface node there is one
global nodal degree of freedom, so overlapping region claims are resolved globally by priority
rather than by silently duplicating the node.

### Numerical resolution

Analytic normalization does not remove discretization error in gradients, energy, or topological
charge. For a profile width $\ell$, compare at least two substantially finer discretizations and
monitor the relaxed energy, charge, core position, and maximum torque. For bimerons, resolve
$\Delta$ and use the exact $r_\mathrm{core}$ above rather than assuming that the cores lie at
$r=R$.

(python-api-magnets-and-textures-preset-textures-implementation-mapping)=
## Implementation mapping

The public Python layer owns ergonomic construction and early validation. `ProblemIR` owns the
versioned descriptor. The Rust planner evaluator is canonical for FDM/FEM materialization. A Python
reference evaluator and PyO3 bridge provide parity evidence, but the higher-level Python
`prepare_initial_magnetization` helper is a separate sampling path and must not be treated as an
identical implementation of every mapping detail.

The profile formulas are evaluated in double precision during planning. Device selection affects
the subsequent solver, not the formula used to create the initial vector.

(python-api-magnets-and-textures-preset-textures-validation)=
## Validation

Current automated evidence includes:

- factory serialization and invalid-parameter tests;
- right-handed `xz` frame tests;
- unit-norm, centre, far-field, vorticity, opposite-core, and exact core-radius checks for the bimeron;
- shared Rust/Python parity fixtures covering every version-2 preset kind;
- explicit version-2 tests for skyrmion polarity, vortex regularization, antivortex winding,
  physical helical period, projection conflicts, and output-vector rotation;
- FDM and FEM planner tests that exercise versioned texture materialization.

These tests establish formula and serialization contracts. They do not by themselves prove
mesh-converged energy, integer discrete charge on arbitrary finite geometries, metastability after
relaxation, or CPU/GPU trajectory parity.

For the bimeron, a publication-grade application validation should additionally report
$R/\Delta$, cell or element size relative to $\Delta$, pre- and post-relaxation topological
charge, both core positions, boundary magnetization error, energy decomposition, and a
discretization study.

(python-api-magnets-and-textures-preset-textures-limitations)=
## Limitations

- Presets are initial states, not constraints. Use a separate frozen-spin or region constraint
  mechanism when selected spins must remain fixed.
- Version 1 and version 2 are intentionally not numerically interchangeable.
- The canonical version-2 analytic sampler does not implement clamp/repeat/mirror behavior.
- Projection support is narrower than the public mapping enum suggests.
- `random` is coordinate-hashed rather than mesh-index-hashed.
- FDM and FEM object coordinates use the same validated owner-translation convention;
  texture-local rotation, pivot, and scale are handled by the shared prepared sampler.
- The Python reference route and planner route use different validation thresholds in some transform
  helpers.
- No preset factory encodes a stabilizing material model, DMI sign, anisotropy convention, external
  field, boundary condition, or relaxation protocol.

(python-api-magnets-and-textures-preset-textures-scientific-bibliography)=
## Scientific bibliography

1. B. Göbel, A. Mook, J. Henk, I. Mertig, and O. A. Tretiakov,
   “Magnetic bimerons as skyrmion analogues in in-plane magnets,”
   *Physical Review B* **99**, 060407(R) (2019),
   DOI: `10.1103/PhysRevB.99.060407`.
2. X. Zhang, J. Xia, L. Shen, M. Ezawa, O. A. Tretiakov, G. Zhao, X. Liu, and Y. Zhou,
   “Static and dynamic properties of bimerons in a frustrated ferromagnetic monolayer,”
   *Physical Review B* **101**, 144435 (2020),
   DOI: `10.1103/PhysRevB.101.144435`.
3. X. Liang, J. Lan, G. Zhao, M. Zelent, M. Krawczyk, and Y. Zhou,
   “Bidirectional magnon-driven bimeron motion in ferromagnets,”
   *Physical Review B* **108**, 184407 (2023),
   DOI: `10.1103/PhysRevB.108.184407`.
4. S.-Z. Lin, A. Saxena, and C. D. Batista,
   “Skyrmion fractionalization and merons in chiral magnets with easy-plane anisotropy,”
   *Physical Review B* **91**, 224407 (2015),
   DOI: `10.1103/PhysRevB.91.224407`.
5. D. Bachmann, M. Lianeris, and S. Komineas,
   “Meron configurations in easy-plane chiral magnets,”
   *Physical Review B* **108**, 014402 (2023),
   DOI: `10.1103/PhysRevB.108.014402`.

The papers establish physical texture classes and topology. The exact radial regularizations,
fallback thresholds, mapping behavior, and version semantics documented here are Fullmag
implementation contracts and are sourced from the repository.

(python-api-magnets-and-textures-preset-textures-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence / lane |
|---|---|---|---|---|
| public factories and validation | `packages/fullmag-py/src/fullmag/init/textures.py` | `class texture` | public analytic preset factories and factory-level validation | Python authoring |
| descriptor and ProblemIR lowering | `packages/fullmag-py/src/fullmag/init/textures.py` | `class PresetTexture` | versioned preset descriptor, immutable transform chaining, and ProblemIR serialization | Python authoring / IR |
| mapping descriptor | `packages/fullmag-py/src/fullmag/init/textures.py` | `class TextureMapping` | public object/world, projection, and clamp descriptor | Python authoring / IR |
| transform authoring | `packages/fullmag-py/src/fullmag/init/textures.py` | `class TextureTransform3D` | public translation, quaternion rotation, component scale, and pivot descriptor | Python authoring / IR |
| v1/v2 dispatch | `crates/fullmag-plan/src/magnetization_textures.rs` | `sample_preset_texture_versioned` | canonical v1/v2 dispatch used by planners | FDM/FEM planner |
| canonical v2 sampling pipeline | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `sample_v2` | v2 mapping, active-point handling, local evaluation, frame embedding, and output-vector rotation | FDM/FEM planner |
| coordinate transform | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `prepare` | one-time validation plus shared forward/inverse texture transform | FDM/FEM planner |
| region ownership and clipping | `crates/fullmag-plan/src/region_textures.rs` | `sample_region_initial_on_mask` | priority-resolved owner masks and strict clipping of regional textures | FDM/FEM planner |
| plane coordinates | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `metric_point` | right-handed planar coordinate projection for metric presets | FDM/FEM planner |
| plane-vector embedding | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `metric_vector` | embedding of local texture vectors into the world frame | FDM/FEM planner |
| preset dispatch and uniform | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `local_evaluate` | canonical v2 preset-kind dispatch and uniform evaluation | FDM/FEM planner |
| random texture | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `random_unit_vector` | SplitMix64 coordinate-hashed random unit-vector realization | FDM/FEM planner |
| vortex and antivortex | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `vortex` | regularized vortex and antivortex profile | FDM/FEM planner |
| Bloch and Neel skyrmions | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `skyrmion` | Bloch and Neel skyrmion vector profile | FDM/FEM planner |
| stable skyrmion radial profile | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `skyrmion_theta` | overflow-resistant radial skyrmion profile | FDM/FEM planner |
| bimeron profile and derived invariants | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `bimeron` | bimeron profile, winding, helicity, and background convention | FDM/FEM planner |
| domain wall | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `domain_wall` | validated Bloch or Neel one-dimensional wall | FDM/FEM planner |
| two-domain texture | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `two_domain` | sharp or smooth two-domain profile | FDM/FEM planner |
| helical texture | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `helical` | physical-wavevector helical profile | FDM/FEM planner |
| conical texture | `crates/fullmag-plan/src/magnetization_textures_v2.rs` | `conical` | physical-wavevector conical profile and deterministic transverse basis | FDM/FEM planner |
| serialized compatibility default | `crates/fullmag-ir/src/model.rs` | `default_preset_version` | legacy-safe preset_version default for serialized ProblemIR | ProblemIR |
| FDM point ordering | `crates/fullmag-plan/src/fdm.rs` | `grid_sample_points` | FDM cell-centre world/object coordinates and active mask | FDM CPU/GPU shared plan |
| FDM materialization and overrides | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM initial-state materialization and region texture overrides | FDM CPU/GPU shared plan |
| FEM materialization | `crates/fullmag-plan/src/mesh.rs` | `initial_vectors_for_magnet` | FEM magnetic-node initial-state materialization | FEM CPU/GPU shared plan |
| Python reference evaluator | `packages/fullmag-py/src/fullmag/init/preset_eval_v2.py` | `evaluate_preset_texture_v2` | Python reference evaluator and optional native parity route | reference / fallback |
| secondary Python pre-sampling | `packages/fullmag-py/src/fullmag/runtime/initial_state.py` | `prepare_initial_magnetization` | secondary Python runtime pre-sampling path and sampled-field normalization | secondary runtime helper |
| native Python/Rust bridge | `crates/fullmag-py-core/src/lib.rs` | `sample_preset_texture_v2_json` | PyO3 bridge to the canonical Rust v2 evaluator | native reference bridge |
| all-preset v2 parity | `crates/fullmag-plan/tests/magnetization_textures_v2_parity.rs` | `v2_matches_shared_python_parity_fixture_for_all_presets` | shared Rust/Python parity fixture for all v2 presets | automated test |
| rotation contract | `crates/fullmag-plan/tests/magnetization_textures_v2_contract.rs` | `v2_texture_rotation_rotates_the_output_vector` | contract test for output-vector rotation | automated test |
| bimeron regression evidence | `packages/fullmag-py/tests/test_bimeron_textures.py` | `test_bimeron_matches_shared_rust_python_parity_fixture` | Python bimeron serialization, validation, profile, and parity evidence | automated test |
| exact bimeron meron-core geometry | `crates/fullmag-plan/tests/magnetization_textures_v2_contract.rs` | `v2_bimeron_uses_exact_meron_core_radius` | regression test for the analytic core-radius relation and opposite normal cores | automated test |
