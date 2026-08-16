# Obserwowalne pola i gęstości energii: wspólna materializacja FEM/FDM

- Status: active contract
- Owners: Fullmag physics, runtime and control-room teams
- Last updated: 2026-08-16
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/capability-matrix-v0.md`

## 1. Problem statement

(fdm-fem-observable-problem-statement)=

FDM i FEM muszą publikować te same obserwowalne quantity przez jeden katalog,
bez utożsamiania materializacji z obecnością danych w cache. W szczególności
pełnodomenowe `H_demag` musi zawierać wartości także poza magnetycznym
wsparciem, a przestrzenne `eden_*` muszą być prawdziwymi polami skalarnymi,
nie nakładką obliczaną w przeglądarce. `data/quantities` opisuje capability i
planowaną materializację; `data/fields` opisuje aktualny stan cache i payloadu.

## 2. Physical model

### 2.1 Governing equations

(fdm-fem-observable-governing-equations)=

Dla znormalizowanej magnetyzacji $\mathbf m$, nasycenia $M_s$ i składowej
pola $\mathbf H_i$ gęstości field-derived są:

```{math}
:label: eq-eden-ex
\varepsilon_{\mathrm{ex}}(\mathbf x) = -\frac{1}{2}\mu_0 M_s(\mathbf x)\,\mathbf m(\mathbf x)\cdot\mathbf H_{\mathrm{ex}}(\mathbf x).
```

```{math}
:label: eq-eden-demag
\varepsilon_{\mathrm{demag}}(\mathbf x) = -\frac{1}{2}\mu_0 M_s(\mathbf x)\,\mathbf m(\mathbf x)\cdot\mathbf H_{\mathrm{demag}}(\mathbf x).
```

```{math}
:label: eq-eden-ext
\varepsilon_{\mathrm{ext}}(\mathbf x) = -\mu_0 M_s(\mathbf x)\,\mathbf m(\mathbf x)\cdot\mathbf H_{\mathrm{ext}}(\mathbf x).
```

```{math}
:label: eq-eden-total
\varepsilon_{\mathrm{total}}(\mathbf x) = \sum_{i\in\mathcal A_{\mathrm{resolved}}}\varepsilon_i(\mathbf x),\qquad
E_i = \int_{\Omega}\varepsilon_i\,\mathrm dV.
```

FDM używa cell-centered payloadu o `n_comp=1` dla `eden_*`; w komórce o
objętości $V_c$ całka jest sumą $E_i=\sum_c\varepsilon_i(c)V_c$. FEM
zachowuje elementową lub kwadraturową własność fizyczną, a ewentualny payload
węzłowy ma jawne provenance projekcji. Solverowe `h_demag` pozostaje
maskowane dla LLG. `h_demag_visual` jest osobnym buforem obserwacyjnym i jest
źródłem pełnodomenowego `H_demag`.

### 2.2 Symbols and SI units

(fdm-fem-observable-symbols-and-si-units)=

| Symbol | Meaning | Unit |
|---|---|---|
| $\mathbf m$ | normalized magnetization direction | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_i$ | effective-field contribution | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\varepsilon_i$ | local energy density contribution | $\mathrm{J\,m^{-3}}$ |
| $E_i$ | integrated energy contribution | $\mathrm{J}$ |
| $V_c$ | FDM cell volume | $\mathrm{m^3}$ |
| $\Omega$ | observation domain | $\mathrm{m^3}$ |

### 2.3 Assumptions and approximations

(fdm-fem-observable-assumptions-and-validity)=

- Quantity jest aktywne tylko wtedy, gdy odpowiadający mu term fizyczny jest
  aktywny w rozstrzygniętym planie.
- Renderer nie rekonstruuje pola ani energii z innych quantity.
- `eden_total` sumuje wyłącznie termy dostępne w tym samym snapshot generation.
- FDM `H_demag` poza magnetycznym wsparciem jest obserwacją pełnodomenową;
  nie jest wejściem do LLG.
- FEM payload węzłowy jest projekcją wizualizacyjną i musi zachować informację
  o lokalizacji kanonicznej oraz regule całkowania.
- FP32 i FP64 mają tę samą semantykę, ale osobne bramki dokładności.

## 3. Numerical interpretation

(fdm-fem-observable-discrete-realization)=

### 3.1 FDM

(fdm-fem-observable-discrete-realization-fdm)=

CPU reference korzysta z tych samych pól co redukcja energii. CUDA przechowuje
osobno `h_demag` (solver, z `active_mask`) i `h_demag_visual` (obserwacja,
pełna domena). Kernel demagnetyzacji wylicza wartości raz, zapisuje visual
buffer przed maskowaniem i nie uruchamia drugiego FFT dla żądania pola. Scalar
`eden_*` jest materializowany w buforze urządzenia i kopiowany jako jeden
komponent na komórkę. Nieznane quantity kończy się błędem, a nie mapowaniem do
magnetyzacji.

### 3.2 FEM

(fdm-fem-observable-discrete-realization-fem)=

FEM zachowuje istniejący adapter snapshotu. Dla `H_demag` native GPU wybiera
odzyskany pełnodomenowy gradient potencjału Poissona, a nie materiałowo
maskowane pole LLG. Gęstości energii są elementowe/kwadraturowe; węzłowy
payload jest oznaczony jako projekcja `fem_nodal_visualization_projection`
albo, dla wspieranego DG0, jako `fem_nodal_conservative_tetra_projection`.
Backend scalar energy pozostaje źródłem prawdy dla walidacji całki.

### 3.3 Hybrid

(fdm-fem-observable-discrete-realization-hybrid)=

Hybrid nie ma jeszcze własnej materializacji. Planner odrzuca żądanie, gdy
żaden właściciel poddomeny nie publikuje kompatybilnego snapshotu; nie ma
cichego browser fallbacku.

## 4. API, IR, and planner impact

### 4.1 Python API surface

(fdm-fem-observable-python-api)=

Nie dodajemy nowego termu fizycznego. Quantity jest obserwacją wybieraną z
katalogu, a publiczny przykład pozostaje stage-first:

```python
# %%
import fullmag as fm

