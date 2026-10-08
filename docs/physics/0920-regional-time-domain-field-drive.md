# Regionalne wymuszenie pola magnetycznego zależne od czasu

- Status: canonical physics and numerics contract; FDM CPU reference and FEM
  native field-drive paths exist; FDM GPU and FEM GPU remain qualification
  lanes for the comparison study below
- Owners: Fullmag core
- Last updated: 2026-10-08
- Decision: `docs/adr/0019-regional-field-drive-and-stage-time-semantics.md`
- Detailed implementation plan: `docs/audits/2026-07-15-fem-pbc-time-domain-field-drive-implementation-plan.md`
- Related physics: `docs/physics/0400-fdm-exchange-demag-zeeman.md`,
  `docs/physics/0410-fem-exchange-demag-zeeman-mfem-gpu.md`,
  `docs/physics/0900-native-fem-operator-contracts-and-validation.md`, and
  `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`

**Stan odbioru:** opis rozdziela kontrakt docelowy od dowodów wykonania.
Obecność kodu nie jest kwalifikacją czterech realizacji. Uzupełnianie mapy
źródeł i rozdziału publicznego API pozostaje WIP; nota nie ma jeszcze odbioru
publication gate. Nie wolno traktować poniższych progów jako wyników testów.

(problem-statement)=
## 1. Scope and physical meaning

`RegionalFieldDrive` is a prescribed magnetic field whose spatial basis is
multiplied by a serializable function of time. It supports global excitation,
magnetic-object or magnetic-region excitation, and an optional geometry mask.
It is the canonical Fullmag equivalent of a MuMax-style field mask.

It is not a conductor, antenna field solve, Oersted field, electromagnetic
wave solve, or material region. `SolvedAntennaDrive` remains a separate source
family whose spatial basis is produced by the staged conductor workflow in
physics note 0950. A runtime must never substitute one source family for the
other.

The intended workflow is:

1. relax or minimize the magnetization with the static bias field;
2. transfer the final equilibrium snapshot to a time-evolution stage;
3. enable one or more regional drives in explicitly selected stages;
4. evaluate each waveform at every Runge--Kutta substage time;
5. publish the exact drive field used by the RHS, its energy, and the response;
6. analyse either the Gamma response of one periodic cell or `S(k,f)` of an
   open propagation supercell.

(governing-equations)=
## 2. Governing equations and SI units

For active drives `q=1,...,N_d`,

```{math}
:label: regional-drive-superposition
\mathbf B_{\mathrm{drive}}(\mathbf r,t)
=\sum_q B_q\hat{\mathbf e}_qS_q(\mathbf r)f_q(\tau_q),
\qquad
\mathbf H_{\mathrm{drive}}=\mathbf B_{\mathrm{drive}}/\mu_0.
```

`B_q >= 0` is authored in tesla, `e_q` is a normalized direction, `S_q` and
`f_q` are dimensionless, and `H_drive` is stored and consumed in ampere per
metre. A negative direction is represented by `e_q`, not a negative scalar
amplitude. Multiple drives superpose linearly and deterministically by stable
drive id.

The Gilbert equation is represented in the explicit form

```{math}
:label: regional-drive-llg
\frac{\partial\mathbf m}{\partial t}
=-\frac{\gamma_0}{1+\alpha^2}
\left[\mathbf m\times\mathbf H_{\mathrm{eff}}
+\alpha\mathbf m\times(\mathbf m\times\mathbf H_{\mathrm{eff}})\right],
```

where `|m|=1`, `gamma0=|gamma| mu0` has unit m/(A s), and

```{math}
:label: regional-drive-effective-field
\mathbf H_{\mathrm{eff}}=\mathbf H_{\mathrm{existing}}
+\mathbf H_{\mathrm{drive}}.
```

The drive energy and density are

```{math}
:label: regional-drive-zeeman-energy
E_{\mathrm{drive}}(t)=-\mu_0\int_{\Omega_m}M_s\mathbf m\cdot
\mathbf H_{\mathrm{drive}}\,dV,
\qquad
e_{\mathrm{drive}}=-\mu_0M_s\mathbf m\cdot\mathbf H_{\mathrm{drive}}.
```

There is no factor `1/2`: this is an imposed Zeeman field. Because the field is
time-dependent, total energy need not decrease during excitation.

(symbols-and-si-units)=
### 2.1. Symbole i jednostki SI

