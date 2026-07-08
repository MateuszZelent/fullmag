# Audyt planu wdrożenia solvera FEM w domenie częstotliwości

**Zakres:** szczegółowy audyt dokumentu `11-comsol-grade-frequency-domain-masterplan-2026-06-30.md` oraz dokumentów towarzyszących `00`–`10` i podręcznika `Manual_for_Micromagnetics_Module.pdf`.

**Cel audytu:** ocena założeń fizycznych, wzorów matematycznych i podejścia obliczeniowego pod kątem budowy fizycznie poprawnego, produkcyjnego solvera FEM w domenie częstotliwości, analogicznego funkcjonalnie do ekosystemu COMSOL Micromagnetics.

**Ograniczenie audytu:** ocena opiera się na dostarczonych dokumentach. Nie uruchamiałem pełnego repozytorium, testów `just`, buildów native FEM ani benchmarków runtime. Twierdzenia o stanie implementacji w planie należy traktować jako deklaracje planu, dopóki nie są potwierdzone przez wskazane recepty runtime.

---

## 1. Werdykt wykonawczy

Plan jest architektonicznie dojrzały: prawidłowo rozdziela rodzinę analiz `frequency_domain` od dwóch solverów produktów, czyli wymuszonej odpowiedzi harmonicznej `FrequencyResponse` i modalnego/eigenfrequency `Eigenmodes`. To jest fundamentalnie zgodne z COMSOL-owym podziałem na `Frequency Domain` i `Eigenfrequency` oraz z liniaryzacją LLG wokół równowagi `m0`.

Jednocześnie dokumentacja zawiera kilka krytycznych punktów matematycznych, które trzeba poprawić **przed** promocją kolejnych ścieżek jako produkcyjnych:

1. **Gyrotropowy problem własny jest zapisany niepoprawnie lub niejednoznacznie.** Zapis `K phi = omega G phi` przy rzeczywistym, skośnie-symetrycznym `G` nie daje wprost rzeczywistych `omega`; brakuje czynnika `i` lub jawnej transformacji Hamiltonowskiej/symplektycznej.
2. **W biliniowej formie gyrotropowej najprawdopodobniej brakuje `mu0`, jeśli `K_t` jest rzeczywistą energią w J.** Poprawny współczynnik powinien być równoważny `Ms / |gamma| = mu0 Ms / gamma0`, jeżeli `gamma0 = mu0 |gamma|`.
3. **Równanie Poissona dla dynamicznego demag ma podejrzany znak.** Przy `H = -grad(phi)` standardowo `laplace(phi) = div(M)`, czyli `div(-grad(phi)) = -div(M)`, nie `+div(M)`.
4. **Wzór na zaabsorbowaną moc pomija `Ms`, jeżeli pole odpowiedzi jest bezwymiarowym `delta_m`.** Dla gęstości mocy potrzebny jest czynnik `mu0 Ms omega / 2`.
5. **Definicja podatności jest jednostkowo nieostra.** `delta_m / h` ma jednostki `m/A`; bezwymiarowa podatność wymaga `delta_M / h = Ms delta_m / h`.
6. **Konwencja tłumienia modalnego miesza `exp(+i omega t)` i `exp(-i omega t)`.** To grozi błędnym znakiem części urojonej eigenfrequency i linewidth.
7. **Tangent-space Floquet wymaga macierzy transportu ramek stycznych między sparowanymi węzłami.** Sam warunek `q_dst = phase*q_src` jest poprawny tylko wtedy, gdy lokalne bazy styczne są identyczne.

Po usunięciu tych ryzyk plan może być bardzo solidną podstawą produkcyjnego solvera. Największym merytorycznym atutem planu jest to, że już teraz blokuje niezwalidowane ścieżki: dynamiczny demag dla niezerowego Floquet-k, GPU demag, szerokie magnetoelastic i modalną produkcję dużych okien częstotliwościowych.

---

## 2. Zgodność z COMSOL i poprawność product split