# %%
study = fm.study("observable_parity")
study.engine("fdm").device("cuda", precision="double")
study.observables.quantity("H_demag")
study.observables.quantity("eden_total")
study.stages.add_relax(steps=4)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `study.observables.quantity("eden_total")` | `QuantityId` | `not requested` | $1$ | catalog membership and active-term check | requested spatial observable | FDM/FEM CPU/GPU lane gated | `observables[].quantity` |

### 4.2 ProblemIR representation

(fdm-fem-observable-problem-ir)=

IR nie dostaje drugiego modelu energii. Żądanie jest reprezentowane jako
`observables[].quantity`; planner łączy je z aktywnymi `energy_terms` oraz
resolved backend/device. Pole `eden_*` ma `shape=spatial_scalar`, `n_comp=1`,
`location=cell` dla FDM. `H_demag` ma `shape=vector`, `n_comp=3`, a domena
`full_domain` wybiera visual source.

### 4.3 Planner and capability-matrix impact

(fdm-fem-observable-implementation-mapping)=

Capability matrix mówi, czy quantity jest `Exact`, `Derived`, `Planned` lub
nieobsługiwane. `supported` nie oznacza jeszcze `materialized`: `data/fields`
może raportować `unmaterialized`, `pending`, `complete`, `stale_complete` albo
`error`. Reason codes obejmują `quantity_not_active`,
`demag_visual_buffer_unavailable`, `scalar_snapshot_unsupported` i
`unsupported_combination`.

### 4.4 Round-trip and failure semantics

(fdm-fem-observable-round-trip-and-failure-semantics)=

`requested intent` z UI/Python jest przechowywane bez zmian, a `resolved execution`
zawiera faktyczny backend, device, precision i generation. Planner zgłasza
`validation errors` dla nieaktywnych termów oraz `unsupported combinations` przed
uruchomieniem; runtime powtarza walidację na granicy ABI.
Brak cache nie zmienia capability na `unsupported`. WebSocket publikuje jedynie
invalidację/completion, zaś payload jest pobierany przez resource-first data
plane.

## 5. Validation strategy

(fdm-fem-observable-validation)=

### 5.1 Analytical checks

(fdm-fem-observable-validation-analytical)=

Jednokomórkowy Zeeman spełnia równanie `eq-eden-ext`, a całka każdego `eden_i`
zgadza się z odpowiadającym globalnym `E_i`. `eden_total` jest sumą aktywnych
składowych w tym samym generation.

