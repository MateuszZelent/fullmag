# Audyt solvera LLG w dziedzinie czasu

**Data:** 2026-07-16
**Repozytorium:** Fullmag
**Bazowy commit:** `707a50386cdfe6787aac06cca3070289dc731fa2`
**Główny przypadek:** `examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py`
**Zakres główny:** FEM GPU/CPU, pełne LLG po etapie `add_minimize`, RK23/RK45, adaptacyjny krok czasu, energia, demagnetyzacja, przekazanie stanu między etapami
**Zakres porównawczy:** COMSOL Time-Dependent Solver, SciPy `solve_ivp`/RK45, lokalny `external_solvers/tetrax`, semantyka FDM CPU/CUDA
**Charakter dowodu:** audyt kodu end-to-end, eksport konfiguracji, ukierunkowane kontrakty, zarządzany gate FEM i niezależne orakle numeryczne; bez modyfikacji kodu produkcyjnego

## 1. Werdykt

Podejrzenie, że problem leży przede wszystkim w solverze czasu i jego konfiguracji, jest uzasadnione. Nie znalazłem błędnego znaku ani brakującego czynnika w bazowym równaniu LLG dla FEM. Znalazłem natomiast nakładający się łańcuch błędów i luk, który dokładnie może dać obserwowany efekt: stan po relaksacji jest poprawnie przekazany, ale jawny RK45 akceptuje niestabilne wzbudzenie szybkich modów wymiany, krok rośnie, a energia całkowita zaczyna rosnąć mimo dodatniego tłumienia.

Najważniejsze przyczyny dla badanego przypadku są następujące:

1. `max_error=1e-6` nie oznacza maksymalnego błędu `1e-6`. Płaskie API ustawia wyłącznie `atol=1e-6`, pozostawiając ukryte `rtol=1e-3`. Dla znormalizowanej magnetyzacji próg akceptacji wynosi około `1.001e-3`.
2. Brak jawnego `dt` nie daje startu z `dt_min=1e-16 s`. Python zapisuje `dt_initial=dt_min`, po czym runner rozpoznaje tę wartość jako sentinel „brak” i zamienia ją na `1e-13 s`. Brak `dt_max` staje się w runnerze `1e-10 s`.
3. Siatka lokalnie schodzi do `0.5 nm`. Prosty szacunek skali wymiany daje czas charakterystyczny rzędu `4.1e-14 s`; start `1e-13 s` jest więc już agresywny dla jawnego integratora, zanim kontroler zacznie podwajać krok.
4. Kontroler PI FEM używa tych samych wykładników dla RK23 i RK45, ignoruje rząd estymatora i po zaakceptowanym kroku zabrania zmniejszenia następnego `dt`.
5. Kryterium akceptacji sprawdza tylko różnicę embedded względem skali całego wektora `|m|≈1`. Nie sprawdza maksymalnego obrotu spinu, defektu normy przed projekcją, granicy stabilności ani wzrostu energii w autonomicznym, dyssypacyjnym przebiegu.
6. Iteracyjne solve-y Poissona zapisują residual i liczbę iteracji, lecz publikują pole jako poprawne bez testu zbieżności. Błędne `H_demag` może więc wejść jednocześnie do RHS i do energii.
7. Bieżący przykład nie zapisuje historii energii, kroku, błędu ani odrzuceń, więc destabilizacja nie ma wystarczającej telemetrii diagnostycznej.

To jest przede wszystkim problem numeryki i kontraktu konfiguracji, nie fizyki znaku LLG.

### Klasyfikacja wyniku

- **Równanie LLG:** zgodne z konwencją Fullmag, COMSOL i TetraX po przeliczeniu jednostek.
- **Przekazanie `relax -> run`:** poprawne dla deklaratywnego staged Study użytego w przykładzie.
- **Adaptacyjny RK FEM:** niekwalifikowany do produkcyjnego użycia na tak sztywnym przypadku bez ścisłego `dt_max`, pełnych guardów i testu zbieżności.
- **`max_error`:** nazwa i semantyka są mylące; w badanym przykładzie tolerancja jest około 1001 razy luźniejsza od intuicyjnej interpretacji parametru.
- **Demag Poisson:** brak fail-closed przy niezbieżności jest niezależnym ryzykiem wysokiego priorytetu.
- **Aktualny working tree:** ręczna próba ustawienia pełnych parametrów adaptive w `study.solver(...)` jest obecnie niewykonalna przez to API i kończy się `TypeError`.

## 2. Co fizyka wymaga od przebiegu

### 2.1 Równanie

Fullmag ewoluuje zredukowaną magnetyzację `m=M/Ms` według jawnej postaci równania Gilberta:

\[
\frac{\partial \mathbf m}{\partial t}
=
-\frac{\gamma_{\mu_0}}{1+\alpha^2}
\left[
\mathbf m\times\mathbf H_\mathrm{eff}
+\alpha\,\mathbf m\times(\mathbf m\times\mathbf H_\mathrm{eff})
\right]
+\boldsymbol\tau_\mathrm{direct}.
\]

Konwencje:

- `m` jest bezwymiarowe i powinno spełniać `|m|=1` na węzłach magnetycznych;
- `H_eff` jest w `A/m`;
- `gamma_mu0` jest w `m/(A s)`;
- `alpha` jest bezwymiarowe;
- bezpośrednie momenty, np. STT, są już w `1/s`.

Dokumentacja kanoniczna: `docs/physics/llg_conventions.md:13-28,77-88`. Implementacja CPU: `backends/fem/cpu/mfem/integrators/llg_rhs.cpp:44-72`. Implementacja GPU: `backends/fem/gpu/cuda/integrators/llg/llg_rhs_kernels.cu:34-59`.

Znaki w kodzie są poprawne. CPU wylicza kolejno `p=m×H`, `d=m×p` i zwraca `-gamma/(1+alpha²) * (p + alpha*d)`. Test `backends/fem/tests/llg_rhs_contract.cpp:81-170` pokrywa znak precesji, damping regionalny, wyłączenie precesji oraz mały przykład spadku energii Zeemana.

### 2.2 Prawo dyssypacji energii

Dla autonomicznego problemu bez pola zależnego od czasu, STT i szumu termicznego oraz przy polu będącym poprawną pochodną funkcjonału energii:

\[
\mathbf H_\mathrm{eff}
=-\frac{1}{\mu_0 M_s}\frac{\delta E}{\delta \mathbf m}.
\]

Po podstawieniu LLG:

\[
\frac{dE}{dt}
=
-\mu_0\int M_s
\frac{\gamma_{\mu_0}\alpha}{1+\alpha^2}
\left|\mathbf m\times\mathbf H_\mathrm{eff}\right|^2 dV
\le 0.
\]

