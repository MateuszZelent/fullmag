# Material regions, parameter fields, and interface couplings

- Status: accepted implementation contract
- Owners: Fullmag core
- Last updated: 2026-08-27
- Related ADRs: `docs/adr/0011-resource-first-api.md`, `docs/adr/0013-frontend-v2-module-kernel.md`, `docs/adr/0027-canonical-fem-mesh-policy-and-quality-evidence.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`
- Related plans:
  - `docs/plans/active/region-owned-mesh-material-texture-plan-2026-06-04-pl.md`
  - `docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md`
- Related physics notes:
  - `docs/physics/0100-mesh-and-region-discretization.md`
  - `docs/physics/regions/0460-sharp-interfaces-multi-body-and-parameter-fields.md`
  - `docs/physics/regions/0461-multi-region-note-corrected.md`
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`

(material-regions-problem-statement)=
## 1. Problem statement

Fullmag needs one canonical way to describe local mesh refinement, local
material variation, initial texture overrides, and explicit coupling between
magnetic bodies. These concepts must not collapse into one "region id" trick.

The physical ambiguity is severe:

- one material object can contain spatially varying coefficients and still own
  one reduced magnetization field `m`,
- two different material objects can touch and still have no direct exchange
  unless an explicit coupling is declared,
- RKKY/contact/interlayer exchange is surface physics with units `J/m^2`, not a
  volumetric `Aex` override,
- airbox is a mesh/field domain for demag and diagnostics, not a magnetic
  material region.

This note defines the contract for:

1. material objects,
2. object-owned authored regions,
3. material parameter fields,
4. realized mesh/material region markers,
5. interface couplings,
6. quantity scoping for airbox and magnetic-only fields.

## 2. Physical model

(material-regions-governing-equations)=
### 2.1 Governing equations

For one material object, the canonical reduced-field and physical-magnetization
contract is

```{math}
:label: material-magnetization

\mathbf m:\Omega\times[0,T]\to S^2,
\qquad
\mathbf M(\mathbf x,t)=M_s(\mathbf x)\mathbf m(\mathbf x,t).
```

Authored regions are selectors over this single field; they do not create
independent magnetization degrees of freedom. The heterogeneous exchange energy
and its effective field are

```{math}
:label: material-exchange-energy

E_\mathrm{ex}=\int_\Omega A(\mathbf x)|\nabla\mathbf m|^2\,\mathrm dV.
```

```{math}
:label: material-exchange-field

\mathbf H_\mathrm{ex}=\frac{2}{\mu_0 M_s}\nabla\!\cdot(A\nabla\mathbf m).
```

Across a sharp internal interface $\Gamma$ without a separate surface
coupling, the natural condition is exchange-flux continuity:

```{math}
:label: material-exchange-flux

A_1\partial_n\mathbf m_1=A_2\partial_n\mathbf m_2
\qquad\text{on }\Gamma.
```

Dla nakładających się ograniczeń siatki regionów obowiązuje ta sama kanoniczna
algebra co dla obiektu i airboxu:

```{math}
:label: eq-material-region-mesh-composition

h_{\mathrm{target}}(\mathbf x)=
\max\!\left(\min_{u\in\mathcal U(\mathbf x)}u,
             \max_{\ell\in\mathcal L(\mathbf x)}\ell\right).
```

For separate material objects, direct exchange is absent unless explicitly
authored. Demagnetization still couples their total physical magnetization.
RKKY/interlayer exchange is the surface energy

```{math}
:label: material-rkky-energy

E_\mathrm{RKKY}=-J_1\int_\Gamma
\mathbf m_1\!\cdot\!\mathbf m_2\,\mathrm dS.
```

It cannot be represented by assigning volumetric $A$ on the two sides. A
region-local parameter transition is

```{math}
:label: material-transition-blend

p(\mathbf x)=p_\mathrm{parent}
+w(d(\mathbf x),h_\mathrm{local})
\left(p_\mathrm{region}-p_\mathrm{parent}\right).
```

The corresponding discrete FDM and FEM exchange contracts are

```{math}
:label: material-fdm-harmonic-exchange

A_{ij}=\frac{2A_iA_j}{A_i+A_j}\,s_{ij}.
```

```{math}
:label: material-fdm-exchange-field

\mathbf H_{\mathrm{ex},i}=
\frac{2}{\mu_0M_{s,i}V_i}
\sum_j A_{ij}\frac{S_{ij}}{d_{ij}}
(\mathbf m_j-\mathbf m_i).
```

```{math}
:label: material-fem-weighted-mass

