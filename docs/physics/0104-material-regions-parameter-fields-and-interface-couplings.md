# Material regions, parameter fields, and interface couplings

- Status: accepted implementation contract
- Owners: Fullmag core
- Last updated: 2026-11-01
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

A_{ij}=s_{ij}\,H(A_i,A_j).
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
| $\max$ | algebraic maximum operator | $1$ |
| $\min$ | algebraic minimum operator | $1$ |
| $\sum_j$ | finite sum over neighbor index j | $1$ |
| $H$ | guarded harmonic mean of two exchange stiffnesses | $\mathrm{J/m}$ |
| $a$ | first harmonic-mean argument | $\mathrm{J/m}$ |
| $b$ | second harmonic-mean argument | $\mathrm{J/m}$ |
| $A^{\mathrm{explicit}}_{ij}$ | authored explicit connection exchange stiffness | $\mathrm{J/m}$ |
| $F_+$ | set of grid connections, each counted once | $1$ |
| $\cdot$ | Euclidean dot-product operator | $1$ |
| $|\cdot|^2$ | squared Euclidean-norm operator | $1$ |
| $\nabla\!\cdot$ | divergence differential operator | $\mathrm{m^{-1}}$ |
| $\int_\Omega(\cdot)\,\mathrm dV$ | volume-integration operator | $\mathrm{m^3}$ |
| $\int_\Gamma(\cdot)\,\mathrm dS$ | surface-integration operator | $\mathrm{m^2}$ |

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

A `sharp` transition, and a parameter whose resolved transition is none, needs
only membership. CSG regions have no signed-distance evaluator, so the planner
evaluates their membership with the analytic selection predicate (inclusive
boundary, relative tolerance `1e-12`) and uses `d = -1` inside and `d = +1`
outside. A CSG region whose resolved transition is smooth, including the
`Ms`/`Aex` default above, still capability-blocks; the planner never substitutes
`sharp` for an unspecified transition.

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
backend instances. The plan contains a shared `active_mask`, per-cell region
indices with a region legend that names each region's owner object, cellwise
material fields, and a sparse list of typed exchange pair rules
(`harmonic_scale`, `explicit`, `disabled`). There is no dense table of all
region pairs and no architectural region-count limit: region indices are `u32`,
and the cost of the rules is proportional to their number.

Intra-object region-region exchange default (labelled equations
`material-fdm-harmonic-exchange` and `material-fdm-guarded-harmonic-mean`):
$A_{ij}=s_{ij}H(A_i,A_j)$ with $s_{ij}=1$ when no rule is authored. An
`explicit` rule replaces the harmonic value by $A^{\mathrm{explicit}}_{ij}$;
`scale=0` or `mode=disabled` means no direct exchange across that interface.

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

(material-regions-fdm-connection-operator)=
#### 3.1.1 FDM connection operator without a region limit

Every pair of face-adjacent cells $(i,j)$ of the regular grid is one
connection. A connection exists only when both cells are active and the grid
provides the neighbour (open boundaries have none; a periodic axis of length 1
has no self-connection; a periodic axis of length 2 has two distinct
connections between the same two cells). The coefficient of an existing
connection is

```{math}
:label: material-fdm-connection-coefficient

A_{ij}=\begin{cases}
0 & \text{owners differ and no rule is authored, or rule }\texttt{disabled},\\
A^{\mathrm{explicit}}_{ij} & \text{rule }\texttt{explicit},\\
s_{ij}\,H(A_i,A_j) & \text{rule }\texttt{harmonic\_scale}\text{ or no rule}.
\end{cases}
```

The guarded harmonic mean is

```{math}
:label: material-fdm-guarded-harmonic-mean

H(a,b)=\begin{cases}
0 & a=0\ \text{or}\ b=0,\\
a & a=b,\\
\dfrac{2ab}{a+b} & \text{otherwise}.
\end{cases}
```

The branch $a=b$ returns $a$ exactly, so a uniform material divided into any
number of regions reproduces the uniform operator. Realizations evaluate the
last branch as $2a\,\bigl(b/(a+b)\bigr)$ to avoid overflow of $ab$. Rules use
the realized cell values $A_i$, $A_j$ (after transitions), not the nominal
material table. Each connection is counted once in the energy

```{math}
:label: material-fdm-exchange-energy-discrete

E_\mathrm{ex}=\sum_{(i,j)\in F_+}A_{ij}\,\frac{S_{ij}}{d_{ij}}
\,|\mathbf m_j-\mathbf m_i|^2,
```

and both cells of a connection use the same $A_{ij}$; then
{eq}`material-fdm-exchange-field` equals
$-\partial E_\mathrm{ex}/\partial\mathbf m_i/(\mu_0M_{s,i}V_i)$. On the regular
grid $S_{ij}/d_{ij}=V_i/h^2$ along the connection axis. Region energy assigns
half of each connection energy to each side; the sum over a disjoint partition,
including the unnamed base region 0, reproduces the total.

Realized operator modes are explicit: `uniform` (every existing connection has
the scalar material $A$ and no active cell carries a local $A_i$ different from
it, so a lane that ignores the faces reproduces them; the classic Laplacian
kernel is used) or `faces`
(coefficients stored per cell on its $+x$, $+y$, $+z$ connection; the $-x$
coefficient of cell $i$ is the $+x$ coefficient of its $-x$ neighbour, with
periodic wrap). One shared builder produces the coefficients for the CPU
reference and for CUDA, so both lanes consume identical $A_{ij}$. Different
objects packed into one grid are decoupled through the owner recorded in the
region legend, without generating pair rules for every object pair.

(material-regions-fdm-lane-realization)=
#### 3.1.2 FDM CPU and CUDA realization of heterogeneous materials

- **FDM CPU reference.** The `faces` mode replaces the per-cell harmonic
  stencil; the field divides by local $M_{s,i}$ and the energy follows
  {eq}`material-fdm-exchange-energy-discrete` including periodic connections.
  The `uniform` mode keeps the existing structure-of-arrays fast path.
- **FDM CUDA.** The 256×256 pair table and its region-index limit are retired.
  The plan descriptor carries the operator mode and, for `faces`, three
  coefficient arrays; optional per-cell `ms_field` and `alpha_field` arrays
  (null means the scalar value) enter the demagnetization source
  $\mathbf M=M_{s,i}\mathbf m_i$, the local field prefactors
  $2/(\mu_0M_{s,i})$, the demagnetization/Zeeman energies and every LLG
  right-hand side through $\alpha_i$ and $\gamma/(1+\alpha_i^2)$.
- **Face coefficients alone** change only exchange. The binary-mask, T0 and T1
  exchange kernels and their energy reductions all read the same per-connection
  coefficients, so region rules and the multi-object owner decoupling combine
  with every other term.