Precesja nie zmienia energii, a damping ją zmniejsza. Dlatego dla statycznego pola zewnętrznego, wymiany i demagnetyzacji — dokładnie konfiguracji z badanego pliku, gdzie drive jest zakomentowany — trwały wzrost poprawnie policzonej energii jest niezgodny z równaniem ciągłym.

Wyjątki, dla których monotoniczność nie obowiązuje:

- pole lub parametry jawnie zależne od czasu;
- antenna/drive;
- STT/SOT i inne bezpośrednie momenty wykonujące pracę;
- szum termiczny;
- energia raportowana z innego stanu/czasu niż RHS;
- błąd dyskretyzacji lub solvera liniowego.

W aktualnym `HEAD` drive, autosave i FFT są zakomentowane, zatem pierwszy zestaw wyjątków nie wyjaśnia obserwowanego wzrostu.

### 2.3 „Duże tłumienie” nie rośnie bez końca

Współczynnik członu dyssypacyjnego jest proporcjonalny do

\[
f(\alpha)=\frac{\alpha}{1+\alpha^2}.
\]

Maksimum występuje dla `alpha=1`. Dla `alpha >> 1` zarówno precesja, jak i dynamika tłumienia ponownie zwalniają. Zwiększanie `alpha` ponad 1 nie jest numerycznym stabilizatorem o nieograniczonej sile.

Ponadto badany plik na `HEAD` ma `body.alpha=0.02`, a nie duże tłumienie (`examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py:49-52`). Etap `add_minimize(method="bb")` nie zmienia materiałowego `alpha` następnego etapu. Jeżeli obserwacja dotyczy innej, ręcznie zmienionej wartości, prawo `dE/dt<=0` nadal obowiązuje dla każdego `alpha>0`, ale skala czasu jest inna.

## 3. Rekonstrukcja dokładnej konfiguracji

### 3.1 Konfiguracja z `HEAD`, która ujawnia problem

Istotne wartości:

| Parametr | Wartość |
|---|---:|
| backend | FEM GPU, `double` |
| geometria | antidot okresowy, `pbc(x,y)`, `periodic_airbox_k0` |
| minimalny element w refinement | `0.5 nm` |
| `Ms` | `800 kA/m` |
| `Aex` | `13 pJ/m` |
| `alpha` w etapie run | `0.02` |
| pole statyczne | `B_ext=(10 mT,0,0)` |
| demag | `poisson_robin`, CG+AMG, `rtol=1e-12`, `max_iterations=500` |
| relaksacja | bezpośredni BB, `max_steps=500`, `tol=500 A/m` |
| integrator run | Dormand–Prince RK45 |
| publiczne `dt_min` | `1e-16 s` |
| publiczne `max_error` | `1e-6` |
| publiczne `dt` | brak |
| czas run | `0.5 ns` |
| output | brak aktywnego autosave/table |

Eksport ProblemIR dla `HEAD` dał w etapie run:

```text
adaptive.atol       = 1e-6
adaptive.rtol       = 1e-3
adaptive.dt_initial = 1e-16
adaptive.dt_min     = 1e-16
adaptive.dt_max     = omitted
material.alpha      = 0.02
```

Runner rozwiązuje tę konfigurację do:

```text
resolved dt_initial = 1e-13 s
resolved dt_min     = 1e-16 s
resolved dt_max     = 1e-10 s
effective scale     = atol + rtol * max(|m|, 1)
                    ≈ 1e-6 + 1e-3
                    = 1.001e-3
```

Źródła tej transformacji:

- defaulty `AdaptiveTimestep`: `packages/fullmag-py/src/fullmag/model/dynamics.py:21-34`;
- serializacja braku `dt_initial` jako `dt_min`: `dynamics.py:57-68`;
- `max_error` mapowany tylko do `atol`: `packages/fullmag-py/src/fullmag/world.py:6590-6599`;
- sentinel i default startu: `crates/fullmag-runner/src/lib.rs:50-68`;
- default `dt_max=1e-10`: `crates/fullmag-runner/src/lib.rs:50-55`, użycie w `native_fem.rs:1661-1675`;
- skala błędu CPU: `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp:84-107`;
- identyczna skala GPU: `backends/fem/gpu/cuda/integrators/rk/adaptive_error_kernels.cu:82-96`.

### 3.2 Aktualny working tree po ręcznej próbie mitigacji

W czasie audytu w pliku roboczym pojawiła się niezacommitowana zmiana:

```python
study.solver(
    integrator="rk45",
    dt=1e-15,
    dt_min=1e-16,
    dt_max=1e-14,
    atol=1e-8,
    rtol=1e-6,
    growth_limit=1.5,
    g=2.115,
)
```

To jest rozsądniejsza intencja numeryczna, ale obecne `StudyBuilder.solver()` jej nie obsługuje. Sygnatura przyjmuje tylko `dt`, `max_error`, `dt_min`, `integrator`, `gamma`, `g` i `demag_interval_s`: `packages/fullmag-py/src/fullmag/world.py:4250-4269,6052-6080`.

Aktualny eksport kończy się przed budową problemu:

```text
TypeError: StudyBuilder.solver() got an unexpected keyword argument 'dt_max'
```

To nie jest błąd native FEM, lecz potwierdzona luka płaskiego API. Pełny rekord istnieje niżej jako `fm.AdaptiveTimestep(...)`, np. `examples/jenkins_vortex_pinning_fem.py:301-310`, ale nie jest dostępny przez tę convenience metodę.

## 4. Przepływ ustawień krok po kroku

### 4.1 Python DSL

`AdaptiveTimestep` publicznie oferuje:

- `atol`, `rtol`;
- `dt_initial`, `dt_min`, `dt_max`;
- `safety`, `growth_limit`, `shrink_limit`;
- `max_spin_rotation`, `norm_tolerance`.

Płaskie `study.solver(...)` udostępnia tylko podzbiór i zastępuje dwie tolerancje nazwą `max_error`. To tworzy dwa problemy:

1. użytkownik nie może z tego API ustawić `rtol`, `dt_max`, clamps ani guardów;
2. nazwa `max_error` sugeruje jeden twardy limit, choć backend używa sumy tolerancji absolutnej i względnej.

Dokumentacja `world.py:6066-6074` nazywa `max_error` „Adaptive integrator error tolerance”, nie ujawniając pozostającego `rtol=1e-3`.

### 4.2 ProblemIR i walidacja

ProblemIR zawiera pełny `AdaptiveTimeStepIR`, ale walidacja liczb jest niepełna:

