# FEM frequency-domain Floquet demagnetization

- Status: canonical physics contract for a planned modal and driven-response
  extension; nonzero-k dynamic demagnetization is not production qualified
- Owner: FEM frequency-domain magnetic and magnetostatic interaction
- Related canonical pencil: 0831-fem-dynamic-pencil-modal-response-and-krylov.md
- Related architecture decision: docs/adr/0031-fem-nonzero-k-dispersion-representations.md

This page freezes the magnetostatic part of the nonzero-k contract. It does not
claim that the current runner, FEM ABI, CPU lane, GPU lane or user interface
executes the complete operator.

(problem-statement)=
## 1. Problem statement

Frequency-domain studies linearize the magnetization around an accepted
equilibrium and use complex phasors. A forced response and a natural mode are
different products: a response has an external RF drive, while an eigensolve
has no independent drive and returns an eigenvalue and a mode profile. A
response peak can be a diagnostic candidate, but it is not an eigenmode.

For a periodic three-dimensional cell, the dynamic magnetization and dynamic
scalar potential must satisfy the same Bloch phase on every paired magnetic and
airbox face. A zero-k periodic Poisson provider cannot be reused at nonzero k.
For a translationally invariant waveguide, a transverse 2D envelope uses a
shifted derivative and a modified Helmholtz operator instead. These are two
representations of two different geometrical assumptions.

The canonical Fullmag convention is exp(+i omega t - i k dot r), with
lambda = i omega. The implementation must preserve requested wave vector,
resolved representation, precision, device and failure provenance. It must
reject an unavailable nonzero-k demagnetization request rather than silently
substituting an isolated or K0 operator.

The local Micromagnetics Module User's Guide is a workflow reference. It
describes a custom Physics Builder .jar module (PDF 6--8 of the 71-page
repository copy), separates Frequency Domain from Eigenfrequency, gives a
Floquet phase example, and couples a dynamic Ms*dmX/Y/Z field through a
second magnetic-fields interface. It does not establish a native standard
COMSOL LLG implementation or qualify Fullmag.

(governing-equations)=
## 2. Governing equations

### 2.1 Full Bloch field in a periodic 3D cell

The physical dynamic phasor is a periodic envelope multiplied by the Bloch
phase:

```{math}
:label: eq-0828-full-bloch-ansatz
\widetilde{\mathbf m}_{n\mathbf k}(\mathbf r)
=\mathbf u_{n\mathbf k}(\mathbf r)
\exp(-\mathrm{i}\mathbf k\cdot\mathbf r),
\qquad
\mathbf u_{n\mathbf k}(\mathbf r+\mathbf R)=\mathbf u_{n\mathbf k}(\mathbf r),
\qquad
\mathbf m_0(\mathbf r)\cdot\mathbf u_{n\mathbf k}(\mathbf r)=0.
```

The finite-element unknown is the full complex phasor. Its element
derivatives are ordinary gradients. The Bloch phase is represented by a
complex constraint or prolongation map $C(\mathbf k)$ on the magnetic tangent
coefficients and the scalar potential. The constrained action can therefore be
written as $C(\mathbf k)^\mathsf{H} A C(\mathbf k)$ without changing the
physical differential operator. Applying a shifted gradient to the same full
phase-constrained field would count k twice.

With $\widetilde{\mathbf M}=M_s\widetilde{\mathbf m}$, the dynamic
magnetostatic field is:

```{math}
:label: eq-0828-full-bloch-demag
\widetilde{\mathbf M}_{n\mathbf k}=M_s\widetilde{\mathbf m}_{n\mathbf k},
\qquad
\nabla^2\widetilde\phi_{n\mathbf k}
=\nabla\cdot\widetilde{\mathbf M}_{n\mathbf k}
\quad\text{in }\Omega_m,
\qquad
\nabla^2\widetilde\phi_{n\mathbf k}=0
\quad\text{in }\Omega_a,
\qquad
\widetilde{\mathbf h}_{d,n\mathbf k}
=-\nabla\widetilde\phi_{n\mathbf k}.
```

The ordinary-gradient weak form over the shared magnetic-plus-air cell is:

```{math}
:label: eq-0828-full-bloch-weak
\int_{\Omega}\nabla v^\ast\cdot\nabla\widetilde\phi_{n\mathbf k}\,\mathrm dV
=\int_{\Omega_m}\nabla v^\ast\cdot
\widetilde{\mathbf M}_{n\mathbf k}\,\mathrm dV.
```

For a source point and destination point related by
$\Delta\mathbf r=\mathbf r_{\mathrm{dst}}-\mathbf r_{\mathrm{src}}$, use one
phase for both fields:

```{math}
:label: eq-0828-full-bloch-constraint
p=\exp(-\mathrm{i}\mathbf k\cdot\Delta\mathbf r),
\qquad
\widetilde{\mathbf m}_{\mathrm{dst}}=p\widetilde{\mathbf m}_{\mathrm{src}},
\qquad
\widetilde\phi_{\mathrm{dst}}=p\widetilde\phi_{\mathrm{src}},
\qquad
T_{\mathrm{dst}}q_{\mathrm{dst}}
=pQ T_{\mathrm{src}}q_{\mathrm{src}},
\qquad
q_{\mathrm{dst}}
=p(T_{\mathrm{dst}}^\mathsf{T}Q T_{\mathrm{src}})q_{\mathrm{src}}.
```

$Q$ is the physical vector transformation for the periodic map and is the
identity for a pure translation. Constraint construction covers complete
corner and edge classes. The phase product around every closed cycle must be
path independent. The scalar potential has the same phase, while the normal
flux uses opposite outward normals on paired faces:

```{math}
:label: eq-0828-flux-condition
\partial_n\widetilde\phi_{\mathrm{dst}}
+p\,\partial_n\widetilde\phi_{\mathrm{src}}=0.
```

At k=0, $p=1$ and the seam is ordinary periodicity. Apply a mean-zero gauge
only if the assembled scalar operator actually has a constant nullspace. An
open or Robin exterior can be coercive even with lateral periodic faces.

### 2.2 Transverse waveguide envelope

The 2.5D representation is valid only when geometry, materials, equilibrium and
boundary data are invariant along the propagation axis $\hat{\mathbf z}$. It
uses a 2D transverse envelope, has no longitudinal seam pairs, and does not
use $C(\mathbf k)$:

```{math}
:label: eq-0828-waveguide-envelope-demag
D_{\mathbf k}=\nabla_\perp-\mathrm{i}k\hat{\mathbf z},
\qquad
(\nabla_\perp^2-k^2)\phi
=\nabla_\perp\cdot\delta\mathbf M_\perp-\mathrm{i}k\delta M_z,
\qquad
\mathbf h_{d,\perp}=-\nabla_\perp\phi,
\qquad
h_{d,z}=\mathrm{i}k\phi.
```

The scalar k is signed along $\hat{\mathbf z}$, and the fields are normalized
per unit waveguide length. The $k\mathbin{\to}0$ limit is a separate 2D
operator check; it does not prove equivalence to removing seams from a 3D
periodic cell. This is the planned S09 path inspired by TetraX arbitrary
cross-section propagating modes.

### Certyfikacja eliminacji potencjału w bounded FEM CPU

W `build_floquet_dynamic_demag_k_real_split` każda kolumna rozwiązania
potencjału jest podstawiana do oryginalnego bloku P, łącznie z wierszem
pominiętym przy pinowaniu. Norma maksimum błędu jest dzielona przez normę
maksimum oryginalnego RHS (dolne ograniczenie 1e-300 w tych samych jednostkach).
Próg względny wynosi 1e-8, bez jednostki. Nieskończony lub większy residual
powoduje operator_error przed publikacją macierzy Schura. Certyfikat
`potential_solve_certified` jest prawdziwy dopiero po wszystkich RHS.
Pinowanie nie naprawia niezgodnego źródła; zgodność pominiętego równania jest
obowiązkowa. Nie dowodzi to identyfikacji nullspace ani pełnego residualu modu.
Parametry publicznego Python/IR nie zmieniają się. Ta kontrola dotyczy bounded
FEM CPU; nie kwalifikuje FEM GPU ani backendów FDM.
Diagnostyka modalna zachowuje `floquet_potential_certificate`; pole
`full_modal_residual_certified=false` oddziela tę kontrolę od V9.

Wewnętrzny `FloquetPotentialReconstruction` zachowuje oryginalne bloki
zredukowane po Schurze. `reconstruct_floquet_potential` odtwarza potencjał
ze znakiem przeciwnym do rozwiązania P inverse A_phiq q, zgodnie z dolnym
równaniem descriptora. Wynik zawiera kompleksowy potencjał, residual i status;
niezgodny gauge nie publikuje pola. Właściciel ogranicza ten oracle do 512
DOF na blok. Adapter dense SLEPc (nearest/window) przekazuje teraz każdy zaakceptowany
wektor do `certify_floquet_realified_mode`. Dwa sektory realifikacji są
rekonstruowane oddzielnie; zapisany potencjał ma nadal podwojony układ
współczynników zespolonych, nie jest bezpośrednio phasorem XYZ ani polem Zarr.
Kontrola oryginalnego równania magnetycznego używa stiffness sprzed dodania
Schura, odtworzonego sprzężenia z potencjałem i gyrotropic mass. Norma maksimum
residualu jest dzielona przez maksimum sumy modułów tych trzech wkładów
wiersza (floor 1e-300 w tych samych jednostkach). Względny próg wynosi 1e-8;
zero eigenvector, niepoprawny wymiar i niefinite dane są odrzucane.
Certyfikat dotyczy algebraicznego descriptora po ograniczeniach. Geometryczne
BC, rozwinięcie potencjału na pełnej siatce i zbieżność V9 nadal są otwarte.
Contour z kontekstem rekonstrukcji jest jawnie odrzucany do czasu integracji.
Wynik natywny per-mode zawiera residuale oraz potential_vector_real/imag;
`floquet_geometric_bc_certified=false` zapobiega awansowi do pełnego V9.