- **CUDA combinations that stay blocked** with cellwise $M_s$ or $\alpha$:
  boundary correction T0/T1 (its demagnetization correction and field scale use
  the scalar $M_s$), Brown thermal noise, Zhang-Li/Slonczewski/SOT and GPU
  transport torques, and rotated interfacial DMI with non-uniform $M_s$. DMI
  with non-uniform $A$ stays blocked on CUDA until its parity with the CPU
  reference is qualified (the DMI stencil and its free-surface term do not
  read $A$ on either lane), and cellwise DMI fields remain unsupported. One
  predicate on the FDM plan rejects each combination with an explicit
  `fdm_cuda_heterogeneous_material_unsupported:<owner>` error: at planning time
  for an explicit CUDA request, and again at backend construction. There is no
  CPU fallback. A GPU transport binding attached after construction through the
  public C ABI (`fullmag_fdm_context_bind_gpu_transport_v1`) is rejected with
  `fdm_cuda_heterogeneous_material_unsupported:gpu_transport` when the backend
  holds cellwise $M_s$ or $\alpha$, because the transport torque term uses the
  scalar $\alpha$. The native backend also rejects a cellwise $A$ that differs from
  the scalar on an active cell but arrives without face coefficients
  (`a_field_requires_exchange_faces`), because CUDA exchange reads $A$ only from
  the faces.
- **DMI across decoupled connections (CPU and CUDA).** The FDM DMI stencils
  (notes 0404–0406) couple a cell to every active neighbour and apply the
  free-surface term only at grid edges and inactive neighbours. They do not
  read $A$, so positive non-uniform face coefficients (harmonic scale, explicit
  $A_{ij}>0$, a cellwise $A$) leave DMI unchanged. A connection with $A_f=0$
  between two active cells is different: exchange treats it as a free surface,
  while DMI would still couple the two sides and omit the free-surface term on
  both. Such connections come from touching objects with different owners, an
  explicit zero inter-region stiffness, a `Disabled` rule, or a cell with
  $A=0$. Until the DMI stencils read the connection operator, the FDM runner
  rejects interfacial, rotated interfacial or bulk DMI (scalar or cellwise
  $D\ne0$) when the resolved `faces` operator has such a connection along an
  axis that the DMI term couples, on CPU and CUDA, with
  `fdm_dmi_decoupled_exchange_connection`, after resolving the operator and
  before the first step. Interfacial and rotated interfacial DMI couple only
  $x$/$y$ neighbours, so stacked films decoupled along $z$ stay allowed; bulk
  DMI also checks $z$. Without an exchange field the objects and rules still
  define the connections: the runner resolves them with a placeholder positive
  stiffness, so only owners and rules decide. The native C ABI repeats the
  check for a `FACES` tail, counting only terms with $D\ne0$. The gate is
  fail-closed and has no fallback; physical DMI
  coupling across an interface between distinct materials remains deferred
  (assumption 8).
- **Magnetoelastic coupling** (prescribed strain, note 0700). The energy density
  $e_\mathrm{mel}(\mathbf m_i,\boldsymbol\varepsilon_i)$ does not depend on
  $M_s$, so the field divides by the local moment:
  $\mathbf H_{\mathrm{mel},i} = -\frac{1}{\mu_0 M_{s,i}}\,
  \partial e_\mathrm{mel}/\partial\mathbf m_i$ on CPU and CUDA. With tensor
  strain the shear part of the derivative carries $2B_2\varepsilon_{jk}$ on both
  lanes. $E_\mathrm{mel}=\sum_i e_{\mathrm{mel},i}V_i$ is part of the total
  energy and of the total energy density (`eden_total`) on both lanes; as on the
  CPU reference, $e_\mathrm{mel}$ omits the $m$-independent $-B_1\operatorname{tr}
  \boldsymbol\varepsilon/3$ offset of note 0700, which does not change fields or
  energy differences.
- **Global average magnetization.** The table columns `mx`, `my`, `mz` follow
  note 0910: they are weighted by the magnetic moment,
  $\langle\mathbf m\rangle=\sum_i M_{s,i}V\mathbf m_i/\sum_i M_{s,i}V$ over active
  cells, on FDM CPU and CUDA. Without a cellwise $M_s$ this is the arithmetic
  mean, computed exactly as before. For example two equal halves with a sharp
  transition, $M_s=(400,800)$ kA/m and $\mathbf m=(+\hat x,-\hat x)$, give
  $\langle m_x\rangle=-1/3$.
- **Precision contract.** Bit identity is promised only in fp64: for a uniform
  material the `uniform` operator reproduces the pre-change CPU and CUDA fp64
  trajectories bit for bit, with or without region labels. CUDA fp32 has no
  bit-identity contract. With region labels it used to run the retired pair-table
  kernel and now runs the scalar Laplacian, so it differs from the old fp32 path
  at rounding level; the old summation order is not reproduced. Instead, fp32 is
  qualified by tolerance against the CPU fp64 reference on every parity case,
  over a short horizon (10 RK4 steps of 10 fs), because the random parity
  texture is chaotic and any rounding difference grows to O(1) over 2000 steps.
  Bounds: max $|\Delta\mathbf m| \le 10^{-5}$, relative difference of each
  energy term $\le 10^{-5}$, and $\max|\Delta\mathbf H| / \max|\mathbf H_\mathrm{ref}|
  \le 10^{-5}$ for $\mathbf H_\mathrm{ex}$ and $\mathbf H_\mathrm{eff}$ at the
  final step. Non-finite values fail. Measured maxima are $2.3\times10^{-7}$,
  $5.0\times10^{-7}$ and $2.3\times10^{-7}$.

Multilayer FDM with region-owned material/coupling is out of scope for v1 and
must be capability-gated. It cannot silently fall through to a partially
implemented path.

#### CPU observation workspace lifetime

Repeated accepted-state field capture must reuse an observation FFT workspace
for the unchanged grid, cell dimensions and demagnetizing boundary policy.
The observation workspace is separate from the integration workspace so its
FFT counters do not become solver counters. Reuse concerns scratch buffers,
FFT plans and Newell spectra; each capture still evaluates the current accepted
magnetization and local $M_s$ at the accepted time. It must preserve the
full-domain stray field in inactive cells and the solver's active-cell mask.
The energy, exchange connection operator, LLG steps, output cadence, thermal
counter and requested execution policy remain the same. Compare fresh/reused
fields and densities for successive states, including heterogeneous $M_s$ and
inactive cells; verify that one workspace lifecycle serves both captures.
Runtime timing is a separate gate. A cancelled timing baseline is not a
completed physics trajectory, and a development build is not a release
throughput qualification.

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
Zhang-Li or Slonczewski STT, prescribed SOT, Oersted, then magnetoelastic.
Section 3.2.3 gives the prescribed-SOT reason. GPU reports its
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

Metadane `MaterialFieldPlan` opisują rzeczywiście rozwiązaną reprezentację.
Jeżeli plan FEM zawiera `a_element_field` lub `ms_element_field`, odpowiednia
lokalizacja to `Element`, metoda to `conformal_domain_element_sampling`, a
statystyki liczą elementy i wartości tego samego wektora. Pola węzłowe oraz
plan eigen zachowują lokalizację `Node`. Writer artefaktów wybiera wektor na
podstawie tej lokalizacji; nie może pomijać DG0 przez szukanie nieistniejącego
wektora węzłowego. Regresje sprawdzają metadane i serializację artefaktu,
bez rozszerzania obsługi współczynników DG0 ani kwalifikacji CPU/GPU.