Poniższa tabela obejmuje także indeksy, dziedziny, miary i operatory.
Indeksy i wskaźniki są bezwymiarowe; norma i operator sumowania zachowują
jednostkę argumentu. Funkcje przestrzenne i czasowe opisują znormalizowany
kształt wymuszenia, nie prąd w amperach.

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf r$ | punkt obserwacji w przestrzeni | $\mathrm{m}$ |
| $t$ | czas fizyczny | $\mathrm{s}$ |
| $q$ | indeks aktywnego wymuszenia | $1$ |
| $N_d$ | liczba aktywnych wymuszeń | $1$ |
| $\sum_q$ | suma po aktywnych wymuszeniach | $1$ |
| $\mathbf B_{\mathrm{drive}}$ | indukcja zadanego wymuszenia | $\mathrm{T}$ |
| $\mathbf H_{\mathrm{drive}}$ | pole wymuszenia konsumowane przez LLG | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | przenikalność magnetyczna próżni | $\mathrm{H\,m^{-1}}$ |
| $B_q$ | nieujemna amplituda indukcji wymuszenia | $\mathrm{T}$ |
| $\hat{\mathbf e}_q$ | jednostkowy kierunek pola | $1$ |
| $S_q$ | profil przestrzenny amplitudy | $1$ |
| $f_q$ | przebieg czasowy wymuszenia | $1$ |
| $\tau_q$ | argument czasu przebiegu | $\mathrm{s}$ |
| $\mathbf m$ | znormalizowana magnetyzacja | $1$ |
| $\gamma_0$ | dodatnia stała żyromagnetyczna dla pola H | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\alpha$ | tłumienie Gilberta | $1$ |
| $\mathbf H_{\mathrm{eff}}$ | całkowite pole efektywne | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{existing}}$ | pole pozostałych interakcji | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm{drive}}$ | energia Zeemana od wymuszenia | $\mathrm{J}$ |
| $e_{\mathrm{drive}}$ | objętościowa gęstość energii | $\mathrm{J\,m^{-3}}$ |
| $\Omega_m$ | dziedzina magnetyczna | $\mathrm{m^3}$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $dV$ | miara objętości | $\mathrm{m^3}$ |
| $\xi$ | współrzędna wzdłuż osi profilu sinc | $\mathrm{m}$ |
| $\operatorname{sinc}_\pi$ | sinc unormowany przez pi | $1$ |
| $S_{\mathrm{sinc}}$ | profil przestrzenny sinc | $1$ |
| $W$ | okno przestrzenne | $1$ |
| $W_{\mathrm{Hann}}$ | okno Hanna | $1$ |
| $\mathrm{period\_m}$ | skala argumentu sinc | $\mathrm{m}$ |
| $\mathrm{width\_m}$ | szerokość skończonego podparcia | $\mathrm{m}$ |
| $x$ | bezwymiarowy argument sinc | $1$ |
| $\pi$ | stała pi | $1$ |
| $\tau$ | argument czasu pojedynczego przebiegu | $\mathrm{s}$ |
| $t_{\mathrm{abs}}$ | czas absolutny symulacji | $\mathrm{s}$ |
| $t_{\mathrm{stage,start}}$ | początek czasu przebiegu dla etapu bez wznowienia | $\mathrm{s}$ |
| $f$ | funkcja przebiegu czasowego | $1$ |
| $a$ | amplituda czasowego sinc; w analizie Gamma także indeks osi | $1$ |
| $f_c$ | częstotliwość odcięcia czasowego sinc | $\mathrm{Hz}$ |
| $t_0$ | środek czasowego sinc | $\mathrm{s}$ |
| $c$ | indeks komórki FDM; w analizie Gamma indeks osi | $1$ |
| $V_c$ | objętość komórki FDM i dziedzina jej całkowania | $\mathrm{m^3}$ |
| $\chi_{T_q}$ | wskaźnik dziedziny docelowej wymuszenia | $1$ |
| $w_{qc}$ | średnia profilu w komórce FDM | $1$ |
| $\mathbf H^0_{qc}$ | statyczna baza pola komórkowego | $\mathrm{A\,m^{-1}}$ |
| $i$ | indeks węzła FEM | $1$ |
| $\phi_i$ | funkcja kształtu P1 | $1$ |
| $M_i$ | wierszowa suma masy geometrycznej FEM | $\mathrm{m^3}$ |
| $w_{qi}$ | rzut profilu na węzeł FEM | $1$ |
| $\mathbf H^0_{qi}$ | statyczna baza pola węzłowego | $\mathrm{A\,m^{-1}}$ |
| $\mathbf R$ | wektor translacji okresowej | $\mathrm{m}$ |
| $\overline{\delta m}_a$ | ważona momentem zmiana magnetyzacji | $1$ |
| $m_a$ | składowa magnetyzacji w osi a | $1$ |
| $m_{0,a}$ | składowa magnetyzacji odniesienia | $1$ |
| $S_\Gamma$ | suma poprzecznych mocy binów odpowiedzi Gamma w bieżącym artefakcie | $1$ |
| $P_b$ | moc binu pierwszej składowej poprzecznej | $1$ |
| $P_c$ | moc binu drugiej składowej poprzecznej | $1$ |
| $b$ | indeks pierwszej osi poprzecznej | $1$ |

Bieżący `build_gamma_response_with_detrend` używa normalizacji
`one_sided_abs_fft_squared_over_N_sum_window_squared`: pola nazwane `*_psd`
zawierają moc binu bezwymiarowej odpowiedzi, nie gęstość per Hz. Docelowa
gęstość widmowa wymaga osobnej, jawnej normalizacji częstotliwościowej;
nie wolno zmieniać jednostek przez samo przemianowanie osi.
W równaniu Gamma argument $f$ oznacza częstotliwość w $\mathrm{Hz}$,
nie bezwymiarową funkcję czasową oznaczoną wcześniej tym samym symbolem.

Historyczne identyfikatory ilości:

| Quantity | Meaning | SI unit |
|---|---|---|
| `m` | reduced magnetization | 1 |
| `M_s` | saturation magnetization | A/m |
| `B_drive` | display view `mu0 H_drive` | T |
| `H_drive` | regional drive used by LLG | A/m |
| `E_drive` | regional-drive energy | J |
| `eden_drive` | regional-drive energy density | J/m3 |
| `B_q` | authored peak flux-density amplitude | T |
| `t`, `tau`, `t0` | time | s |
| `frequency_hz`, `cutoff_hz` | frequency | Hz |