M_{M_s}\mathbf H_\mathrm{ex}=-\frac{2}{\mu_0}K_A\mathbf m.
```

Regionowe `maximum_element_size` jest upper target, a
`minimum_element_size` jest lower bound; żadna nazwa regionu nie aktywuje
fizyki ani nie może ominąć dolnego ograniczenia.

(material-regions-symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf x$ | physical point | $\mathrm m$ |
| $t$ | time | $\mathrm s$ |
| $T$ | terminal time | $\mathrm s$ |
| $\Omega$ | magnetic volume domain | $\mathrm{m^3}$ |
| $\Gamma$ | material interface surface | $\mathrm{m^2}$ |
| $S^2$ | unit sphere of reduced magnetization | $1$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf m_1$ | reduced magnetization on side 1 | $1$ |
| $\mathbf m_2$ | reduced magnetization on side 2 | $1$ |
| $\mathbf m_i$ | reduced magnetization in cell i | $1$ |
| $\mathbf m_j$ | reduced magnetization in cell j | $1$ |
| $\mathbf M$ | physical magnetization | $\mathrm{A/m}$ |
| $M_s$ | saturation magnetization | $\mathrm{A/m}$ |
| $M_{s,i}$ | cell saturation magnetization | $\mathrm{A/m}$ |
| $E_\mathrm{ex}$ | exchange energy | $\mathrm J$ |
| $E_\mathrm{RKKY}$ | RKKY/interlayer energy | $\mathrm J$ |
| $A$ | exchange stiffness | $\mathrm{J/m}$ |
| $A_i$ | cell-i exchange stiffness | $\mathrm{J/m}$ |
| $A_j$ | cell-j exchange stiffness | $\mathrm{J/m}$ |
| $A_1$ | side-1 exchange stiffness | $\mathrm{J/m}$ |
| $A_2$ | side-2 exchange stiffness | $\mathrm{J/m}$ |
| $\nabla$ | spatial derivative | $\mathrm{m^{-1}}$ |
| $\partial_n$ | outward-normal derivative | $\mathrm{m^{-1}}$ |
| $\mathrm dV$ | volume measure | $\mathrm{m^3}$ |
| $\mathrm dS$ | surface measure | $\mathrm{m^2}$ |
| $\mathbf H_\mathrm{ex}$ | exchange effective field | $\mathrm{A/m}$ |
| $\mathbf H_{\mathrm{ex},i}$ | cell-i exchange effective field | $\mathrm{A/m}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N/A^2}$ |
| $J_1$ | bilinear surface-coupling density | $\mathrm{J/m^2}$ |
| $\mathcal U(\mathbf x)$ | eligible upper mesh-size targets | $\mathrm m$ |
| $u$ | one upper target | $\mathrm m$ |
| $\mathcal L(\mathbf x)$ | eligible lower mesh-size bounds | $\mathrm m$ |
| $\ell$ | one lower bound | $\mathrm m$ |
| $h_\mathrm{target}$ | resolved mesh target | $\mathrm m$ |
| $p$ | selected material parameter | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ |
| $p_\mathrm{parent}$ | parent material parameter | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ |
| $p_\mathrm{region}$ | region material parameter | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ |
| $w$ | smooth transition weight | $1$ |
| $d$ | signed selector distance | $\mathrm m$ |
| $h_\mathrm{local}$ | local mesh length used by mesh-relative transition | $\mathrm m$ |
| $A_{ij}$ | discrete pair exchange coefficient | $\mathrm{J/m}$ |
| $s_{ij}$ | authored dimensionless exchange scale | $1$ |
| $i$ | current-cell index | $1$ |
| $j$ | neighbor-cell index | $1$ |
| $V_i$ | cell volume | $\mathrm{m^3}$ |
| $S_{ij}$ | shared-face area | $\mathrm{m^2}$ |
| $d_{ij}$ | cell-center distance | $\mathrm m$ |
| $M_{M_s}$ | saturation-weighted FEM mass operator | $\mathrm{A\,m^2}$ |
| $K_A$ | exchange-weighted FEM stiffness operator | $\mathrm J$ |

(material-regions-assumptions-and-validity)=
### 2.3 Assumptions and approximations

1. One material object owns one reduced magnetization field `m`.
2. Authored object regions do not create independent fields.
3. Smooth material variation is modeled as a material parameter field.
4. An object region with `realization_policy="inherit"` and only a
   `mesh_policy` is mesh-size-only. It may change element density, but it must
   not create an FEM object-region domain marker, a separate magnetic material,
   a material coefficient field, a local texture override, or duplicated
   magnetization degrees of freedom. If an OCC/Gmsh realization returns
   coincident but topologically duplicated nodes on an intra-object region
   interface, Fullmag must merge those nodes before FEM execution.
5. Sharp internal jumps in one object are allowed, but FEM requires conformal
   boundary/domain markers in strict mode.
6. Projection mode for a sharp FEM jump is an explicit extended-mode
   approximation and must be reported.
7. `Ms(x) > 0` is required for every active magnetic cell/node/element. A void
   is represented by geometry or active masks, not by `Ms=0`.
8. DMI interfaces between distinct materials are deferred to a separate physics
   note.
9. Full RKKY runtime support is capability-gated. If authored RKKY cannot be
   realized by the selected backend, the run is blocked.
10. Exact through-thickness layers and structured in-plane meshing are odrębnymi
    własnościami; regionowa polityka rozmiaru nie gwarantuje żadnej z nich.

### 2.4 Region-local material transition semantics

For one continuous magnetic object, a region-local material parameter change
does not automatically imply a sharp material interface. The authored region is
a support selector; the material transition describes how the parent parameter
and local region parameter are blended near the selector boundary.

Supported authored transition intents are:

- `mesh_relative(cells=N)`: smooth transition width tied to the local mesh scale,
- `metric(width=...)`: smooth transition width tied to a physical SI distance,
- `sharp`: discontinuous coefficient jump that may require conformal FEM
  realization.

Smooth transitions also define where the transition is anchored relative to the
region boundary:

- `scope="boundary"`: transition spans both sides of the region boundary,
- `scope="inside"`: transition is consumed only inside the region,
- `scope="outside"`: transition is consumed only outside the region.

The default for region-local `Ms` and `Aex` overrides in one object is:

```text
mesh_relative(cells=3, scope="boundary")
```

With signed distance `d(x) < 0` inside the authored region and `d(x) > 0`
outside, a smooth region-local defect realizes:

```text
p(x) = p_parent + w(d(x), h_local(x)) (p_region - p_parent)
```

where `p` is the material parameter and `w` is a smooth weight determined by
the authored transition kind, width, and scope. A smooth transition requires a
supported signed-distance evaluator for the authored region shape. Unsupported
shapes must capability-block instead of silently falling back to a bounding-box
distance or binary mask.

## 3. Numerical interpretation

### 3.1 FDM

FDM realizes material fields on a Cartesian grid. For v1, the runner/planner
materializes authored fields into cellwise arrays:

- `Ms_i`,
- `A_i`,
- `alpha_i`,
- anisotropy/DMI fields where supported,
- object/region masks,
- exchange pair descriptors.

Two material objects in one FDM grid are one backend plan, not two hidden
backend instances. The plan contains a shared `active_mask`, per-cell object or
region indices, cellwise material fields, and an explicit exchange pair table.

Intra-object region-region exchange default:

```text
A_ij = harmonic_mean(A_i, A_j) * scale(region_i, region_j)
```

with

```text
harmonic_mean(A_i, A_j) = 2 A_i A_j / (A_i + A_j)
```

unless an explicit `inter_exchange` is provided. `scale=0` or `mode=disabled`
means no direct exchange across that interface.

An authored region with no local material override, no coefficient field, and
no explicit exchange override is only a selector/authoring subobject. It must
not create a physical material boundary. If a backend materializes such a
region into an internal mask for UI, texture, or future local policy
bookkeeping, the resolved physics remains one continuous magnetic medium with
the parent material parameters.

Inter-object default:

```text
A_ij = 0
```

unless the user declares `study.couplings.exchange(...)`.

This remains true even if the two objects use the same material preset. If a
backend packs multiple authored objects into one technical region mask or
combined grid, it must emit explicit disabled exchange pairs between object ids.
The harmonic default is only an intra-object region default.

The exchange field must divide by local `Ms_i`:

```text
H_ex,i = 2 / (mu0 Ms_i V_i) sum_j A_ij (S_ij / d_ij) (m_j - m_i)
```

The exchange energy reduction must use the same `A_ij` as the field kernel.
This is a required validation target, not an implementation detail.

Multilayer FDM with region-owned material/coupling is out of scope for v1 and
must be capability-gated. It cannot silently fall through to a partially
implemented path.

### 3.2 FEM

FEM realizes material fields as coefficients over elements, nodes, or
quadrature points. For sharp piecewise constants, strict mode requires a
conformal region boundary or domain marker so the weak form can preserve the
material interface. A conformal authored-region marker is valid only when the
shared-domain mesh actually contains elements with that marker; metadata alone
must not satisfy strict conformal planning.

For exchange:

```text
E_ex = integral_Omega A(x) grad m : grad m dV
```

and the weak form naturally imposes flux continuity at conformal internal
interfaces unless an explicit surface coupling changes the condition.

For consistent-mass exchange projection with spatial `Ms(x)`, the discrete
field equation uses the `Ms`-weighted mass matrix:

```text
M_Ms H_ex = -(2 / mu0) K_A m
```

where `(M_Ms)_ij = integral Ms(x) phi_i phi_j dV`. Solving an unweighted mass
system and dividing its solution nodewise by `Ms_i` is not equivalent when
`Ms` varies spatially. The lumped path may use the corresponding diagonal
approximation `M_lumped,ii * Ms_i`.

Projection mode:

- does not split geometry,
- samples/project material coefficients onto the existing mesh,
- is acceptable for smooth fields and mild variation,
- has no v1 quantitative error guarantee for sharp piecewise jumps,
- is not the default for sharp `Aex`, `Ms`, DMI, RKKY, or validation-grade
  contact physics,
- must be visible in mesh reports, runtime provenance, and UI diagnostics.

If conformal split is requested but mesh quality or degenerate tetrahedron gates
fail, the solver must not silently continue with projected sharp jumps. The run
is blocked unless the user explicitly switches to projection mode.

### 3.2.1 FEM-TD-PHY-MAT-001: sharp element coefficients in executable time domain

For a conformal P1 mesh, a piecewise-constant `A_e` is a valid exchange weak
form coefficient in `J/m`: `E_ex = sum_e integral_{Omega_e} A_e grad m : grad
m dV`. A piecewise-constant `Ms_e` in `A/m` also has a well-defined exchange
projection through `M_Ms`, but it is not a node value. It must be read at the
same element/quadrature point by every dependent term: Zeeman and demag source
and energy, DMI normalization, anisotropy conversion, `mu0 Ms` relaxation
metric, thermal variance, Zhang-Li and Slonczewski torque, observables, and
CPU/GPU uploads. Replacing a sharp `Ms_e` by a shared-node average is forbidden:
it smears the interface and changes with mesh connectivity and numbering.

The current standard FEM time-domain/static/relaxation runtime implements
elementwise `A_e` in the CPU exchange form only. That ownership is sufficient
for `A_e` to coexist with Zeeman, demag, anisotropy, DMI, thermal/STT, Oersted,
and magnetoelastic terms: none reads `A_e`. A CPU plan rejects `A_e` only when
exchange is disabled, because then no exchange weak form consumes the sharp
coefficient. GPU rejects `A_e` before backend construction because it has no
element-coefficient upload path.

By contrast, GPU state upload and every listed dependent owner accept nodal
`Ms` or a scalar fallback, not element/quadrature `Ms_e`. A native Context is
also a reusable handle: after create, its public calls may execute LLG,
relaxation (whose metric contains `mu0 Ms`), field/energy queries, or
observables. Create cannot infer which later call will be selected. Therefore
the standard runtime rejects every elementwise `Ms_e` request on CPU and GPU
before backend construction. The diagnostic names `Ms_element_field`, the
resolved device, and the first active CPU owner in this fixed order: Zeeman,
demag, uniaxial or cubic anisotropy, interfacial or bulk DMI, thermal Brown,
Zhang-Li or Slonczewski STT, Oersted, then magnetoelastic. GPU reports its
first unavailable owner as `GPU material-state upload`. With no active CPU
owner, the explicit `native FEM handle lifecycle fallback` records that later
LLG, relaxation, field, energy, or observable calls could still select an
unsupported nodal/scalar `Ms` consumer. The rejection does not reinterpret a
sharp coefficient as a scalar or shared-node average.

This does not change the authored `ProblemIR` representation. Requested sharp
conformal material intent remains distinct from resolved execution: rejected
plans produce no backend, no fields, no energy/statistics artifact, and no
claim of a resolved heterogeneous material lane. The deferred full correction
is one backend-neutral element/quadrature material accessor shared by CPU and
GPU, followed by two-tetra analytic field/energy tests and CPU/GPU parity on
the same element IDs.

#### 3.2.2 Normative deferred element-quadrature material contract

This subsection specifies the one material realization which the deferred full
implementation must use. It is a contract for the standard FEM time-domain,
static, and relaxation lanes; it does not claim that the current fail-closed
runtime has enabled the realization.

For a conformal tetrahedral mesh `T_h`, sharp coefficients are DG0 maps:

```text
Ms_h|Omega_e = Ms_e > 0                 [A/m]
A_h |Omega_e = A_e >= 0                 [J/m]
```

Here `e` is the realized element ordinal. A non-empty map contains one ordered
P1 tetra connectivity tuple `(n0,n1,n2,n3)` with four distinct global node IDs
in range and one positive physical volume `V_e [m^3]` for every element. Input
with duplicate IDs is malformed rather than a degenerate quadrature shortcut.
Two tetrahedra sharing a face retain separate volume coefficients; the common
reduced magnetization is P1 and continuous, and its shared vertices do not own
material values. `A_e=0` has one canonical representation: a supplied IEEE-754
`-0.0` is normalized to `+0.0` before storage and digesting.

The canonical P1 integration rule is deterministic and independent of CPU/GPU
thread decomposition:

```text
integral_Omega_e Ms_e q(x) dV = Ms_e V_e q(c_e)       for P1 q,
integral_Omega_e Ms_e phi_i phi_j dV
  = Ms_e V_e / 20 * (2 if i=j else 1)                 for P1 basis functions.