When executable, resolved provenance must state
`material_realization=element_quadrature`, quadrature/mass order, element-map
digest, resolved CPU/GPU lane, and every consuming owner. Older artifacts lack
the required comparability. Evidence still deferred beyond this pure contract:
two-tetra field/energy oracle, per-owner directional derivatives, and CPU/GPU
parity on the same map. This section does not lift the current fail-closed
policy.

#### 3.2.3 Ms consumers outside the element adapter

Three FEM consumers read `Ms` outside the exchange, demag and Zeeman element
adapter. Each one either uses the resolved realization or is rejected before
it can run.

**Prescribed SOT.** The `prescribed_sot.fullmag.v1` RHS is evaluated at
every magnetic node `i` with the local coefficient

```text
omega_i = gamma_e hbar J_c f(t) / (2 e Ms_i t_F)                  [1/s]
```

where `gamma_e = gamma_mu0/mu0 [1/(T s)]`, `hbar [J s]`, `J_c [A/m^2]`, the
dimensionless envelope `f(t)`, `e [C]`, `Ms_i [A/m]` and `t_F [m]`. The
damping-like and field-like terms are `xi_DL omega_i` and `xi_FL omega_i`.
`Ms_i` is the nodal P1 value or the scalar. A node shared by two DG0 elements
has no single `Ms_i`, and the mass projection does not compensate. A plan with
`Ms_element_field` and prescribed SOT is therefore rejected. The planner
(`first_unsupported_elementwise_ms_cpu_owner`) and the native context builder
(`validate_elementwise_ms_runtime_support`) both name the owner
`prescribed SOT`, between Slonczewski STT and Oersted in the fixed order of
section 3.2.1. Nodal P1 and scalar `Ms` with prescribed SOT stay legal. An
element-quadrature SOT owner is deferred.

**Coupled spin transport.** The bounded FEM M1/M2 transport descriptor carries
one scalar `M_s`. Its torque, as in
[spin-Hall drift-diffusion transport](0970-spin-hall-drift-diffusion-transport.md),

```text
T_tr,G = -(gamma_e / M_s) (hbar / 2e) (R_J + R_phi)               [1/s]
```

with `R_J + R_phi [A/m^3]`, divides by that scalar everywhere. With nodal values
`Ms_i != M_s` the torque at node `i` would be wrong by the factor `M_s / Ms_i`.
For example, halving `Ms_i` must double the torque there, and the scalar
coefficient does not. Spatial `Ms` in the descriptor and the native transport
ABI is deferred. Until then, the planner
(`fem_spin_transport_ms_realization_error`) rejects spin transport with
`ms_element_field`, and also with a nodal `material.ms_field` that differs from
the scalar. A value differs when
`|Ms_i - M_s| > 64 epsilon_double max(|Ms_i|, |M_s|)`, the same tolerance that
decides whether the planner emits a nodal field at all. The runner preflight
(`validate_transport_ms_realization`) applies the same rule to each descriptor
before any native call. The native stage-transport callback
(`validate_transport_stage_ms_realization`) applies it on magnetic nodes before
it installs the reciprocal torque. A uniform nodal field equal to the scalar is
the same coefficient and stays legal.

**Per-object average magnetization.** With `Ms_element_field`, the global
average is the exact P1/DG0 moment-weighted mean:

```text
<m>_E = sum_{e in E} Ms_e V_e (m_{n0}+m_{n1}+m_{n2}+m_{n3})/4
        / sum_{e in E} Ms_e V_e                                    [1]
```

Here `E` is the set of active magnetic elements, `V_e [m^3]` is the element
volume, and `m` is the dimensionless P1 reduced magnetization. The per-object
reduction (`fullmag_fem_backend_average_m_for_elements_f64`) uses the same
formula. Its `E_O` contains exactly the active elements selected by the
object's resolved element markers or element ranges. Shared interface nodes
do not transfer element ownership. It does not use a lumped nodal `Ms` weight, which
is undefined for DG0. For two equal-volume tetrahedra with
`Ms = 400 kA/m` and `m = +x`, and `Ms = 800 kA/m` and `m = -x`, the object that
contains both has `<m_x> = (400 - 800)/1200 = -1/3`. Each one-tetrahedron object
has `<m_x> = +1` or `-1`. A regression must also exclude a foreign tetrahedron
whose four vertices are shared with the selected object. The legacy node-set
ABI retains its induced-node-set semantics; the runner must not use it for
DG0 per-object observables. Duplicate element indices have set semantics,
out-of-range indices are rejected, and inactive elements contribute nothing.
Nodal and scalar `Ms` keep the existing lumped-mass weighting. This change
requires native/runner contract tests and a managed-runtime check before it
can be considered qualified; source inspection alone is not runtime evidence.
The native plan importer preserves the requested consistent-mass policy even
in a dependency-free ABI build, so the initial-state average contract observes
the same material intent. This does not provide MFEM operators or time stepping:
those capabilities remain unavailable without the MFEM stack.

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