### 2.3 Modal pencil and original residual

The same tangent LLG pencil is used by both representations, but each sample
has its own constrained operator:

```{math}
:label: eq-0828-modal-pencil
L(\mathbf k)q=\lambda B_\alpha(\mathbf k)q,
\qquad
\lambda=\mathrm{i}\omega,
\qquad
\omega=\omega_r+\mathrm{i}\Gamma,
\qquad
f=\frac{\omega_r}{2\pi}.
```

For a full descriptor with a scalar potential, acceptance reconstructs the
original blocks and evaluates:

```{math}
:label: eq-0828-original-residual
\begin{aligned}
r_q&=A_{qq}q+A_{q\phi}\phi-\lambda B_{qq}q,\\
r_\phi&=A_{\phi q}q+P\phi+c\eta,\\
r_g&=c^\mathsf{T}\phi,\\
\epsilon_{\mathrm{full}}&=\max(\epsilon_q,\epsilon_\phi,\epsilon_g).
\end{aligned}
```

The reduced or preconditioned residual is diagnostic only. A reported mode
needs the full residual, phase and frame seam errors, scalar-potential
continuity, gauge policy and normalization.

(symbols-and-si-units)=
### 2.4 Symbols and SI units

| Field or symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf r$ | spatial position | $\mathrm{m}$ |
| $t$ | time | $\mathrm{s}$ |
| $\mathbf m$, $\mathbf m_0$, $\widetilde{\mathbf m}_{n\mathbf k}$ | normalized magnetization, accepted equilibrium and dynamic phasor | $1$ |
| $\mathbf u_{n\mathbf k}$ | periodic Bloch envelope | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\widetilde{\mathbf M}_{n\mathbf k}$ | dynamic magnetization phasor | $\mathrm{A\,m^{-1}}$ |
| $\widetilde\phi_{n\mathbf k}$ | full Bloch scalar-potential phasor | $\mathrm{A}$ |
| $\phi$ | transverse waveguide scalar-potential envelope | $\mathrm{A}$ |
| $\widetilde{\mathbf h}_{d,n\mathbf k}$ | dynamic demagnetizing-field phasor | $\mathrm{A\,m^{-1}}$ |
| $v$ | scalar-potential test function | $1$ |
| $\mathbf k$ | Bloch wave vector | $\mathrm{rad\,m^{-1}}$ |
| $k$ | signed wave number along the waveguide axis | $\mathrm{rad\,m^{-1}}$ |
| $\Delta\mathbf r$ | paired-face translation | $\mathrm{m}$ |
| $\mathbf R$ | lattice translation | $\mathrm{m}$ |
| $p=\exp(-\mathrm{i}\mathbf k\cdot\Delta\mathbf r)$ | Floquet phase | $1$ |
| $C(\mathbf k)$ | complex full-Bloch constraint or prolongation map | $1$ |
| $T$, $T_{\mathrm{src}}$, $T_{\mathrm{dst}}$ | tangent-frame maps | $1$ |
| $q$, $q_{\mathrm{src}}$, $q_{\mathrm{dst}}$ | tangent-plane coefficients | $1$ |
| $Q$ | physical vector transformation across a pair | $1$ |
| $\nabla$, $\nabla_\perp$ | ordinary and transverse spatial gradients | $\mathrm{m^{-1}}$ |
| $\partial_n$ | outward normal derivative on a paired face | $\mathrm{m^{-1}}$ |
| $D_{\mathbf k}=\nabla_\perp-\mathrm{i}k\hat{\mathbf z}$ | waveguide shifted gradient | $\mathrm{m^{-1}}$ |
| $\hat{\mathbf z}$ | propagation direction | $1$ |
| $\delta\mathbf M_\perp$, $\delta M_z$ | transverse and longitudinal waveguide magnetization components | $\mathrm{A\,m^{-1}}$ |
| $\Omega$, $\Omega_m$, $\Omega_a$ | full cell, magnetic and air subdomains | $\mathrm{m^3}$ |
| $\mathrm dV$ | volume measure | $\mathrm{m^3}$ |
| $\omega$, $\omega_r$, $\Gamma$ | complex angular frequency, oscillation and decay rates | $\mathrm{rad\,s^{-1}}$ |
| $\lambda$ | generalized eigenvalue | $\mathrm{s^{-1}}$ |
| $f$ | cyclic frequency | $\mathrm{Hz}$ |
| $L$ | dynamic restoring operator | $\mathrm{m^3\,s^{-1}}$ |
| $B_\alpha$ | damped gyrotropic or mass operator | $\mathrm{m^3}$ |
| $A_{qq}$, $A_{q\phi}$, $A_{\phi q}$, $P$ | descriptor magnetic, coupling and scalar blocks | $\mathrm{m^3\,s^{-1}}$, $\mathrm{m^3\,A^{-1}\,s^{-1}}$, $\mathrm{A\,m}$, $\mathrm{m}$ |
| $A_{q\phi}$ | potential-to-magnetic coupling block | $\mathrm{m^3\,A^{-1}\,s^{-1}}$ |
| $A_{\phi q}$ | magnetic-to-potential coupling block | $\mathrm{A\,m}$ |
| $P$ | scalar Poisson block | $\mathrm{m}$ |
| $c$, $\eta$ | conditional gauge vector and multiplier | $\mathrm{m^3}$, $\mathrm{A\,m^{-2}}$ |
| $r_q$, $r_\phi$, $r_g$ | original magnetic, scalar and gauge residuals | $\mathrm{m^3\,s^{-1}}$, $\mathrm{A\,m}$, $\mathrm{A\,m^3}$ |
| $\epsilon_q$, $\epsilon_\phi$, $\epsilon_g$, $\epsilon_{\mathrm{full}}$ | normalized residuals | $1$ |
| $\operatorname{Re}$, $\exp$, $\mathrm{i}$, $\pi$, $(\cdot)^\mathsf{T}$, $(\cdot)^\mathsf{H}$, $(\cdot)^\ast$, $\cdot$, $\max$ | real part, exponential, imaginary unit, circle constant, transpose, Hermitian transpose, conjugation, contraction and maximum | $1$ |