```

The second identity is the exact consistent P1 tetra mass rule. It defines the
coefficient-weighted mass operator, rather than post-hoc division of an
unweighted projection:

```text
(M_Ms)_ij = sum_e integral_Omega_e Ms_e phi_i phi_j dV,
M_Ms H_ex = -(2 / mu0) K_A m.
```

For a P1 scalar proxy `u` and a piecewise constant field proxy `h_e`, the
Zeeman energy contract is

```text
E_Z = -mu0 sum_e Ms_e V_e h_e * (u_n0+u_n1+u_n2+u_n3)/4.                [J]
```

The vector form replaces the scalar product by `H_e dot m(c_e)`. This is a
material-integration oracle, not permission to approximate arbitrary fields by
a barycentre value. A term with a higher-degree integrand needs an explicit
deterministic quadrature of sufficient order and records that order.

For the executable CPU Zeeman owner, both the reduced magnetization and the
already-resolved external field are P1 nodal fields.  Their dot product is
therefore quadratic, so the sharp DG0 material realization is the exact
consistent-mass rule, not the preceding P1 proxy:

```text
E_Z,h = -mu0 sum_e Ms_e V_e / 20
          sum_{a,b=0..3} (2 if a=b else 1)
          m_{n_a} . H_ext,{n_b}                                      [J].