Przypisanie pola do parametru sprawdza zgodność `unit` z jego jednostką SI:
`Ms`: `A/m`; `Aex`: `J/m`; `Ku1`, `Ku2`, `Kc1..3`: `J/m^3`;
`Dind`, `Dbulk`: `J/m^2`; `Alpha`, `AnisotropyAxis`: `1` (również
dotychczasowy alias `dimensionless`). Otaczające spacje nie zmieniają znaczenia.
Pominięte `unit` lub `null` dla pola analitycznego oznacza SI; sampled wymaga
jawnej jednostki. Prefiksy takie jak `pJ/m` i `kA/m`, pusty napis i jednostka
innego wymiaru są odrzucane przy przypisaniu w Python oraz walidacji sceny/IR.
Wartości nie są przeliczane ani modyfikowane. Dotyczy to wszystkich czterech
realizacji przed wyborem backendu; istniejące ograniczenia wykonania pól nadal
obowiązują. Starszy model z błędną etykietą wymaga poprawienia etykiety albo
liczb do SI; nie ma automatycznej migracji, która zgadywałaby intencję.

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
| `fm.fields.constant.unit` | `str \| None` | `None` | $1$ | opcjonalna jednostka SI parametru; zgodność sprawdzana przy przypisaniu pola | declared unit metadata | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Constant.unit` | `packages/fullmag-py/src/fullmag/fields.py::constant` |
| `fm.fields.linear.base` | `float` | `required` | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ | must be finite; otherwise ValueError | field value at the object-frame origin | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Linear.base` | `packages/fullmag-py/src/fullmag/fields.py::linear` |
| `fm.fields.linear.gradient` | `tuple[float, float, float]` | `required` | $\{\mathrm{A/m^2},\mathrm{J/m^2},\mathrm{m^{-1}},\mathrm{J/m^4},\mathrm{J/m^3}\}$ | must contain exactly three finite components; otherwise ValueError | spatial gradient | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Linear.gradient` | `packages/fullmag-py/src/fullmag/fields.py::linear` |
| `fm.fields.linear.frame` | `Literal["object", "world"]` | `"object"` | $1$ | case-normalized to object/world; any other token gives ValueError | coordinate frame | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Linear.frame` | `packages/fullmag-py/src/fullmag/fields.py::linear` |
| `fm.fields.linear.unit` | `str \| None` | `None` | $1$ | opcjonalna jednostka SI parametru; zgodność sprawdzana przy przypisaniu pola | declared base-value unit metadata | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Linear.unit` | `packages/fullmag-py/src/fullmag/fields.py::linear` |
| `fm.fields.radial.center` | `tuple[float, float, float]` | `required` | $\mathrm m$ | must contain exactly three finite components; otherwise ValueError | radial-field center | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.center` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.radius` | `float` | `required` | $\mathrm m$ | must be finite and > 0; otherwise ValueError | radial transition radius | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.radius` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.inside` | `float` | `required` | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ | must be finite; otherwise ValueError | value inside the radius | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.inside` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.outside` | `float` | `required` | $\{\mathrm{A/m},\mathrm{J/m},1,\mathrm{J/m^3},\mathrm{J/m^2}\}$ | must be finite; otherwise ValueError | value outside the radius | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.outside` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.frame` | `Literal["object", "world"]` | `"object"` | $1$ | case-normalized to object/world; any other token gives ValueError | coordinate frame | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.frame` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.radial.unit` | `str \| None` | `None` | $1$ | opcjonalna jednostka SI parametru; zgodność sprawdzana przy przypisaniu pola | declared field-value unit metadata | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Radial.unit` | `packages/fullmag-py/src/fullmag/fields.py::radial` |
| `fm.fields.sampled.asset_id` | `str` | `required` | $1$ | must be non-empty; otherwise ValueError | sampled-field artifact identity | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Sampled.asset_id` | `packages/fullmag-py/src/fullmag/fields.py::sampled` |
| `fm.fields.sampled.component_count` | `int \| float (runtime-coerced)` | `required` | $1$ | annotated as int, but the current runtime accepts real values >= 1 and stores int(component_count), truncating toward zero; for example 1.5 becomes 1; values < 1 give ValueError, while non-integral and bool inputs are not rejected before coercion | components per sample | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Sampled.component_count` | `packages/fullmag-py/src/fullmag/fields.py::sampled` |
| `fm.fields.sampled.location` | `Literal["cell", "node", "element", "quadrature"]` | `required` | $1$ | case-normalized to the four listed tokens; any other token gives ValueError | sample association | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Sampled.location` | `packages/fullmag-py/src/fullmag/fields.py::sampled` |
| `fm.fields.sampled.unit` | `str` | `required` | $1$ | wymagana jednostka SI parametru; zgodność sprawdzana przy przypisaniu pola | declared sampled-value unit metadata | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `MaterialParameterFieldIR::Sampled.unit` | `packages/fullmag-py/src/fullmag/fields.py::sampled` |
| `study.couplings.exchange.source` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to an object, ObjectRegion, CouplingEndpoint, or non-empty object name; otherwise TypeError/ValueError | source endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.source` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.target` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to an object, ObjectRegion, CouplingEndpoint, or non-empty object name; otherwise TypeError/ValueError | target endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.target` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.mode` | `Literal["harmonic_mean", "explicit", "disabled"]` | `"harmonic_mean"` | $1$ | invalid token gives ValueError; harmonic_mean forbids inter_exchange; explicit requires it; disabled requires scale=0 or None | exchange coupling policy | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::Exchange.mode` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.scale` | `float \| None` | `None` | $1$ | when provided, must be finite and >= 0; disabled mode accepts only 0 or None | dimensionless exchange scale | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::Exchange.scale` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.inter_exchange` | `float \| None` | `None` | $\mathrm{J/m}$ | when provided, must be finite; required for explicit mode and forbidden for harmonic_mean | explicit inter-object exchange stiffness | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::Exchange.inter_exchange` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.coupling_id` | `str \| None` | `None` | $1$ | None or the empty string selects the deterministic default id through coupling_id or default_id; a non-empty string is retained | coupling identity | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.coupling_id` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.enabled` | `bool` | `True` | $1$ | current lowering coerces by bool(value) rather than rejecting non-bool input; strict type validation is a current limitation | activation flag | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.enabled` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.exchange.capability_policy` | `Literal["require_runtime", "authored_only"]` | `"require_runtime"` | $1$ | any other token gives ValueError | runtime capability policy | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.capability_policy` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.exchange` |
| `study.couplings.rkky.source` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to CouplingEndpoint.surface with selector top/bottom/left/right/front/back; otherwise ValueError | source endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.source` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.target` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to CouplingEndpoint.surface with selector top/bottom/left/right/front/back; otherwise ValueError | target endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.target` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.J1` | `float` | `required` | $\mathrm{J/m^2}$ | must be finite; either sign is allowed; otherwise ValueError | bilinear RKKY surface density | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::Rkky.j1` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.coupling_id` | `str \| None` | `None` | $1$ | None or the empty string selects the deterministic default id through coupling_id or default_id; a non-empty string is retained | coupling identity | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.coupling_id` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.enabled` | `bool` | `True` | $1$ | current lowering coerces by bool(value); strict type validation is a current limitation | activation flag | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.enabled` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.rkky.capability_policy` | `Literal["require_runtime", "authored_only"]` | `"require_runtime"` | $1$ | any other token gives ValueError | runtime capability policy | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.capability_policy` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.rkky` |
| `study.couplings.interlayer_exchange.source` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to CouplingEndpoint.surface with selector top/bottom/left/right/front/back; otherwise ValueError | source endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.source` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.target` | `object \| ObjectRegion \| CouplingEndpoint \| str` | `required` | $1$ | must resolve to CouplingEndpoint.surface with selector top/bottom/left/right/front/back; otherwise ValueError | target endpoint | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.target` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.J1` | `float` | `required` | $\mathrm{J/m^2}$ | must be finite; either sign is allowed; otherwise ValueError | bilinear interlayer surface density | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::InterlayerExchange.j1` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.J2` | `float \| None` | `None` | $\mathrm{J/m^2}$ | when provided, must be finite; either sign is allowed; otherwise ValueError | biquadratic interlayer surface density | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingParametersIR::InterlayerExchange.j2` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.coupling_id` | `str \| None` | `None` | $1$ | None or the empty string selects the deterministic default id through coupling_id or default_id; a non-empty string is retained | coupling identity | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.coupling_id` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.enabled` | `bool` | `True` | $1$ | current lowering coerces by bool(value); strict type validation is a current limitation | activation flag | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.enabled` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |
| `study.couplings.interlayer_exchange.capability_policy` | `Literal["require_runtime", "authored_only"]` | `"require_runtime"` | $1$ | any other token gives ValueError | runtime capability policy | authored IR on FDM/FEM CPU/GPU; runtime capability-gated | `CouplingIR.capability_policy` | `packages/fullmag-py/src/fullmag/world.py::StudyCouplingsHandle.interlayer_exchange` |

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