### 2.1 Co jest poprawne

COMSOL Micromagnetics Module deklaruje dwa interfejsy: `Micromagnetics (Time Domain)` i `Micromagnetics (Frequency Domain)`. Interfejs frequency-domain rozwiązuje liniaryzowaną LLG i wspiera zarówno `Frequency Domain`, jak i `Eigenfrequency`. W podręczniku frequency-domain używa `m = m0 + delta_m exp(i omega t)`, wymusza ortogonalność `m0 dot delta_m = 0`, traktuje `delta_m` jako zespolony phasor i rozróżnia eigenfrequency od wymuszonego sweepu częstotliwościowego.

Plan Fullmag zachowuje dokładnie ten podział:

- `FrequencyResponse`: wymuszony solver harmoniczny, matematycznie `(i omega B - A) q = b` lub równoważnie `(i omega M - L) q = b`.
- `Eigenmodes`: modalny solver wartości własnych, matematycznie `A q = lambda B q` lub równoważny problem gyrotropowy.
- `frequency_domain`: rodzina analiz, manifesty, zasoby, UX, a nie jeden solver.

To jest decyzja krytyczna i prawidłowa. Należy ją utrzymać w API, UI, nazwach plików, capability matrix, artefaktach i komunikatach użytkownika.

### 2.2 Luka względem COMSOL

Jeżeli celem jest „analogicznie do COMSOL-a”, plan powinien jawnie oznaczyć jako osobne capability rows również:

- pinning boundary condition dla `delta_m`,
- surface anisotropy / EASA w frequency-domain,
- STT/SOT w liniaryzacji frequency-domain,
- spatially varying dynamical field / antenna / RF-source, nie tylko uniform field,
- magnetostatyczne sprzężenie dynamiczne przez dodatkowy potencjał/pole,
- późniejsze RF/magnetoelastic multiphysics jako odrębne, gated workflows.

Nie muszą być w pierwszym release, ale powinny być nazwane jako `unsupported`, `semantic_only` lub `future_gated`, aby „COMSOL-grade” nie było mylone z pierwszym no-demag/no-Floquet slice.

---

## 3. Liniaryzowana LLG: zalecany kanoniczny zapis

Dla jednej konwencji w całym projekcie proponuję utrzymać COMSOL/Fullmag:

```text
m(r,t) = m0(r) + Re[delta_m(r) exp(i omega t)]
H_eff[m] = H0 + delta_H[delta_m] exp(i omega t)
|m0| = 1
m0 dot delta_m = 0
m0 x H0 ~= 0
```

Dla `gamma0 = mu0 |gamma|` i `H` w A/m:

```text
i omega delta_m =
  -gamma0 [m0 x delta_H[delta_m] + delta_m x H0]
  + i omega alpha [m0 x delta_m]
  + drive_terms
```

W tangent-space, dla `delta_m = T q`:

```text
L q = tangent projection of -gamma0 [m0 x delta_H[Tq] + (Tq) x H0]
C q = tangent coordinates of m0 x (Tq)
```

Wtedy napędzany system harmoniczny można zapisać jako:

```text
[i omega (M - alpha C_mass) - L] q = b
```

albo, jeśli `M`/`B` jest zdefiniowane jako operator zawierający damping:

```text
(i omega B_alpha - L) q = b
```

**Wniosek:** symbol `B`/`M` musi mieć jedną definicję w całym planie. Obecne mieszanie `(i omega B - A)`, `(i omega M - L)` i `K/G` jest akceptowalne jako szkic, ale za słabe jako kontrakt implementacyjny.

---

## 4. Krytyczne korekty matematyczne

### 4.1 Gyrotropowy problem własny

Obecny zapis w planie:

```text
G q_dot = -K q
K phi = omega G phi
```

jest problematyczny, jeśli `G` jest rzeczywistą skośnie-symetryczną formą gyrotropową. Po podstawieniu `q(t)=phi exp(i omega t)` dostajemy:

```text
i omega G phi = -K phi
K phi = -i omega G phi
```

Dla konwencji `exp(-i omega t)` znak się zmienia:

```text
K phi = +i omega G phi
```

Nie ma więc prostego realnego problemu `K phi = omega G phi`, chyba że `G` w dokumentacji nie jest rzeczywistą formą gyrotropową, lecz już przetransformowanym operatorem zawierającym czynnik `i` lub inną symplektyczną transformację. Plan powinien wybrać jeden z zapisów produkcyjnych:

**Opcja A – pierwszorzędowy operator dynamiczny:**

```text
L q = lambda M q
lambda = i omega
frequency_hz = Im(lambda) / (2 pi)  # przy dodatniej częstotliwości i exp(+i omega t)
```

**Opcja B – gyrotropowy pencil z czynnikiem `i`:**

```text
K phi = -i omega G phi  # dla exp(+i omega t)
```

**Opcja C – realny Hamiltonian po jawnej transformacji:**

```text
A_H y = omega y
```

przy czym dokument musi podać `A_H`, znak, normę, iloczyn wewnętrzny i mapowanie eigenvalue → `omega_rad_s`.

### 4.2 Brakujący `mu0` w formie gyrotropowej

Plan definiuje `gamma0 = mu0 |gamma|`, a `K_t` jako drugą wariację energii w J. W takim układzie forma gyrotropowa powinna mieć współczynnik:

```text
Ms / |gamma| = mu0 Ms / gamma0
```

czyli:

```text
G_t(p,q) = integral_Omega (mu0 Ms / gamma0) * eta dot (m0 x xi) dV
```

Obecny zapis `Ms / gamma0` nie ma poprawnych jednostek dla problemu `K/G -> 1/s`, jeżeli `K` jest w J. Alternatywnie można użyć formy polowej, nie energetycznej, ale wtedy `K_t` nie może być nazywane Hessianem energii w J. To trzeba ujednolicić.

### 4.3 Znak równania demag Poissona

Standardowo:

```text
B = mu0 (H + M)
div B = 0
H = -grad phi
```

zatem:

```text
-div(grad phi) + div M = 0
laplace(phi) = div M
```

równoważnie:

```text
div(-grad phi) = -div M
```

Jeśli `delta_H_demag = -grad(delta_phi)`, to planowy zapis:

```text
div(-grad(delta_phi)) = div(Ms * xi)
```

ma przeciwny znak względem tej konwencji. Plan musi rozstrzygnąć znak i dodać testy:

- energia demag nieujemna,
- jednorodnie namagnesowana sfera/ellipsoid ma właściwy znak `H_demag`,
- symetria `p^T K_demag q = q^T K_demag p` dla k=0,
- zgodność potencjału i pola `H=-grad(phi)`.

### 4.4 Moc absorbowana

Planowy wzór:

```text
absorbed_power_density = 0.5 * mu0 * omega * Im(conj(h_drive) dot delta_m)
```

ma błędne jednostki, jeśli `delta_m` jest bezwymiarowe. Zalecany lokalny wzór przy `h` w A/m i `delta_m` bezwymiarowym:

```text
p_abs(r) = sgn * 0.5 * mu0 * Ms(r) * omega * Im[conj(h_drive(r)) dot delta_m(r)]
```

Znak `sgn` zależy od przyjętej konwencji `exp(+i omega t)` oraz definicji „moc pochłonięta przez magnetyzację” kontra „praca wykonana przez magnetyzację na polu”. Plan powinien zapisać test konwencji: dodatnie tłumienie Gilberta w rezonansie ma dawać dodatnią absorpcję.

Dla całkowitej mocy:

```text
P_abs = integral_Omega p_abs(r) dV
```

Dla średniej gęstości:

```text
<P_abs_density> = P_abs / volume_magnetic
```

### 4.5 Podatność

Jeżeli odpowiedzią solvera jest `delta_m`, to:

```text
chi_m = delta_m / h_drive
```

