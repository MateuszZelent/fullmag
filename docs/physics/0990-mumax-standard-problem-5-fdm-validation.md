# MuMax3 Standard Problem 5 as a Fullmag FDM/FEM validation contract

- Status: frozen source-to-IR reproduction with an executable FEM counterpart; isolated CPU↔CUDA MuMax3-operator step is qualified, but FDM/FEM full scientific qualification is not
- Owners: Fullmag FDM validation
- Last updated: 2026-08-04
- Related ADRs: `docs/adr/0003-stno-v1-fdm-only.md`
- Related specs: `docs/specs/problem-ir-v0.md`, `docs/specs/capability-matrix-v0.md`

(problem-statement)=
## 1. Problem statement

MuMax3 Standard Problem 5 is the current external-solver workload
`external_solvers/3/test/standardproblem5.mx3`. It is the spin-transfer-torque
benchmark proposed by Najafi et al. The workload starts from a vortex in a
`100 nm x 100 nm x 10 nm` rectangular Permalloy body, relaxes it, applies a
uniform current density along $x$, and integrates for $1\,\mathrm{ns}$.

The Fullmag reproduction is an ordinary stage-first Python script,
`examples/mumax_standard_problem_5_fdm.py`. It deliberately keeps the literal
source constants visible so that a reviewer can compare the source file, the
lowered `ProblemIR`, and the output artifact without relying on hidden defaults.
The default lane is FDM CPU in double precision. FDM GPU is exposed only for a
diagnostic fixed-step Heun run; its adaptive capability identity is not yet
qualified.

The source expression
`setcellsize(100e-9/32,100e-9/32,10e-9/4)` means a **total** thickness of
$10\,\mathrm{nm}$ because there are four cells in $z$. Treating the final
extent as $40\,\mathrm{nm}$ is a geometry error and is explicitly rejected by
the regression test.

(governing-equations)=
## 2. Physical model

### 2.1 Governing equations

The reduced magnetization is evolved with the Gilbert equation and a
Zhang--Li current torque:

```{math}
:label: sp5-llg-gilbert
\frac{\partial\mathbf m}{\partial t}
=-\gamma_0\,\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\,\mathbf m\times\frac{\partial\mathbf m}{\partial t}
+\mathbf T_{\mathrm{ZL},G},
\qquad \lVert\mathbf m\rVert=1.
```

The source current is a signed CIP current. With $\mathbf J_c$ in
$\mathrm{A\,m^{-2}}$, the advection velocity and non-adiabatic parameter are

```{math}
:label: sp5-zhang-li
\mathbf u=\frac{g\,\mu_B\,P}{2eM_s}\,\mathbf J_c,
\qquad
\mathbf T_{\mathrm{ZL},G}
=-(\mathbf u\!\cdot\!\nabla)\mathbf m
+\beta\,\mathbf m\times[(\mathbf u\!\cdot\!\nabla)\mathbf m].
```

Fullmag's public names map `Pol` to `degree=$P$` and `xi` to
`beta=$\beta$`. The current is not a Slonczewski/CPP torque and no polarizer
layer is inferred from this benchmark.

The effective field in this source workload contains exchange and open-boundary
demagnetization:

```{math}
:label: sp5-effective-field
\mathbf H_{\mathrm{eff}}
=\frac{2A_{\mathrm{ex}}}{\mu_0M_s}\nabla^2\mathbf m
+\mathbf H_{\mathrm{demag}}.
```

The initial state is the in-plane vortex preset with circulation $+1$ and core
polarity $+1$. The preset is a state initializer, not an additional energy
term. The relaxation stage uses Fullmag's explicitly declared overdamped
`llg_overdamped` policy with `relax_alpha=1`; the physical run restores the
source material damping $\alpha=0.1$. This preserves the equilibrium hand-off
without claiming that Fullmag reproduces MuMax3's private `relax()` controller
bit-for-bit.