(assumptions-and-validity)=
## 3. Assumptions and validity

- The equilibrium is accepted on the same mesh, material state, geometry and
  boundary topology as the linearization.
- A 3D full Bloch cell uses ordinary gradients and complex phase constraints
  on both magnetic and magnetostatic fields. It never also uses $D_{\mathbf k}$.
- The waveguide envelope requires translational invariance along its axis and
  uses $D_{\mathbf k}$ without longitudinal phase pairs.
- The scalar-potential gauge is conditional on an actual nullspace.
- Complex fields are first-class outputs. Gilbert damping makes the pencil
  non-Hermitian; a damping-enabled modal result needs left/right or equivalent
  nonnormal diagnostics.
- The local COMSOL manual is not a native implementation oracle. Its DMI
  boundary-condition warning (PDF 25, printed page 20 in the 71-page copy)
  requires independent Fullmag seam and interface tests.
- TetraX comparison is meaningful only for its translationally invariant
  waveguide/layer assumptions; it is not a 3D arbitrary-periodic-cell oracle.

(discrete-realization)=
## 4. Discrete realization

### 4.1 FEM 3D full Bloch

(full-bloch-contract)=

Assemble the ordinary-gradient shared-domain Poisson operator on magnetic and
air elements. Build complete seam equivalence classes and apply the complex
constraint map to the interleaved local tangent layout and scalar potential.
The matrix-free magnetic action is the planned C^H A C boundary. The new
foundational FloquetTangentProlongation and FloquetReducedMagneticOperator
source is visible, but it is currently uncompiled, unvalidated and disconnected
from the solver ABI. The scalar potential, dynamic demagnetization coupling,
and selected-spectrum solve remain future steps.

### 4.2 FEM 2.5D waveguide

(waveguide-envelope-contract)=

The planned S09 owner will assemble the transverse modified Helmholtz block,
the -i k delta M_z source and the +i k phi longitudinal field. It must reject
geometry or equilibrium that changes along the axis and must publish per-length
normalization and the k-to-zero policy.

### 4.3 FDM CPU/GPU boundary

FDM demagnetization uses a convolution or another FDM-specific kernel. It
cannot claim this FEM scalar-potential floquet_airbox realization. A future
FDM reference may supply independent frequency-versus-k data, but a time-domain
FFT peak is not a modal eigenvalue.

### 4.4 Support and qualification matrix

| Solver | Device | Status | Boundary |
|---|---|---|---|
| FEM | CPU | source_visible / unvalidated | Full Bloch prolongation source is present; dynamic demagnetization-k and solver connection are not qualified. |
| FEM | GPU | source_visible / unvalidated | Shared physics is specified; device operator, residency, parity and runtime are not qualified. |
| FDM | CPU | not-applicable | This page owns an FEM scalar-potential realization; FDM needs a separate convolution-k owner. |
| FDM | GPU | not-applicable | This page owns an FEM scalar-potential realization; FDM needs a separate convolution-k owner. |

(python-api)=
## 5. Python API