`H_ant` remains the instantaneous field of `SolvedAntennaDrive`. It is not an
alias for newly authored regional drives. A deserialized legacy
`prescribed_zeeman_mask` records migration provenance while exporting the new
`H_drive` contract.

## 3. Target and spatial profile

The target defines which magnetic domain may receive the field:

- `global`: all active magnetic elements or cells;
- `object(object_id)`: one magnetic object;
- `region(object_id, region_id)`: one region of one magnetic object.

The spatial profile modulates amplitude within the target:

- `uniform`;
- `sinc(axis, period_m, center_m, width_m, window)`;
- `gaussian_plane_wave`, obecny w Python/IR i ścieżkach materializacji;
- `geometry_mask(object_id, envelope)`, where the mask object may be
  nonmagnetic and the envelope is uniform or sinc.

For `u=axis/|axis|` and `xi=u dot r-center_m`,

```{math}
:label: regional-drive-spatial-sinc
S_{\mathrm{sinc}}(\mathbf r)=\operatorname{sinc}_\pi
(\xi/\mathrm{period\_m})W(\xi),
\quad
\operatorname{sinc}_\pi(x)=\frac{\sin(\pi x)}{\pi x},
```

with the continuous value one at zero. `period_m` is positive and `axis` is
nonzero. Without `width_m`, `W=1`. With finite width, support is zero for
`|xi|>width_m/2`; `window=none` is one inside support and

```{math}
:label: regional-drive-spatial-hann
W_{\mathrm{Hann}}(\xi)=\sin^2\left[\pi\left(
\frac{\xi}{\mathrm{width\_m}}+\frac12\right)\right].
```

A geometry mask uses `chi_G(r) S_envelope(r)`. Version 1 accepts only geometry
predicates with deterministic native evaluation: `Box`, `Cylinder`,
`Translate`, `Difference`, `Union`, and `Intersection`. Imported geometry and
curves without a stable predicate are rejected before execution.

## 4. Stage clock, activation, and waveforms

Each stage has a stable, unique `stage_id`. A drive uses either
`all_time_evolution` or an explicit set of stage ids. The former includes run
stages and excludes relax/minimize stages. A constant drive may be explicitly
enabled during energy minimization; a dynamic drive is invalid there because
a minimizer has no physical clock.

The time argument is

```{math}
:label: regional-drive-stage-clock
\tau_q=\begin{cases}
t_{\mathrm{abs}}-t_{\mathrm{stage,start}},&\texttt{stage_local},\\
t_{\mathrm{abs}},&\texttt{absolute}.
\end{cases}
```

`stage_local` is the default. The closed waveform catalogue is:

| Kind | Definition |
|---|---|
| `constant` | `f(tau)=1` |
| `sinusoidal` | `sin(2 pi frequency_hz tau + phase_rad)+offset` |
| `pulse` | one for `t_on <= tau < t_off`, zero otherwise |
| `piecewise_linear` | linear interpolation, endpoint hold outside range |
| `sinc_pulse` | `a sinc_pi(2 cutoff_hz (tau-t0))` |

For sinc,

```{math}
:label: regional-drive-time-sinc
f(\tau)=a\frac{\sin(2\pi f_c(\tau-t_0))}
{2\pi f_c(\tau-t_0)},
```

evaluated with a stable series near zero. `f_c>0`, `t0>=0`, PWL times are
strictly increasing, and all values are finite. A validator warns when the
sinc tail at stage start exceeds `1e-4 |a|`. Raw Python or JavaScript callbacks
are forbidden because they cannot round-trip, reproduce, or execute on GPU.

(discrete-realization)=
## 5. FDM discretization

For active finite-volume cell `c`,

```{math}
:label: regional-drive-fdm-projection
w_{qc}=V_c^{-1}\int_{V_c}\chi_{T_q}(\mathbf r)S_q(\mathbf r)dV,
\qquad
\mathbf H^0_{qc}=\frac{B_q}{\mu_0}\hat{\mathbf e}_q w_{qc}.
```

Global uniform gives exactly one on active cells. Region markers give zero or
one. A conservative Box/Cylinder/Translate/Union/Intersection/Difference cell
classifier proves cells wholly inside or outside a geometry mask; only mask
boundary cells use deterministic adaptive integration. Smooth analytic sinc
profiles (sinc and Gaussian) use a fixed order-4 tensor Gauss rule, because discontinuity-driven
subdivision is neither necessary nor a valid smooth-profile performance
strategy. Bieżący `adaptive_cell_average` porównuje bezwymiarowe średnie
kwadratur absolutnym progiem `1e-6`, nie względnym błędem. Maximum
depth 10. Failure to converge is an error, not a centroid fallback. The
immutable cell basis can be multiplied by the waveform without spatial
reintegration at every RHS evaluation. Docelowy cache musi być niezależny
od waveform; obecny `resolve_fdm_regional_field_drives` hashuje jednak
`(drive, field_xyz)`, w tym waveform. Sam podpis nie dowodzi niezależnego reuse.