- IR: `crates/fullmag-ir/src/study.rs:397-414`;
- validator sprawdza konflikt fixed/adaptive, lecz pomija większość pól przez `..`: `crates/fullmag-ir/src/validation.rs:1165-1201`;
- planner sprawdza głównie zgodność integratora z adaptive: `crates/fullmag-plan/src/validate.rs:444-469`;
- niewywoływany helper pełnej walidacji istnieje w `crates/fullmag-runner/src/fem/integrators/adaptive.rs:95-134`.

W efekcie JSON omijający walidację Pythona może wprowadzić niepoprawne wartości głębiej do runtime.

Istnieje też niespójność granicy `safety`: Python dopuszcza `1.0` (`dynamics.py:46-47`), a native FEM wymaga wartości ściśle mniejszej od 1 (`adaptive_dt.cpp:47-51`).

### 4.3 Runner i utrata intencji `dt_initial`

`AdaptiveTimestep.to_ir()` nie zachowuje rozróżnienia:

- użytkownik nie podał `dt_initial`;
- użytkownik jawnie podał `dt_initial == dt_min`.

Oba przypadki stają się tą samą liczbą. Runner dodatkowo interpretuje równość jako sentinel i wybiera `1e-13 s`. Test `crates/fullmag-runner/src/lib.rs:791-805` utrwala tę semantykę.

To jest wcześniej opisany, nadal aktywny finding `DOC-019` z `docs/validation/2026-07-09-backend-llg-scientific-audit.md:2808-2857`.

Poprawny kontrakt musi zachowywać `None`/`Some(dt)` do samego resolvera i publikować oddzielnie `requested` oraz `resolved`.

### 4.4 Native FEM FFI

Runner przekazuje do native FEM:

```text
atol, rtol, dt_initial, dt_min, dt_max,
safety, growth_limit, shrink_limit, max_reject=50
```

`max_spin_rotation` i `norm_tolerance` są jawnie odrzucane: `crates/fullmag-runner/src/native_fem.rs:1640-1659`. To jest uczciwsze niż ciche ignorowanie, lecz oznacza, że dwa guardy przewidziane w publicznym API nie mogą chronić FEM.

Nie ma publicznej kontroli `max_reject`; jest hardcoded `50` (`native_fem.rs:1661-1676`).

### 4.5 Tableaux RK

Same współczynniki są poprawne:

- RK23 to Bogacki–Shampine 3(2), cztery stages, `order_est=2`, FSAL: `backends/fem/cpu/mfem/integrators/rk23.cpp:31-49`;
- RK45 to Dormand–Prince 5(4), siedem stages, `order_est=4`, FSAL: `backends/fem/cpu/mfem/integrators/rk45.cpp:31-53`.

Czasy stage są liczone jako `t_n + c_i dt`, a końcowe pola przy `t_n+dt`: `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp:156-178,268-292`. Wcześniejszy problem czasu stage został naprawiony; nie jest aktualną przyczyną.

### 4.6 Projekcja na sferę

Każdy stan stage i kandydat końcowy jest normalizowany przed dalszym użyciem: `rk_explicit_step.cpp:156-165,197-205`. To ogranicza dryf długości, ale nie stabilizuje jawnego RK i nie gwarantuje spadku energii.

Potwierdzony defekt: `normalize_aos_field()` dzieli tylko, gdy `norm>0`. Wektor zerowy pozostaje zerowy, a `NaN/Inf` może przejść dalej (`llg_rhs.cpp:16-27`). CUDA ma analogiczną politykę w `backends/fem/gpu/cuda/fields/vector_field_kernels.cu:13-27`. Test `llg_rhs_contract.cpp:173-183` wręcz oczekuje pozostawienia zera.

### 4.7 Estymator błędu

Po wyliczeniu rozwiązania wysokiego rzędu kod buduje:

\[
e=dt\sum_i(b_i^{hi}-b_i^{lo})k_i
\]

i redukuje maksimum po węzłach:

\[
\eta=max_a\frac{\|e_a\|_2}
{\mathrm{atol}+\mathrm{rtol}\max(\|m_a^{hi}\|_2,1)}.
\]

Krok jest akceptowany dla `eta<=1`. To jest sensowna norma wektorowa i jest zgodna z notą projektową `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md:241-263`.

Problemem nie jest sama formuła, lecz:

- luźny, ukryty `rtol`;
- skala odniesiona do całego `|m|=1`, a nie do małej amplitudy szybkiego modu poprzecznego;
- brak drugiego warunku „norm-defect below threshold”, wymaganego w tej samej nocie na linii 255;
- brak ograniczenia obrotu spinu i stabilności spektralnej.

Argumenty `old_m` są obecne, ale ignorowane zarówno na CPU (`adaptive_dt.cpp:91`), jak i GPU (`adaptive_error_kernels.cu:34-36`). To byłoby naturalne miejsce dla rotation/norm guardów.

### 4.8 Kontroler PI

Stan kontrolera ma stałe:

```text
pi_alpha = 0.7
pi_beta  = 0.4
```

dla obu metod (`adaptive_dt.hpp:33-47`). Dla zaakceptowanego kroku:

```text
ratio = safety * error^(-0.7) * (prev_error/error)^(0.4)
ratio = min(ratio, growth_limit)
ratio = max(ratio, 1.0)
```

Ostatnia linia zabrania accepted shrink. Te same instrukcje są na CPU (`adaptive_dt.cpp:118-127`) i GPU (`rk_adaptive_runtime.cu:23-32`). `order_est` zapisany w tableau nigdy nie dociera do kontrolera.

Dla identycznej historii błędu RK23 i RK45 proponują ten sam współczynnik, mimo różnych rzędów estymatora. To jest nadal aktywny finding `FEM-TD-NUM-RK-002`.

Przykład:

| `prev_eta` | `eta` | obecny surowy ratio | obecny po clamp | order-aware RK23 | order-aware RK45 |
|---:|---:|---:|---:|---:|---:|
| 0.1 | 0.9 | 0.402 | 1.000 | ok. 0.679 | ok. 0.760 |
| 1.0 | 0.5 | 1.929 | 1.929 | ok. 1.058 | ok. 0.992 |

Pierwszy wiersz pokazuje dokładnie potrzebę accepted shrink. Drugi pokazuje nadmierny wzrost, szczególnie dla RK45.

### 4.9 Akceptacja, rollback i commit

Przy zwykłym odrzuceniu embedded error CPU poprawnie odtwarza `m_backup`, zmniejsza `dt`, unieważnia FSAL i ponawia (`rk_explicit_step.cpp:212-248`). GPU ma odpowiednią pętlę retry.