The page adds no public field. It reuses the existing stage-first
add_frequency_response and k_sampling authoring surface. This example is
copyable and demonstrates a nonzero-k Floquet request. The explicit `pbc`
declaration creates the lateral mesh seam pairs before domain-mesh creation;
the same x/y extent of the film and airbox makes those seams part of the
declared cell. Current planning must still reject the request because
`floquet_airbox` dynamic demagnetization is not qualified.

```python
# %% Imports and execution intent
import fullmag as fm

study = fm.study("floquet_demag_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %% Geometry, material and accepted initial state
study.universe(
    mode="auto",
    size=(60e-9, 60e-9, 90e-9),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(maximum_element_size=60e-9)
film = study.geometry(
    fm.Box(size=(60e-9, 60e-9, 10e-9), name="film"),
    name="film",
)
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.0
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
film.mesh(maximum_element_size=30e-9, order=1)
study.b_ext(0.05, 0.0, 0.0)
study.exchange()
study.demag(realization="poisson_robin")
study.pbc(x=True, y=True)
study.build_domain_mesh()

# %% Ordered equilibrium and response stages
study.stages.add_relax(
    algorithm="projected_gradient_bb",
    max_steps=1000,
    tolA=1e-3,
)
study.stages.add_frequency_response(
    frequencies_hz=(2.0e9, 4.0e9, 6.0e9),
    excitation_field_au_per_m=(0.0, 0.0, 1.0),
    excitation_phase_rad=0.0,
    observable="susceptibility_tensor",
    include_demag=True,
    equilibrium_source="relax",
    normalization="unit_l2",
    damping_policy="ignore",
    k_sampling=fm.KPath(
        points=(
            fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
            fm.KPoint("X", (1.0e6, 0.0, 0.0)),
        ),
        samples_per_segment=(3,),
    ),
    bc=fm.FloquetBC(pair_ids=("x_faces", "y_faces")),
    magnetostatic_bc="floquet_airbox",
)
```

This block is a driven-response authoring example: `excitation_field_au_per_m`
is intentional and no eigenvalue is returned. For the natural-dispersion aim,
use the modal stage-first example in
`0831-fem-dynamic-pencil-modal-response-and-krylov.md` and retain the same
`pbc` topology, k sampling and Floquet phase contract.

The relevant existing parameters are:

| Python parameter | Type | Default | SI unit | Validation domain and errors | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| add_frequency_response.frequencies_hz | Sequence[float] | required | $\mathrm{Hz}$ | Non-empty finite positive sequence; otherwise ValueError. | Driven-frequency samples. | FEM CPU/GPU authoring; runtime gated | study.frequencies_hz.values_hz. |
| add_frequency_response.excitation_field_au_per_m | tuple[float, float, float] | (0.0, 0.0, 1.0) | $\mathrm{A\,m^{-1}}$ | Exactly three finite components; otherwise ValueError. | Independent RF drive amplitude. | FEM CPU/GPU authoring; runtime gated | study.excitation.field_au_per_m. |
| add_frequency_response.excitation_phase_rad | float | 0.0 | $\mathrm{rad}$ | Finite after conversion; non-finite values raise ValueError. | Global RF-drive phase. | FEM CPU/GPU authoring; runtime gated | study.excitation.phase_rad. |
| add_frequency_response.include_demag | bool | True | $1$ | Boolean; unsupported physical combinations fail during planning. | Include the dynamic-demagnetization derivative. | FEM CPU/GPU authoring; nonzero-k gated | study.operator.include_demag. |
| add_frequency_response.k_sampling | object | None | $1$ | None, a 3-vector, KPoint or KPath; invalid input raises ValueError. | One k point or declared k path. | FEM CPU/GPU authoring; nonzero-k demag gated | study.k_sampling via coerce_k_sampling. |
| add_frequency_response.bc | str or PeriodicBC or FloquetBC or dict | free | $1$ | Supported spin-wave boundary; pair objects require non-empty IDs. | Dynamic magnetic seam or boundary condition. | FEM CPU/GPU authoring; runtime gated | study.spin_wave_bc. |
| add_frequency_response.magnetostatic_bc | str | open | $1$ | open, periodic_airbox_k0 or floquet_airbox; unsupported combinations fail closed. | Dynamic scalar-potential boundary model. | FEM CPU/GPU authoring; nonzero-k gated | study.magnetostatic_bc. |
| add_frequency_response.damping_policy | str | ignore | $1$ | ignore or include; invalid values raise ValueError. | Gilbert-damping participation in the pencil. | FEM CPU/GPU authoring; runtime gated | study.damping_policy. |
| study.pbc(x, y, z, demag, images) | bool axes plus optional image tuple | all false, demag=open, images=None | $1$ and $1$ | The selected axes must span matching periodic seams; `demag` is open, truncated_images or periodic_airbox_k0; invalid combinations raise ValueError. | Declare cell topology and generate the default FEM pair IDs `x_faces`, `y_faces`, `z_faces` before `build_domain_mesh`. | FEM CPU/GPU authoring; Floquet dynamic demag remains gated | study.periodic_boundary_conditions; study.default_mesh.periodic_pair_ids. |