### 5.2 Cross-backend checks

(fdm-fem-observable-validation-cross-backend)=

FDM CPU jest referencją. Managed brama FDM kwalifikuje bounded slice CUDA FP64
przez parity w double, a FP32 przez parity z CUDA FP64 na tych samych maskach,
siatkach i stanach. FEM CPU i GPU zachowują istniejącą regresję pełnodomenowego
snapshotu. Każdy lane raportuje osobno status executable, validated i
production-qualified; kwalifikacja nie rozszerza się automatycznie na inne
modele materiałowe ani hybrydową materializację.

### 5.3 Regression tests

(fdm-fem-observable-validation-regression)=

- katalog publikuje `eden_*` tylko dla aktywnych i wspieranych termów;
- scalar data-plane ma `n_comp=1` i niezerowe metadane dla materializowanego pola;
- Airbox `H_demag` nie jest zerowany przez maskę magnetyczną;
- Wireframe i Points działają bez żadnego pola, a Vectors wymaga zgodnego
  vector payloadu;
- snapshot demag nie zwiększa liczby FFT ponad jeden dla tego samego generation.

## 6. Completeness checklist

- [x] Python API contract
- [x] ProblemIR semantics
- [x] Planner and capability matrix
- [x] FDM CPU reference
- [x] FDM CUDA FP64 bounded-slice production qualification
- [x] FDM CUDA FP32 bounded-slice precision qualification
- [x] FEM CPU/GPU full-domain snapshot regression
- [x] Resource-first observables contract
- [ ] Hybrid backend
- [x] Browser/WebGL qualification

## 7. Known limits and deferred work

(fdm-fem-observable-limitations)=

FEM canonical element/quadrature publication i hybrid materialization są poza
tym bounded slice. UI pokazuje provenance projekcji. FP32 nie może być
oznaczany jako qualified na podstawie samego builda; wymagane są managed parity
bramy. Globalne historie energii pozostają osobnym zasobem scalar history.

### 7.1 Evidence dla bounded slice (2026-08-16)

Managed evidence `fdm_observable_materialization_parity.v1` znajduje się w
`/mnt/fullmag-zfn2-native/fdm-observable-materialization-parity/evidence/qualification.json`.
Obejmuje CPU↔CUDA FP64 pól i gęstości, CUDA FP32↔FP64, transfery F32→F64
oraz wszystkie sześć `eden_*`; test CPU↔FP64 raportuje
`max_density_abs_drift=1.082183e-2` na 7 aktywnych komórkach. Browser/WebGL
evidence jest w `/tmp/fullmag-observable-browser-proof-cuda-fp32-1/`, a
120-cyklowy lifecycle evidence w
`/tmp/fullmag-observable-viewport-audit-fp32-1/metrics.json`. Lokalny
`react-doctor` nie jest zainstalowany i pozostaje jawnie `tooling_gap`.

## 8. Scientific bibliography

(fdm-fem-observable-scientific-bibliography)=

- mumax3: energy-density registry and integration checks,
  `https://github.com/mumax/3`;
- mumax+: field/scalar quantity split,
  `https://github.com/mumax/plus/blob/main/src/physics/energy.cu`;
- Boris: module energy display/output model,
  `https://github.com/SerbanL/Boris2`.

## 9. Source code index

(fdm-fem-observable-source-code-index)=

| Path | Symbol | Responsibility |
|---|---|---|
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `field_dot_energy_density` | CPU field-derived density equation |
| `crates/fullmag-runner/src/fdm/cpu/reference.rs` | `select_scalar` | CPU scalar snapshot selection |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `launch_demag_field_fp64` | CUDA FP64 demag and visual buffer |
| `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `launch_demag_field_fp32` | CUDA FP32 demag and visual buffer |
| `crates/fullmag-runner/src/quantities.rs` | `fdm_quantity_is_active` | active quantity gating |
| `crates/fullmag-plan/src/quantities.rs` | `default_capability_matrix` | backend capability matrix |
| `crates/fullmag-api/src/quantities.rs` | `build_quantities` | resource-first quantity descriptors |
| `backends/fem/src/api.cpp` | `gpu_snapshot_source_field` | FEM full-domain H_demag source |
| `backends/fem/tests/snapshot_contract.cpp` | `gpu_snapshot_preserves_full_domain_observable_fields` | FEM regression contract |
