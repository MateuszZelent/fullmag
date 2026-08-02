# MuMax3 Standard Problem 5 as a Fullmag FDM validation contract

- Status: frozen source-to-IR reproduction; numerical parity is not yet qualified
- Owners: Fullmag FDM validation
- Last updated: 2026-08-02
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
| $g$ | electron g factor | $1$ |
| $\mu_B$ | Bohr magneton | $\mathrm{J\,T^{-1}}$ |
| $P$ | current spin polarization (`degree`) | $1$ |
| $e$ | elementary charge magnitude | $\mathrm C$ |
| $\beta$ | Zhang--Li non-adiabaticity (`xi`) | $1$ |
| $\Delta x,\Delta y,\Delta z$ | FDM cell sizes | $\mathrm m$ |
| $N_x$ | grid counts | $1$ |
| $N_y$ | grid counts | $1$ |
| $N_z$ | grid counts | $1$ |
| $\bar m_i$ | volume-weighted mean reduced-magnetization component | $1$ |

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
study.spin_torque(fm.ZhangLiSTT(current_density=(1e12, 0.0, 0.0),
                                degree=1.0, xi=0.05))
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
| `ZhangLiSTT.current_density` | `vec3` | required | $\mathrm{A\,m^{-2}}$ | finite signed vector | CIP charge current | FDM CPU reference; GPU diagnostic | `spin_torque_modules[].current_density` |
| `ZhangLiSTT.degree` | `float` | `1.0` | $1$ | finite polarization degree | current polarization | FDM CPU reference; GPU diagnostic | `spin_torque_modules[].degree` |
| `ZhangLiSTT.xi` | `float` | required | $1$ | finite; alias of beta | non-adiabaticity | FDM CPU reference; GPU diagnostic | `spin_torque_modules[].beta` |
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
    "formula_version": "zhang_li.legacy_fullmag.v0",
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
local. A completed CPU adaptive run at the full one-nanosecond horizon is still
required for qualification.

The current legacy Fullmag Zhang--Li evaluator is not the same discrete
operator as the vendored MuMax3 CUDA kernel. Fullmag selects an upwind neighbour
from the sign of $J$ and uses `(m_i-m_{i-1})/\Delta x`; MuMax3's
`zhangli2.cu` uses the centered numerator `(m_{i+1}-m_{i-1})` with the
corresponding `1/(2\Delta x)` scale. The public parameter mapping is therefore
valid, while trajectory parity remains open until a separately versioned
MuMax-compatible central operator and one-step oracle are added. The benchmark
must not silently relabel the existing `legacy_fullmag.v0` evaluator as
MuMax3-equivalent.

### 6.2 FDM GPU

The executed diagnostic uses CUDA double precision and fixed Heun because the
current planner rejects adaptive CUDA when it cannot attach an executable
timestep capability identity. The diagnostic artifact records an NVIDIA
GeForce RTX 4080 SUPER, compute capability 8.9, CUDA driver 13010, runtime
12060, and cuFFT. Its `qualification.json` is intentionally
`status=not_evaluated`.

### 6.3 FEM

No FEM SP5 reproduction is claimed. A FEM comparison would require an explicit
shared-domain or conforming magnetic mesh, a declared demagnetization
realization, and a spatial convergence table before its mean magnetization
could be compared with the FDM source result.

### 6.4 Observables and artifact semantics

The external oracle checks the volume mean
$(\bar m_x,\bar m_y,\bar m_z)$ at $t=1\,\mathrm{ns}$:

```{math}
:label: sp5-mean-observable
\bar m_i=\frac{1}{N_xN_yN_z}\sum_{c=1}^{N_xN_yN_z}m_{c,i},
\qquad i\in\{x,y,z\}.
```

For the current diagnostic script, `m_final.json` is the authoritative field
artifact for this calculation. The no-autosave path currently writes zeroes in
the `mx`, `my`, and `mz` columns of `scalars.csv`; those columns must not be
used as a comparison result until the accepted-sample publication path is
fixed. The report records this as an artifact-contract defect rather than
silently treating zero as a physical mean.

(implementation-mapping)=
## 7. Implementation mapping

The source constants are captured by `examples/mumax_standard_problem_5_fdm.py`
and lowered by `StudyBuilder`/`StudyStagesBuilder` into per-stage `ProblemIR`.
`ZhangLiSTT` owns the public `current_density`, `degree`, `beta`/`xi`, and
formula-version fields. The regression test checks the geometry, stage-local
damping, vortex preset, exact torque IR, and one-nanosecond horizon.

No native FEM or GPU code is inferred from the Python presence. Source-visible,
compiled, executed-device, parity, and scientific qualification statuses remain
separate evidence levels.

(validation)=
## 8. Validation strategy and current result

The external source expects:

| Component | MuMax3 reference | Acceptance |
|---|---:|---:|
| $\bar m_x$ | `-0.23479773` | absolute error $\le 1\times10^{-4}$ |
| $\bar m_y$ | `-0.09453578` | absolute error $\le 1\times10^{-4}$ |
| $\bar m_z$ | `0.02296375` | absolute error $\le 1\times10^{-4}$ |

The focused source-to-IR test passes. The first managed CUDA fixed-step run
with `dt=1e-13 s` and relaxation threshold `1e-4 T` produced, from
`m_final.json`,
$(\bar m_x,\bar m_y,\bar m_z)=(-0.23433954,-0.09938201,0.02290157)$.
The maximum component error is $4.85\times10^{-3}$, so the result fails the
external tolerance and remains diagnostic. A longer relaxation changed the
maximum error only to $4.84\times10^{-3}$; this does not close the temporal
integrator/adaptive-RK gate.

The required final matrix is: CPU adaptive RK45 at the source horizon; fixed
step refinement; independent equilibrium convergence; GPU adaptive capability
identity and device-resident parity; then (only then) an FDM/FEM comparison.

(limitations)=
## 9. Limitations and deferred work

1. Complete and archive a CPU adaptive RK45 run with a qualified equilibrium
   and accepted-step mean samples.
2. Fix or explicitly version the scalar artifact publisher so `mx/my/mz` agree
   with the final field mean.
3. Implement and qualify an executable CUDA adaptive controller before using
   GPU adaptive results as evidence.
4. Add timestep and grid convergence tables; the one diagnostic fixed-step
   result is not a production tolerance claim.
5. Add a FEM realization only after its own mesh, demag, and cross-backend
   convergence gates.

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