(material-regions-v04-registry-identities)=
### 4.2.1 Tożsamości rejestrów przed przypisaniem fizyki V04

Stan: poniższe guardy są **zaimplementowane w źródłach walidatora V04**.
Regresje Rust są przygotowane, lecz nie skompilowane ani wykonane zgodnie
z obowiązującym zakazem kompilowania testów. Parser i przegląd źródeł
nie zastępują typechecku ani wykonania `ProblemIRV04::validate`.
Managed build #229 przypięto przed tym przyrostem i nie kwalifikuje tych guardów.

Przed zbudowaniem lookupów materiałów i par owner/region walidator V04
musi odrzucić puste lub whitespace-only `materials[].name` oraz
powtórzone dokładne nazwy materiałów. W obecnym stagingu
`ObjectMaterialAssignmentIR.material_id` i `MagnetizationModuleIR.material_id`
odwołują się dokładnie do `MaterialIR.name`; osobny niezmienny identyfikator
materiału nie istnieje w tym typie. Nie wolno zastąpić tego faktu fikcyjnym
rejestrem ID ani normalizować nazw przez trim przy rozwiązywaniu referencji.
Trim służy wyłącznie odrzuceniu pustego identyfikatora.

`ObjectRegionIR.region_id` pozostaje niepuste i globalnie unikalne, zgodnie
z kontraktem powyżej i istniejącą walidacją V03. Dotyczy to także regionów
disabled oraz regionów różnych właścicieli. Każdy `owner_object` musi być
niepustym dokładnym `PhysicsObjectIR.object_id` obecnym w `objects[]`;
nazwa obiektu ani prezentacyjny `type` nie zastępują referencji i nie
aktywują magnetyzmu. Walidacja nie zmienia danych użytkownika i zbiera
indeksowane błędy przed dalszą kontrolą assignments/modules.

To poprawka brakującej kontroli istniejącego kontraktu w
`ProblemIRV04::validate`, bez nowego pola wire, migracji, zmiany publicznego
writera V03, planner capabilities lub API/UI. Jest wymagana także przed
przyszłym powiązaniem regionów przekroju falowodu S09 z modelem. Sam
poprawny rejestr nie dowodzi geometrycznej zgodności, wyboru aktywnego
modułu, zrealizowanych współczynników ani działania providera 2.5D.

FDM CPU/GPU i FEM CPU/GPU współdzielą tę semantykę rejestrów; nie jest to
kwalifikacja wykonania żadnej realizacji. Regresje Rust wymagają osobnego
wykonania po odwołaniu zakazu kompilowania testów. Kontrola interpretowana
może sprawdzić golden wejścia i obecność guardów, lecz nie wykonuje Rust.

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
| FDM CPU | regular-grid realization; `u32` region indices without a count limit | reference connection operator {eq}`material-fdm-connection-coefficient`, typed pair rules |
| FDM GPU | regular-grid realization; `u32` region indices without a count limit | same connection coefficients, cellwise $M_s$/$\alpha$; combinations listed in {ref}`material-regions-fdm-lane-realization` blocked; no silent CPU fallback |
| FEM CPU | conformal or explicit projection | shared-domain coefficients and markers |
| FEM GPU | ta sama canonical mesh intent | osobna realizacja runtime, wspólna semantyka |

(material-regions-discrete-realization)=
### 4.5 Discrete realization

FDM materializuje maski i pola na komórkach. FEM materializuje conformal domain
markers albo jawnie raportowaną projekcję. Region mesh-only pozostaje polem
rozmiaru i nie tworzy niezależnych stopni swobody magnetyzacji.

Canonical FEM domain and boundary labels remain u32. MFEM receives separate,
import-owned compact positive attributes with forward and reverse maps
([ADR 0079](../adr/0079-fem-compact-canonical-marker-maps.md)). Storage for each
map scales with distinct marker count, not the largest label. Domain zero
retains its physical air meaning and cannot alias magnetic material one;
explicit boundary zero and one remain distinct in the representation.
Only emitted exterior/periodic-seam facets enter the boundary map. Missing
canonical marker buffers retain default one in the main builder. Accepted
transport without domain markers retains its legacy ElementNo+1 attributes. Public selectors are translated
once before assembly; missing selectors fail explicitly, subject to the
existing BC legality. Legacy per-element transport coefficients retain their
per-element volume attributes; accepted transport and boundary conditions use
their own appropriate maps. This representation preserves canonical buffers,
continuous magnetization, finite-element spaces, SI coefficients and physical
fluxes. It does not enable a previously unsupported CPU/GPU interaction.
The internal operator identity records the mapping policy; canonical public
mesh/marker identities retain their established meaning. Versioned native ABI
extension carries a full u32 Poisson selector without narrowing legacy fields.
Python MeshData validates integer range before normalization to u32, including
legacy nonnegative int32 buffers. Typed lead selectors and accepted-charge
artifact readers retain canonical u32. NPZ readers verify original member
bytes before normalization; canonical topology fingerprints encode values,
not NumPy signedness. Working incidence arrays with -1 sentinels use int64.
Gmsh/COMSOL export separate compact positive tags and reverse them through
the existing hash-bound sidecar; group display names cannot override that
explicit identity. Negative markers are rejected, not reinterpreted.

#### Wyrocznia zbieżności regionalnej FDM/FEM

Przed pomiarem przypinamy wspólny problem wymiany na pręcie długości 64 nm
oraz przekroju 4 nm × 4 nm. Dwie konformalne połowy mają A=(13,26) pJ/m,
Ms=(0,8;1,6) MA/m, alpha=0,5 i gamma=2,211e5 m/(A s). Stosunek A/Ms jest
stały. Demag, precesja i inne oddziaływania są wyłączone. Dla k=2 pi/L,
theta(x,t)=a(t) cos(kx), m=(cos theta,sin theta,0) dokładne rozwiązanie
czystego tłumienia ma a(t)=0,2 exp(-D k² t), gdzie
D=[alpha gamma/(1+alpha²)] [2 A/(mu0 Ms)]. Pochodna theta znika na końcach
oraz na interfejsie, więc spełnione są naturalny warunek brzegowy i ciągłość
strumienia wymiany pomimo skoku A. Energia wynosi
E_ex=w² L (A1+A2) a² k²/4. Pole obejmuje zarówno składową styczną theta_xx,
jak i radialną -theta_x² m; porównanie nie pomija składowej radialnej.