FDM CPU double is the reference implementation. FDM GPU may execute this
contract only through its own double-precision field, RHS, energy, and
trajectory parity gates; capability cannot be inherited from CPU. A study that
compares lanes must publish the requested and resolved lane separately and
must leave a lane pending when its runtime or mesh qualification has not
passed.

## 6. FEM P1 lumped-L2 projection

For P1 basis functions `phi_i`, the production FEM backend constructs

```{math}
:label: regional-drive-fem-projection
M_i=\int_{\Omega_m}\phi_i\,dV,
\qquad
w_{qi}=M_i^{-1}\int_{\Omega_m}\phi_i\chi_{T_q}S_q\,dV,
\qquad
\mathbf H^0_{qi}=\frac{B_q}{\mu_0}\hat{\mathbf e}_q w_{qi}.
```

The same lumped mass and material weighting are used for the LLG field,
energy, response moments, and quantity readback. Global uniform must produce
`w_i=1` on every active magnetic degree of freedom to solver tolerance. Version
1 rejects `fe_order != 1`; broadcasting nodal values to higher-order degrees
of freedom is forbidden.

The qualified mixed `prism6`/`pyramid5`/`tet4` P1 time-domain lane used by the
shared-domain comparison accepts the global uniform spatial profile exactly:
after MFEM publishes the magnetic nodal mass row sums, every active node gets
the prescribed field value and every air-only node gets zero. This lane does
not reinterpret a mixed cell as four tetrahedral vertices. Non-uniform
regional profiles remain on the tetrahedral projection path until an
element-family-specific MFEM projection is qualified; an unsupported mixed
profile must fail explicitly before time integration.

Production quadrature and basis construction belong to `backends/fem`. The
Rust planner resolves stable target markers, the closed geometry/profile
descriptor, stage activation, capability, and periodic topology, but does not
implement production FEM integration. A Rust projector may exist only as an
independent test oracle.

For tetrahedra, native FEM first applies the same conservative geometry-tree
classifier. Proven outside cells contribute zero and proven inside cells are
integrated directly. Smooth sinc profiles use a fixed order-4 Duffy/Gauss rule.
Only cut geometry-mask tetrahedra use:

1. AABB rejection and certified exact inclusion for supported convex cases;
2. fixed tetrahedral quadrature rules of order two and four for all four
   `phi_i chi S` integrals;
3. deterministic eight-way midpoint subdivision when the difference exceeds
   `1e-6` times sub-tetra volume;
4. maximum depth 10, after which materialization fails with element id,
   estimated error, and depth;
5. division by `M_i`; inactive zero-mass nodes receive zero.

The subdivision diagonal and reduction order are deterministic and included in
the required basis signature. Pełny manifest tej sygnatury nie jest obecnie
publikowany przez `regional_field_drive.v1` (zob. rozdział 9).
Qualification requires Box/Cylinder volume error below
0.5% on the qualification mesh and at least linear convergence under `h/2`.

The immutable basis is rebuilt only when mesh topology/coordinates, magnetic
ownership, target/profile/amplitude/direction, or periodic classes change.
Docelowo zmiana wyłącznie waveform nie powinna jej przebudowywać.
Wymagane provenance obejmuje basis algorithm version, signature, extrema,
norms, weighted integral i materialization counters; nie są to obecnie
pola `RegionalFieldDriveManifest`.

## 7. Periodic boundary conditions

For static `k=0` PBC,

```{math}
:label: regional-drive-pbc
\mathbf m(\mathbf r+\mathbf R,t)=\mathbf m(\mathbf r,t),\qquad
\mathbf H_{\mathrm{drive}}(\mathbf r+\mathbf R,t)=
\mathbf H_{\mathrm{drive}}(\mathbf r,t).
```

Wymagany docelowy warunek: after projection, every periodic node class must contain equal basis values
within `atol + rtol max(|H_i|,|H_j|)`, with double defaults
`rtol=1e-12` and `atol=1e-9 A/m`. Mismatch fails materialization with pair,
axis, and maximum mismatch. Values must never be averaged to hide an invalid
profile. A local mask in a periodic unit cell represents its periodic repeat.

**Bieżąca różnica implementacji FEM CPU:**
`project_regional_field_drive_bases` dla zwykłej projekcji porównuje
maksymalną różnicę składowych z `1e-12 * max(1, abs(amplitude_h))`,
a dla wejścia preprojected porównuje każdą składową z
`1e-12 * max(1, abs(lhs), abs(rhs))`. Nie jest to powyższy warunek
`atol + rtol * max(...)`. Nie zmieniono progów w ramach uzupełniania
dokumentacji; zgodność tolerancji wymaga osobnej regresji i decyzji kontraktowej.

A homogeneous drive on one periodic cell excites only Gamma-compatible
response. Direct specification of nonzero Bloch phase belongs to a
Bloch/Floquet solver, not this `k=0` time-domain contract.

## 8. Time integration, events, and output cadence

Every explicit RK substage evaluates

```text
t_eval = t_n + c[s] * dt
tau_q = stage_local ? t_eval - stage_start : t_eval
lambda_q = waveform_q(tau_q)
H_drive = sum_q lambda_q * H0_q
H_eff = existing_effective_field(m_stage, t_eval) + H_drive
k_s = LLG(m_stage, H_eff)
```

Freezing the drive at `t_n` for a whole accepted step is invalid. This applies
to Heun, RK4, RK23, and RK45 on every executable lane.

