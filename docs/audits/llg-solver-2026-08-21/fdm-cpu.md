# Audyt solvera LLG — FDM CPU

**Audytowany commit:** `04e362df5dd51b1e6acca3aab9033c8124d3d6d0`  
**Data:** 2026-08-21  
**Werdykt:** **nie kwalifikować adaptacyjnego RK23/RK45 do produkcji przed naprawą P0**  
**Tryb dowodu:** statyczny audyt ścieżki Rust; bez benchmarku wall-clock

## 1. Zakres i mapa wykonania

Główna ścieżka:

```text
fullmag-plan / runner
  -> crates/fullmag-runner/src/fdm/cpu/reference.rs
  -> ExchangeLlgProblem
  -> crates/fullmag-engine/src/fdm/cpu/integrators.rs
  -> effective_field_* / llg_rhs_*
  -> crates/fullmag-engine/src/fdm/cpu/fields.rs
  -> FFT demag: crates/fullmag-engine/src/fdm/cpu/fft.rs
  -> observables / StepReport
```

Najważniejsze źródła:

- [`integrators.rs`](https://github.com/MateuszZelent/fullmag/blob/04e362df5dd51b1e6acca3aab9033c8124d3d6d0/crates/fullmag-engine/src/fdm/cpu/integrators.rs)
- [`shared/problem.rs`](https://github.com/MateuszZelent/fullmag/blob/04e362df5dd51b1e6acca3aab9033c8124d3d6d0/crates/fullmag-engine/src/fdm/shared/problem.rs)
- [`fields.rs`](https://github.com/MateuszZelent/fullmag/blob/04e362df5dd51b1e6acca3aab9033c8124d3d6d0/crates/fullmag-engine/src/fdm/cpu/fields.rs)
- [`fft.rs`](https://github.com/MateuszZelent/fullmag/blob/04e362df5dd51b1e6acca3aab9033c8124d3d6d0/crates/fullmag-engine/src/fdm/cpu/fft.rs)
- [`reference.rs`](https://github.com/MateuszZelent/fullmag/blob/04e362df5dd51b1e6acca3aab9033c8124d3d6d0/crates/fullmag-runner/src/fdm/cpu/reference.rs)

## 2. Podsumowanie ustaleń

| ID | Priorytet | Typ | Ustalenie |
|---|---:|---|---|
| `FDM-CPU-NUM-001` | **P0** | potwierdzony defekt | odrzucony RK23/RK45 nie zmniejsza `dt`, więc retry może nigdy się nie zakończyć |
| `FDM-CPU-TRX-001` | **P1** | potwierdzony defekt | termiczny licznik RNG jest zwiększany również po błędzie kroku |
| `FDM-CPU-PERF-001` | **P1** | potwierdzony koszt | runner wymusza `EvaluationRequest::Full` po każdym zaakceptowanym kroku |
| `FDM-CPU-PERF-002` | **P1** | potwierdzony koszt | klonowanie pól/stanu i materializacja dynamicznych źródeł występują w hot loop |
| `FDM-CPU-NUM-002` | **P1** | ryzyko numeryczne | normalizacja każdego etapu zmienia formalny integrator i estimator embedded |
| `FDM-CPU-PHY-001` | **P1** | ryzyko fizyczne | DMI na granicy maski/obiektu nie realizuje jawnego naturalnego warunku brzegowego |
| `FDM-CPU-PHY-002` | **P1** | potwierdzona niespójność | termika hot-path używa skalarnego `Ms/alpha`, mimo dostępnych pól przestrzennych |
| `FDM-CPU-ARCH-001` | **P1** | potwierdzona niespójność | AoS i SoA nie realizują identycznie DMI, termiki, STT/SOT i energii |
| `FDM-CPU-NUM-003` | **P2** | ryzyko numeryczne | ABM3 używa współczynników stałego kroku, choć historia przechowuje różne `dt` |
| `FDM-CPU-PERF-003` | **P2** | ograniczenie | tylko RustFFT, pełne zespolone bufory i brak wyspecjalizowanego planu vendor FFT |
| `FDM-CPU-QUAL-001` | **P2** | luka kwalifikacyjna | benchmarki `Minimal` nie mierzą produkcyjnej ścieżki `Full` |

## 3. Ustalenia szczegółowe

## FDM-CPU-NUM-001 — adaptacyjny RK23/RK45 może zawiesić solver

**Priorytet:** P0  
**Klasa:** potwierdzony defekt

### Dowód w kodzie

W implementacjach:

- `rk23_step_buf`;
- `rk23_step_soa_buf`;
- `rk23_step_soa_state_buf`;
- `rk45_step_buf`;
- `rk45_step_soa_buf`;
- `rk45_step_soa_state_buf`;

odrzucenie przebiega w przybliżeniu tak:

```rust
if error <= threshold {
    // accept
    return Ok(...);
}
if dt <= cfg.dt_min {
    return Err("dt_min_exhausted");
}
// koniec iteracji loop — dt pozostaje bez zmian
```

Kod oblicza nowy `ratio` tylko w gałęzi akceptacji. Nie ma `dt = dt_next` dla retry. W tym samym pliku istnieje poprawniejszy wspólny `decide_adaptive_step`, ale te ścieżki go nie wywołują.

### Skutek

Dla stabilnego, deterministycznego przypadku z:

```text
error > threshold
oraz
dt > dt_min
```

następna próba ma identyczne:

- `m_n`;
- `t_n`;
- `dt`;
- etapy RK;
- błąd.

Pętla nie może sama przejść do akceptacji ani `dt_min_exhausted`. Dla `NaN` porównanie `error <= threshold` jest fałszywe, a jeśli `dt > dt_min`, otrzymujemy ten sam rodzaj niekończącej się pętli.

### Naprawa

Wszystkie warianty powinny używać jednego kontrolera:

```rust
match decide_adaptive_step(order_est, dt, error, previous_error, cfg) {
    AdaptiveDecision::Accepted(dt_next) => { /* commit */ }
    AdaptiveDecision::Retry(dt_next) => {
        dt = dt_next;
        rejected += 1;
        continue;
    }
    AdaptiveDecision::DtMinExhausted => return Err(...),
}
```

Dodatkowo:

- jawnie odrzucać `!error.is_finite()`;
- ograniczyć `max_reject`;
- publikować trace każdej próby;
- nie duplikować regulatora w AoS/SoA.

### Test regresyjny

1. Sztuczny RHS wymuszający `error_norm = 4` przy `dt=1e-12`.
2. Sprawdzić, że druga próba ma `dt < 1e-12`.
3. Test z `NaN` musi kończyć się typed failure, nie timeoutem.
4. Uruchomić dla RK23/RK45 oraz AoS/SoA/state-SoA.
5. Dodać test timeoutowy, aby przyszły hang kończył CI.

---

## FDM-CPU-TRX-001 — licznik termiczny zmienia się po nieudanym kroku

**Priorytet:** P1  
**Klasa:** potwierdzony defekt atomowości

`ExchangeLlgProblem::step_with_buffers_evaluation` oraz odpowiednik SoA wykonują `advance_thermal_step()` po wywołaniu integratora bez warunku, że integrator zakończył się zaakceptowanym krokiem. Kontrakt solvera wymaga, aby jedna próba była transakcją:

```text
sukces -> dokładnie jeden commit
błąd   -> pełny rollback stanu, czasu, cache i RNG
```

### Skutek

Po błędzie pola, normalizacji, callbacku transportu lub adaptacji:

- magnetyzacja i czas mogą pozostać niezmienione;
- numer realizacji termicznej zostaje przesunięty;
- ponowienie z checkpointu generuje inną trajektorię;
- nieudana operacja zmienia późniejszy wynik naukowy.

### Naprawa

- `advance_thermal_step()` przenieść do gałęzi commit po `Ok(report)`;
- dla integratorów coupled zachować istniejący jawny `commit_coupled_imex_ark2_step`;
- snapshotować/odtwarzać FSAL i historię ABM razem z RNG;
- dodać invariant: `failed_step => serialized_state_before == serialized_state_after`.

---

## FDM-CPU-PERF-001 — pełne obserwable wymuszają dodatkową ewaluację pola

**Priorytet:** P1  
**Klasa:** potwierdzony koszt hot loop

Produkcja w `reference.rs` przekazuje `EvaluationRequest::Full`, podczas gdy benchmarkowe ścieżki używają `Minimal`. Po zaakceptowaniu integratora `compute_step_observables_*` ponownie składa pola oraz energie. Dla aktywnego demag oznacza to kolejną konwolucję FFT poza ewaluacjami RHS.

### Koszt według integratora

Bez FSAL i bez termiki typowa liczba kosztownych ewaluacji pola na zaakceptowany krok jest co najmniej:

| Integrator | RHS etapowe | dodatkowe obserwable | Razem |
|---|---:|---:|---:|
| Heun | 2 | 1 | 3 |
| RK4 | 4 | 1 | 5 |
| RK23 | 4 | 1 | 5 |
| RK45 | 6–7 | 1 | 7–8 |

Przy demag każda taka ewaluacja niesie FFT magnetyzacji, mnożenie tensorowe i inverse FFT. Pełne energie są liczone nawet wtedy, gdy:

- output ma stride większy niż 1;
- stop criterion używa tylko momentu;
- użytkownik nie zamówił tabeli energii;
- krok jest częścią długiej sekcji bez snapshotu.

### Naprawa

Wprowadzić bitmaskę:

```rust
EvaluationRequest {
    need_rhs_max,
    need_h_eff_max,
    need_energy_terms,
    need_demag_field,
    need_snapshot,
    need_provenance_sample,
}
```

oraz harmonogram:

```text
co krok: finite/norm/control metrics
co N kroków: lekkie stop metrics
zgodnie z output stride: pełne energie i pola
```

Końcowy `H_eff` FSAL można zachować jako cache; nie należy go od razu przeliczać drugi raz.

---

## FDM-CPU-PERF-002 — klony i materializacja źródeł w gorącej pętli

**Priorytet:** P1  
**Klasa:** potwierdzony koszt pamięci i alokatora

W `reference.rs` występują m.in.:

- `previous_magnetization = state.magnetization().to_vec()` na krok;
- `Some(field.clone())` dla dynamicznych pól;
- ponowna materializacja anten/Oersteda;
- pełne klony stanu i workflow w adaptacji transportu przez step-doubling;
- tworzenie artefaktów/checkpointów bez całkowitego oddzielenia od solver hot loop.

### Skutek

Dla dużej siatki koszt staje się kombinacją:

```text
FFT + O(N) kopiowanie magnetyzacji + O(N) pole dynamiczne + serializacja/output
```

co utrudnia skalowanie Rayon i powoduje presję na bandwidth/NUMA.

### Naprawa

- dwa prealokowane bufory magnetyzacji i `swap`;
- dynamiczne pole w buforze owned-by-runtime z wersją czasu;
- żadnego `Vec::clone` w pętli kroków;
- oddzielny output worker otrzymujący immutable snapshot tylko zgodnie ze stride;
- step-doubling wykonywać na prealokowanych stanach próbnych;
- licznik alokacji na zaakceptowany krok jako gate CI (`0` po warm-up).

---

## FDM-CPU-NUM-002 — projected RK nie ma potwierdzonego deklarowanego rzędu

**Priorytet:** P1  
**Klasa:** ryzyko numeryczne

Każdy etap Heun/RK4/RK23/RK45 jest normalizowany przez `normalized(...)`. To zachowuje geometrię sfery, ale zmienia tablicę Butchera jako faktycznie wykonywaną metodę. Embedded error jest kombinacją pochodnych policzonych w projektowanych punktach.

### Ryzyka

- obserwowany rząd może być niższy od deklarowanego;
- regulator błędu może systematycznie niedoszacować błędu fazy;
- CPU, GPU i FEM mogą różnić się kolejnością „kombinacja → projekcja → RHS”;
- silne momenty bezpośrednie mogą zwiększać wpływ projekcji.

### Wymagana decyzja projektowa

Nie rekomenduje się prostego usunięcia normalizacji. Należy:

1. dodać `projection_policy` do requested/resolved plan;
2. zdefiniować, czy kontrolowany jest błąd przed, czy po projekcji;
3. sprawdzić zbieżność makrospinu i spin-wave phase error;
4. rozważyć integrator tangent-plane/geometric dla ścieżki kwalifikowanej.

---

## FDM-CPU-PHY-001 — warunek brzegowy DMI jest niejawnie zastąpiony zerową różnicą

**Priorytet:** P1  
**Klasa:** ryzyko fizyczne

W obliczeniu DMI brakujący lub nieaktywny sąsiad jest zastępowany spinem centralnym. Powoduje to zerowy wkład po brakującej stronie w różnicy centralnej. Nie jest to jawna implementacja naturalnego warunku brzegowego wynikającego z wariacji energii DMI.

### Skutek

- zewnętrzna krawędź obiektu i wewnętrzna krawędź maski są traktowane podobnie;
- boundary twist może mieć błędną amplitudę lub znak;
- interfacial i bulk DMI mogą nie być zgodne z FEM weak form;
- CPU/GPU mają różne korekty brzegowe.

### Naprawa i oracle

- wyprowadzić ghost spin z naturalnego BC dla wybranej konwencji DMI;
- rozróżnić physical boundary, inactive void, inter-material interface i PBC;
- dodać 1D/2D analityczny boundary-twist test;
- sprawdzić wariacyjną zgodność `-mu0 Ms H_DMI = delta E / delta m`.

---

## FDM-CPU-PHY-002 — termika nie korzysta konsekwentnie z lokalnego `Ms/alpha`

**Priorytet:** P1  
**Klasa:** potwierdzona niespójność modelu materiałowego

Gorąca ścieżka termiczna skaluje wariancję przez skalarne parametry materiału, podczas gdy LLG, exchange lub inne operatory potrafią odczytywać pola przestrzenne. Dla heterostruktury z `Ms_field` albo `alpha_field` powstaje hybrydowy model:

```text
LLG damping: lokalny alpha
thermal covariance: globalny alpha/Ms
```

Fluctuation–dissipation wymaga użycia tej samej lokalnej wartości tłumienia i momentu, która występuje w równaniu ruchu.

### Naprawa

Termiczny sampler powinien otrzymywać per-cell:

```text
Ms_i, alpha_i, V_i, dt, T_i
```

oraz wspólny counter-based RNG. Test powinien porównać wariancję w dwóch regionach o różnych `Ms/alpha`.

---

## FDM-CPU-ARCH-001 — AoS i SoA nie są równoważnymi implementacjami fizyki

**Priorytet:** P1  
**Klasa:** potwierdzona niespójność architektoniczna

SoA jest traktowana jako fast path, ale część implementacji korzysta w niej z parametrów skalarnych lub osobnych funkcji dla:

- DMI;
- thermal;
- STT/SOT;
- energii;
- niektórych pól materiałowych.

Fast-path guard zmniejsza zakres ekspozycji, ale nie stanowi dowodu równoważności. Dwa layouty nie powinny posiadać niezależnej semantyki fizycznej.

### Naprawa

- wspólne scalar accessors i wspólne formuły, różni się tylko layout;
- jeden zestaw property tests AoS ↔ SoA dla losowych aktywnych masek i pól materiałowych;
- fast path wybierać dopiero po capability proof;
- provenance powinno publikować `layout=aos|soa`.

---

## FDM-CPU-NUM-003 — ABM3 nie wykorzystuje zapisanej historii kroku

**Priorytet:** P2  
**Klasa:** ryzyko numeryczne

`abm_history.push(..., dt)` przechowuje `dt`, lecz predictor/corrector zawsze stosuje stałokrokowe współczynniki:

```text
AB3:  23/12, -16/12, 5/12
AM3:   5/12,   8/12, -1/12
```

Nie ma sprawdzenia, że trzy poprzednie kroki są równe bieżącemu. Zmiana `dt` przez użytkownika, podział etapu, skrócenie ostatniego kroku albo restart z innym `dt` narusza założenia metody.

### Naprawa

Albo:

- odrzucać zmianę `dt` i restartować historię przez Heun;
- albo zastosować współczynniki variable-step Adams;
- w provenance zapisać kroki historii.

Dodatkowo w pełnym kroku do historii trafia RHS predykowanego punktu `f_star`, a nie ponownie policzony RHS skorygowanego zaakceptowanego stanu. To wariant PECE, który musi być jawnie udokumentowany i zakwalifikowany.

---

## FDM-CPU-PERF-003 — demag CPU jest ograniczony do RustFFT

**Priorytet:** P2  
**Klasa:** ograniczenie architektury wydajnościowej

`CpuFftBackend` wybiera RustFFT. Konwolucja używa powiększonej siatki i wielu pełnych buforów zespolonych. Brak:

- FFTW/MKL backendu;
- planowania NUMA/thread affinity;
- real-to-complex storage reduction;
- wisdom/plan cache zależnego od topologii;
- rozdzielenia small-grid i large-grid strategy.

### Zalecenie

Wprowadzić backend FFT jako resolved capability:

```text
rustfft_serial | rustfft_parallel | fftw_threads | mkl_dfti
```

Benchmarkować osobno:

- forward FFT/s;
- inverse FFT/s;
- GB/s pakowania i rozpakowania;
- całkowity demag RHS/s;
- scaling 1/2/4/8/16 rdzeni;
- first-step plan cost i steady state.

---

## FDM-CPU-QUAL-001 — benchmark nie odtwarza kosztu produkcyjnego

Benchmarkowa ścieżka używa `EvaluationRequest::Minimal`, podczas gdy runner produkcyjny wymusza `Full`. Wynik może dobrze mierzyć integrator i jednocześnie nie przewidywać czasu rzeczywistej symulacji.

Wymagane są dwa benchmarki:

1. `rhs_core` — minimalna fizyka bez outputu;
2. `production_step` — dokładnie ta sama polityka obserwabli, artefaktów i stop criteria co runtime.

## 4. Elementy poprawne lub warte zachowania

- Bazowa formuła LLG w `llg_rhs_from_field_at` odpowiada repozytoryjnej konwencji `gamma_mu0`, `H` w A/m i dzielnikowi `1+alpha^2`.
- Momenty bezpośrednie są dodawane jako `1/s`, a nie mieszane z polem energetycznym.
- Istnieją prealokowane `IntegratorBuffers` i warianty SoA — problemem jest niepełne wykorzystanie i semantyczny drift, nie sam kierunek projektu.
- Wspólny `decide_adaptive_step` ma PI-like logikę i powinien zostać jedynym właścicielem decyzji.
- Frozen spins są przywracane po projekcjach etapów.

## 5. Plan napraw i optymalizacji

### Natychmiast — correctness gate

1. `FDM-CPU-NUM-001` — wspólny retry controller i `max_reject`.
2. `FDM-CPU-TRX-001` — commit RNG tylko po sukcesie.
3. finite checks dla kandydata, RHS i error norm.
4. regression tests AoS/SoA.

### Małe ryzyko, duży zysk

1. `EvaluationRequest::Control` oraz output stride.
2. Usunąć klony stanu/pól z hot loop.
3. Zachować końcowe `H_eff`/RHS jako cache dla statystyk i FSAL.
4. Rozdzielić solver thread od writera artefaktów.
5. Liczyć pełne energie tylko, gdy są zamówione.

### Średnia refaktoryzacja

1. Jedna implementacja fizyki z adapterem AoS/SoA.
2. Vendor FFT i R2C/C2R.
3. Jawna `projection_policy`.
4. DMI ghost/natural BC.
5. Termika z lokalnymi polami materiałowymi.

## 6. Wymagane benchmarki

| Benchmark | Konfiguracja | Metryki |
|---|---|---|
| exchange-only | sześcienna siatka, bez demag | cell-updates/s, bandwidth, scaling Rayon |
| demag-only RHS | thin film i 3D | FFT/s, pack/unpack GB/s, pamięć peak |
| RK4 production | exchange+demag | RHS/step, dodatkowe obserwable, alokacje |
| RK45 adaptive | kontrolowany transient | accepted/rejected, RHS/accepted, regulator overhead |
| thermal | dwa regiony `Ms/alpha` | wariancja i restart determinism |
| DMI edge | pasek z naturalnym BC | boundary angle i zbieżność dx |
| AoS/SoA parity | losowy stan i maski | max field/RHS/energy difference |

## 7. Kryterium zamknięcia audytu

Ścieżka FDM CPU może zostać oznaczona jako produkcyjnie kwalifikowana dopiero, gdy:

- żaden adaptive rejection test nie może zawisnąć;
- failed step jest bitowo/transakcyjnie neutralny dla stanu i RNG;
- AoS/SoA mają udowodnioną równoważność dla wspieranych interakcji;
- DMI boundary oracle przechodzi;
- pełne obserwable nie są wymuszane na każdy krok;
- benchmark produkcyjny publikuje liczbę FFT, RHS, alokacji i koszt outputu.