ma jednostki `m/A`. Bezwymiarowa podatność magnetyczna w SI powinna używać `delta_M = Ms delta_m`:

```text
chi = delta_M / h_drive = Ms delta_m / h_drive
```

Dla materiału z przestrzennie zmiennym `Ms` trzeba jasno zdefiniować, czy raportowana jest podatność lokalna, objętościowo uśredniona, drive-projected, czy tensorowa.

### 4.6 Damping i częstotliwość zespolona

Plan w części modalnej przełącza się na `exp(-i omega_complex t)`, choć reszta systemu i COMSOL parity używa `exp(+i omega t)`. Trzeba utrzymać jedną konwencję.

Dla `exp(+i omega t)` zanikający mod ma:

```text
omega_complex = omega_r + i Gamma
exp(i omega_complex t) = exp(i omega_r t - Gamma t)
Gamma > 0
```

Wtedy artefakty muszą podawać:

```text
omega_rad_s_real
omega_rad_s_imag
frequency_hz = omega_rad_s_real / (2*pi)
damping_rate_hz = omega_rad_s_imag / (2*pi)
linewidth_fwhm_hz = omega_rad_s_imag / pi  # jeśli Gamma jest HWHM w rad/s
```

Jeżeli projekt wybiera `exp(-i omega t)`, wszystkie znaki w LLG, odpowiedzi harmonicznej, absorpcji i Floquet metadata muszą być odpowiednio przepisane. Obecnie najlepszym wyborem jest zostać przy `exp(+i omega t)`, bo tak jest w COMSOL-reference i planie.

---

## 5. FEM weak form i operatory

### 5.1 Mocne elementy planu

Plan poprawnie wymaga:

- operatorów FEM wyprowadzonych z weak form, nie ad hoc finite differences na mesh,
- dwóch DOF stycznych na węzeł magnetyczny,
- deterministycznej ramki stycznej,
- diagnostyk `m0 dot delta_m`, residuali, normalizacji, orthogonality i provenance,
- oddzielenia operator assembly od solve path.

### 5.2 Co trzeba doprecyzować

#### Tangent-space exchange dla niejednorodnego `m0`

Dla zmiennego `m0(r)` ramka styczna `T(r)` też jest zmienna. Jeżeli interpolujecie `delta_m = sum_i phi_i (e1_i q1_i + e2_i q2_i)`, gradient automatycznie zawiera zmienność nodalnych ramek przez interpolowane pole wektorowe. Jeśli natomiast implementujecie osobne scalar FE na `q1/q2` i traktujecie `e1/e2` jako lokalnie stałe per element, trzeba jasno opisać, czy jest to spójne z pełną projekcją. Test powinien porównać pełnowektorową projekcję z tangent-space assembly na teksturze niejednorodnej, np. skyrmion albo domain wall.

#### Zeeman i constraint term

Zdanie „Zeeman Hessian is zero” jest prawdziwe dla energii z ustalonym polem zewnętrznym, ale precesja od `H0` nie znika. Makrospin FMR zależy bezpośrednio od `H0`. Plan musi wskazać dokładne miejsce w operatorze, gdzie pojawia się termin:

```text
-gamma0 * P_T(delta_m x H0)
```

lub jego odpowiednik w `K/G`. Bez tego łatwo zbudować Hessian energii bez właściwego lokalnego torque-restoring term.

#### DMI

Plan słusznie wymaga testów directional derivative. To powinien być twardy warunek promocji. DMI w periodic/Floquet jest szczególnie ryzykowne, bo warunki brzegowe/seam terms decydują o nieodwracalności `f(+k) != f(-k)`. Każda produkcyjna ścieżka DMI powinna mieć:

- weak residual derivative test,
- test nieodwracalnej dyspersji dla znanego przypadku,
- seam/PBC test,
- test znaku bulk i interfacial osobno,
- odmowę uruchomienia, jeśli użytkownik aktywuje oba typy DMI bez jawnie udokumentowanej mieszanej fizyki.

---