The event scheduler works in absolute time and includes pulse edges, all PWL
knots, stage activation boundaries, and output times. A step is capped at the
next event. Pulse semantics are half-open; internal substages of a step ending
at an event use the left limit, and the next step starts with the right-limit
value. FSAL and cached RHS state are invalidated on an event or drive revision.

FFT products require exact uniform snapshots `t_start+n*dt_out`; the stepper
must land on those times rather than Fourier transforming irregular samples.
The validator checks Nyquist, recommends at least ten samples per period at a
sinc cutoff, and records accepted/rejected steps, min/max `dt`, event caps,
field revision, and `max ||m|-1|`. The double-precision norm-drift gate after
normalization is `1e-10` with no NaN or Inf.

(problem-ir)=
## 9. Canonical authoring and runtime contract

Python and UI author the same typed collection `field_drives`. A canonical
drive contains stable id, nonnegative `amplitude_B_T`, normalized direction,
target, spatial profile, waveform, time origin, and activation. New export
never emits `AntennaFieldSource(model="prescribed_zeeman_mask")`; import
migrates it deterministically and records
`migrated_from="prescribed_zeeman_mask"`.

ProblemIR uses tagged unions with unknown fields denied. Validation rejects
dangling object/region/stage ids, duplicate ids, zero direction, invalid sinc
or PWL data, unsupported geometry, dynamic minimizer activation, unsupported
backend/order/precision, and PBC-incompatible profiles.

(round-trip-and-failure-semantics)=
### 9.1. Intencja, wykonanie i odmowy

**Requested intent** i **resolved execution** są odrębne. **Validation errors**
oznaczają jawne odmowy danych lub referencji; **unsupported combinations**
nie mogą powodować ukrytej zmiany backendu, modelu pola ani projekcji.

Requested and resolved execution are both preserved. A forced unsupported lane
fails before the solver starts. There is no semantic fallback from a regional
drive to solved antenna, from FEM GPU to CPU, or from exact projection to a
centroid mask.

Native FEM receives the resolved semantic descriptor and performs production
projection. It owns reusable `H0_q`, a reusable instantaneous `H_drive`,
waveform descriptors, stage start time, revision, and materialization
diagnostics in the Zeeman interaction subsystem. The same instantaneous buffer
and revision feed `H_eff`, `E_drive`, and `H_drive` readback. No new physics is
added to `mfem_bridge.cpp` or as loose cross-cutting `Context` state.

Docelowy odbiór wymaga provenance obejmującego normalized drive JSON,
target/profile/basis signatures, PBC certificate, waveform/time origin,
stage activation/events, backend/precision/ABI, basis norms oraz quantity
revision map. Heavy fields use the binary data plane.

**Rzeczywisty manifest `regional_field_drive.v1`:**
`RegionalFieldDriveManifest` i `regional_field_drive_artifact` zapisują
`active_stage_id`, początki i koniec czasu, SHA256 JSON wymuszeń, liczbę i
deklaracje wymuszeń, harmonogram zdarzeń, `execution_engine`, `precision`
oraz `requested_outputs`. Nie zapisują obecnie sygnatury przestrzennej bazy,
jej norm, certyfikatu PBC, ABI ani mapy rewizji ilości. Pola
`fsal_invalidation_count` i `fsal_invalidation_times_s` są wyliczane przez
`resolved_stage_drive_discontinuities_with_origin`; opisują wymagany
harmonogram unieważnień, **nie zaobserwowane wywołania solvera**.
Nie wolno używać ich jako dowodu wykonania invalidation przy każdym zdarzeniu.

Przy wznowieniu segmentu artefakt zapisuje osobno absolutny początek segmentu
`stage_start_time_s` i początek przebiegu `waveform_origin_time_s`; czasy
zdarzeń i unieważnień FSAL są liczone względem drugiej wartości dla przebiegów
lokalnych etapu. Stare przebiegi zachowują `waveform_origin_time_s =
stage_start_time_s`.

(python-api)=
## 9.2. Publiczny Python i kompletny kontrakt parametrów wymuszenia

Tabele obejmują publiczny model `RegionalFieldDrive` i bezpośrednie fabryki
jego celów, profili, aktywacji oraz przebiegów. Kierunek/axis są normalizowane
w Python; serde/IR nie może zakładać, że zewnętrzny JSON przeszedł tę walidację.
Nieujemna `amplitude_B_T` nie ogranicza znaku przebiegu, profilu ani kierunku.