```

Here `mu0 [N/A^2]`, `Ms_e [A/m]`, `V_e [m^3]`, and both `m` and `H_ext`
are dimensionless and `A/m`, respectively.  The energy is negative when the
magnetization aligns with the applied field.  For a P1 tangent/probe direction
`p`, the same discrete mass operator gives the residual/projection identity

```text
d/d epsilon E_Z,h(m + epsilon p)|_{epsilon=0}
  = -mu0 sum_e Ms_e V_e / 20
      sum_{a,b=0..3} (2 if a=b else 1) p_{n_a} . H_ext,{n_b}.
```

The owner may use this identity for an unnormalised directional-derivative
oracle.  A constrained LLG or relaxation projection must apply its tangent
projection separately; it must not replace `Ms_e` by a shared-node average.
For the central-difference check, the floating-point tolerance is derived
from the sum of absolute individual P1 mass contributions before their signed
accumulation. It includes per-term and accumulation rounding, multiplication
by `mu0`, central subtraction, and division by `2 epsilon`. Scaling the bound
by the final `|E(m+epsilon p)|+|E(m-epsilon p)|` is invalid because opposite
element contributions can cancel while their rounding errors do not.
The backend-neutral `ElementQuadratureMaterial` exposes this weighted mass
bilinear and the CPU Zeeman owner consumes it through its dedicated
element-quadrature entry point.  That entry point is intentionally not wired
to public `Ms_element_field` plan creation while the other material consumers
remain unavailable, so the fail-closed planner/runtime policy stays unchanged.

For uniaxial anisotropy with a constant unit easy axis `u`, the first CPU
element-quadrature owner uses the existing P1 nodal `Ku1` and `Ku2` fields:

```text
E_u = - sum_e integral_{Omega_e} [ Ku1_h (m_h.u)^2
                                  + Ku2_h (m_h.u)^4 ] dV.              [J]
```

`Ku1_h`, `Ku2_h`, and every component of `m_h` are P1.  Consequently the
`Ku1` integrand has polynomial degree three and the `Ku2` integrand has
degree five.  The owner uses a tensor-product Duffy rule with Gauss-Legendre
orders `(4,4,3)`: after the tetrahedral Jacobian, those orders integrate every
degree-five physical polynomial exactly.  This is the required order, not a
barycentre approximation.  `Ms_e` does not occur in this conservative
energy, but the owner accepts the same `ElementQuadratureMaterial` topology
and validates its element ordinal for every integral.  The corresponding
effective field must later be projected using the same `mu0 Ms_e` mass form:

```text
M_Ms H_u = - (1 / mu0) dE_u/dm.
```

That field projection is deliberately deferred: the present helper is an
energy-and-directional-derivative oracle only and has no `Context` or public
plan wiring.  A directional test evaluates `E_u(m + eps p)` and
`E_u(m - eps p)` with the same rule and compares the central difference to
the separately integrated derivative.  Its tolerance is an absolute
termwise roundoff envelope, including quadrature accumulation and central
subtraction; cancellation in the final energy cannot shrink that bound.
The helper is a public-internal contract boundary, so it independently
rejects a non-finite axis and an axis whose Euclidean norm differs from one by
more than `128 * epsilon_double`. The native plan path normalizes a supplied
finite non-zero axis before it reaches the helper; this narrow tolerance only
admits the unavoidable rounding of that normalization, and never silently
rescales a direct helper call. For the quartic term the exact central
difference remainder is `4 eps^2 q d^3`, where `q = m_h . u` and
`d = p_h . u`; its absolute bound must therefore include `abs(q)`. The
contract oracle proves degree-five exactness independently from the production
Duffy nodes and weights by integrating barycentric monomials with
`integral_T lambda_0^a0 ... lambda_3^a3 dV = 6 V_T product(ai!) /
(sum(ai)+3)!`.

For cubic anisotropy, the matching CPU element-quadrature energy helper uses a
single directly supplied, unit orthonormal crystal frame `(c1,c2,c3)`, with
`c3 = c1 x c2`, and P1 nodal `Kc1_h`, `Kc2_h`, and `Kc3_h` in `J/m^3`:

```text
sigma_h = m1_h^2 m2_h^2 + m2_h^2 m3_h^2 + m1_h^2 m3_h^2
E_c = sum_e integral_{Omega_e} [ Kc1_h sigma_h
                                + Kc2_h m1_h^2 m2_h^2 m3_h^2
                                + Kc3_h sigma_h^2 ] dV.               [J]