## 6. Periodic, Floquet i PBC

### 6.1 Co jest poprawne

Plan ma bardzo dobry podział na:

- P1: static / zero-phase periodic unit cell,
- P2: modal Bloch/Floquet eigenmodes and dispersion,
- P3: driven Bloch/Floquet frequency response.

Znak Floquet:

```text
delta_m_dst = delta_m_src * exp(-i k dot (r_dst - r_src))
```

jest zgodny z dokumentem COMSOL i powinien pozostać kanoniczny.

### 6.2 Najważniejsza luka: transport ramki stycznej

Warunek Floquet dotyczy pełnego wektora `delta_m`, nie surowych współrzędnych w lokalnej ramce stycznej. Dla sparowanych węzłów:

```text
T_dst q_dst = exp(-i k dot delta_r) T_src q_src
```

Zatem:

```text
q_dst = exp(-i k dot delta_r) * (T_dst^T T_src) q_src
```

jeżeli `T_src`, `T_dst` są ortonormalnymi bazami w tangent plane. Dla idealnie periodycznego `m0` i deterministycznej identycznej ramki często `T_dst^T T_src = I`, ale produkcyjny solver nie powinien tego zakładać bez diagnostyki. Artefakty PBC powinny zapisywać:

```text
static_periodic_frame_max_mismatch
floquet_tangent_transport_max_nonunitarity
basis_transport_policy = full_vector | tangent_frame_identity | rejected
```

### 6.3 Dynamic demag-k

Plan słusznie blokuje niezerowy `k` z demag. To musi pozostać twarde. Dla produkcyjnego Floquet demag potrzeba osobnego kontraktu:

```text
delta_m(r + R) = delta_m(r) exp(-i k dot R)
delta_phi(r + R) = delta_phi(r) exp(-i k dot R)
```

oraz odpowiedniej fazowej dywergencji/gradientu, gauge/neutralization i testów supercell. Statyczny demag PBC dla `k=0` nie jest zamiennikiem dynamicznego demag-k.

---

## 7. Demag i magnetostatyka

### 7.1 M5 jako gate jest właściwy

Dodanie M5 jako blokującego etapu przed M6 jest bardzo dobrą decyzją. Liniaryzacja frequency-domain wokół niezaakceptowanego `m0` prowadzi do fizycznie bezużytecznych wyników nawet wtedy, gdy solver liniowy zbiega. Gate powinien obowiązywać dla wszystkich dynamicznych solverów, nie tylko dla antidot/PBC.

### 7.2 M6 musi rozwiązywać dynamiczny demag, nie tylko konsumować statyczny demag

Dla k=0 periodic-airbox odpowiedź dynamiczna z demag powinna zawierać pochodną Frecheta pola demag:

```text
delta_H_demag[delta_m] = -grad(delta_phi)
```

z dynamicznym źródłem od `delta_M = Ms delta_m`. Statyczny `H_demag[m0]` jest składnikiem `H0`, ale nie zastępuje dynamicznej pochodnej `delta_H_demag`.

### 7.3 Preconditioning

Obecny opis M6 mówi o GMRES blisko tolerancji. To jest za słabe jako strategia produkcyjna. Dla coupled `delta_m/delta_phi` potrzebny jest docelowy preconditioner, np. blokowy Schur:

```text
[ A_mm(omega)  A_mphi ] [q]   [b]
[ A_phim       A_phiphi] [phi] = [0]
```

z preconditionerem:

```text
P^{-1} ~= diag(A_mm^{-1}, A_phiphi^{-1})
```

lub przybliżonym Schur complement. Artefakty powinny raportować KSP/PC osobno dla bloku magnetycznego i Poissona.

---

## 8. Driven response solver

### 8.1 Poprawny kierunek

Plan prawidłowo wymaga bezpośredniego rozwiązania wymuszonego układu harmonicznego, a nie rekonstrukcji odpowiedzi z modów. Modal reconstruction może być walidacją lub postprocessingiem, ale nie solverem response.