| Python | Typ | Domyślnie | SI | Walidacja / odmowy | Znaczenie | Wsparcie | ProblemIR |
|---|---|---|---|---|---|---|---|
| fm.RegionalFieldDrive.id | str | required | $1$ | niepusty; unikalny w kolekcji | niezmienna tożsamość | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].id |
| fm.RegionalFieldDrive.name | str | required | $1$ | niepusty; StudyFieldDriveRegistry odmawia duplikatu nazwy | nazwa prezentacyjna | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].name |
| fm.RegionalFieldDrive.target | FieldTarget | required | $1$ | typowany; istniejący obiekt/region sprawdza IR/planner | dziedzina odbioru | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].target |
| fm.RegionalFieldDrive.amplitude_B_T | float | required | $\mathrm{T}$ | skończony i >=0 | amplituda indukcji | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].amplitude_B_T |
| fm.RegionalFieldDrive.direction | Sequence[float] | required | $1$ | trzy skończone składowe; wektor niezerowy, normalizowany | kierunek pola | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].direction |
| fm.RegionalFieldDrive.spatial_profile | FieldSpatialProfile | required | $1$ | Uniform/Sinc/GaussianPlaneWave/GeometryMask; pozostałe typy odrzucone | baza przestrzenna | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile |
| fm.RegionalFieldDrive.waveform | TimeDependence | required | $1$ | obiekt z to_ir; pełny zamknięty katalog i liczby sprawdza IR | przebieg czasowy | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform |
| fm.RegionalFieldDrive.time_origin | str | stage_local | $1$ | stage_local lub absolute, lowercase | semantyka zegara | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].time_origin |
| fm.RegionalFieldDrive.activation | DriveActivation or None | None -> all_time_evolution | $1$ | typowana aktywacja; referencje stage_id sprawdza IR | wybór etapów | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].activation |
| fm.RegionalFieldDrive.enabled | bool | True | $1$ | Python normalizuje przez bool; IR używa boolean | włączenie źródła | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].enabled |
| fm.RegionalFieldDrive.migration | dict[str,str] or None | None | $1$ | tylko migrated_from=prescribed_zeeman_mask; pozostałe odrzucone | provenance migracji | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].migration |
| fm.FieldTarget.global_domain() | bez parametrów | global | $1$ | bez object_id i region_id | cała domena magnetyczna | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].target.kind |
| fm.FieldTarget.object(object_id) | str | required | $1$ | niepusty object_id; bez region_id | jeden obiekt magnetyczny | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].target.object_id |
| fm.FieldTarget.region(object_id, region_id) | str, str | required | $1$ | obie tożsamości niepuste i rozwiązywalne | region obiektu | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].target.object_id/region_id |
| fm.UniformFieldProfile() | bez parametrów | uniform | $1$ | brak dodatkowych pól | stała baza przestrzenna | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.kind |
| fm.SincFieldProfile.axis | Sequence[float] | required | $1$ | trzy skończone składowe; niezerowy, normalizowany | oś profilu | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.axis |
| fm.SincFieldProfile.period_m | float | required | $\mathrm{m}$ | skończony >0 | skala sinc | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.period_m |
| fm.SincFieldProfile.center_m | float | 0.0 | $\mathrm{m}$ | skończony | przesunięcie wzdłuż osi | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.center_m |
| fm.SincFieldProfile.width_m | float or None | None | $\mathrm{m}$ | None lub skończony >0 | skończone podparcie | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.width_m |
| fm.SincFieldProfile.window | str | none | $1$ | none lub hann; lowercase | okno przestrzenne | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.window |
| fm.GaussianPlaneWaveFieldProfile.center_x_m | float | required | $\mathrm{m}$ | skończony | pozycja obwiedni | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.center_x_m |
| fm.GaussianPlaneWaveFieldProfile.center_y_m | float | required | $\mathrm{m}$ | skończony | pozycja obwiedni | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.center_y_m |
| fm.GaussianPlaneWaveFieldProfile.carrier_origin_x_m | float | required | $\mathrm{m}$ | skończony | niezależny początek nośnej | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.carrier_origin_x_m |
| fm.GaussianPlaneWaveFieldProfile.sigma_x_m | float | required | $\mathrm{m}$ | skończony >0 | skala przestrzenna | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.sigma_x_m |
| fm.GaussianPlaneWaveFieldProfile.sigma_y_m | float | required | $\mathrm{m}$ | skończony >0 | skala przestrzenna | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.sigma_y_m |
| fm.GaussianPlaneWaveFieldProfile.wavelength_m | float | required | $\mathrm{m}$ | skończony >0 | skala przestrzenna | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.wavelength_m |
| fm.GaussianPlaneWaveFieldProfile.carrier_phase_rad | float | 0.0 | $1$ | skończony | faza przestrzenna | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.carrier_phase_rad |
| fm.GeometryMaskFieldProfile.object_id | str | required | $1$ | niepusty; istniejąca geometria o wspieranym predykacie | obiekt maski, może być niemagnetyczny | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.object_id |
| fm.GeometryMaskFieldProfile.envelope | UniformFieldProfile or SincFieldProfile | UniformFieldProfile() | $1$ | Gaussian jako envelope jest odrzucany | obwiednia wewnątrz maski | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].spatial_profile.envelope |
| fm.DriveActivation.all_time_evolution() | bez parametrów | all_time_evolution | $1$ | bez listy stage_ids | tylko etapy ewolucji czasu | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].activation.kind |
| fm.DriveActivation.stage_ids(stage_ids) | Sequence[str] | required | $1$ | niepusta lista niepustych unikalnych ID; referencje sprawdza IR | jawny wybór etapów | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].activation.stage_ids |
| fm.Constant() | bez parametrów | constant | $1$ | brak dodatkowych pól | przebieg jeden | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.kind |
| fm.Sinusoidal.frequency_hz | float | required | $\mathrm{Hz}$ | skończony >0 | częstotliwość | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.frequency_hz |
| fm.Sinusoidal.phase_rad | float | 0.0 | $1$ | skończony | faza w radianach | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.phase_rad |
| fm.Sinusoidal.offset | float | 0.0 | $1$ | skończony | offset względem amplitudy | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.offset |
| fm.Pulse.t_on | float | required | $\mathrm{s}$ | skończony | początek impulsu, włącznie | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.t_on |
| fm.Pulse.t_off | float | required | $\mathrm{s}$ | skończony > t_on | koniec impulsu, wyłącznie | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.t_off |
| fm.PiecewiseLinear.points | Sequence[Sequence[float]] | required | $\mathrm{s}\times 1$ | >=2 pary skończonych liczb; czasy ściśle rosną | czas i bezwymiarowa wartość; endpoint hold | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.points |
| fm.SincPulse.cutoff_hz | float | required | $\mathrm{Hz}$ | skończony >0 | odcięcie idealnego sinc | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.cutoff_hz |
| fm.SincPulse.t0 | float | 0.0 | $\mathrm{s}$ | skończony >=0 | środek przebiegu | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.t0 |
| fm.SincPulse.amplitude | float | 1.0 | $1$ | skończony; może być ujemny | bezwymiarowa amplituda czasowa | Authoring wspólny; wykonanie według macierzy FDM/FEM CPU/GPU, bez dziedziczenia kwalifikacji | field_drives[].waveform.amplitude |