Recepta naukowa w wybranym backendzie DEV ładuje opublikowane biblioteki,
bez kompilowania: `scripts/benchmarks/regional_fdm_fem_convergence.py`.
FDM CUDA/double używa centrów komórek, harmonicznych A_FACES i lokalnego Ms.
FEM CPU/double używa P1, sześciu tetraedrów na segment, konformalne DG0 A/Ms
oraz consistent mass. Nie promuje to DG0 na GPU. W osi x obowiązuje Neumann,
a y/z są periodyczne w obu realizacjach. Klasy węzłów FEM na przekroju
zachowują dokładną podprzestrzeń jednowymiarową. Bez tych więzów interpolacja
na jednej warstwie tetraedrów ma artefakty silnego laplasjanu w węzłach
brzegowych; zgodność słabej macierzy K/M nie gwarantuje wtedy przyjętej
silnej normy L2 pola. Pierwszy taki pomiar pozostaje negatywnym dowodem,
nie kwalifikacją. Zmiana warunku poprzecznego nie zmienia rozwiązania
analitycznego niezależnego od y/z ani niżej podanych progów.
Obie siatki mają kolejno
8/16/32 segmenty, kanoniczne regiony 257 i UINT32_MAX, RK4, dt=1e-14 s,
100 kroków. Każdy przebieg zapisuje nową parę skrypt/Zarr na WSL, surowe pola,
energię w każdym kroku oraz hashe bibliotek i nagłówków.

Bramki ustalone przed pomiarem: względny błąd energii maleje co najmniej 2×
na zagęszczenie i na najdrobniejszej siatce wynosi <=0,03; ważony objętością
błąd L2 pola maleje >=1,5× i wynosi <=0,05. Błąd amplitudy po 100 krokach
maleje >=2× i wynosi <=0,01. Względna różnica amplitud FDM/FEM maleje >=2×
i wynosi <=0,005. Defekt normy <=1e-10, względny przyrost energii między
krokami <=1e-10. To kryteria kwalifikacji, a nie deklaracja uzyskanego wyniku;
zmierzone wartości i ewentualne odmowy należą do raportu audytu.

Uzupełniający test terminalnej relaksacji PG-BB używa ośmiu komórek 2 nm,
dwóch ostrych regionów Ms=400/800 kA/m i alpha=0,1/0,4, A=13 pJ/m, bez demag,
Bz=0,05 T oraz początkowego m=+x. Dokładne minimum to m=+z oraz
E=-Bz sum(Ms_i V_i). Przed pomiarem ustala się: zakończenie przez torque,
nie limit 2500 kroków; próg 1e-3 A/m dla double i 100 A/m dla single;
maksymalny błąd składowej m odpowiednio 3e-8 i 3e-3, względny błąd energii
1e-10 i 1e-5, defekt normy 1e-10 i 1e-5 oraz względny wzrost energii między
krokami najwyżej 1e-12 i 1e-6. Osobne publiczne wykonania CPU/double,
CUDA/double i CUDA/single zachowują intent, receipt i brak fallbacku.

Współczynniki skalarne DMI w starszym `MaterialIR` są odrębną drogą od
regionalnych pól: `interfacial_dmi` i `bulk_dmi` muszą trafić do planu FDM
single-grid. Jawny term energii ma pierwszeństwo (również przy D=0), bez
sumowania z materiałem. Dla multilayer brak D w materiale oznacza zero;
obecny descriptor o jednym skalarze wymaga identycznych efektywnych D we
wszystkich ciałach. Rozbieżność jest jawnym błędem, a zgodny BulkD przechodzi
przez istniejący guard braku wykonania multilayer. Wybór CPU/CUDA, normalne
i odrębne brzegi ciał nadal podlegają dotychczasowym ograniczeniom.
Fizyka pozostaje opisana w [iDMI](0404-interfacial-dmi.md) oraz
[Bulk DMI](0405-bulk-dmi.md); testy descriptorów nie są kwalifikacją GPU.

(material-regions-round-trip-and-failure-semantics)=
### 4.6 Round-trip and failure semantics

Python/UI round-trip zachowuje requested intent: właściciela, nazwę, shape,
`mesh_policy`, material fields i couplings. Resolved execution zachowuje
markery, projection/conformal mode oraz capability result. Validation errors
blokują niepoprawne zakresy i `Ms<=0`; unsupported combinations blokują planner.
Nie wolno porzucać regionu lub coupling po cichu.

Eksport Python i SceneDocument zachowuje także `shape.center` dla box/sphere,
`shape.center` i `shape.axis` dla cylinder oraz pełne wyrażenie CSG. Zastąpienie
CSG pudełkiem lub wyzerowanie przesunięcia zmienia wsparcie parametrów, a więc
problem fizyczny. Nieznany typ kształtu musi zostać odrzucony. Regresje obu
ścieżek eksportu porównują kanoniczny shape IR, a publiczny przypadek dwóch
połówek z Ms 400/800 kA/m sprawdza niezależnie moment globalny `mx=-1/3`.

Ograniczony harness `scripts/benchmarks/fdm_regions_interaction_abi_checks.py`
sprawdza w natywnym CUDA lokalne wagi Ms w tożsamości
`dE/dε = -mu0 * sum_i Ms_i V_i H_i · dm_i/dε` oraz niezależne różnice energii
Zeeman/uniaxial/cubic/MEL. Dla stałego pola +z i początkowego m=+x wyrocznia LLG
ma `ω_i=gamma H/(1+alpha_i²)`, `m_z=tanh(alpha_i ω_i t)` oraz
`m_x+i m_y=sech(alpha_i ω_i t) exp(i ω_i t)`. Czas pochodzi z zaakceptowanych
statystyk solvera. Sprawdzenie pięciu integratorów nie włącza adaptacji ani
nie kwalifikuje długich trajektorii fp32. Heterogeniczne A trafia do ABI v2
jako współczynniki FACES; raw ABI bez widm Newella ma jawnie odmówić demagu.
Dokładne tolerancje, biblioteka i wyniki znajdują się w audycie kwalifikacji
z 7 listopada 2026; ten punkt nie zastępuje publicznych testów CPU/CUDA.

Accepted worker musi zachować precyzję dopuszczonego planu single-grid CUDA:
requested `single` oznacza storage/compute/FFT FP32 i redukcje FP64 zgodnie
z `FdmPrecisionPolicyIR`, także dla zakwalifikowanych pól regionalnych.
Kanoniczny readback pól i accepted-state w f64 jest formatem transferu;
nie zmienia precyzji integratora. Request, ProblemIR i plan muszą wskazywać
tę samą precyzję i politykę. CPU/single, multilayer/single oraz frozen terminal
context/single pozostają niedopuszczone; pozostałe bramki planera/native
nie są przez worker omijane. Samo rozszerzenie tej walidacji nie jest dowodem
wykonania: wymagane są osobne testy publicznego Run, pól, publikacji i recovery.

