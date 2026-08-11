# Macierz kwalifikacji: FDM multilayer convolution

Statusy są niezależne: implemented oznacza kod, executable uruchamialny kontrakt,
runtime-verified świeże uruchomienie, physically-validated niezależny orakl, a
production-qualified komplet dowodów. Wartości nie są dziedziczone między lane’ami.

> Korekta audytowa 2026-08-11: lokalne artefakty bez śledzonego pełnego SHA są
> `source-unbound`; nested status `qualified` nie zmienia aggregate statusu
> `blocked`. CPU `push_pull` ma lokalny, source-unbound dowód pola, energii i
> adjointness dla różnych extentów oraz $V_{native}\ne V_{scratch}$ przy równej
> natywnej grubości komórki Z. Brakuje bezpośredniego orakla continuum/native-cell
> dla $h_{source,z}\ne h_{destination,z}$. CUDA-assisted dla
> `two_d_stack`/heterogenicznych
> transferów nie używa obecnie tego samego descriptorowego pair-kernela co CPU.
> Szczegóły: [audyt implementacji](../../audits/2026-08-11-fdm-multilayer-convolution-implementation-audit.md).

(problem-statement)=
## Problem fizyczny

Macierz kwalifikuje osobno natywne siatki magnetów, computationalny common/scratch
grid oraz pole docelowe Airbox. Common grid nie jest dodatkowym ferromagnetykiem
ani supermeshem fizycznym. Każdy status dotyczy konkretnej klasy kernela,
transferu, precyzji i urządzenia.

(governing-equations)=
## Równanie rządzące

```{math}
:label: qualification-demag-field
\mathbf H_d=-\sum_{s=1}^{L}\mathsf N_{d\leftarrow s}\mathbf M_s .
```

(symbols-and-si-units)=
## Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf H_d$ | pole demagnetyzujące w komórkach celu | $\mathrm{A\,m^{-1}}$ |
| $\mathsf N_{d\leftarrow s}$ | tensor pary źródło-cel | $1$ |
| $\mathbf M_s$ | magnetyzacja komórek źródła | $\mathrm{A\,m^{-1}}$ |
| $L$ | liczba warstw/obiektów źródłowych | $1$ |

(assumptions-and-validity)=
## Założenia i granice ważności

Open boundary jest jedynym kwalifikowanym boundary mode. PBC, BORIS
`supermesh`, `2dmulticonvolution=1/2`, niezweryfikowane reduced/full storage,
CUDA device parity i dynamiczny replan są jawnie odseparowane od statusów
z tabeli. Implementacja CPU może mieć status executable lub runtime-verified,
ale nie jest automatycznie production-qualified.