Ustawienia geometrii/materiału i integratora w poniższym przykładzie nie są
parametrami źródła: Box.size w metrach, Ms w A/m, Aex w J/m, alpha bezwymiarowe,
dt/until w sekundach, g bezwymiarowe. Są jawne, aby przykład nie zależał od
ukrytego stanu. Wzorzec etapowy:
`examples/fem_regional_field_drive_manufactured.py`; nie uruchamiamy
LLG podczas kontroli samego authoringu.

```python
# %% Study and magnetic body
import fullmag as fm

study = fm.study("regional_drive_contract")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
magnet = study.geometry(fm.Box(size=(4e-9, 4e-9, 4e-9)), name="macrospin")
magnet.Ms = 800e3
magnet.Aex = 13e-12
magnet.alpha = 0.01
magnet.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.b_ext(0.0, 0.0, 20e-3)
study.disable_exchange()
study.demag(enabled=False)
study.solver(integrator="rk4", dt=1e-14, g=2.0)

# %% Prescribed drive, not a conductor solve
drive = fm.RegionalFieldDrive(
    id="contract-drive",
    name="Contract sinusoid",
    target=fm.FieldTarget.global_domain(),
    amplitude_B_T=1e-3,
    direction=(0.0, 2.0, 0.0),
    spatial_profile=fm.UniformFieldProfile(),
    waveform=fm.Sinusoidal(frequency_hz=5e9),
    activation=fm.DriveActivation.stage_ids(["run"]),
)
study.field_drives.add(drive)

# %% Stage and outputs; definition does not execute LLG
study.tableautosave(1e-14, quantities=["time", "mx", "my", "mz", "E_drive"])
study.stages.add_run(stage_id="run", until=2e-12)
wire = drive.to_ir()
assert wire["direction"] == [0.0, 1.0, 0.0]
assert wire["waveform"]["frequency_hz"] == 5e9
```

Obiektowe `to_ir()` zwraca poniższy fragment kanonicznego
`ProblemIR.field_drives[]`; nie jest to kompletny snapshot problemu.
Backend/mode są intencją study, nie ukrytym polem regionalnego źródła.

```json
{
  "id": "contract-drive",
  "name": "Contract sinusoid",
  "kind": "regional",
  "enabled": true,
  "target": {"kind": "global"},
  "amplitude_B_T": 0.001,
  "direction": [0.0, 1.0, 0.0],
  "spatial_profile": {"kind": "uniform"},
  "waveform": {"kind": "sinusoidal", "frequency_hz": 5000000000.0, "phase_rad": 0.0, "offset": 0.0},
  "time_origin": "stage_local",
  "activation": {"kind": "stage_ids", "stage_ids": ["run"]}
}
```

Eksport `_render_regional_field_drive_expr` zachowuje typowane warianty;
migrację historycznego prescribed mask wykonuje
`_migrate_legacy_prescribed_field_sources`. Dowód lowering nie jest dowodem
zrealizowania etapu solvera ani zachowania niezapisanych draftów UI.

## 10. Gamma response qualification

The Gamma benchmark uses one 200 nm by 200 nm by 10 nm antidot cell with x/y
PBC and `periodic_airbox_k0` demag, a static x bias, and a small transverse
global drive, for example 1 mT in y with a 20 GHz sinc cutoff. The drive is
active only in the excitation stage. Runs at 0.5, 1, and 2 mT establish the
linear-response range.

With equilibrium `m0`, the moment-weighted response is

```{math}
:label: regional-drive-moment-response
\overline{\delta m}_a(t)=
\frac{\int M_s(m_a-m_{0,a})dV}{\int M_s dV}.
```

A Hann window is applied after explicit detrending choice. The artifact keeps
raw times, moments, windows, complex FFT, one-sided PSD, normalization, source
spectrum, units, and Nyquist frequency. Susceptibility is valid only where the
source spectrum exceeds `1e-6` of its maximum.

For equilibrium primarily along axis `a`, the Gamma spectral response is the
sum of both transverse powers,

```{math}
:label: regional-drive-gamma-psd
S_\Gamma(f)=P_b(f)+P_c(f),\qquad \{a,b,c\}=\{x,y,z\}.
```