```

Here `mi_h = m_h . ci`; `m_h` and each `Kc*_h` are P1.  The three integrands
have physical polynomial degrees five, seven, and nine, respectively.  The
helper uses a tensor-product Duffy Gauss-Legendre rule of orders `(6,6,5)`.
With the Duffy Jacobian, its one-dimensional exactness degrees `(11,11,9)`
cover every coordinate power of an arbitrary total-degree-nine tetrahedral
polynomial, including the Jacobian powers; this is not a barycentre or
lumped-mass approximation.  Sharp `Ms_e` is validated through the same
ordered `ElementQuadratureMaterial` map but does not enter this conservative
energy density.  The later field must use the same `mu0 Ms_e` mass projection:

```text
M_Ms H_c = - (1 / mu0) dE_c/dm.
```

This is a CPU-only energy/directional-derivative oracle with no `Context`,
MFEM state, CUDA state, or public-plan wiring, and it does not lift the
fail-closed `Ms_element_field` policy. It rejects non-finite axes, norms
different from one by more than `128 * epsilon_double`, and nonorthogonal
`c1`, `c2` under that same absolute tolerance; it never silently normalizes a
direct helper call. The two-tetra contract independently integrates the
degree-nine polynomial in barycentric monomials and compares a central
directional derivative to a separately differentiated polynomial. Its
tolerance is a termwise absolute roundoff envelope plus the independently
evaluated central-difference truncation, so inter-element cancellation cannot
weaken the oracle.

The backend-neutral accessor owns no `Context`, MFEM object, CUDA allocation,
or physics owner. It accepts ordered tetra topology, positive volumes, and
parallel `Ms_e`/`A_e` arrays; exposes direct per-element lookup and the exact
P1 mass bilinear; and publishes a canonical element-map digest. The digest is
a versioned bytewise hash of element ordinal, four global node IDs, volume and
DG0 values. CPU and GPU must receive the same digest and reject a mismatch
before consuming a map. The digest is provenance/transfer validation only; it
must never choose a coefficient at a node.

Required per-term policy after wiring the deferred accessor:

| Owner | Required sharp-material read |
| --- | --- |
| exchange residual and energy | `A_e` at element quadrature and `M_Ms` for field projection |
| Zeeman, demag source/energy, anisotropy, DMI | `Ms_e` and used material coefficients at owner quadrature |
| relaxation metric and line search | `mu0 Ms_e` through the same element mass integration |
| thermal Brown variance | local `Ms_e`, element volume/mass realization and recorded order |
| Zhang-Li and Slonczewski torque | local `Ms_e` and term coefficients at owner quadrature |
| observables and statistics | the same `Ms_e` mass weighting, never node-count/shared-node averaging |

CPU may wrap this contract in MFEM coefficients/integration objects and GPU may
upload arrays and use CUDA kernels. Neither lane may construct a nodal
projection for a sharp map. A supplied map with unsupported owners remains
rejected before backend construction. A supplied map that is omitted,
malformed, non-positive in active material, has inconsistent extent, or has a
digest mismatch is rejected fail-closed; scalar and supplied nodal payload
compatibility is unchanged.

For each coefficient independently, planning resolves exactly one realization:
uniform scalar, nodal P1, or element DG0. Supplying both nodal and element
payloads for the same coefficient is malformed and must fail before native
creation; element DG0 must not silently discard a nodal payload. This makes
the resolved material realization and its provenance unambiguous. Different
coefficients may use different legal locations, including exchange-only
`A_e` with scalar or nodal `Ms`.

When executable, resolved provenance must state
`material_realization=element_quadrature`, quadrature/mass order, element-map
digest, resolved CPU/GPU lane, and every consuming owner. Older artifacts lack
the required comparability. Evidence still deferred beyond this pure contract:
two-tetra field/energy oracle, per-owner directional derivatives, and CPU/GPU
parity on the same map. This section does not lift the current fail-closed
policy.

Contact/interface discovery is a realization step, not an authoring shortcut.
FDM resolves contact from object/region masks and cell adjacency on one grid.
FEM resolves contact from boundary/domain markers in the shared-domain mesh. If
an explicit coupling endpoint cannot be resolved to runtime faces, planning must
fail instead of dropping the coupling.

### 3.3 Hybrid

Hybrid or cross-discretization workflows must preserve authored intent and
resolved realization separately:

- authored region id/name,
- owner object,
- material field descriptor,
- projection/conformal realization,
- backend capability result,
- realized field or marker asset id.

Projection between FDM grids and FEM meshes is a realized numerical operation,
not a change in public physics semantics.

## 4. API, IR, and planner impact

(material-regions-python-api)=
### 4.1 Python API surface

The canonical public model is:

- `fm.shapes` for geometry and region selectors,
- `fm.fields` for material parameter fields,
- object-owned regions such as `waveguide.add_region(...)`,
- global `study.couplings` for inter-object/interface coupling,
- optional convenience aliases such as `waveguide.interfaces` that lower into
  `study.couplings`.

Regionowa część mesh API jest wyczerpująco zmapowana poniżej:

| Python | Type | Default | SI unit | Validation / error | Meaning | Backend support | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `ObjectRegion.mesh.maximum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite and positive | region upper target | FDM/FEM by capability | `object_regions[].mesh_policy.maximum_element_size` | `packages/fullmag-py/src/fullmag/model/structure.py::ObjectRegion` |
| `ObjectRegion.mesh.minimum_element_size` | `float \| None` | `None` | $\mathrm m$ | finite, positive, and not above maximum | region lower bound | FDM/FEM by capability | `object_regions[].mesh_policy.minimum_element_size` | `packages/fullmag-py/src/fullmag/model/structure.py::ObjectRegion` |
| `ObjectRegion.mesh.transition_distance` | `float \| None` | `None` | $\mathrm m$ | finite and non-negative | region transition span | FEM by capability | `object_regions[].mesh_policy.transition_distance` | `packages/fullmag-py/src/fullmag/model/structure.py::ObjectRegion` |
| `ObjectRegion.mesh.order` | `int \| None` | `None` | $1$ | integer at least one | region FEM basis-order intent | FEM by capability | `object_regions[].mesh_policy.order` | `packages/fullmag-py/src/fullmag/model/structure.py::ObjectRegion` |

Public material names, every constructor argument, and every coupling argument are mapped below. Units on `unit` arguments are metadata strings (`1` as the string field itself); the physical field-value unit is fixed by the selected material name.