Natywny harness `fdm_regions_pbc_abi_checks.py` rozróżnia jedną krawędź otwartą
i dwie różne krawędzie okresowe przy dwóch komórkach na wybranej osi. Wyrocznia
ma `E_ex = L A V |m1-m0|²/h²` i
`H_ex,i = 2 L A (m_j-m_i)/(mu0 Ms_i h²)`, gdzie `L=1` lub `2`.
Pozostałe osie długości jeden nie dodają energii ani pola. Test obejmuje trzy
orientacje osi, okresowość osi singleton oraz rzadkie etykiety u32 do `u32::MAX`;
oddzielny przypadek sprawdza lokalne A przez FACES. Nie otwiera to publicznej
bramki GPU/fp32/PBC ani nie kwalifikuje większych siatek okresowych.

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
| Can FDM keep the old cross-region zero default? | No. The realized operator follows {eq}`material-fdm-connection-coefficient`: regions of one object couple through $H$, different owners are decoupled. The retired native pair table and its `exchange_pair_default` are rejected; legacy stored `(i, j, A)` triples are read as `explicit` rules. |
| Is there a region-count limit? | No architectural limit. Region indices are `u32`; memory, cell count and explicit backend capabilities remain the only bounds. |
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
6. DMI with a decoupled connection is rejected; DMI with positive non-uniform
   faces is not. `first_decoupled_connection` finds the zero face between two
   active cells (owner-decoupled pair, explicit zero, periodic wrap) on the
   scanned axes, ignores zero faces next to inactive cells and ignores a
   $z$-only decoupling when only $x$/$y$ are scanned; the runner rejects the
   plan only when a DMI coefficient is non-zero, also without an exchange
   field.

### 5.2 Cross-backend checks

Canonical Python export must preserve the IEEE-754 values of material
coefficients, regional parameter-field payloads, metric transition widths and
interface-coupling strengths. Use round-trip numeric literals rather than a
display formatter with a fixed significant-digit limit. This is preservation
of the existing SI inputs; it does not change the material law, default
transition policy or execution precision. Verify both Problem-to-Python and
SceneDocument-to-Python paths for constant, linear and radial material fields.

The same round-trip must retain Brown thermal-noise intent: temperature in
kelvin and the optional positive u64 seed, including an unspecified entropy
seed. SceneDocument carries it as the optional study-level `thermal_noise`
configuration; its seed uses a decimal string to preserve all u64 bits through
browser JSON, while ProblemIR and the Python DSL retain an integer seed.
Absence means no authored noise in a complete scene; a missing
override preserves an existing script, while explicit null removes its noise.
Do not silently lower a stochastic regional model to deterministic dynamics.
Preservation does not enable unsupported thermal/device combinations: the
existing planner must still reject heterogeneous CUDA thermal noise before
native execution. Check both seeded and entropy configurations through
Problem and Scene exports, then check that public regional refusal.

Sharp-interface and grain-assignment fixtures must explicitly author
`material_transition(kind="sharp")` before local overrides. The public
mesh-relative default remains intentional. CPU/CUDA agreement for that
smoothed default does not qualify a discontinuous-coefficient oracle.
For a sharp grain fixture, independently verify the winning cell count and
the realized local Ms/A/alpha against the authored seeded values, in addition
to comparing the two solver lanes.

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
- `airbox_rejects_magnetic_material_and_m_quantity`,
- `uniform_material_many_regions_collapses_to_uniform` (1000 regions),
- `rules_matching_scalar_keep_faces_over_variable_a_field`,
- `distinct_owners_are_decoupled_without_rules`,
- `periodic_axis_lengths_one_and_two`,
- `legacy_tuple_pairs_deserialize_as_explicit`,
- `cuda_rejects_heterogeneous_material_with_thermal_noise`,
- CPU versus CUDA headless parity for two materials with an interface rule and
  for 1000 grains, plus an unchanged uniform case,
- the CUDA fp32 tolerance qualification against the CPU fp64 reference on the
  same cases (`run_fdm_regions_parity.py --with-fp32`).
- `fem_planner_elementwise_material_legality_distinguishes_a_from_ms` (prescribed-SOT case),
- `fem_spin_transport_ms_realization_admits_only_the_scalar_torque_coefficient`,
- `transport_plan_rejects_spatial_ms_before_native_call`.

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
- FDM CUDA cellwise $M_s$/$\alpha$ do not yet combine with boundary correction
  T0/T1, thermal noise, spin torques or rotated DMI with non-uniform $M_s$, and
  DMI does not combine with non-uniform $A$ (see
  {ref}`material-regions-fdm-lane-realization`).