Brakuje jednak pełnej atomowości na ścieżkach innych błędów:

- CPU zapisuje kandydata `m` przed końcowym odświeżeniem `H_eff`; zwykły błąd tego odświeżenia nie robi rollbacku, choć `time/step` nie są jeszcze commitowane (`rk_explicit_step.cpp:197-205,268-292`).
- GPU również może mieć zapisany kandydat przed awarią final refresh/statystyk.

Nie jest to przyczyna stabilnego przebiegu bez błędów, ale pojedyncza awaria demag/CUDA może pozostawić niespójny runtime.

### 4.10 Energia

Po zaakceptowanym kroku runtime sumuje:

```text
E_total = E_exchange + E_demag + E_external + E_drive
        + E_anisotropy + E_DMI + E_magnetoelastic
```

oraz publikuje `max|H_eff|`, `max|H_demag|`, `max|dm/dt|` i `max|m×H_eff|`: `backends/fem/cpu/mfem/runtime/step_metrics.cpp:105-137`.

Nie znalazłem potwierdzonego błędu znaku w tej sumie dla badanego zestawu interakcji. Znaleziony problem w aktualnym zarządzanym gate dotyczy driftu testu source-contract po uogólnieniu redukcji energii zewnętrznej na external+drive; sam w sobie nie dowodzi złej wartości energii.

Najważniejsza luka: nie istnieje tryb akceptacji „dyssypacyjny/autonomiczny”, który dla run bez drive/STT/thermal odrzucałby krok z istotnym `E_{n+1}>E_n`. Taki guard musi być warunkowy — nie wolno go stosować do wymuszanej dynamiki.

### 4.11 Demagnetyzacja

W kilku ścieżkach Hypre kod:

1. wykonuje `solver->Mult(...)`;
2. pobiera `iterations` i `final_residual`;
3. zapisuje telemetrię;
4. zwraca sukces bez porównania residualu z tolerancją i bez sprawdzenia osiągnięcia limitu iteracji.

Dowody:

- CPU Poisson Hypre: `backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp:347-378`;
- CPU okresowy reduced: `demag_poisson_periodic.cpp:198-221`;
- GPU Hypre: `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp:220-238`.

To jest finding `FEM-TD-NUM-DEMAG-001`, nadal obecny w kodzie. W badanym przykładzie użytkownik żąda `rtol=1e-12` i maksymalnie 500 iteracji. Jeżeli solver nie osiąga tej tolerancji, Fullmag obecnie nie failuje. Bez logu residualu nie da się stwierdzić, czy ryzyko zostało aktywowane w konkretnym przebiegu, ale mechanizm jest realny i musi być usunięty.

### 4.12 Przekazanie stanu `minimize -> run`

Nie znalazłem błędu transferu dla deklaratywnego pipeline użytego w przykładzie:

- `add_minimize` i `add_run` tworzą kolejne stages;
- orchestrator przed następnym etapem wstrzykuje końcowe `m` poprzedniego etapu: `crates/fullmag-cli/src/orchestrator.rs:6592-6640`;
- po etapie zachowuje finalną magnetyzację: `orchestrator.rs:7249-7251`;
- helper obsługuje single magnet i shared-domain FEM: `crates/fullmag-cli/src/step_utils.rs:3030-3097`.

Nie potwierdzam wycieku czasu lokalnego relaksacji do run. Direct minimizer nie ma fizycznego czasu trwania; etap run zaczyna własny zegar zgodnie z pipeline.

Oddzielny problem istnieje wyłącznie dla bezpośredniego, in-process `fm.relax(); fm.run()` poza loader capture: `run()` może ponownie zbudować authored initial `m`. Nie dotyczy to analizowanego staged Study.

## 5. Dlaczego ten przykład jest szczególnie sztywny

### 5.1 Szacunek skali wymiany

Dla najmniejszego rozmiaru `h=0.5 nm` można oszacować charakterystyczne pole wymiany:

\[
H_\mathrm{ex}\sim\frac{2A}{\mu_0 M_s h^2}.
\]

Dla `A=13e-12 J/m`, `Ms=800e3 A/m`:

```text
H_ex ~ 1.03e8 A/m
```

Dla `g=2.115` Fullmag wylicza:

```text
gamma_mu0 ~ 2.337e5 m/(A s)
omega_ex  ~ 2.42e13 1/s
1/omega   ~ 4.14e-14 s
period    ~ 2.60e-13 s
```

To jest szacunek rzędu wielkości, nie certyfikowany największy eigenvalue konkretnej macierzy FEM. Stała spektralna zależy od jakości elementów, operatora masy, warunków okresowych i lokalnej geometrii. W praktyce najmniejszy stabilny krok może być jeszcze mniejszy.

Nota projektu sama ostrzega, że exchange na drobnej siatce FEM daje surowe ograniczenie `dt ~ C h²/A` i że planner powinien ostrzegać o silnej sztywności: `docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md:287-301`. Planner obecnie nie wykonuje takiego testu.

### 5.2 Niezależny liniowy orakel RK45

Zbudowano diagnostyczny model jednego szybkiego, liniowego modu poprzecznego wokół stanu równowagi:

\[
\dot z=\lambda z,\qquad
\lambda=\frac{-\alpha+i}{1+\alpha^2}\omega_\mathrm{ex}.
\]

Użyto dokładnych współczynników Dormand–Prince z `rk45.cpp`, bieżącego kontrolera PI, `alpha=0.02`, `atol=1e-6`, `rtol=1e-3` i początkowej amplitudy `|z|=1e-8`.

Pierwsze zaakceptowane kroki:

| krok | `dt` | `eta` | `|z|` przed | `|z|` po | przyrost energii modu `~|z|²` | następny `dt` |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | `1e-13` | `8.12e-7` | `1.00e-8` | `1.074e-8` | `×1.15` | `2e-13` |
| 2 | `2e-13` | `4.58e-5` | `1.074e-8` | `1.321e-7` | `×151` | `4e-13` |
| 3 | `4e-13` | `4.99e-2` | `1.321e-7` | `1.553e-4` | `×1.38e6` | `4e-13` |

Wszystkie trzy kroki mają `eta<1`, więc są akceptowane. Rozwiązanie dokładne powinno maleć. Po 20 zaakceptowanych i 7 odrzuconych próbach model miał `|z|≈4.3e-3` po około `2.3 ps`, zamiast zanikać.