| Python | Type | Default | SI unit | Validation / error | Meaning | Backend support | ProblemIR destination | Source |
|---|---|---|---|---|---|---|---|---|
| `MaterialParameterName.Ms` | `MaterialParameterField` | `authored assignment value` | $\mathrm{A/m}$ | constant scalar must be > 0; positivity of non-constant or vector payloads is not checked by the current Python assignment validator and remains a fail-closed planner/runtime requirement | typed Ms material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Ms` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Aex` | `MaterialParameterField` | `authored assignment value` | $\mathrm{J/m}$ | constant scalar must be >= 0; non-negativity of non-constant or vector payloads is not checked by the current Python assignment validator | typed Aex material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Aex` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Alpha` | `MaterialParameterField` | `authored assignment value` | $1$ | constant scalar must be >= 0; non-negativity of non-constant or vector payloads is not checked by the current Python assignment validator | typed Alpha material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Alpha` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Ku1` | `MaterialParameterField` | `authored assignment value` | $\mathrm{J/m^3}$ | constant scalar must be finite; the generic field container currently accepts incompatible vector arity, which a consuming planner must reject | typed Ku1 material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Ku1` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Ku2` | `MaterialParameterField` | `authored assignment value` | $\mathrm{J/m^3}$ | constant scalar must be finite; the generic field container currently accepts incompatible vector arity, which a consuming planner must reject | typed Ku2 material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Ku2` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.AnisotropyAxis` | `MaterialParameterField` | `authored assignment value` | $1$ | physical value is a finite three-vector; the current generic assignment validator does not reject a scalar payload, which is a current limitation | typed AnisotropyAxis material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::AnisotropyAxis` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Kc1` | `MaterialParameterField` | `authored assignment value` | $\mathrm{J/m^3}$ | constant scalar must be finite; incompatible vector arity is a current validation limitation | typed Kc1 material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Kc1` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Kc2` | `MaterialParameterField` | `authored assignment value` | $\mathrm{J/m^3}$ | constant scalar must be finite; incompatible vector arity is a current validation limitation | typed Kc2 material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Kc2` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Kc3` | `MaterialParameterField` | `authored assignment value` | $\mathrm{J/m^3}$ | constant scalar must be finite; incompatible vector arity is a current validation limitation | typed Kc3 material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Kc3` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Dind` | `MaterialParameterField` | `authored assignment value` | $\mathrm{J/m^2}$ | constant scalar must be finite; either sign is allowed; incompatible vector arity is a current validation limitation | typed Dind material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Dind` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `MaterialParameterName.Dbulk` | `MaterialParameterField` | `authored assignment value` | $\mathrm{J/m^2}$ | constant scalar must be finite; either sign is allowed; incompatible vector arity is a current validation limitation | typed Dbulk material-parameter selection | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterNameIR::Dbulk` | `packages/fullmag-py/src/fullmag/model/structure.py::_normalize_parameter_name` |
| `fm.fields.constant.value` | `float \| tuple[float, float, float]` | `required` | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ | scalar must be finite; vector must contain exactly three finite components; otherwise ValueError | constant scalar/vector payload | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Constant.value` | `packages/fullmag-py/src/fullmag/fields.py::constant` |
| `fm.fields.constant.unit` | `str \| None` | `None` | $1$ | when provided, must be non-empty; current Python code does not validate that the string matches the selected parameter SI unit | declared unit metadata | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Constant.unit` | `packages/fullmag-py/src/fullmag/fields.py::constant` |
| `fm.fields.linear.base` | `float` | `required` | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ | must be finite; otherwise ValueError | field value at the object-frame origin | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Linear.base` | `packages/fullmag-py/src/fullmag/fields.py::linear` |
| `fm.fields.linear.gradient` | `tuple[float, float, float]` | `required` | $\{\mathrm{A/m^2},\mathrm{J/m^2},\mathrm{m^{-1}},\mathrm{J/m^4},\mathrm{J/m^3}\}$ | must contain exactly three finite components; otherwise ValueError | spatial gradient | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Linear.gradient` | `packages/fullmag-py/src/fullmag/fields.py::linear` |
| `fm.fields.linear.frame` | `Literal["object", "world"]` | `"object"` | $1$ | case-normalized to object/world; any other token gives ValueError | coordinate frame | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Linear.frame` | `packages/fullmag-py/src/fullmag/fields.py::linear` |
| `fm.fields.linear.unit` | `str \| None` | `None` | $1$ | when provided, must be non-empty; SI consistency with the target parameter is not currently machine-validated | declared base-value unit metadata | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Linear.unit` | `packages/fullmag-py/src/fullmag/fields.py::linear` |
| `fm.fields.radial.center` | `tuple[float, float, float]` | `required` | $\mathrm m$ | must contain exactly three finite components; otherwise ValueError | radial-field center | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.center` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.radius` | `float` | `required` | $\mathrm m$ | must be finite and > 0; otherwise ValueError | radial transition radius | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.radius` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.inside` | `float` | `required` | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ | must be finite; otherwise ValueError | value inside the radius | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.inside` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.outside` | `float` | `required` | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ | must be finite; otherwise ValueError | value outside the radius | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.outside` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.frame` | `Literal["object", "world"]` | `"object"` | $1$ | case-normalized to object/world; any other token gives ValueError | coordinate frame | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.frame` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.unit` | `str \| None` | `None` | $1$ | when provided, must be non-empty; SI consistency with the target parameter is not currently machine-validated | declared field-value unit metadata | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.unit` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.sampled.asset_id` | `str` | `required` | $1$ | must be non-empty; otherwise ValueError | sampled-field artifact identity | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Sampled.asset_id` | `packages/fullmag-py/src/fullmag/fields.py::sampled` |
| `fm.fields.sampled.component_count` | `int` | `required` | $1$ | integer must be >= 1; otherwise ValueError; compatibility with the selected material parameter is a current planner-validation boundary | components per sample | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Sampled.component_count` | `packages/fullmag-py/src/fullmag/fields.py::sampled` |
| `fm.fields.sampled.location` | `Literal["cell", "node", "element", "quadrature"]` | `required` | $1$ | case-normalized to the four listed tokens; any other token gives ValueError | sample association | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Sampled.location` | `packages/fullmag-py/src/fullmag/fields.py::sampled` |
| `fm.fields.sampled.unit` | `str` | `required` | $1$ | must be non-empty; SI consistency with the selected parameter is not currently machine-validated | declared sampled-value unit metadata | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Sampled.unit` | `packages/fullmag-py/src/fullmag/fields.py::sampled` |
| `study.couplings.exchange.source` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to an object, ObjectRegion, CouplingEndpoint, or non-empty object name; otherwise TypeError/ValueError | source endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.source` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.target` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to an object, ObjectRegion, CouplingEndpoint, or non-empty object name; otherwise TypeError/ValueError | target endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.target` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.mode` | `Literal["harmonic_mean", "explicit", "disabled"]` | `"harmonic_mean"` | $1$ | invalid token gives ValueError; harmonic_mean forbids inter_exchange; explicit requires it; disabled requires scale=0 or None | exchange coupling policy | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::Exchange.mode` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.scale` | `float \| None` | `None` | $1$ | when provided, must be finite and >= 0; disabled mode accepts only 0 or None | dimensionless exchange scale | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::Exchange.scale` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.inter_exchange` | `float \| None` | `None` | $\mathrm{J/m}$ | when provided, must be finite; required for explicit mode and forbidden for harmonic_mean | explicit inter-object exchange stiffness | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::Exchange.inter_exchange` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.coupling_id` | `str \| None` | `None` | $1$ | None generates a deterministic id; an authored id must be non-empty when lowered with to_ir, otherwise ValueError | coupling identity | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.coupling_id` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.enabled` | `bool` | `True` | $1$ | current lowering coerces by bool(value) rather than rejecting non-bool input; strict type validation is a current limitation | activation flag | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.enabled` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.capability_policy` | `Literal["require_runtime", "authored_only"]` | `"require_runtime"` | $1$ | any other token gives ValueError | runtime capability policy | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.capability_policy` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.rkky.source` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to CouplingEndpoint.surface with selector top/bottom/left/right/front/back; otherwise ValueError | source endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.source` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.target` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to CouplingEndpoint.surface with selector top/bottom/left/right/front/back; otherwise ValueError | target endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.target` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.J1` | `float` | `required` | $\mathrm{J/m^2}$ | must be finite; either sign is allowed; otherwise ValueError | bilinear RKKY surface density | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::Rkky.j1` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.coupling_id` | `str \| None` | `None` | $1$ | None generates a deterministic id; an authored id must be non-empty when lowered with to_ir, otherwise ValueError | coupling identity | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.coupling_id` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.enabled` | `bool` | `True` | $1$ | current lowering coerces by bool(value); strict type validation is a current limitation | activation flag | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.enabled` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.capability_policy` | `Literal["require_runtime", "authored_only"]` | `"require_runtime"` | $1$ | any other token gives ValueError | runtime capability policy | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.capability_policy` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.interlayer_exchange.source` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to CouplingEndpoint.surface with selector top/bottom/left/right/front/back; otherwise ValueError | source endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.source` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.target` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to CouplingEndpoint.surface with selector top/bottom/left/right/front/back; otherwise ValueError | target endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.target` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.J1` | `float` | `required` | $\mathrm{J/m^2}$ | must be finite; either sign is allowed; otherwise ValueError | bilinear interlayer surface density | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::InterlayerExchange.j1` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.J2` | `float \| None` | `None` | $\mathrm{J/m^2}$ | when provided, must be finite; either sign is allowed; otherwise ValueError | biquadratic interlayer surface density | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::InterlayerExchange.j2` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.coupling_id` | `str \| None` | `None` | $1$ | None generates a deterministic id; an authored id must be non-empty when lowered with to_ir, otherwise ValueError | coupling identity | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.coupling_id` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.enabled` | `bool` | `True` | $1$ | current lowering coerces by bool(value); strict type validation is a current limitation | activation flag | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.enabled` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.capability_policy` | `Literal["require_runtime", "authored_only"]` | `"require_runtime"` | $1$ | any other token gives ValueError | runtime capability policy | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.capability_policy` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |

Example:

Example:

```python
# %% Complete canonical FEM study with material fields and explicit coupling.
import fullmag as fm