### 8.2 Wymagane doprecyzowania produkcyjne

Dla każdej częstotliwości artefakt powinien zapisać:

```text
frequency_hz
omega_rad_s
matrix_form = iomega_B_minus_L | K_plus_iomega_G | coupled_demag_block
phasor_convention
linear_residual_absolute
linear_residual_relative
preconditioner_reused = true/false
ksp_type
pc_type
iterations
converged_reason
field_payload_id
observable_units
```

Sweep powinien wspierać:

- reuse symbolic assembly,
- reuse preconditionera, jeżeli bezpieczne,
- frequency continuation dla initial guess,
- osobne residual gates w pobliżu rezonansu,
- partial artifacts i cancellation.

---

## 9. Modal/eigenfrequency solver

### 9.1 Dobre elementy

Plan bardzo dobrze uwzględnia:

- selected-spectrum/interior-window,
- shift-invert i contour/FEAST-like path,
- completeness policy,
- degeneracy clusters,
- residuals,
- mode normalization,
- gauge fixing,
- artifact provenance.

### 9.2 Krytyczny warunek: poprawna algebra

Przed rozbudową SLEPc trzeba najpierw naprawić zapis operatora gyrotropowego i eigenvalue mapping. Minimalny test bez MFEM:

```text
m0 = z
H0 = H z
alpha = 0
expected omega = gamma0 H
```

Zbudować 2-DOF macrospin i sprawdzić:

- znak `omega`,
- dodatnią częstotliwość,
- parę sprzężoną,
- mapowanie `lambda -> omega_rad_s`,
- residual dla wybranego pencil.

Dopiero po tym należy budować SLEPc shift-invert na dużych macierzach.

### 9.3 Modal damping

Pierwszy production modal lane jako `damping_policy=ignore` jest rozsądny. Damped/non-Hermitian modal powinien pozostać gated do momentu wdrożenia lewych/prawych wektorów własnych, biorthogonal normalization i spójnej konwencji linewidth.

---

## 10. GPU

Plan jest uczciwy: GPU no-demag/static-periodic slices mogą być partial production, ale GPU dynamic demag i GPU periodic-airbox powinny być unavailable. To trzeba utrzymać.

Dla promocji GPU konieczne są:

- FP64 capability check,
- deterministyczne tolerancje CPU/GPU,
- transfer/memory diagnostics,
- parity z CPU dla identycznego operatora,
- jawne odrzucenie unsupported terms, zamiast CPU fallback,
- osobne artefakty `requested_device=gpu`, `resolved_device=gpu`, `fallback=false`.

---

## 11. Artefakty, API, UI

### 11.1 Mocne elementy

Plan ma bardzo dobry resource-first model:

- JSON jako control-plane,
- Zarr jako heavy-data default,
- manifest jako discovery root,
- osobne eigen/response resource families,
- provenance i diagnostics jako gate produkcyjności,
- Control Room bez bezpośredniego `fetch()` w komponentach.

### 11.2 Braki do zamknięcia

Field payload metadata powinno zawsze zawierać:

```text
field_id
source_family = analysis/eigen | analysis/frequency-response
quantity = delta_m | delta_M | h_drive | phi_demag | H_demag
value_kind = complex_vector | complex_scalar | real_scalar
units
normalization
mesh_id
fe_space
basis = global_xyz | tangent_components | reconstructed_xyz
complex_layout = real_imag | amplitude_phase
component_order
storage_format
zarr_path
revision
```

Response-derived peak mode nie może być opisywany jako eigenmode. Powinien mieć np.:

```text
source = driven_response_peak
canonical_product = frequency_response
linked_frequency_index
not_an_eigenmode = true
```

---

## 12. Rekomendowana kolejność poprawek

### P0 – naprawić kontrakt matematyczny