(problem-ir)=
## 6. ProblemIR and normalization

The existing stage builder lowers the example to a first-class
frequency_response object. The relevant canonical fields are:

```json
{
  "kind": "frequency_response",
  "operator": {"kind": "linearized_llg", "include_demag": true},
  "k_sampling": {
    "kind": "path",
    "points": [
      {"label": "Gamma", "k_vector": [0.0, 0.0, 0.0]},
      {"label": "X", "k_vector": [1000000.0, 0.0, 0.0]}
    ],
    "samples_per_segment": [3],
    "closed": false
  },
  "spin_wave_bc": {
    "kind": "floquet",
    "pair_ids": ["x_faces", "y_faces"],
    "phase_convention": "exp_minus_i_k_dot_delta_r"
  },
  "periodic_boundary_conditions": {
    "axes": ["periodic", "periodic", "open"],
    "demag": "open"
  },
  "default_mesh": {
    "periodic_pair_ids": ["x_faces", "y_faces"]
  },
  "magnetostatic_bc": "floquet_airbox",
  "damping_policy": "ignore"
}
```

k_sampling is normalized by coerce_k_sampling; the legacy k_vector spelling is
an alias and cannot be supplied together with a non-equivalent sampling. SI
values remain in rad/m and A/m at the IR boundary. The planner adds resolved
representation and execution fields to provenance; it must not rewrite
floquet_airbox to periodic_airbox_k0 or to an isolated airbox.