(python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDMDemag.strategy` | `Literal[str]` | `auto` | $1$ | `auto`, `single_grid`, `multilayer_convolution` | requested demag realization | FDM CPU/GPU authoring; runtime lane gated | `discretization.fdm.demag.strategy` |

```python
# %% Import
import fullmag as fm

# %% Requested multilayer intent
demag = fm.FDMDemag(strategy="multilayer_convolution", mode="two_d_stack")
assert demag.to_ir()["strategy"] == "multilayer_convolution"
```

(problem-ir)=
## ProblemIR

The authored `ProblemIR` stores requested strategy and mode. Resolved native grids,
common transform layout, transfer kind, kernel catalog, and provenance belong to
the planner/runtime result and are not inferred from the status table.

(round-trip-and-failure-semantics)=
## Round-trip i semantyka błędów

Requested intent must survive Python → ProblemIR → planner → runtime provenance.
Resolved execution is reported separately from authored intent. Validation errors
must reject illegal counts, overlapping layers, PBC and unsupported storage before
execution. Unsupported combinations never silently fall back to `single_grid` or
another precision; the matrix records the resulting boundary.

(discrete-realization)=
## Realizacja dyskretna

The runtime computes ordered source-to-destination pairs. CPU catalog/workspace
reuse is an implementation fact; each row below still needs the evidence stated in
its gate column.

| Lane | Transfer | Precision | implemented | executable | runtime-verified | physically-validated | production-qualified | Owner (path::symbol) | Evidence (path::symbol/status) | Artifact | Brama |
|---|---|---:|---|---|---|---|---|---|---|---|---|
| FDM CPU, 2D-self | identity | FP64 | yes | yes | local/source-unbound | nested oracle qualified; aggregate artifact blocked | no | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::observe_multilayer` | `scripts/verify_fdm_multilayer_independent_oracle.py` nested L=1 report: qualified | `.superpowers/sdd/evidence/fdm-multilayer-runtime/l1-fixed-fresh-v2-oracle.json`; full `4096/4096`, energy/reciprocity/cubature/self-trace pass | fresh source-bound managed report |
| FDM CPU, 3D-self | identity | FP64 | yes | yes | yes (local) | yes (local) | no | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::observe_multilayer` | `scripts/verify_fdm_multilayer_independent_oracle.py` fresh L=3 3D identity report: qualified | `.superpowers/sdd/evidence/fdm-multilayer-runtime/l3-identity-3d-direct-fresh-v1-oracle.json`; full `192/192`, field/energy/reciprocity/self-trace/cubature pass | independent managed-container receipt and broader production matrix |
| FDM CPU, 2D-zShift | identity | FP64 | yes | yes | local/source-unbound | nested oracle qualified; aggregate artifact blocked | no | `crates/fullmag-fdm-demag/src/shifted_kernel.rs::compute_shifted_kernel` | `scripts/verify_fdm_multilayer_independent_oracle.py` nested L=2 equal report: qualified, both `+Z/-Z` | `.superpowers/sdd/evidence/fdm-multilayer-runtime/identity-airbox-fixed-fresh-v2-oracle.json`; full `8192/8192`, max field `1.9463819626253098e-5 A/m` | fresh source-bound managed report with six components, weighted reciprocity and energy |
| FDM CPU, 3D-zShift | identity | FP64 | yes | yes | yes (local) | yes (local) | no | `crates/fullmag-fdm-demag/src/shifted_kernel.rs::compute_shifted_kernel` | fresh L=3 3D identity direct oracle observes both $+Z$ and $-Z$ lags; qualified | `.superpowers/sdd/evidence/fdm-multilayer-runtime/l3-identity-3d-direct-fresh-v1-oracle.json`; full `192/192`, max field `3.183395165251568e-7 A/m`, energy and cubature pass | independent managed-container receipt and broader production matrix |
| FDM CPU, 2D-full-complex | identity | FP64 | partial | no | no | no | no | `crates/fullmag-fdm-demag/src/shifted_kernel.rs::compute_shifted_kernel` | planned offset/crop direct test | planned FP64 complex-storage report | offset/crop direct proof |
| FDM CPU, 3D-full-complex | identity | FP64 | partial | no | no | no | no | `crates/fullmag-fdm-demag/src/shifted_kernel.rs::compute_shifted_kernel` | planned offset/crop direct test | planned FP64 complex-storage report | offset/crop direct proof |
| FDM CPU, unequal Z | identity | FP64 | yes | yes | no | kernel-only | no | `crates/fullmag-fdm-demag/src/shifted_kernel.rs::compute_shifted_kernel_pair`; `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::build_multilayer_demag_runtime` | irregular kernel GL8/reciprocity/parity tests; no end-to-end source-bound unequal runtime receipt | local/source-unbound kernel and runtime diagnostics | direct full-field/energy oracle for the composed operator, then managed receipt |
| FDM CPU, push_pull | push_pull | FP64 | yes | yes | local/source-unbound | yes, scoped to tested different extents and $V_{native}\ne V_{scratch}$ with equal native $h_z$ | no | `crates/fullmag-fdm-demag/src/transfer.rs::VolumeWeightedTransfer::{push_m_into,pull_h_adjoint_into}` | local verifier passes `96/96` field, energy, and adjoint checks; this does not cover unequal native-cell thickness | local JSON has nested checks but is not immutable production evidence | direct continuum/native-cell oracle for $h_{source,z}\ne h_{destination,z}$, then source-bound managed receipt |
| FDM CUDA, 2D-self | identity | FP64 | partial | unsafe for heterogeneous public scope | no | no | no | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs::build_multilayer_demag_runtime` | assisted builder uses first-layer cell and Z-only shifted kernel, not the CPU descriptor pair operator | current managed CUDA gate is `not_qualified` | fail-close unsupported cases or unify descriptor operator; managed device parity and FFT telemetry |
| FDM CUDA, zShift/full | identity | FP64 | partial | no qualified canonical lane | no | no | no | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`; `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu` | D-07 source contract exists only for bounded 3D identity; whole step remains assisted | no source-bound CUDA artifact | device-resident whole-step parity per kernel class |
| FDM CUDA, any | identity or push_pull | FP32 | partial | no qualified canonical lane | no | no | no | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs::build_multilayer_demag_runtime_f32` | source/tests only; no fresh managed FP32 device report | none | qualify FP64 first, then independent FP32 thresholds and device receipt |
| Airbox H_demag | target-only observation | FP64 | yes | yes, eager post-run | local/source-unbound | scoped local oracle only | no | `crates/fullmag-runner/src/fdm/cpu/airbox_observation.rs::materialize_airbox_observation`; `crates/fullmag-runner/src/artifacts.rs::write_artifacts`; API/UI owners | local convergence report and contract/model tests; latest WebGL matrix blocked before fresh `compute_fields` | untracked local JSON plus source-contract tests | on-demand materialization, outside-support mask/hash, exact source/target FFT counters, source-bound receipt and full WebGL matrix |
| Airbox H_eff | target-only observation | any | yes | yes | runtime reason recorded | n/a (unavailable by contract) | no | `crates/fullmag-runner/src/fdm/cpu/airbox_observation.rs::materialize_airbox_observation` | versioned unavailable-reason contract; no field synthesized | runtime-origin manifest with `H_eff` unavailable reason | explicitly unavailable first |

Kanoniczny µMAG SP4 pozostaje bez zmian; sp4-derived-multilayer i paper
reproduction są traceability lanes. Żaden wpis partial, planned, no lub
no evidence nie może być przedstawiony jako runtime-verified albo
production-qualified.

(implementation-mapping)=
## Mapowanie implementacji

`build_kernel_catalog` i `compute_demag_fields_checked` są właścicielami CPU
catalog/workspace; `compute_shifted_kernel_pair` jest właścicielem checked
irregular Newell dla nierównych grubości, a `FDMDemag` jest właścicielem
authoringu. Airbox pozostaje target-only observation, nie common transform mesh.

(validation)=
## Walidacja

Wymagany dowód dla każdej pozycji obejmuje odpowiedni field/energy oracle,
volume-weighted reciprocity, transfer moment/adjointness, świeży artefakt
runtime oraz, dla GPU/UI, urządzenie i browser/WebGL. Statusy w tabeli nie są
dziedziczone między klasami kernela ani display modes.

(limitations)=
## Ograniczenia

Macierz nie promuje supermesh, PBC, BORIS force modes `1/2`, pełnego 3-D
heterogeneous transferu, reduced/full storage, CUDA device parity ani pełnej
macierzy viewport. Brak artefaktu oznacza `no`, nawet gdy kod lub test
kontraktowy istnieje.

(scientific-bibliography)=
## Bibliografia naukowa

1. S. Lepadatu, “Efficient computation of demagnetizing fields for magnetic
   multilayers using multilayered convolution,” *Journal of Applied Physics*
   **126**, 103903 (2019), [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
2. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the
   demagnetizing tensor for nonuniform magnetization,” *J. Geophys. Res.*
   **98**, 9551–9555 (1993), [doi:10.1029/93JE01171](https://doi.org/10.1029/93JE01171).

(source-code-index)=
## Indeks kodu źródłowego

| Claim | Path | Symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| CPU multilayer refresh | `crates/fullmag-engine/src/multilayer.rs` | `compute_demag_fields_checked` | Checked ordered-pair refresh with catalog and workspace. | FDM CPU FP64 | runtime-verified, not production-qualified |
| CPU kernel catalog | `crates/fullmag-engine/src/multilayer.rs` | `build_kernel_catalog` | Deduplicates kernels and binds source/destination pairs. | FDM CPU FP64 | runtime-verified, not production-qualified |
| Spectral pair multiply | `crates/fullmag-fdm-demag/src/multiply.rs` | `accumulate_tensor_convolution` | Accumulates six-component source spectra into the destination field. | FDM CPU | executable kernel contract |
| Shifted Newell pair | `crates/fullmag-fdm-demag/src/shifted_kernel.rs` | `compute_shifted_kernel_pair` | Unequal-thickness checked pair tensor. | FDM CPU | oracle/contract scope only |
| Python intent | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | Validates and lowers strategy/mode hints. | Python FDM | executable authoring contract |