1. Ujednolicić `A/B/L/M/K/G` i znaki dla `exp(+i omega t)`.
2. Poprawić gyrotropowy pencil.
3. Poprawić `mu0` w `G_t` albo zmienić definicję `K_t` z energii na formę polową.
4. Poprawić znak dynamicznego Poissona demag.
5. Poprawić absorpcję i podatność o `Ms` i jednostki.
6. Ujednolicić damping/complex frequency.
7. Dodać test macrospin bez MFEM.

### P1 – zamknąć M5 equilibrium gate

1. Torque residual i unit norm.
2. Seam mismatch.
3. Demag energy sign.
4. Airbox/z-padding convergence.
5. Primitive-vs-supercell central-cell parity.
6. Artefakt equilibrium reusable by response/eigen.

### P2 – M6 k=0 periodic-airbox dynamic demag response

1. Dynamic demag derivative, nie tylko static demag.
2. Poprawiony block/Schur preconditioner.
3. Single-point convergence.
4. Refined spectrum.
5. Supercell response parity.

### P3 – M8 modal selected-spectrum

1. Correct pencil.
2. SLEPc shift-invert with residuals.
3. Window completeness.
4. Dense/reference parity.
5. Mesh convergence.

### P4 – M7 UI/Control Room hardening

1. Transaction-backed authoring.
2. Capability reasons by lane.
3. Browser smoke for WebGL overlays.
4. No response-map noise without artifacts.

### P5 – GPU and nonzero-k Floquet no-demag

1. CPU/GPU parity no-demag.
2. Floquet frame transport.
3. Reciprocal exchange test.
4. DMI nonreciprocal only after weak-form validation.

---

## 13. Minimalny zestaw testów, bez których nie promowałbym lane do produkcji

### Unit/math tests

- Macrospin undamped: `omega = gamma0 H`.
- Macrospin damping: sign części urojonej i linewidth zgodne z konwencją.
- Absorbed power positive near resonance for positive Gilbert damping.
- Susceptibility units and scaling with `Ms`.
- Poisson demag sign via sphere/ellipsoid.
- Tangent projection idempotence.
- Tangent frame transport across PBC pairs.

### Operator derivative tests

- Exchange Frechet derivative.
- Uniaxial/cubic anisotropy derivative.
- DMI derivative.
- Demag derivative.
- Surface anisotropy derivative.

### Physical validation

- Kittel/Smit-Beljers FMR.
- Standing spin waves exchange-only film.
- Magnetostatic mode thin film with dynamic demag.
- `f(k)=f(-k)` exchange-only Floquet.
- `f(+k)!=f(-k)` DMI fixture.
- Unit-cell PBC vs 2x2/3x3 supercell.
- Time-domain pulse Fourier vs frequency-domain response for a small case.

### Numerical validation

- Mesh refinement frequency drift.
- Solver residual vs observable drift.
- Preconditioner stability across frequency sweep.
- Window completeness under shift-invert and contour.
- Degenerate subspace overlap.
- CPU/GPU parity where GPU is promoted.

### Artifact/UI validation

- Manifest completeness.
- Diagnostics required for successful status.
- Field payload metadata round-trip.
- No direct fetch in UI.
- No `PlaceholderPanel` for frequency-domain nodes.
- Browser WebGL smoke for eigen and response overlays.

---

## 14. Konkluzja

Plan jest dobrym szkieletem systemu produkcyjnego i ma właściwą filozofię: najpierw fizyka, potem kontrakty, potem solver, artefakty, API i UI. Największe ryzyko nie leży w architekturze, lecz w kilku szczegółach matematycznych, które w solverze frequency-domain są krytyczne: znak phasora, gyrotropowy pencil, `mu0`, znak demag Poissona, `Ms` w observables i jednoznaczne jednostki.

Po poprawieniu tych punktów rekomendowałbym utrzymać obecny priorytet: M5 → M6 → M8 → M7 hardening → GPU/Floquet. Nie promowałbym dynamic demag, nonzero-k Floquet demag, damped modal eigen, magnetoelastic ani GPU demag jako produkcyjnych przed osobnymi walidacjami fizycznymi i runtime gates.