The artifact therefore retains both transverse reference moments, both time
traces, both complex spectra, both component PSDs, and their combined
`S_Gamma`; a single selected component is insufficient as a Gamma response
definition.

**Ograniczenie aktualnego collectora:**
`append_requested_spin_wave_artifacts` obsługuje global/uniform i parę
`my`/`mz`, czyli osie poprzeczne względem x; nie wybiera dowolnych osi na
podstawie kierunku równowagi. Źródłowy ślad sumuje amplitudy bez składowej
`direction`. Poprawka zegara StageLocal używa teraz
`waveform_origin_time_s()` zamiast początku wznowionego segmentu; źródłowa
regresja arytmetyki obejmuje sinus, impuls, legacy i czas absolutny.
Wykonanie Rust/FFT po wznowieniu pozostaje nieweryfikowane. Ogólna podatność
wymaga dodatkowej naprawy kierunku źródła, nie tylko strukturalnego walidatora.

Qualification requires: zero-drive stability from `m0`; peak frequencies
stable below 0.5% for `dt/2`; mesh refinement below 2%; doubled small-signal
amplitude `2.0 +/- 5%` with peak shift below 0.5%; and FEM CPU/GPU double peak
parity below 0.5% with normalized PSD L2 below 5%.

## 11. Finite-k supercell qualification

Finite-k time-domain qualification uses an open propagation axis, optional
transverse PBC, a localized source, a central observation region, and damping
ramps at the open ends. It is a finite-domain propagation benchmark and not a
replacement for a Bloch eigensolver.

FEM nodal samples are not treated as a regular grid. A versioned sparse P1
sampling operator produces uniform `x_j` cross-sectional, `M_s`-weighted
averages. Plane/tetrahedron intersections use deterministic ownership and
triangulation. If a plane coincides with a shared tetrahedral face, the
smallest magnetic element index owns that face, implementing an exact half-open
cross-section convention without double area. Invalid slices without magnetic
mass remain masked. Spatial
sampling obeys `Delta x <= pi/k_max` with `k` stored in rad/m.

After subtracting `m0` and applying declared space/time windows, the dynamic
structure factor uses the convention `exp(+i(omega t-kx))`. Artifacts retain
complex response, PSD, axes, windows, normalizations, probe signature, invalid
mask, and source spectrum. Absorber qualification compares at least two ramps
and requires reflection amplitude at least 20 dB below the no-absorber case in
a declared time window.

**Ograniczenie aktualnego collectora:** `requested_finite_k_artifacts`
jest ścieżką FEM wymagającą co najmniej czterech zapisanych snapshotów
magnetyzacji i `H_drive` z identyczną osią czasu. Przed FFT nie odejmuje
jawnie stanu `m0`. Operator zwraca metadane nieważnych przekrojów, lecz
collector odmawia przy takich wierszach, zamiast wykonywać pełną analizę
z maską. Nie jest to jeszcze wykonanie całego powyższego kontraktu.

(assumptions-and-validity)=
(limitations)=
## 12. Assumptions, validity limits, and deferred work

- The field is prescribed and does not respond to magnetization.
- No conductor current, impedance, skin effect, radiation, circuit, or
  electromagnetic propagation is inferred.
- The first FEM realization is P1 and the first production GPU qualification
  is double precision.
- FEM GPU single, higher-order FEM, arbitrary expression callbacks, direct
  nonzero Bloch phase, and automatic nonlinear-response qualification are
  unsupported until their own contracts and gates pass. FDM GPU double is
  limited to the explicitly qualified regional-drive waveform set and remains
  unvalidated until the five-lane comparison evidence is complete.
- A sinc has infinite tails; the solver does not truncate it silently.

(validation)=
## 13. Validation and completeness gates

The feature is not complete until all of the following are evidenced:

1. Python/UI/SceneDocument/ProblemIR exact round-trip and legacy migration;
2. invalid-input, stage activation, capability, and no-fallback tests;
3. analytic waveform tables shared by Rust, C++, and CUDA;
4. FDM cell-average and FEM lumped-L2 projection refinement tests;
5. exact global uniform field and strict PBC class certificate;
6. RK substage-time order tests for every supported explicit integrator;
7. pulse/PWL event landing, FSAL invalidation, and exact output cadence;
8. one-source-of-truth field, energy, and readback revision tests;
9. managed container-backed native FEM CPU and GPU gates;
10. OpenAPI generation, resource lifecycle, binary data, and invalidation tests;
11. Explorer-to-Inspector, preview, quantity, and browser round-trip tests;
12. passing Gamma and finite-k publication-aligned benchmarks.

For the open, one-layer Py comparison workload, the minimum numerical evidence
is one common scalar table with `mx`, `my`, `mz`, `e_ex`, `e_demag`, `e_ext`,
`e_drive`, `e_ani`, `e_dmi`, and `e_total` for each of: Fullmag FDM CPU,
Fullmag FDM GPU, Fullmag FEM CPU, Fullmag FEM GPU, and the newest locally
verified MuMax3 executable. Every dynamic lane starts from the same declared
uniform `m0=(1,0,0)`; a separately measured relaxation result is not silently
transferred to only one lane. The workload must record no time-dependent full
magnetization snapshots. A chart may show a pending or not-applicable lane,
but it must not draw an absent result as zero.

Capability states remain `source_visible`, `executable`, or `validated` based
on these proofs. Source presence alone never promotes a lane.