(symbols-and-si-units)=
### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $A_{\mathrm{ex}}$ | exchange stiffness | $\mathrm{J\,m^{-1}}$ |
| $\alpha$ | Gilbert damping | $1$ |
| $\gamma_0$ | gyromagnetic coefficient | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\mathbf H_{\mathrm{eff}}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{demag}}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf T_{\mathrm{ZL},G}$ | Gilbert-source Zhang--Li torque | $\mathrm{s^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $t$ | physical time | $\mathrm{s}$ |
| $\mathbf J_c$ | signed charge-current density | $\mathrm{A\,m^{-2}}$ |
| $\mathbf u$ | Zhang--Li advection velocity | $\mathrm{m\,s^{-1}}$ |
| $g$ | Landé-factor provenance; fixed to 2.0 by the MuMax3-compatible source operator | $1$ |
| $\mu_B$ | Bohr magneton | $\mathrm{J\,T^{-1}}$ |
| $P$ | current spin polarization (`degree`) | $1$ |
| $e$ | elementary charge magnitude | $\mathrm C$ |
| $\beta$ | Zhang--Li non-adiabaticity (`xi`) | $1$ |
| $b$ | MuMax3 Zhang--Li source prefactor | $\mathrm{m^3\,A^{-1}\,s^{-1}}$ |
| $\Delta x,\Delta y,\Delta z$ | FDM cell sizes | $\mathrm m$ |
| $N_x$ | grid counts | $1$ |
| $N_y$ | grid counts | $1$ |
| $N_z$ | grid counts | $1$ |
| $\bar m_i$ | volume-weighted mean reduced-magnetization component | $1$ |
| $R_{ci}^{(e)}$ | volume-integrated affine-P1 restriction weight from tet4 element $e$ and node $i$ to Cartesian voxel $c$ | $1$ |
| $V_c$ | Cartesian voxel volume | $\mathrm{m^3}$ |
| $\lambda_i^{(e)}$ | affine P1 barycentric basis function of tet4 element $e$ | $1$ |
| $\vartheta_c$ | fraction of voxel $c$ covered by selected magnetic tetrahedra | $1$ |
| $\widetilde{\mathbf m}_c$ | volume-averaged FEM reduced magnetization reconstructed in voxel $c$ | $1$ |

The literal material and grid values are $M_s=8.0\times10^5\,\mathrm{A\,m^{-1}}$,
$A_{\mathrm{ex}}=13\times10^{-12}\,\mathrm{J\,m^{-1}}$,
$\alpha=0.1$, $\gamma_0=2.211\times10^5\,\mathrm{m\,A^{-1}\,s^{-1}}$,
$(N_x,N_y,N_z)=(32,32,4)$, and
$(\Delta x,\Delta y,\Delta z)=(3.125,3.125,2.5)\,\mathrm{nm}$.

(assumptions-and-validity)=
### 2.3 Assumptions and approximations

- The source is a regular, cell-centered FDM problem with one homogeneous
  magnetic region; no FEM geometry, interface spin accumulation, or SHE
  drift-diffusion solve is implied.
- The source uses a uniform, time-independent CIP current. Dynamic current
  envelopes and Oersted coupling are outside this benchmark.
- The benchmark uses the source's open-boundary demagnetizing realization. A
  periodic or finite-element demagnetizing result is not an equivalent oracle.
- The external expected values are an application reference at the specified
  grid, source parameters, and one-nanosecond horizon. They are not a proof of
  convergence as $\Delta x\to0$ or $\Delta t\to0$.
- MuMax3's internal `relax()` algorithm is not part of the public source
  contract. Fullmag records its numerical relaxation choice and requires an
  independent equilibrium gate before promoting a trajectory.

(python-api)=
## 3. Python API and authoring workflow

The reproduction uses the canonical stage-first surface:

```python
# %%
import fullmag as fm

# %%
study = fm.study("mumax_standard_problem_5_fdm")
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(100e-9, 100e-9, 10e-9),
               center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.cell(3.125e-9, 3.125e-9, 2.5e-9)

# %%
plate = study.geometry(fm.Box(size=(100e-9, 100e-9, 10e-9), name="plate"),
                       name="plate")
plate.Ms = 800e3
plate.Aex = 13e-12
plate.alpha = 0.1
plate.m = fm.texture.vortex(circulation=1, core_polarity=1)
study.exchange()
study.demag()

# %%
study.spin_torque(fm.ZhangLiSTT(
    current_density=(1e12, 0.0, 0.0), degree=1.0, xi=0.05,
    id="sp5_zhang_li", target=fm.RegionRef("plate"), lande_g=2.0,
    operator_version="zl_mumax3_central_v1"))
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped",
                        tolT=1e-6, max_steps=100000, relax_alpha=1.0)
study.stages.add_run(1e-9, stage_id="current_run")
```

The repository example additionally selects the explicit source gamma and
adaptive RK45 policy by default. `FULLMAG_SP5_FIXED_DT` is an opt-in diagnostic
switch, not a production qualification setting.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `study.engine` | `str` | required | $1$ | `fdm` for this contract | requested solver family | FDM CPU/GPU | `runtime_selection.backend` |
| `study.device` | `str` | `cpu` | $1$ | `cpu` or explicit `gpu` | requested execution device | FDM CPU/GPU | `runtime_selection.device` |
| `study.universe.size` | `tuple[float,float,float]` | required | $\mathrm m$ | three positive finite lengths | physical domain extent | FDM CPU/GPU | `runtime_metadata.study_universe.size` |
| `study.cell` | `tuple[float,float,float]` | required | $\mathrm m$ | three positive finite cell sizes | Cartesian FDM spacing | FDM CPU/GPU | `discretization.fdm.cell` |
| `plate.Ms` | `float` | required | $\mathrm{A\,m^{-1}}$ | positive finite | saturation magnetization | FDM CPU/GPU | `materials[].saturation_magnetisation` |
| `plate.Aex` | `float` | required | $\mathrm{J\,m^{-1}}$ | positive finite | exchange stiffness | FDM CPU/GPU | `materials[].exchange_stiffness` |
| `plate.alpha` | `float` | required | $1$ | non-negative finite | physical Gilbert damping | FDM CPU/GPU | `materials[].damping` |
| `ZhangLiSTT.current_density` | `vec3` | required | $\mathrm{A\,m^{-2}}$ | finite signed vector | CIP charge current | FDM CPU reference; FEM CPU reference; GPU diagnostic | `spin_torque_modules[].current_density` |
| `ZhangLiSTT.degree` | `float` | `1.0` | $1$ | finite polarization degree | current polarization | FDM CPU reference; FEM CPU reference; GPU diagnostic | `spin_torque_modules[].degree` |
| `ZhangLiSTT.xi` | `float` | required | $1$ | finite; alias of beta | non-adiabaticity | FDM CPU reference; FEM CPU reference; GPU diagnostic | `spin_torque_modules[].beta` |
| `ZhangLiSTT.id` | `str` | required for canonical operator | $1$ | non-empty | torque identity | FDM CPU/GPU MuMax3; FEM canonical reference | `spin_torque_modules[].id` |
| `ZhangLiSTT.target` | `RegionRef` | required for canonical operator | $1$ | existing object/region | target mask ownership | FDM CPU/GPU MuMax3; FEM central reference | `spin_torque_modules[].target` |
| `ZhangLiSTT.lande_g` | `float` | required for canonical operator | $1$ | exactly `2.0` for `zhang_li.mumax3.v1`; finite and positive for `zhang_li.fullmag.v1` | explicit Landé-factor provenance | FDM CPU/GPU MuMax3 source identity; FEM central reference | `spin_torque_modules[].lande_g` |
| `ZhangLiSTT.operator_version` | `str` | `zl_mumax3_central_v1 for FDM; zl_central_reference_v1 for FEM` | $1$ | versioned operator compatible with the selected backend | spatial/formula realization | FDM CPU/GPU; FEM CPU reference | `spin_torque_modules[].operator_version` |
| `add_relax.tolT` | `float` | `1e-6` | $\mathrm T$ | positive finite; exclusive with `tolA` | maximum relaxation torque | FDM CPU reference; GPU diagnostic | `study.stop.torque_tolerance_apm` |
| `add_run.until` | `float` | required | $\mathrm s$ | positive finite | physical observation horizon | FDM CPU reference; GPU diagnostic | `stage.default_until_seconds` |

(problem-ir)=
## 4. ProblemIR representation and normalization

The run-stage normalized fragment is:

```json
{
  "runtime_selection": {"backend": "fdm", "device": "cpu", "execution_precision": "double"},
  "study_universe": {"mode": "manual", "size": [1e-7, 1e-7, 1e-8]},
  "discretization": {"fdm": {"cell": [3.125e-9, 3.125e-9, 2.5e-9]}},
  "energy_terms": [{"kind": "exchange"}, {"kind": "demag", "realization": "auto"}],
  "spin_torque_modules": [{
    "kind": "zhang_li",
    "schema_version": "zhang_li_torque.v1",
    "id": "sp5_zhang_li",
    "target": {"object_id": "plate"},
    "formula_version": "zhang_li.mumax3.v1",
    "operator_version": "zl_mumax3_central_v1",
    "lande_g": 2.0,
    "degree": 1.0,
    "beta": 0.05,
    "current_density": [1e12, 0.0, 0.0]
  }]
}
```

The relaxation stage is a separate stage IR: it has no spin-torque module,
uses `llg_overdamped`, and carries the stage-local damping override
`relax_alpha=1.0`. The run stage carries the physical `alpha=0.1` and the
Zhang--Li module. Unit normalization converts `tolT` to the internal
`torque_tolerance_apm`; it does not change the public T-valued input.

(round-trip-and-failure-semantics)=
## 5. Round-trip and failure semantics

The requested intent records FDM, the requested device, literal grid, torque
parameters, and one-nanosecond horizon. The resolved execution must separately
record CPU or CUDA, precision, integrator, and the artifact's device identity.
The Python loader, canonical script exporter, and UI model-builder must retain
these fields without replacing `xi`/`beta`, the current sign, or the $z$ extent.

Validation errors are required for non-positive cell sizes, a non-finite or
wrong-length current vector, incompatible torque aliases, and an adaptive CUDA
request without an executable adaptive capability identity. Unsupported combinations
include FEM execution of this FDM-only source contract and a
strict GPU claim backed only by a fixed-step diagnostic. No silent CPU fallback
is allowed for a strict GPU request.

(discrete-realization)=
## 6. Numerical realization

### 6.1 FDM CPU

The reference lane uses a regular cell-centered grid and double precision. The
exchange operator is the FDM nearest-neighbour realization and demagnetization
is the selected open-boundary FDM implementation. The default source-faithful
time policy is adaptive RK45; the equilibrium stage is overdamped and stage
local. The versioned MuMax3 central operator is executable in this CPU lane and
has an independent one-cell/one-step algebraic oracle. A completed CPU adaptive
run at the full one-nanosecond horizon is still required for trajectory
qualification.

The legacy Fullmag Zhang--Li evaluator remains a separate compatibility
operator. It selects an upwind neighbour from the sign of $J$ and uses
`(m_i-m_{i-1})/\Delta x`; it is never relabelled as MuMax3. The reproduction
therefore requests the explicit FDM operator
`formula_version=zhang_li.mumax3.v1`, `operator_version=zl_mumax3_central_v1`.
This is the source-compatible realization of
`external_solvers/3/cuda/zhangli2.cu`:

```{math}
:label: sp5-zhang-li-mumax3
b=\frac{P\mu_B}{2eM_s(1+\beta^2)},\qquad
\mathbf v_i=b\sum_{a\in\{x,y,z\}}J_a
\frac{\mathbf m_{i+\hat a}-\mathbf m_{i-\hat a}}{\Delta a},
```

where each neighbour is clamped at an open boundary and wrapped on a periodic
axis, exactly as MuMax3's `hclamp*`/`lclamp*` stencil. The factor $1/2$ is
already part of $b$; applying another central-difference factor would halve
the source torque and is not the `addzhanglitorque2` kernel. The direct RHS uses
the single Gilbert projection

```{math}
:label: sp5-zhang-li-mumax3-rhs
\mathbf T_{\mathrm{MuMax3}}=
\frac{-(1+\alpha\beta)\,\mathbf m\times(\mathbf m\times\mathbf v)
 +(\alpha-\beta)\,\mathbf m\times\mathbf v}{1+\alpha^2}.
```

The numerical constants are pinned to the external kernel
($\mu_B=9.2740091523\times10^{-24}\,\mathrm{J/T}$ and
$e=1.60217646\times10^{-19}\,\mathrm C$). CPU FDM and native CUDA carry the
same discriminator; FEM rejects this MuMax3 realization and uses the separate
`zhang_li.fullmag.v1` central P1 operator. The old
`zhang_li.legacy_fullmag.v0` path is unchanged.

`lande_g` is retained in the canonical Python/IR record for explicit physical
provenance. It is required to be exactly `2.0` for this source-compatible
MuMax3 operator because `external_solvers/3/cuda/zhangli2.cu` fixes
`GAMMA0=1.7595e11` and does not expose a configurable Landé factor. Fullmag
rejects another value at authoring/IR validation; it must not accept a value
that the FDM kernels would ignore. A future configurable-`g` operator requires
a new formula/version and an independent analytic and cross-solver oracle.

### 6.2 FDM GPU

The native CUDA kernels carry the same explicit discriminator and central
clamped/PBC stencil for FP64 and FP32. The single-grid v2 ABI now exposes an
executable adaptive RK23/DP45 timestep identity for FDM CUDA double; the
qualification registry still resolves it as `unvalidated` until a clean
managed trajectory and trace are archived. The earlier SP5 diagnostic used
CUDA double precision and fixed Heun. Its artifact records an NVIDIA GeForce
RTX 4080 SUPER, compute capability 8.9, CUDA driver 13010, runtime 12060, and
cuFFT. That trajectory fails the MuMax3 tolerance, so `qualification.json`
correctly remains `status=not_evaluated`.

The isolated operator gate is executable on the managed CUDA lane. The recipe
`just verify-fdm-zhang-li-native-contract` builds the native FDM library and
runs
`fdm::gpu::cuda::native::tests::native_fdm_mumax3_zhang_li_matches_cpu_reference_for_one_masked_step_when_cuda_is_available`.
The FP64 Heun step uses a masked $3\times3\times1$ plan, all three signed
current components, and explicit `zhang_li.mumax3.v1` /
`zl_mumax3_central_v1`. Exchange, demagnetization, and external field are
disabled deliberately so the assertion isolates Zhang--Li. CPU reference and
native CUDA agree under relative tolerance $5\times10^{-8}$ and absolute
tolerance $10^{-10}$ (`1 passed`). This is a one-step operator/integrator gate
only; it does not qualify relaxation, demagnetization, or the $1\,\mathrm{ns}$
SP5 trajectory.

### 6.3 FEM

The repository now contains an explicit FEM counterpart in
`examples/mumax_standard_problem_5_fem.py`. It uses the same physical body,
material constants, vortex preset, current density, and stage separation as the
source, but it is not the MuMax3-compatible FDM operator: FEM records
`zhang_li.fullmag.v1` with `zl_central_reference_v1`, while the FDM source lane
records `zhang_li.mumax3.v1` with `zl_mumax3_central_v1`.

A managed CPU-double FEM run now completes the full two-stage workload with
the canonical FEM Zhang--Li operator. On the bounded-but-fully-dynamic mesh
(`hmax=12 nm`, `hmin=6 nm`, airbox `hmax=40 nm`, 1961 tetrahedra, 382 nodes),
projected-gradient-BB relaxation reaches `9.03e-7 T` in 39 iterations and
the adaptive RK45 stage accepts 1028 steps to `t=1 ns`. Its final
volume-weighted mean is
$(\bar m_x,\bar m_y,\bar m_z)=(0.06571195970862106,
-0.07068185866088325,-0.001918570717269359)$, with
$(E_{\rm ex},E_{\rm demag},E_{\rm total})=(2.457573497099033e-18,
5.962245456383275e-19,3.053798042737360e-18)\,\mathrm J$ and
$\max|\tau|=3.283768393400342e-2\,\mathrm T$. The artifact is archived at
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fem-full-20260804-cpu-h12-bb-r12`.

The first refinement (`hmax=8 nm`, `hmin=3 nm`, airbox `hmax=30 nm`) has
10595 tetrahedra and 1822 nodes. It converges with the same torque stop to
`4.90e-7 T` in 78 minimizer iterations; the 1 ps dynamic endpoint is
$(0.04073733843953036,-0.009595994833123806,0.01187191608956891)$. A nominal
`hmax=6 nm`, `hmin=2.5 nm` mesh exposes a qualification blocker: PG-BB
oscillates near `1.3e-1 T` after 169 iterations, while nonlinear-CG decreases
the torque monotonically but still ends at `1.19e-5 T` after its 300-step
budget. The refinement is therefore not converged at the required `1e-6 T`
stop.

At the matched final time `t=1 ns`, the scalar comparison with the FDM CPU
MuMax3-operator artifact
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed-cpu`
has $\|\Delta\bar m\|_2=0.30233523404716306$ and is recorded by
`scripts/compare_sp5_scalar_runs.py`. This is a diagnostic endpoint report,
not equivalence: FEM uses `zhang_li.fullmag.v1`/`zl_central_reference_v1`, FDM
uses `zhang_li.mumax3.v1`/`zl_mumax3_central_v1`, and the relaxed equilibria,
finite-element mesh and Poisson--Robin demagnetization are not the same as the
FDM tensor-FFT realization. The FEM run also comes from a managed runtime with
`worktree_state=dirty`, so it is not a release qualification artifact.

The earlier one-step bounded probe remains archived at
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fem-probe-20260804-cpu-fixed-v2`.
Until a stable three-level FEM `h` sweep, controlled `dt` sweep, matched field
sampling, and independent operator/sign audit pass, FEM remains
`reference-executable/bounded` and `validated_workloads` must not advance.

The same final snapshots were then compared as fields on the FDM Cartesian
grid. `scripts/compare_sp5_field_states.py` reconstructs the FEM planner mesh
from `metadata.json` and applies the exact affine-P1 volume restriction
`build_tet4_cartesian_restriction`. The clipped tet4/voxel intersections cover
all `4096` FDM voxels (`valid_fraction=1.0`); the coverage extrema are
`0.9999999999999808` and `1.0000000000000167`, so the restriction preserves the
magnetic volume to floating-point round-off. Both snapshots are at `t=1 ns`.
The new report is archived at
`/zfn2/mateuszz/git/fullmag/runs/sp5-fem-fdm-volume-field-comparison-1ns-h12.json`.

The field metrics are substantially different: vector RMS error
`0.49796257925222454`, maximum error `1.9122155987326996`, p99 error
`1.679783779553503`, and cosine similarity `0.8741985937637287`. The sampled
FEM mean is `(0.06571195970862105, -0.07068185866088314,
-0.001918570717269364)`, exactly the volume-weighted artifact mean to the
reported precision; the FDM mean is
`(-0.23465571179208225, -0.09450957174904828, 0.02294296086440476)`. This is
evidence that the earlier scalar discrepancy is also visible in the full
texture, not an artifact of reducing each field to one vector. It remains a
diagnostic comparison: the volume-preserving field map removes restriction
error as an uncontrolled explanation, but no `h/dt` convergence, common
equilibrium, or operator/sign parity gate has passed. The volume-restricted
metrics are vector RMS `0.49731737652723923`, p99 `1.6738097210831444`, maximum
`1.8966968128889123`, and cosine similarity `0.874437658356207`.

The next comparison operator is defined as a volume-preserving tet4
restriction rather than another point-sampling heuristic. For each FDM voxel
$C_c$ and magnetic FEM tetrahedron $T_e$, the affine P1 nodal basis weight is

```{math}
:label: sp5-tet4-volume-restriction
R_{ci}^{(e)}=\frac{1}{V_c}\int_{C_c\cap T_e}\lambda_i^{(e)}(\mathbf r)\,dV,
\qquad
\vartheta_c=\frac{1}{V_c}\sum_e\lvert C_c\cap T_e\rvert,
```

where $V_c$ is the Cartesian voxel volume and $\lambda_i^{(e)}$ is the
tetrahedral barycentric basis function. The reconstructed voxel field is

```{math}
:label: sp5-tet4-volume-field
\widetilde{\mathbf m}_c
=\frac{\sum_{e,i}R_{ci}^{(e)}\mathbf m_i}{\vartheta_c},
\qquad 0<\vartheta_c\leq1,
```

and voxels with $\vartheta_c=0$ are masked. Because $\lambda_i^{(e)}$ is
affine, integrating it over the clipped convex polyhedron is exact up to the
floating-point geometry and clipping tolerance; it preserves the FEM volume
integral when the Cartesian grid covers the magnetic domain. This operator is
valid only for affine straight-sided tet4 cells and non-overlapping magnetic
meshes. Curved/high-order cells, overlapping elements, and uncovered magnetic
volume are rejected or remain outside the qualification scope. The operator is
an analysis/restriction layer, not a replacement for either backend's native
demagnetization or Zhang--Li solver.

### 6.4 Observables and artifact semantics

The external oracle checks the volume mean
$(\bar m_x,\bar m_y,\bar m_z)$ at $t=1\,\mathrm{ns}$:

```{math}
:label: sp5-mean-observable
\bar m_i=\frac{1}{N_xN_yN_z}\sum_{c=1}^{N_xN_yN_z}m_{c,i},
\qquad i\in\{x,y,z\}.
```

For the current diagnostic script, `m_final.json` is the authoritative field
artifact for this calculation. The CUDA final-output path now derives
`mx,my,mz` from the same final magnetization snapshot; in the fresh SP5 run the
scalar-to-field-mean differences are below `3e-17`. A scalar row is therefore
usable for this run, while the CPU accepted-step publication still needs a full
trajectory gate.

(implementation-mapping)=
## 7. Implementation mapping

The source constants are captured by `examples/mumax_standard_problem_5_fdm.py`
and lowered by `StudyBuilder`/`StudyStagesBuilder` into per-stage `ProblemIR`.
`ZhangLiSTT` owns the public `current_density`, `degree`, `beta`/`xi`, and
formula-version fields. The regression test checks the geometry, stage-local
damping, vortex preset, exact torque IR, and one-nanosecond horizon.

The native CUDA one-step parity test is kept in the active inline CUDA test
module in `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`; the historical
orphan `native/tests.rs` file is not runtime evidence.

The FEM counterpart is intentionally mapped separately from the FDM source
contract. Source-visible, compiled, executed-device, parity, and scientific
qualification statuses remain separate evidence levels. The full FEM CPU
trajectory is now executable and compared at a matched endpoint, but its
different canonical Zhang--Li realization, mesh, demagnetization operator, and
relaxed state prevent an equivalence claim. The managed runtime is dirty, so
the run is diagnostic rather than release qualification.

(validation)=
## 8. Validation strategy and current result

The external source expects:

| Component | MuMax3 reference | Acceptance |
|---|---:|---:|
| $\bar m_x$ | `-0.23479773` | absolute error $\le 1\times10^{-4}$ |
| $\bar m_y$ | `-0.09453578` | absolute error $\le 1\times10^{-4}$ |
| $\bar m_z$ | `0.02296375` | absolute error $\le 1\times10^{-4}$ |

The focused source-to-IR test passes. A fresh MuMax3 `v3.11.2` execution on the
RTX 4080 SUPER returned
$(\bar m_x,\bar m_y,\bar m_z)=(-0.23488366603851318,
-0.09453280270099640,0.022961989045143127)$, within the source golden
tolerance. The fresh Fullmag managed CUDA fixed-step run with `dt=1e-13 s`,
`tolT=1e-6 T`, and the corrected source prefactor returned
$(\bar m_x,\bar m_y,\bar m_z)=(-0.23465571179208225,
-0.09450957174904828,0.02294296086440478)$.
The component differences from the fresh MuMax3 run are
$(2.2795424643\times10^{-4},2.3230951948\times10^{-5},
-1.9028180738\times10^{-5})$, with vector RMS
$1.3274648427\times10^{-4}$. This is a substantial correction of the prior
factor-of-two error, but the maximum component still exceeds the external
$1\times10^{-4}$ tolerance; the executed result remains diagnostic and not
validated. The artifact records `execution_engine=cuda_fdm`, FP64/cuFFT,
`lossy_fallback_used=false`, and the scalar row agrees with the volume mean to
below `3\times10^{-17}`. The one-step oracle does not substitute for the full
trajectory comparison below.

The corresponding CPU fixed-step artifact is now complete at
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed-cpu`.
It contains the same `10000` accepted dynamic steps (plus the preceding
relaxation stage, `12458` total accepted steps), uses
`execution_engine=cpu_reference`, `rustfft`, and `lossy_fallback_used=false`.
The CPU and CUDA final fields agree to `6.94e-16` maximum component error and
`1.14e-16` vector RMS; their accepted-step traces have identical `step`,
`time`, and `dt` identities. Physical trace quantities agree to machine
precision apart from backend reduction round-off (maximum observed difference
`1.29e-3` in `max_dm_dt`, on a scale of `1e10 s^-1`). This closes the fixed
CPU↔CUDA trajectory parity gate, but both artifacts remain
`qualification.json.status=not_evaluated` because the MuMax3 error is still
above `1e-4` in the maximum mean component.

The required final matrix is: CPU adaptive RK45 at the source horizon; fixed
step refinement; independent equilibrium convergence; GPU adaptive capability
identity and device-resident parity; then (only then) an FDM/FEM comparison.
The isolated CPU↔CUDA MuMax3-operator step and the fixed-step trajectory parity
are green, but neither substitutes for the remaining scientific qualification
requirements.

(limitations)=
## 9. Limitations and deferred work

1. Complete and archive a CPU adaptive RK45 run with a qualified equilibrium
   and accepted-step mean samples.
2. Execute and qualify the newly identity-bound CUDA adaptive controller before
   using GPU adaptive results as evidence; the identity alone is not a
   scientific qualification.
3. Add timestep and grid convergence tables; the one diagnostic fixed-step
   result is not a production tolerance claim.
4. Isolate the central-v1 trajectory mismatch with independent equilibrium,
   operator, demagnetization, and update-order controls before changing the
   published equation.
5. Complete the FEM three-level mesh, demagnetization, timestep, and matched
   field-sampling gates. The volume-preserving tet4 restriction is now
   implemented and tested, but the current hmax=6 nm minimizer budget is not
   yet torque-qualified.
6. Keep the one-step CPU↔CUDA gate green while extending it to an accepted-step
   trajectory and a device-resident parity matrix.

(scientific-bibliography)=
## 10. Scientific bibliography

1. M. Najafi, B. Krüger, S. Bohlens, M. Franchin, H. Fangohr et al.,
   “Proposal for a standard problem for micromagnetic simulations including
   spin-transfer torque,” *Journal of Applied Physics* **105**, 113914
   (2009), DOI: [10.1063/1.3126702](https://doi.org/10.1063/1.3126702).
2. A. Thiaville et al., “Micromagnetic understanding of current-driven domain
   wall motion in patterned nanowires,” *Europhysics Letters* **69**, 990
   (2005), for the Zhang--Li advection/non-adiabatic torque convention.
3. `external_solvers/3/test/standardproblem5.mx3`, the vendored MuMax3 source
   contract and expected scalar values used by this validation note.

(source-code-index)=
## 11. Source-code index

| Source id | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| `sp5-source-file-gridsize` | `external_solvers/3/test/standardproblem5.mx3` | `setgridsize` | source grid counts |
| `sp5-source-file-cellsize` | `external_solvers/3/test/standardproblem5.mx3` | `setcellsize` | source cell sizes and total thickness |
| `sp5-source-file-vortex` | `packages/fullmag-py/src/fullmag/init/textures.py` | `vortex` | Fullmag vortex initializer corresponding to the source preset |
| `sp5-source-file-relax` | `external_solvers/3/test/standardproblem5.mx3` | `relax` | source equilibrium stage |
| `sp5-source-file-run` | `external_solvers/3/test/standardproblem5.mx3` | `run` | source one-nanosecond stage |
| `sp5-python-study` | `packages/fullmag-py/src/fullmag/world.py` | `study` | stage-first study entry point |
| `sp5-python-add-relax` | `packages/fullmag-py/src/fullmag/world.py` | `add_relax` | relaxation stage lowering |
| `sp5-python-add-run` | `packages/fullmag-py/src/fullmag/world.py` | `add_run` | physical-time stage lowering |
| `sp5-python-zhangli` | `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class ZhangLiSTT` | public Zhang--Li torque contract |
| `sp5-python-loader` | `packages/fullmag-py/src/fullmag/runtime/loader.py` | `load_problem_from_script` | script capture and per-stage IR |
| `sp5-mumax3-zhangli` | `external_solvers/3/cuda/zhangli2.cu` | `addzhanglitorque2` | external MuMax3 central clamped/PBC stencil and constants |
| `sp5-cpu-mumax3` | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `zhang_li_mumax3_torque_at_with` | FDM CPU MuMax3 operator |
| `sp5-cuda-mumax3` | `backends/fdm/gpu/cuda/integrators/llg_fp64.cu` | `zhang_li_neighbor_index` | native CUDA central/PBC neighbour realization |
| `sp5-cuda-cpu-parity-test` | `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` | `native_fdm_mumax3_zhang_li_matches_cpu_reference_for_one_masked_step_when_cuda_is_available` | managed FP64 one-step CPU↔CUDA operator gate |
| `sp5-ir-mumax3` | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | execution provenance fields for formula/operator/target/Landé |
| `sp5-fem-fixture` | `packages/fullmag-py/src/fullmag/world.py` | `study` | stage-first study builder invoked by the shared-domain FEM counterpart fixture |
| `sp5-fem-demag-runtime` | `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp` | `context_compute_demag_poisson` | FEM Poisson--Robin demagnetization realization and volume-weighted observables |
| `sp5-fem-zhangli-provenance` | `crates/fullmag-runner/src/artifacts.rs` | `fem_spin_torque_provenance` | resolved FEM CPU engine and versioned Zhang--Li provenance |
| `sp5-comparison-script` | `scripts/compare_sp5_scalar_runs.py` | `compare` | matched-time FEM/FDM scalar endpoint comparison with diagnostic-only qualification |
| `sp5-field-comparison-script` | `scripts/compare_sp5_field_states.py` | `compare` | matched-time FEM/FDM field comparison on the FDM grid with explicit restriction method and diagnostic qualification |
| `sp5-tet4-volume-restriction` | `packages/fullmag-py/src/fullmag/analysis/fem_cartesian_restriction.py` | `build_tet4_cartesian_restriction` | exact affine-P1 volume-preserving tet4-to-Cartesian restriction used to separate field mapping error from solver physics |