- The production choice between per-face coefficient arrays and a compact
  material-index representation is decided by the measurements recorded in
  `docs/audits/2026-11-01-fdm-unbounded-regions-benchmark.md`.
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
| Rejestry V04 | `crates/fullmag-ir/src/validation.rs` | `validate_physics_object_problem` | indeksowane błędy pustych/duplikowanych materiałów i regionów oraz właścicieli; źródła, bez kwalifikacji runtime |
| Publiczna walidacja V04 | `crates/fullmag-ir/src/physics_object.rs` | `validate` | `validate()` egzekwuje istniejący kontrakt rejestrów, bez zmiany wire V03/V04 |
| Walidacja jednostek | `crates/fullmag-ir/src/model.rs` | `validate_unit` | Zgodność etykiety z SI parametru bez przeliczania wartości; wspólna kontrola sceny oraz IR V03/V04. |
| Walidacja jednostek | `packages/fullmag-py/src/fullmag/model/structure.py` | `_validate_material_parameter_field` | Walidacja jednostki po przypisaniu pola do parametru w Python. |
| Walidacja jednostek | `crates/fullmag-ir/tests/material_field_units.rs` | `material_field_units_are_checked_in_v04_public_validation` | Regresja walidacji jednostek przed wykonaniem solvera. |
| Materiały FDM | `crates/fullmag-plan/src/fdm.rs` | `resolve_multilayer_material_dmi_scalar` | Jednolite D materiałów lub jawny błąd descriptoru multilayer; explicit term ma pierwszeństwo. |
| Materiały FDM | `crates/fullmag-plan/src/tests/material_audit_fdm.rs` | `single_grid_material_scalar_dmi_is_lowered_on_cpu_and_cuda` | Regresja descriptorów CPU/CUDA, bez dowodu wykonania urządzenia. |
| Metadane FEM | `crates/fullmag-plan/src/fem.rs` | `gather_fem_material_field_plans` | Lokalizacja i statystyki zgodne z rozwiązaną reprezentacją współczynnika. |
| Metadane FEM | `crates/fullmag-plan/src/tests/material_audit_fem.rs` | `fem_material_field_metadata_tracks_resolved_element_coefficients` | Regresja lokalizacji i statystyk DG0 niezależnie od kolejności regionów. |
| Metadane FEM | `crates/fullmag-runner/src/artifacts.rs` | `fem_element_material_artifact_preserves_location_and_values` | Zapis współczynnika elementowego bez pominięcia ani projekcji węzłowej. |
| Operator wymiany FDM | `crates/fullmag-engine/src/fdm/shared/exchange_operator.rs` | `build_exchange_operator` | Połączenia siatki, właściciele i typowane reguły par → `uniform` albo współczynniki na połączeniach, wspólne dla CPU i CUDA. |
| Operator wymiany FDM | `crates/fullmag-engine/src/fdm/shared/exchange_operator.rs` | `harmonic_exchange` | Strzeżona średnia harmoniczna $H(a,b)$ z dokładną gałęzią $a=b$. |
| Reguły par FDM | `crates/fullmag-ir/src/execution.rs` | `validate_fdm_exchange_pair_rules` | Walidacja reguł `harmonic_scale`/`explicit`/`disabled` na indeksach `u32` bez limitu. |
| Plan → operator | `crates/fullmag-runner/src/fdm/exchange_operator.rs` | `build_plan_exchange_operator` | Obniżenie planu FDM do wspólnego operatora wymiany. |
| Wymiana CUDA | `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu` | `exchange_field_fp64_kernel` | Pole wymiany z współczynników na połączeniach i lokalnego $M_s$. |
| Bramka CUDA | `crates/fullmag-ir/src/plan.rs` | `cuda_heterogeneous_material_error` | Wspólny predykat planera i runnera CUDA: jawna odmowa niewspieranych kombinacji z komórkowym $M_s$/$\alpha$ i zmiennym $A$. |
| Wymiana CUDA fp32 | `backends/fdm/gpu/cuda/interactions/exchange_fp32.cu` | `exchange_field_fp32_kernel` | Te same współczynniki na połączeniach w fp32; kwalifikacja tolerancją względem referencji fp64, bez zgodności bitowej. |
| Parytet torów | `scripts/benchmarks/run_fdm_regions_parity.py` | `compare_lane` | CUDA fp64 vs CPU fp64 (2000 kroków) i krótka kwalifikacja tolerancyjna CUDA fp32 dla $\mathbf m$, energii, $\mathbf H_\mathrm{ex}$, $\mathbf H_\mathrm{eff}$; NaN/inf to błąd. |
| Magnetosprężystość FDM | `crates/fullmag-engine/src/magnetoelastic.rs` | `h_mel_single_with_ms` | Pole $\mathbf H_\mathrm{mel}$ z lokalnym $M_{s,i}$; gęstość $e_\mathrm{mel}$ niezależna od $M_s$. |
| Magnetosprężystość CUDA | `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_magnetoelastic_energy_fp64` | $E_\mathrm{mel}$ w energii całkowitej toru CUDA. |
| Średnie $\mathbf m$ | `crates/fullmag-runner/src/scalar_metrics.rs` | `apply_average_m_to_step_stats_with_active_mask` | Średnia ważona momentem $M_{s,i}V$ dla kolumn `mx`/`my`/`mz` na FDM CPU i CUDA. |
| Bramka transportu GPU | `backends/fdm/api/c_api.cpp` | `fullmag_fdm_context_bind_gpu_transport_v1` | Odmowa późnego wiązania transportu przy komórkowym $M_s$/$\alpha$. |
| FEM Ms owners | `crates/fullmag-plan/src/fem.rs` | `first_unsupported_elementwise_ms_cpu_owner` | Planner order of DG0 `Ms` owners, including the prescribed-SOT rejection. |
| FEM Ms owners | `backends/fem/core/fem_material_fields.cpp` | `validate_elementwise_ms_runtime_support` | Native create-time rejection of DG0 `Ms` with an unsupported owner, including prescribed SOT. |
| FEM transport Ms | `crates/fullmag-plan/src/fem.rs` | `fem_spin_transport_ms_realization_error` | Planner rejection of DG0 or heterogeneous nodal `Ms` with the scalar-`M_s` transport descriptor. |
| FEM transport Ms | `crates/fullmag-runner/src/native_fem/steady_transport/descriptor.rs` | `validate_transport_ms_realization` | Runner preflight of the same rule before any native transport call. |
| FEM transport Ms | `backends/fem/cpu/mfem/interactions/transport_stage.cpp` | `validate_transport_stage_ms_realization` | Native rejection before the reciprocal stage-transport torque is installed. |
| FEM observables | `backends/fem/src/api.cpp` | `fullmag_fem_backend_average_m_for_elements_f64` | DG0 per-object average `m` over explicit owned elements. |
| FEM observables | `backends/fem/core/fem_element_quadrature_material.cpp` | `ms_weighted_aos3_average_reduction_for_element_set` | Exact P1/DG0 moment reduction over the selected active elements, independent of shared interface nodes. |
| FEM object ownership | `crates/fullmag-runner/src/native_fem/object_average.rs` | `object_element_indices` | Resolve object element selectors before native marker normalization. |
| FEM mass policy import | `backends/fem/cpu/mfem/interactions/exchange.cpp` | `initialize_exchange_plan_fields` | Preserve requested consistent-mass policy independently of MFEM availability; no operator or stepping capability is added. |
| FEM shared-node regression fixture | `backends/fem/tests/element_dg0_workflow_contract.cpp` | `make_dg0_shared_node_plan` | Analytical ABI regression with unequal volumes: selected elements give 0.5; the induced node set gives 9/14. The initial-state average contract runs separately from MFEM dynamics in CI. |
| FEM Ms regressions | `crates/fullmag-plan/src/tests.rs` | `fem_spin_transport_ms_realization_admits_only_the_scalar_torque_coefficient` | Planner rejection table for transport with spatial `Ms`. |
| CPU observation FFT | `crates/fullmag-engine/src/fdm/shared/problem.rs` | `observable_demag_field_with_workspace` | Full-domain stray field with reusable observation scratch and spectra. |
| CPU observation FFT | `crates/fullmag-engine/src/fdm/shared/problem.rs` | `observable_effective_field_with_workspace` | Current accepted effective field without rebuilding observation FFT plans. |
| CPU accepted capture | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `capture_full_active_cpu_fields` | Separate observation workspace lifetime and integrator telemetry. |
| CPU observation regression | `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `cpu_snapshot_reuses_observation_fft_workspace_across_states` | Fresh/reused field and density equality, current states, inactive cells and local Ms. |
| Sharp parity fixture | `scripts/benchmarks/fdm_regions_parity_case.py` | `_half` | Explicit sharp intent instead of the smooth authoring default. |
| Sharp parity authoring regression | `packages/fullmag-py/tests/test_regional_parity_fixture.py` | `test_heterogeneous_parity_cases_author_sharp_coefficients` | Public fixture to ProblemIR verification for both material-pair cases and grains. |
| Material numeric export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_material_parameter_field_expr` | Exact f64 parameter payloads through canonical Python. |
| Material numeric regression | `packages/fullmag-py/tests/test_regional_material_precision.py` | `test_material_fields_and_interface_parameters_preserve_f64_values` | Direct and Scene exports preserve material values, metric widths and exchange strengths. |
| Base material export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_geometry_and_materials` | Exact material coefficients in direct export. |
| Scene material export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_geometries_from_override` | Exact material coefficients from scene overrides. |
| Transition width export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_material_transition_kwargs` | Exact metric transition width. |
| Coupling strength export | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_couplings` | Exact exchange scale and coupling energy strengths. |