study = fm.study("material-fields-and-coupling")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(260e-9, 180e-9, 100e-9))
study.universe.mesh(maximum_element_size=24e-9)

lower = study.geometry(
    fm.Box(size=(120e-9, 60e-9, 2e-9)).translate((0.0, 0.0, -1e-9)),
    name="lower",
)
upper = study.geometry(
    fm.Box(size=(120e-9, 60e-9, 2e-9)).translate((0.0, 0.0, 1e-9)),
    name="upper",
)
lower.Ms = 800e3
lower.Aex = 13e-12
lower.alpha = 0.02
lower.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
upper.Ms = 780e3
upper.Aex = 12e-12
upper.alpha = 0.02
upper.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
lower.mesh(maximum_element_size=6e-9)
upper.mesh(maximum_element_size=6e-9)

study.exchange()
study.demag(realization="poisson_robin")
study.couplings.rkky(
    source=lower.surface("top"),
    target=upper.surface("bottom"),
    J1=-0.3e-3,
)
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1)
```

The executable study deliberately uses scalar `lower.Ms`: assigning a
`MaterialParameterField` directly to the scalar material slot is not supported
and currently fails during stage lowering. Field construction and descriptor
lowering are current and can be inspected independently:

```pycon
>>> ms_profile = fm.fields.linear(
...     base=800e3,
...     gradient=(0.0, 2.0e11, 0.0),
...     frame="object",
...     unit="A/m",
... )
>>> ms_profile.to_ir()
{'kind': 'linear', 'base': 800000.0, 'gradient': [0.0, 200000000000.0, 0.0], 'frame': 'object', 'unit': 'A/m'}
```

Direct property assignment such as `lower.Ms = ms_profile` remains outside the
current builder contract; adding that ergonomic builder path is planned. Until
then, `MaterialParameterField.to_ir()` proves descriptor semantics only and is
not evidence that a selected runtime consumes the spatial field.

`ObjectRegion.mesh` uses the same maximum/minimum ordering rule as object mesh
controls. `fm.fields.constant`, `linear`, `radial`, and `sampled` are the
implemented field constructors. Inter-object exchange, RKKY, and interlayer
exchange are authored only through `study.couplings`; precomputed conformal
markers remain declarations about an already-populated mesh, not generated
region topology.
(material-regions-problem-ir)=
### 4.2 ProblemIR representation

`ProblemIR` needs distinct authored and realized concepts:

- legacy `RegionIR` remains a body/geometry binding compatibility type,
- new `ObjectRegionIR` represents owner-scoped authored regions,
- `MaterialParameterFieldIR` represents authored scalar/vector field intent,
- `MaterialIR.*_field` remains realized/runtime payload, not authored intent,
- `CouplingIR` represents explicit exchange/RKKY/interface coupling,
- realized mesh/material region markers remain runtime/meshing assets.

Required validation:

- object region owner exists,
- region names are unique within an owner,
- `region_id` is stable and globally unique,
- shape dimensions are positive,
- material parameter fields have finite values and valid units,
- `Ms > 0` for active magnetic domains,
- airbox cannot receive `m`, `Ms`, `Aex`, anisotropy, DMI, or texture
  attachments,
- RKKY endpoints are surface/object boundary endpoints,
- unsupported RKKY blocks runtime planning,
- multilayer FDM + region-owned material/coupling is rejected for v1.

Planowane typowane pola V04 dla regionowej polityki siatki przechodzą w jednym
atomic cutover razem z ADR 0024 i ADR 0027. Requested intent pozostaje w
`ObjectRegionIR.mesh_policy`; resolved execution, markery i realne pola należą
do artifacts/provenance. Dual-write V03/V04 i heurystyczne odczyty są zabronione.

### 4.3 Planner and capability-matrix impact

The planner must resolve:

1. authored regions,
2. material object ownership,
3. material parameter fields,
4. overlap/priority conflicts,
5. conformal versus projected realization,
6. coupling endpoints and surface selectors,
7. backend support and capability diagnostics,
8. realized mesh/material/runtime payloads.

Default exchange policy:

- intra-object region-region: harmonic mean,
- inter-object without explicit coupling: none/free surface,
- object-object harmonic mean only after explicit `study.couplings.exchange`.

Surface selector v1:

- `surface("top")` is the maximum local-`z` bounding-box face with tolerance,
- FDM resolves it to exposed/contact cell faces and adjacency pairs,
- FEM resolves it to boundary face markers in the shared-domain mesh,
- named surfaces and arbitrary feature selectors are v2.

(material-regions-backend-matrix)=
### 4.4 Backend matrix

| Lane | Region mesh policy | Material/interface physics |
|---|---|---|
| FDM CPU | regular-grid realization | canonical reference where capability exists |
| FDM GPU | regular-grid realization | capability-gated parity, no silent CPU fallback |
| FEM CPU | conformal or explicit projection | shared-domain coefficients and markers |
| FEM GPU | ta sama canonical mesh intent | osobna realizacja runtime, wspólna semantyka |

(material-regions-discrete-realization)=
### 4.5 Discrete realization

FDM materializuje maski i pola na komórkach. FEM materializuje conformal domain
markers albo jawnie raportowaną projekcję. Region mesh-only pozostaje polem
rozmiaru i nie tworzy niezależnych stopni swobody magnetyzacji.

(material-regions-round-trip-and-failure-semantics)=
### 4.6 Round-trip and failure semantics

Python/UI round-trip zachowuje requested intent: właściciela, nazwę, shape,
`mesh_policy`, material fields i couplings. Resolved execution zachowuje
markery, projection/conformal mode oraz capability result. Validation errors
blokują niepoprawne zakresy i `Ms<=0`; unsupported combinations blokują planner.
Nie wolno porzucać regionu lub coupling po cichu.

(material-regions-implementation-mapping)=
### 4.7 Implementation mapping

`ObjectRegion.mesh` zapisuje cztery bieżące parametry. `RegionMeshPolicyIR` jest
ich typowanym kontraktem Rust, a `validate_region_mesh_policy` weryfikuje liczby.
Pełna realizacja wszystkich material/interface przypadków pozostaje zgodna z
macierzą capability i nie wynika z samej obecności tych typów.

### 4.8 Review decision log

The following answers close the architectural questions raised during review.
They are part of the physics contract, not implementation preferences.

| Question | Contract answer |
|---|---|
| Do two regions inside one object exchange-couple by default? | Yes. They are one continuum field `m`; default exchange uses harmonic mean `A_ij` unless explicitly overridden. |
| Do two separate objects exchange-couple by default? | No. Separate objects have free surfaces unless `study.couplings.exchange(...)` or another explicit coupling is authored. |
| Can FDM keep the old cross-region zero default? | Only for legacy plan versions. Current region-owned semantics require explicit `exchange_pair_default=harmonic_mean` and pair descriptors; `exchange_pair_default=unspecified` is a zero-initialized legacy compatibility value, not current region-owned semantics. |
| Can unsupported RKKY be a warning? | No. Authored RKKY can remain in the model, but solver start is blocked until the selected backend supports the operator. |
| Is `Ms=0` a valid way to make a void? | No. Active magnetic cells/nodes/elements require `Ms > 0`; voids are geometry or masks. |
| How is field/energy consistency validated? | Exchange field and energy must share one `A_ij` definition and pass a directional-derivative/Taylor test. |
| What does `surface("top")` mean in v1? | A local bounding-box face selector with tolerance, resolved during materialization to FDM cell-face pairs or FEM boundary markers. |
| What if a selector cannot be resolved? | Explicit coupling endpoints that cannot resolve to runtime faces block planning; the coupling is not silently dropped. |
| Is FEM projection equivalent to conformal material splitting? | No. Projection is an explicit extended-mode approximation for smooth or intentionally smeared fields, not a production default for sharp jumps. |
| Is projection allowed for RKKY/contact/DMI interfaces? | No default projection path. These need an explicit runtime interface or a capability block. |
| Is multilayer FDM with regions in v1? | No. It is capability-gated out of scope until the multilayer plan descriptor supports region masks/material fields/couplings. |
| Is old `MaterialIR.ms_field` authored intent? | No. It is a realized/runtime compatibility payload; authored fields use `MaterialParameterFieldIR`. |
| How are object contacts discovered? | Contact discovery is a runtime materialization step: FDM uses mask adjacency; FEM uses shared-domain boundary/domain markers. |

(material-regions-validation)=
## 5. Validation strategy

### 5.1 Analytical checks

1. Uniform material with no regions matches existing exchange reference.
2. Two intra-object regions with `A1 != A2` use harmonic face coefficients.
3. The FDM exchange field and exchange energy pass a directional derivative
   Taylor test with the same `A_ij`.
4. `Ms(x)` in the exchange denominator changes `H_ex` locally as expected.
5. `Ms=0` in active magnetic cells/nodes/elements is rejected before runtime.

### 5.2 Cross-backend checks

1. Smooth `Ms(x)` and `Aex(x)` field authoring lowers to FDM cell fields and FEM
   coefficient fields with matching provenance.
2. FEM conformal split preserves domain markers and exchange flux continuity for
   piecewise `Aex`.
3. FEM projection mode emits warning/provenance and is not accepted in strict
   mode for sharp material jumps.
4. FDM and FEM agree qualitatively on relaxation for a simple two-region
   heterogeneous body at converged mesh/grid resolution.

### 5.3 Regression tests

Required regression names can be refined during implementation, but coverage
must include:

- `intra_object_region_exchange_defaults_harmonic_mean`,
- `object_object_exchange_without_coupling_defaults_none`,
- `object_object_exchange_with_harmonic_mean_coupling_builds_pair_table`,
- `exchange_scale_zero_disables_interface_exchange`,
- `exchange_field_energy_directional_derivative_consistency`,
- `ms_zero_in_active_object_is_validation_error`,
- `rkky_unsupported_blocks_runtime_plan`,
- `surface_top_selector_resolves_to_runtime_faces`,
- `multilayer_fdm_regions_are_capability_gated`,
- `airbox_rejects_magnetic_material_and_m_quantity`.

## 6. Completeness checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [x] Documentation

(material-regions-limitations)=
## 7. Known limits and deferred work

- Full production RKKY runtime operators are deferred until backend capability
  work lands. Authored RKKY may exist, but unsupported runtime execution blocks.
- DMI interface physics between distinct material objects is deferred to a
  separate note.
- Named faces and arbitrary feature selectors are deferred to selector v2.
- Automatic conformal CSG split for arbitrary region shapes is deferred.
- Production strict-conformal runtime mapping still requires discontinuous
  element/domain `A` and `Ms` coefficients while retaining one shared
  magnetization field across the internal interface. Duplicating interface
  magnetization DOFs is not an acceptable realization of an intra-object
  material region.
  Conformal v1 supports box and cylinder regions fully contained in an
  OCC-compatible owner geometry. The cylinder axis may be arbitrary. Other
  shapes remain projection-only or require a precomputed shared-domain mesh.
  Every authored-region marker must occur in the actual element marker array;
  marker metadata alone is invalid.
- Multilayer FDM plus region-owned material/coupling is deferred behind a
  capability gate.
- Runtime texture authoring is deferred; region texture override in v1 is an
  initial-condition feature.

(material-regions-scientific-bibliography)=
## 8. References

- Mumax+/Mumax region exchange semantics: default harmonic mean inside one
  shared magnet, explicit scale/inter exchange for overrides.
- Tetrax/FEM weak-form interpretation: coefficient fields and conformal domain
  markers for sharp material interfaces.
- Fullmag masterplan:
  `docs/plans/active/region-owned-implementation-masterplan-2026-06-04-pl.md`.

(material-regions-source-code-index)=
## 9. Source-code index

| Warstwa | Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|---|
| Python API | `packages/fullmag-py/src/fullmag/model/structure.py` | `class ObjectRegion` | owner-scoped region i `mesh_policy` |
| ProblemIR | `crates/fullmag-ir/src/model.rs` | `RegionMeshPolicyIR` | typowane cztery pola polityki |
| Walidacja IR | `crates/fullmag-ir/src/lib.rs` | `validate_region_mesh_policy` | skończoność, dodatniość i order |
| Meshing | `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py` | `_build_field_stack` | regionowe pola rozmiaru |
| Python fields | `packages/fullmag-py/src/fullmag/model/structure.py` | `class MaterialParameterField` | public authored field constructors |
| Python vocabulary | `packages/fullmag-py/src/fullmag/model/structure.py` | `class MaterialParameterField` | accepted parameter-field owner |
| Python couplings | `packages/fullmag-py/src/fullmag/model/couplings.py` | `class CouplingRegistry` | explicit exchange/RKKY authoring |
| ProblemIR fields | `crates/fullmag-ir/src/model.rs` | `MaterialParameterFieldIR` | typed field intent |
| ProblemIR vocabulary | `crates/fullmag-ir/src/model.rs` | `MaterialParameterNameIR` | typed parameter names |
| ProblemIR couplings | `crates/fullmag-ir/src/model.rs` | `CouplingIR` | typed explicit couplings |
| FEM material core | `backends/fem/core/fem_element_quadrature_material.hpp` | `class ElementQuadratureMaterial` | element/quadrature material access |