(round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Python and UI preserve requested intent. The planner records resolved execution
and evidence status separately. Validation errors reject malformed k samples,
missing Floquet pair IDs, non-finite frequencies or inconsistent boundary
types before a run. Unsupported combinations include dynamic floquet_airbox
without a complete complex operator, a full 3D request using the waveguide
envelope assumption, a waveguide request with changing axial geometry, and
forced GPU without a qualified device lane.

Partial or rejected artifacts retain the requested and resolved boundary
models, phase convention, representation, normalization, device, precision,
reason and latest residual. A failed capability check is a correct result. No
fallback may erase the physical k or report a K0 calculation as nonzero-k.

(implementation-mapping)=
## 8. Implementation mapping

The existing Floquet validator checks phase cycles and tangent-frame transport.
The shared-domain Poisson owner remains the K0/provider boundary. The new
native prolongation and reduced operator are foundational source only. The
complete dynamic demagnetization coupling, potential reconstruction, selected
spectrum and artifact publication remain planned steps.

| Claim | Lane | Repository path + stable symbol | Responsibility | Evidence status |
|---|---|---|---|---|
| Public response stage | common | packages/fullmag-py/src/fullmag/world.py + frequency_response_stage | Capture stage-first frequency, k and boundary intent. | source visible; runtime unvalidated |
| Response IR | common | packages/fullmag-py/src/fullmag/model/study.py + class FrequencyResponse | Validate and normalize k sampling and magnetostatic boundary. | source visible; source tests exist |
| Phase contract | common | crates/fullmag-ir/src/eigen_contract.rs + PhaseConventionIR | Preserve exp_minus_i_k_dot_delta_r. | source visible |
| K-path expansion | common | crates/fullmag-runner/src/eigen/path.rs + expand_k_sampling | Expand declared k points and paths. | source visible; runtime unvalidated |
| Existing Floquet checks | FEM response | backends/fem/src/frequency_domain/driven_response_solver.cpp + validate_driven_response_floquet_phase_constraints | Check seam phase, frame and cycle consistency. | source visible; nonzero-k demag unavailable |
| Existing shared-domain assembly | FEM CPU | backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp + assemble_poisson_airbox_shared_domain | Keep the K0/shared-domain owner separate from Floquet-k. | source visible; physics unvalidated |
| Full Bloch tangent prolongation | FEM CPU planned | backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp + class FloquetTangentProlongation | Apply phase and tangent-frame transport with the interleaved local layout. | source visible; uncompiled/unvalidated; disconnected from solver ABI |
| Full Bloch reduced action | FEM CPU planned | backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp + class FloquetReducedMagneticOperator | Define the matrix-free C^H A C boundary. | source visible; uncompiled/unvalidated; disconnected from solver ABI |
| Contract regression | documentation | scripts/test_frequency_domain_math_contract_docs.py + test_dynamic_demag_and_response_observables_use_si_contract | Freeze algebra, units and honest support wording. | source visible; not numerical evidence |

(validation)=
## 9. Validation strategy

The following gates are required before capability promotion:

1. Algebra: random complex vectors, tangent-frame maps and corner cycles
   satisfy the same phase constraint in direct and C^H A C actions.
2. K0 parity: full Bloch at k=0 matches the qualified periodic provider where
   the scalar gauge and exterior boundaries are identical.
3. Demagnetization: manufactured potential, field-sign and energy tests,
   magnetic/scalar seam continuity, opposite-normal flux and three airbox
   padding refinements.
4. Exchange: a uniform saturated cell follows the k^2 curvature and has the
   expected reciprocal +k/-k result when nonreciprocal terms are off.
5. Supercell: a one-cell Gamma result agrees with a compatible explicit
   supercell after central-cell extraction.
6. Waveguide: the modified Helmholtz cross-section converges independently
   and its k-to-zero limit is tested against the separately assembled 2D case.
7. Product parity: modal frequency, driven resonance, mode profile and
   original descriptor residual agree within a predeclared error budget.
8. COMSOL/TetraX comparisons use exported results with exact SI parameters,
   topology, boundary policy, version and mesh; manuals and plots alone are
   not numerical evidence.
9. CPU/GPU requires device identity, residency, per-k parity, complex residuals
   and zero fallback. Source presence or a standalone algebra test is not
   runtime or production qualification.

(limitations)=
## 10. Limitations and deferred work

Nonzero-k dynamic demagnetization, nonzero-k DMI, the full scalar-potential
coupled modal solve, the 2.5D waveguide owner and GPU execution are not
qualified by this note. The finite airbox is an open-space approximation.
Periodic Green functions, Ewald sums, FFT/FMM kernels and Fredkin--Koehler
coupling need separate interaction owners and evidence. Complex k at fixed
frequency, nonlinear finite-amplitude waves, automatic field-by-k scans and
magnetoelastic coupling are outside this contract.

The conditional gauge, damping sign, branch tracking and original residual
remain mandatory even when the first implementation uses a lossless CPU
selected-spectrum slice. The TetraX waveguide representation must not be used
for a periodic 3D cell, and a full Bloch implementation must not apply
$D_{\mathbf k}$ to already phase-constrained fields.

(scientific-bibliography)=
## 11. Scientific bibliography and presentation references

- W. Yu, Micromagnetics Module User's Guide, V2.13, local repository copy
  docs/plans/active/fd_sovler_masterplan/MicromagneticsModuleUsersGuideV2.13.pdf,
  SHA-256 6c212ed2ee9580f2917118c58ed1caafec18488076a3e7bcb3eb15a64b5e49e1;
  Floquet PDF 27--28 (printed 22--23), standing-wave eigenfrequency PDF
  29--31 (printed 24--26), dynamic demagnetization PDF 40--43 (printed
  35--38), DMI boundary caveat PDF 25 (printed 20).
- Independent 74-page repository copy:
  docs/comsol/Manual_for_Micromagnetics_Module.pdf, SHA-256
  91f8f602d82bdec0a7b6c6947c1919e127c6d4f1a71c69819e328b7d54a06e2d.
  The two files are distinct byte-level copies; page claims above are anchored
  to the 71-page copy and cross-checked against the 74-page copy.
- W. Yu, Micromagnetic simulation with COMSOL Multiphysics,
  [COMSOL custom-module article](https://www.comsol.com/blogs/micromagnetic-simulation-with-comsol-multiphysics)
  and [Physics Builder exchange entry](https://www.comsol.com/community/exchange/883/).
- M. Mruczkiewicz et al., Weak Formulations for Calculating Spin Wave
  Dispersion Relation in Magnonic Crystals,
  [COMSOL paper abstract PDF](https://www.comsol.com/paper/download/181859/mruczkiewicz_abstract.pdf).
- TetraX authors, TetraX: a finite element micromagnetic solver for
  propagating spin waves in waveguides,
  [arXiv:2104.06943](https://arxiv.org/abs/2104.06943) and
  [numerical experiments documentation](https://tetrax.readthedocs.io/en/latest/usage/experiments.html).
- TetraX layer reduction:
  [arXiv:2207.01519](https://arxiv.org/abs/2207.01519). It is a
  translationally invariant layer/waveguide reference, not a proof for a
  general 3D periodic cell.
- Fullmag contracts:
  docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md,
  docs/specs/capability-matrix-v0.md and
  docs/architecture/backend-golden-masterplan.md.

(source-code-index)=
## 12. Source-code index

The following identities are repository-relative path plus stable symbol. They
identify source ownership and evidence boundaries; they do not turn source
visibility into runtime or physical qualification.

| Equation or claim | Lane | Repository path + stable symbol | Responsibility | Tests/evidence | Evidence status |
|---|---|---|---|---|---|
| All labelled full-Bloch field equations | FEM CPU/GPU planned | docs/physics/0828-fem-frequency-domain-floquet-demag.md + DOC-ANCHOR:full-bloch-contract | Freeze ordinary-gradient full Bloch demagnetization and seam constraints. | S03/S04 and V0--V4 pending | planned contract; no runtime evidence |
| Waveguide envelope equation | FEM CPU/GPU planned | docs/physics/0828-fem-frequency-domain-floquet-demag.md + DOC-ANCHOR:waveguide-envelope-contract | Freeze the separate shifted-gradient cross-section model. | S09/V5 pending | planned contract; no runtime evidence |
| Public response stage | common | packages/fullmag-py/src/fullmag/world.py + frequency_response_stage | Capture the public stage-first request. | Python source tests | source visible; runtime unvalidated |
| Periodic cell topology | common | packages/fullmag-py/src/fullmag/world.py + class StudyBuilder | Declare lateral axes and synchronize default FEM pair IDs before domain-mesh creation. | Python source tests; runtime unvalidated | source visible; runtime unvalidated |
| Response validation and IR | common | packages/fullmag-py/src/fullmag/model/study.py + class FrequencyResponse | Normalize frequencies, k sampling, BC and provenance fields. | Python/Rust round-trip tests | source visible |
| Phase convention | common | crates/fullmag-ir/src/eigen_contract.rs + PhaseConventionIR | Own the canonical phase spelling. | IR tests | source visible |
| K-path expansion | common | crates/fullmag-runner/src/eigen/path.rs + expand_k_sampling | Expand single points and paths. | runner tests | source visible; runtime unvalidated |
| Floquet seam validation | FEM response | backends/fem/src/frequency_domain/driven_response_solver.cpp + validate_driven_response_floquet_phase_constraints | Validate phase cycles and tangent-frame transport. | focused source tests | source visible; demag-k unavailable |
| K0/shared-domain Poisson | FEM CPU | backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp + assemble_poisson_airbox_shared_domain | Preserve existing K0/provider owner. | existing FEM source tests | source visible; nonzero-k unvalidated |
| Native full Bloch prolongation | FEM CPU planned | backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp + class FloquetTangentProlongation | Foundational phase/frame map for interleaved local coefficients. | fem_floquet_magnetic_operator_contract; not compiled here | source visible; uncompiled/unvalidated; disconnected from solver ABI |
| Native reduced action | FEM CPU planned | backends/fem/cpu/frequency_domain/operators/floquet_magnetic_operator.hpp + class FloquetReducedMagneticOperator | Foundational C^H A C MFEM boundary. | same standalone contract test; not a FEM run | source visible; uncompiled/unvalidated; disconnected from solver ABI |
| Dynamic nonzero-k demagnetization oracle | FEM CPU planned | backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp + build_floquet_dynamic_demag_k_real_split | Provide the bounded dense Schur oracle for complex nonzero-k dynamic demagnetization; mesh assembly and production qualification remain separate. | fem_floquet_dynamic_demag_k_contract source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated |
| MFEM Floquet airbox bridge | FEM CPU planned | backends/fem/cpu/frequency_domain/floquet_airbox_operator.hpp + assemble_floquet_airbox_dynamic_demag_k | Materialize bounded `C(k)^H P_full(k) C(k)` and `C(k)^H A_{phi q}` blocks, then delegate Schur elimination to the dynamic demag-k provider; production mesh assembly and capability promotion remain separate. | fem_floquet_airbox_operator_contract source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated |
| Waveguide nonzero-k demagnetization oracle | FEM CPU planned | backends/fem/include/frequency_domain/floquet_waveguide_demag_k.hpp + build_floquet_waveguide_demag_k_real_split | Provide the bounded 2.5D modified-Helmholtz and Schur oracle; transverse MFEM assembly and open-boundary convergence remain separate. | fem_floquet_waveguide_demag_k_contract source is present; compile/runtime unvalidated | source visible; uncompiled/unvalidated |
| Shared harmonic pencil | common native | backends/fem/include/frequency_domain/linearized_dynamic_pencil.hpp + apply_Aomega | Preserve the shared i omega B_alpha minus L convention. | existing dynamic-pencil contract tests | source visible; managed physics unvalidated |
| CPU descriptor boundary | FEM CPU | backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.hpp + solve_poisson_airbox_modal_eigen_cpu_schur | Reconstruct the full descriptor and original residual. | focused CPU Schur tests | source visible; managed qualification absent |
| Contract regression | documentation | scripts/test_frequency_domain_math_contract_docs.py + test_dynamic_demag_and_response_observables_use_si_contract | Protect SI and support wording. | focused documentation test | source visible; not numerical evidence |

| Reduced Floquet descriptor certificate | FEM CPU | backends/fem/cpu/frequency_domain/floquet_dynamic_demag_k.cpp + certify_floquet_realified_mode | source-floquet-descriptor-certification: reconstruct potential and test original reduced equations | isolated contract test passed; managed and geometric BC unverified | source visible |