To nie jest pełny reproducer konkretnej siatki MFEM. Jest to kontrolowany orakel mechanizmu i dowód, że obecne kryterium akceptacji może uznać za poprawny jawnie niestabilny wzrost małego modu. Powód: błąd embedded jest dzielony przez około `1e-3`, bo całe `m` ma normę 1, choć destabilizowana amplituda wynosi początkowo `1e-8`.

## 6. Rejestr findingów Fullmag

| ID | Priorytet | Status | Finding | Wpływ na badany przypadek |
|---|---|---|---|---|
| `LLG-TD-API-001` | P0 | potwierdzony | `max_error` ustawia tylko `atol`; ukryte `rtol=1e-3` dominuje skalę | bezpośredni |
| `LLG-TD-TIME-002` | P0 | potwierdzony | brak `dt_initial`/równość z `dt_min` staje się `1e-13`; brak `dt_max` staje się `1e-10` | bezpośredni |
| `LLG-TD-STAB-003` | P0 | proven-by-oracle | adaptive error dopuszcza jawnie niestabilny wzrost małych szybkich modów | bezpośredni |
| `LLG-TD-CTRL-004` | P1 | potwierdzony | PI ignoruje `order_est`; accepted step nie może zmniejszyć `dt` | bezpośredni |
| `LLG-TD-GUARD-005` | P1 | potwierdzony | FEM nie obsługuje rotation/norm guardów ani stabilności/energy guard | bezpośredni |
| `LLG-TD-DEMAG-006` | P1 | potwierdzony | niezbieżny solve demag może zostać opublikowany jako sukces | możliwy, wymaga residualu z run |
| `LLG-TD-NORM-007` | P1 | potwierdzony | normalizacja stage akceptuje zero/nonfinite | ścieżka awarii |
| `LLG-TD-ATOMIC-008` | P1 | potwierdzony | niepełny rollback przy błędzie final refresh/statystyk | ścieżka awarii |
| `LLG-TD-API-009` | P1 | potwierdzony | pełne adaptive istnieje w modelu, lecz nie w `StudyBuilder.solver()` | blokuje bezpieczną konfigurację przykładu |
| `LLG-TD-OBS-010` | P1 | potwierdzony | staged Study domyślnie nie zapisuje outputs; przykład ma telemetry zakomentowane | utrudnia diagnozę i kwalifikację |
| `LLG-TD-TEST-011` | P1 | potwierdzony | canonical gate nie obejmuje adaptive contract i obecnie nie jest zielony | brak dowodu produkcyjnego |
| `LLG-TD-RELAX-012` | P2 | konfiguracja | `tol=500 A/m`, `max_steps=500` nie certyfikuje bardzo ścisłej równowagi | może zasiać szybkie residual modes |
| `LLG-TD-PERF-013` | P2 | potwierdzony | GPU nie wykorzystuje FSAL w pełni i ponownie liczy final RHS/demag | koszt, nie źródło złej fizyki |

### 6.1 Interpretacja P0

P0 nie oznacza, że każdy przypadek RK45 zawsze się rozbiegnie. Oznacza, że obecny publiczny zestaw parametrów i resolver może akceptować przebieg sprzeczny z prawem dyssypacji bez ostrzeżenia, a dokładny badany zestaw jest w obszarze podwyższonego ryzyka sztywności.

### 6.2 Relaksacja jako czynnik wtórny

`tol=500 A/m` jest bardzo luźne względem kanonicznego defaultu direct minimization `1e-4 A/m`. Użytkownik może wizualnie widzieć „perfekcyjnie zrelaksowany” stan, który nadal ma małe, wysoko-częstotliwościowe składowe torque. Poprawne LLG powinno je wygasić. Wadliwy jawny solver może je zamiast tego selektywnie wzmocnić.

To czyni luźny stop czynnikiem inicjującym, ale nie usprawiedliwia wzrostu energii.

## 7. Porównanie z COMSOL

COMSOL jest tu traktowany jako niezależny wzorzec semantyki i ergonomii solvera, nie jako dowód, że Fullmag powinien kopiować konkretny algorytm.

Oficjalne źródła:

- [Micromagnetic Simulation with COMSOL Multiphysics](https://www.comsol.com/blogs/micromagnetic-simulation-with-comsol-multiphysics) — jednostkowe `m`, równanie Gilberta, `H_eff` z wariacji energii; opisuje model zbudowany w Physics Builder, nie należy go przedstawiać jako dowodu defaultu specjalizowanego, wbudowanego interfejsu micromagnetycznego.
- [COMSOL 6.4 Time-Dependent Solver](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_solver.36.139.html) — implicit BDF/generalized-alpha oraz explicit RK, tolerancje, initial/max step, PI i clamps.
- [COMSOL 6.4 Time Dependent study](https://doc.comsol.com/6.4/doc/com.comsol.help.comsol/comsol_ref_solver.36.017.html) — rozdzielenie output times od kroków solvera.
- [COMSOL 6.3 About the Time-Dependent Solver](https://doc.comsol.com/6.3/doc/com.comsol.help.comsol/comsol_ref_solver.36.120.html) — norma błędu i własności metod implicit/explicit.

| Obszar | COMSOL | Fullmag FEM | Ocena |
|---|---|---|---|
| LLG i `|m|=1` | Gilbert, jednostkowe `m`, damping do minimum | ta sama postać po algebraicznym rozwiązaniu Gilberta | zgodne |
| Domyślna rodzina czasu | implicit jest defaultem ogólnego solvera; BDF/generalized-alpha | produkcyjny run FEM używa jawnych Heun/RK/RK embedded | luka dla sztywnego exchange |
| RK45 | Dormand–Prince 5 z PI | Dormand–Prince 5(4) | tableau zgodne |
| Tolerancje | względna i absolutna są osobnymi, widocznymi kontrolami | model ma oba, convenience API ukrywa `rtol` za `max_error` | błąd API Fullmag |
| Initial step | automatyczny albo jawny | brak staje się sentinelem i `1e-13` | utrata intencji |
| Maximum step | automatyczny albo jawny constraint | model ma, flat Study nie udostępnia; default runner `1e-10` | niebezpieczne na fine FEM |
| PI controller | wybór Quick/Smooth/Disabled; zależność od estymatora | stałe 0.7/0.4 dla RK23/RK45 | błąd numeryczny Fullmag |
| Zmiana kroku | min growth ratio default 0.2, max default 10; accepted step może być mniejszy | accepted ratio clampowane do `>=1` | błąd Fullmag |
| Safety | jawny, default 0.9 | jawny w modelu, ukryty w flat Study, default 0.9 | częściowo zgodne |
| Sztywność | implicit default; explicit może korzystać z lokalnej skali elementu | brak stiff warning i brak ogólnego implicit run | luka architektury |
| Output | output times nie muszą być krokami solvera | architektura rozdziela sampling, lecz przykład wyłączył wszystko | koncepcyjnie zgodne, słaba observability |

Najistotniejsza różnica nie brzmi „COMSOL ma lepszy RK45”. COMSOL daje użytkownikowi jawny kontrakt tolerancji i ograniczeń oraz oferuje implicit lane dla sztywnych problemów. Fullmag ma poprawne tableau, ale słaby resolver, kontroler i brak stabilnościowej kwalifikacji.

## 8. Porównanie z lokalnym TetraX

Lokalne źródło to `external_solvers/tetrax`, wersja `2.0.0` (`tetrax/_version.py:9`). TetraX jest użyteczny jako niezależne porównanie równań i interakcji, ale nie jest wiarygodnym złotym standardem adaptacyjnej relaksacji czasu.

### 8.1 Równanie i jednostki

TetraX używa bezwymiarowego pola `h=H/Ms_avg` i czasu

\[
\tau=\gamma_e\mu_0 M_{s,avg}t.
\]

Jego RHS w `tetrax/experiments/_relax_dynamic/integrate_llg.py:25-42,143-150` po powrocie do sekund jest równoważny Fullmag:

\[
\frac{d\mathbf m}{dt}
=-\frac{\gamma_e\mu_0}{1+\alpha^2}
[\mathbf m\times\mathbf H+\alpha\mathbf m\times(\mathbf m\times\mathbf H)].
\]

Różnica defaultu `gamma` to około 0.08%, nie błąd znaku ani jednostek.

### 8.2 Potwierdzone problemy w TetraX

1. `solve_ivp(..., t_span=[0,dt])` zwraca punkty wybrane wewnętrznie przez solver, lecz kod bierze `sol.y[:,1]` zamiast stanu końcowego `sol.y[:,-1]`, po czym zwiększa zegar o całe `dt`: `integrate_llg.py:173-177`.
2. Nie sprawdza `sol.success`, `sol.status` ani `sol.message`.
3. Liczy `abs(max(m_new-m_old))` zamiast `max(abs(m_new-m_old))`: `integrate_llg.py:182`. Duża zmiana ujemna może zostać ukryta.
4. Kryterium stopu jest przyrostem stanu zależnym od `dt`, nie `max|m×H_eff|` ani normą RHS.
5. Zewnętrzna „adaptacja” tylko dzieli `dt` przez 2, gdy przyrost wzrósł w punkcie logowania; nie ma rollbacku/retry, `dt_min` ani wzrostu kroku: `integrate_llg.py:219-222`.
6. Relaksacja nazywana „over-damped” zachowuje precesję. Dla default `alpha=1` współczynniki precesji i damping są równe. To nie jest odpowiednik Fullmag `llg_overdamped`, który jawnie ustawia `precession_enabled=false`.
7. Domyślna ścieżka `verbose=True` mnoży tuple zwrócone przez `torques()` przez scalar i może zakończyć się `TypeError`: `integrate_llg.py:45-54,203-213`.

Oficjalna dokumentacja SciPy potwierdza, że:

- przy `t_eval=None` solver sam wybiera zwracane punkty i stan końcowy jest ostatnią kolumną: [SciPy solve_ivp](https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html);
- SciPy RK45 to Dormand–Prince 5(4), z defaultami `rtol=1e-3`, `atol=1e-6`: [SciPy RK45](https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.RK45.html).

Wniosek porównawczy: TetraX potwierdza fizykę równania, ale jego `relax_dynamic` ma własne poważne błędy czasu i stopu. Nie wolno używać go jako bezpośredniego orakla adaptacyjnego przebiegu Fullmag bez wcześniejszej naprawy.

## 9. Rozbieżności między backendami Fullmag

Dokładny przypadek jest FEM, ale publiczne parametry powinny mieć jedną semantykę. Obecnie jej nie mają.

### 9.1 FDM CPU

- kontroler jest order-aware i pozwala na accepted shrink, więc pod tym względem jest lepszym punktem odniesienia niż FEM;
- jednak przy `dt_min` może wymusić akceptację kroku z błędem ponad tolerancją;
- `max_spin_rotation` i `norm_tolerance` są cicho pomijane przez runner.

### 9.2 FDM CUDA

ABI przekazuje głównie `adaptive_max_error`, `dt_min`, `dt_max`, `headroom`. Gubi:

- `rtol`;
- `growth_limit`, `shrink_limit`;
- `max_spin_rotation`, `norm_tolerance`.

Kernel używa absolutnego błędu i także może force-accept przy `dt_min`: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu:101-125`.

Batch CUDA dodatkowo nie przenosi `suggested_next_dt` między zaakceptowanymi krokami, podczas gdy interactive runtime to robi.

### 9.3 Multilayer CUDA

Adaptive może być zaakceptowane wyżej, lecz zgubione podczas materializacji planu native multilayer. Capability matrix deklaruje tylko fixed-step. Poprawne zachowanie powinno być fail-closed w plannerze, nie ciche usunięcie intencji.

### 9.4 Fixed RK23/RK45

W części single-grid FDM/internal lanes wybór `fixed_timestep` wraz z RK23/RK45 nadal uruchamia wewnętrzną pętlę adaptacyjną z fallbackowymi tolerancjami. To narusza kontrakt mówiący, że fixed i adaptive są rozłączne. Native FEM analizowanego przykładu rozróżnia je poprawniej, ale publiczna semantyka cross-backend pozostaje niespójna.

Te rozbieżności nie są główną przyczyną bieżącego FEM GPU run, lecz blokują deklarację jednej, kanonicznej semantyki solvera czasu.

## 10. Testy i dowody wykonane podczas audytu

### 10.1 Testy Python DSL

Uruchomiono wybrane testy mapowania `max_error`, `dt_min` i `dt_max`:

```text
3 passed, 249 deselected in 0.28s
```

Testy potwierdzają aktualne lowering/serialization, ale nie dowodzą poprawności numerycznej. Część z nich utrwala sentinel `dt_initial==dt_min`.

### 10.2 Eksport konfiguracji

- eksport wariantu z `HEAD` potwierdził `atol=1e-6`, `rtol=1e-3`, `dt_initial=dt_min=1e-16`, brak `dt_max` i brak outputs;
- eksport aktualnego working tree kończy się `TypeError` dla nieobsługiwanego `dt_max`.

### 10.3 Zarządzany gate native FEM

Zgodnie z `AGENTS.md` użyto repozytoryjnego, kontenerowego:

```text
just verify-fem-time-domain-native-contract
```

Build i wcześniejsze kontrakty przeszły, lecz cały gate zakończył się błędem:

```text
FAIL: GPU CUDA RK external final energy reductions source must own
external energy validation, launch, and scalar slot
```

Test `source_facade_gpu_rk_contract.cpp:776-794` oczekuje starego, dokładnego tekstu i jawnej walidacji `H_ext`. Implementacja `rk_external_energy_reductions.cu:43-91` została uogólniona na external+regional drive i ma inny komunikat. To wygląda głównie na drift source-contract, choć brak jawnej walidacji wskaźników pola wymaga osobnego review.

Wniosek: aktualny `HEAD` nie ma zielonego kanonicznego gate czasu. Nie należy przedstawiać tego wyniku jako dowodu błędnej energii; jest to dowód braku pełnej kwalifikacji.

### 10.4 Adaptive contract

`fem_adaptive_dt_contract` istnieje w CMake, ale nie jest budowany ani wykonywany przez `verify-fem-time-domain-native-contract` (`justfile:158-160`).

Ukierunkowane uruchomienie executable zbudowało się, lecz test zakończył się na próbie odczytu:

```text
/docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md
```

`repo_root()` w `backends/fem/tests/adaptive_dt_contract.cpp:66-68` wchodzi o jeden poziom za wysoko. Wcześniejsze asercje kontrolera przeszły, ale same utrwalają „accepted step grows” i nie testują accepted shrink ani zależności od rzędu (`:139-191`).

### 10.5 Czego nie wykonano

Nie wykonano pełnego 0.5 ns przebiegu dokładnej geometrii na zarządzanym GPU, ponieważ aktualny plik roboczy nie przechodzi DSL, a audyt nie miał zmieniać kodu użytkownika. Nie ma więc dynamicznego artefaktu z dokładną historią `E(t), dt(t), eta(t), residual_demag(t)`. Mechanizm rozbieżności jest potwierdzony statycznie i niezależnym oraklem, ale aktywacja demag nonconvergence w konkretnym run pozostaje do rozstrzygnięcia telemetrią.

## 11. Braki testowe

Brakuje następujących testów produkcyjnych:

1. direct minimize → time evolution, bez drive/STT/thermal, z weryfikacją `E_{n+1}<=E_n+budget`;
2. ten sam test dla `alpha={0.1,1,10}` oraz Heun/RK4/RK23/RK45 na CPU/GPU FP64;
3. stiff exchange mode na fine FEM, który przy obecnym kontrolerze reprodukuje zaakceptowany wzrost;
4. order-aware controller test: identyczne `eta` musi dawać inne ratio dla RK23 i RK45;
5. accepted shrink przy `eta<1`, lecz ratio<1;
6. rozróżnienie omitted `dt_initial` od jawnego `dt_initial==dt_min`;
7. `dt_initial` spoza `[dt_min,dt_max]` i `safety=1.0`;
8. norm/rotation guard CPU/GPU;
9. zero, subnormal, `NaN`, `Inf` na każdym stage z bitowym rollbackiem `m/time/step`;
10. fail-closed demag przy `max_iterations=1` i residualu ponad tolerancją;
11. pełny trace `dt`, `eta`, reject count, energy terms, torque i demag residual;
12. convergence-order RK23/RK45 pod normalizacją i projekcją okresową;
13. parity publicznego AdaptiveTimestep między FDM CPU, FDM CUDA, FEM CPU i FEM GPU;
14. test, że `fixed_timestep` jest naprawdę fixed na każdej deklarowanej lane;
15. end-to-end staged continuation z resetem zegara fizycznego i zachowaniem finalnego `m`.

## 12. Zalecenia doraźne dla użytkownika

### 12.1 Nie używać `max_error` jako jedynego parametru jakości

`max_error=1e-6` nie daje żądanej dokładności. Dopóki API nie zostanie naprawione, nie należy traktować tej nazwy jako gwarancji.

### 12.2 Aktualna ręczna konfiguracja wymaga zmiany powierzchni API

Wpisanie `atol`, `rtol`, `dt_max`, `growth_limit` bezpośrednio do `study.solver(...)` obecnie nie działa. Są dwie uczciwe ścieżki tymczasowe:

1. dla dokładnego FEM staged Study użyć jednoznacznego fixed-step RK4 i zrobić sweep `dt`, np. `dt`, `dt/2`, `dt/4`, aż energia i observables się zbiegną;
2. zbudować problem przez niższy model `TimeEvolution(dynamics=LLG(adaptive_timestep=AdaptiveTimestep(...)))`, który przyjmuje pełne pola, pamiętając, że wady kontrolera i brak guardów nadal pozostają.

Nie należy podawać jednej „magicznej” wartości `dt` jako certyfikowanej bez estymacji największej wartości własnej konkretnego operatora. `1e-15 s` jest rozsądnym punktem startowym do sweepu dla tego przykładu, nie dowodem stabilności.

### 12.3 Nie zwiększać `alpha` jako substytutu stabilnego integratora

Dla fizycznej dynamiki należy zachować fizyczne `alpha`. Jeśli celem jest tylko dalszy spadek energii, właściwym narzędziem jest etap relaksacji/direct minimization albo dedykowany pure-damping integrator, nie arbitralnie duże `alpha` w run.

### 12.4 Zaostrzyć certyfikat relaksacji

Przed run:

- wymagać statusu `converged`, nie tylko zakończenia po 500 krokach;
- znacząco obniżyć `tol` i wykonać sweep tolerancji;
- zapisać końcowe `max|m×H_eff|` i wszystkie składowe energii.

### 12.5 Włączyć telemetrię

Minimalny zapis dla każdego zaakceptowanego kroku lub kontrolowanego podpróbkowania:

```text
t
accepted_dt
suggested_dt
embedded_eta
rejected_attempts
E_total
E_exchange
E_demag
E_external
max|m×H_eff|
max|dm/dt|
demag_iterations
demag_residual
```

Bez tych danych „energia rośnie” nie pozwala rozdzielić niestabilności RK, niezbieżnego demag i błędu raportowania.

## 13. Plan napraw produkcyjnych

### Faza 0 — fail-safe i observability

1. Dodać typowany trace accepted/rejected adaptive steps.
2. Publikować requested/resolved `dt_initial`, `dt_min`, `dt_max`, `atol`, `rtol`, controller, integrator order.
3. Failować przy nonfinite `m`, RHS, error norm i energii.
4. Failować przy niezbieżnym solve demag; residual i limit iteracji muszą być częścią błędu.
5. Naprawić current source-contract gate i włączyć `fem_adaptive_dt_contract` do zarządzanego recipe.

**Exit gate:** żaden run nie może publikować accepted state po nonfinite lub niezbieżnym solve; trace pozwala odtworzyć każdą decyzję kroku.

### Faza 1 — semantyka API i IR

1. Zastąpić `max_error` jawnie nazwanymi `atol` i `rtol`; legacy alias może być tylko deprecated i musi ustawiać obie wartości według udokumentowanej reguły.
2. Udostępnić w `StudyBuilder.solver()` pełny `AdaptiveTimestep` albo przyjmować jeden obiekt zamiast rosnącej listy kwargs.
3. Zachować `dt_initial=None` w IR; nie używać wartości liczbowej jako sentinela.
4. Walidować wszystkie liczby i relacje:
   - finite i dodatnie;
   - `dt_min <= dt_initial <= dt_max`;
   - `0<safety<=1` w każdym layer;
   - `0<shrink<1<growth`.
5. Fail-closed dla pól nieobsługiwanych przez wybrany backend.

**Exit gate:** round-trip omitted/equal/distinct oraz identyczny resolved config na Python→IR→planner→runner→native.

### Faza 2 — wspólny, order-aware controller

1. Przekazać `order_est` do kontrolera.
2. Użyć wykładników skalowanych przez rząd, np. dla estymatora `q`:

   \[
   r=safety\,\eta_n^{-0.7/(q+1)}\eta_{n-1}^{0.4/(q+1)}.
   \]

   Dokładna konwencja `q` musi zostać raz zdefiniowana w nocie fizyczno-numerycznej i wspólna dla CPU/GPU.
3. Clampować accepted ratio do `[shrink_limit,growth_limit]`, nie `[1,growth_limit]`.
4. Na `dt_min` zwracać typed failure, jeżeli `eta>1`; nigdy force-accept.
5. Współdzielić test vectors między FEM CPU/GPU i FDM CPU/GPU.

**Exit gate:** identyczne historie controller decisions dla tych samych `eta`, z order-aware różnicą RK23/RK45 i accepted shrink.

### Faza 3 — guardy geometryczne i stabilnościowe

1. Mierzyć defekt normy przed projekcją.
2. Mierzyć maksymalny kąt `acos(clamp(m_n·m_{n+1}))`.
3. Odrzucać krok przekraczający guard niezależnie od embedded eta.
4. Dodać planner warning/limit z estymacji sztywności exchange i jakości siatki.
5. Dla autonomicznego trybu dyssypacyjnego dodać opcjonalny energy-descent guard z budżetem roundoff/solver tolerance.

**Exit gate:** liniowy stiff-mode oracle nie może zostać zaakceptowany przy wzroście amplitudy; poprawny wymuszany run nie może być fałszywie odrzucany przez energy guard.

### Faza 4 — demag i atomowość kroku

1. Każdy solver liniowy musi raportować converged/failure, nie tylko residual.
2. Accepted RK step musi być transakcją: `m`, pola, cache, czas, step count i statystyki commitują się razem.
3. Każdy błąd final refresh/statystyk przywraca pełny backup.
4. Wspólny demag residual gate CPU/GPU/periodic/hybrid.

**Exit gate:** fault injection pozostawia bitowo identyczny stan sprzed kroku; `max_iterations=1` kończy się przewidywalnym typed failure.

### Faza 5 — kwalifikacja naukowa

1. Macrospin z rozwiązaniem analitycznym.
2. Exchange-only eigenmode z przewidywaną częstotliwością i dampingiem.
3. Relax→run energy descent na reprezentatywnym FEM.
4. `alpha={0.1,1,10}` z poprawnym skalowaniem `alpha/(1+alpha²)`.
5. CPU/GPU FP64 parity.
6. Refinement w czasie i siatce.
7. Dokładny zredukowany przypadek periodic antidot.

**Exit gate:** wszystkie zarządzane recipes zielone; artefakty zawierają historię energii, kroku, błędu i residualu.

### Faza 6 — stiff solver lane

Jawny RK pozostanie użyteczny, ale fine FEM exchange wymaga docelowo implicit/geometric lane, np. tangent-plane lub innego integratora zachowującego strukturę. COMSOL pokazuje praktyczną wartość posiadania implicit BDF/generalized-alpha obok explicit RK. To jest rozwój architektury, nie zamiennik napraw faz 0–5.

## 14. Minimalne kryteria akceptacji poprawki

Naprawy nie należy uznać za zakończoną, dopóki jednocześnie nie są spełnione:

- `max_error` nie ukrywa `rtol` albo jest usunięty/deprecated z jednoznaczną migracją;
- `dt_initial=None` i `dt_initial=dt_min` dają różne, zgodne z intencją wyniki;
- pełny adaptive config jest dostępny w staged Study lub jawnie odrzucony;
- RK23/RK45 controller jest order-aware i pozwala na accepted shrink;
- nie ma force-accept przy `dt_min`;
- norm/rotation guard działa na FEM CPU/GPU;
- nonfinite i niezbieżny demag failują;
- step commit jest atomowy;
- managed time-domain gate zawiera adaptive contract i jest zielony;
- zredukowany przypadek relax→run ma malejącą energię w autonomicznym trybie oraz zbiega przy `dt/2` i `dt/4`;
- dokładny przykład zapisuje trace wystarczający do niezależnego odtworzenia decyzji solvera.

## 15. Ostateczna diagnoza badanego objawu

Najbardziej prawdopodobny łańcuch przyczynowy jest następujący:

```text
luźny końcowy residual po direct minimize
        ↓
małe szybkie mody wymiany na lokalnym h=0.5 nm
        ↓
brak dt → runtime startuje od 1e-13 s, nie 1e-16 s
        ↓
max_error=1e-6 → faktyczny scale około 1e-3
        ↓
RK45 akceptuje niestabilne wzmocnienie małego modu
        ↓
PI podwaja dt i nie pozwala na accepted shrink
        ↓
normalizacja zachowuje |m|=1, ale nie usuwa wzrostu energii modu
        ↓
E_exchange/E_total rośnie mimo alpha>0
```

Niezbieżny demag może ten przebieg dodatkowo pogorszyć, ale bez residual trace nie można go przypisać do konkretnego run. Błędny transfer stanu po relaksacji i błędny znak podstawowego LLG zostały wykluczone dla użytego staged FEM pipeline.

Najpierw należy naprawić semantykę tolerancji i startowego kroku, następnie controller/guardy, potem fail-closed demag i kwalifikację end-to-end. Samo zmniejszenie `dt` w przykładzie może ukryć objaw, ale nie naprawi publicznego kontraktu ani innych backendów.
