# Diagnostyka regresji relaksacji po zmianach solverów w `fullmag`

**Repo:** `MateuszZelent/fullmag`  
**Data analizy:** 2026-03-28  
**Zakres:** statyczna analiza aktualnego kodu źródłowego (bez pełnego zbudowania i uruchomienia całego repo w tym środowisku)

## TL;DR

Najbardziej prawdopodobna przyczyna problemu **nie leży w tym, że pole efektywne albo RHS zostały wyzerowane**, tylko w tym, że po zmianach solverów relaksacja zaczęła domyślnie iść przez **adaptacyjny RK23**, a bieżące ścieżki wykonawcze **nie przenoszą poprawnie konfiguracji adaptacyjnego kroku czasu**. W praktyce `fixed_timestep` przestaje zachowywać się jak „sztywny dt”, krok może się silnie kurczyć, a runner nadal ucina obliczenia po `max_steps`. Efekt użytkowy jest dokładnie taki, jak opisujesz: **czas fizyczny rośnie bardzo wolno, energia na zapisach wygląda niemal stała, a spiny sprawiają wrażenie zamrożonych**.

Dodatkowo znalazłem dwie poboczne, ale realne usterki API:

1. `solver(max_error=...)` w flat API jest obecnie **zapisywany do stanu, ale nigdzie nie jest przenoszony do problemu/runnera**.
2. `fm.relax()` w flat API wygląda na **osobne uruchomienie**, które nie wstrzykuje końcowej magnetyzacji z powrotem do świata; więc sekwencja `fm.relax(); fm.run(...)` **najpewniej nie łączy stanów**.

---

## Najważniejsze ustalenia

### 1) Relaksacja z `LLG(integrator="auto")` jest teraz automatycznie mapowana na `RK23`

To jest główny punkt regresji semantycznej.

**Dowód:**

- `packages/fullmag-py/src/fullmag/model/dynamics.py:79-82`
  - `LLG.integrator` ma domyślnie wartość `"auto"`.
- `packages/fullmag-py/src/fullmag/model/study.py:83-87`
  - `Relaxation.algorithm` ma domyślnie `"llg_overdamped"` i `max_steps = 50_000`.
- `crates/fullmag-ir/src/lib.rs:1222-1232`
  - `RelaxationAlgorithmIR::default_integrator()` zwraca `IntegratorChoice::Rk23` dla:
    - `LlgOverdamped`
    - `ProjectedGradientBb`
    - `NonlinearCg`
- `crates/fullmag-plan/src/lib.rs:337-345`
  - planner rozwiązuje `integrator="auto"` tak, że:
    - `TimeEvolution -> RK45`
    - `Relaxation -> algorithm.default_integrator()`

**Wniosek:**

Jeżeli kod relaksacji wcześniej zachowywał się jak klasyczny krokowy LLG/Heun, to po tej zmianie ta sama definicja problemu może wejść w **adaptacyjny RK23** bez jakiejkolwiek jawnej zmiany po stronie skryptu użytkownika.

---

### 2) `RK23` jest adaptacyjny, więc przekazany `dt` nie jest już „sztywnym krokiem”

W silniku `RK23` bierze `dt` wejściowe tylko jako **krok startowy / limit początkowy**, a potem sam go zmniejsza według błędu lokalnego.

**Dowód:**

- `crates/fullmag-engine/src/lib.rs:209-225`
  - domyślny `AdaptiveStepConfig` to:
    - `max_error = 1e-5`
    - `dt_min = 1e-18`
    - `dt_max = 1e-10`
    - `headroom = 0.8`
- `crates/fullmag-engine/src/lib.rs:1308-1365`
  - w `rk23_step_buf()`:
    - `let mut dt = dt.min(cfg.dt_max).max(cfg.dt_min);`
    - jeżeli błąd jest zbyt duży, krok jest redukowany
    - zaakceptowany krok dopiero wtedy zwiększa `state.time_seconds`

**Wniosek:**

Jeżeli użytkownik podał np. `fixed_timestep=1e-13`, to po auto-przełączeniu relaksacji na `RK23` ten parametr **nie gwarantuje już stałego 1e-13 s na krok**. Może skończyć się na dużo mniejszym zaakceptowanym `dt`.

---

### 3) Bieżące runnery nie przenoszą poprawnie konfiguracji adaptacyjnego kroku czasu

To jest najpoważniejszy problem implementacyjny.

#### 3a) CPU FDM używa domyślnych adaptive defaults z silnika

**Dowód:**

- `crates/fullmag-runner/src/cpu_reference.rs:136-163`
  - runner buduje dynamikę przez `LlgConfig::new(plan.gyromagnetic_ratio, integrator)`
  - następnie bierze `dt = plan.fixed_timestep.unwrap_or(1e-13)`
- `crates/fullmag-engine/src/lib.rs:245-257`
  - `LlgConfig::new(...)` ustawia `adaptive: AdaptiveStepConfig::default()`

**Wniosek:**

Na ścieżce CPU FDM ustawienia adaptacyjne nie są jawnie dostarczane do silnika; kończy się to użyciem domyślnych wartości z engine.

#### 3b) CPU FEM ma ten sam problem

**Dowód:**

- `crates/fullmag-runner/src/fem_reference.rs:110-132`
  - analogicznie do FDM: `LlgConfig::new(...)`
  - `dt = plan.fixed_timestep.unwrap_or(1e-13)`
- w całym runnerze FEM nie ma użycia `plan.adaptive_timestep` do zbudowania `LlgConfig::with_adaptive(...)`

**Wniosek:**

Nawet tam, gdzie plan FEM przenosi `adaptive_timestep`, referencyjny runner FEM i tak je ignoruje przy egzekucji.

#### 3c) CUDA FDM ma jeszcze twardszy problem: parametry adaptive są wpisane na sztywno jako zera

**Dowód:**

- `crates/fullmag-runner/src/native_fdm.rs:174-177`
  - do backendu idzie:
    - `adaptive_max_error: 0.0`
    - `adaptive_dt_min: 0.0`
    - `adaptive_dt_max: 0.0`
    - `adaptive_headroom: 0.0`
- `native/backends/fdm/src/api.cpp:127-131`
  - backend zamienia te zera na domyślne:
    - `1e-5`, `1e-18`, `1e-10`, `0.8`

**Wniosek:**

Na CUDA FDM konfiguracja adaptacyjna użytkownika jest obecnie de facto **ignorowana**, a backend zawsze wpada w własne wartości domyślne.

---

### 4) FDM plan w ogóle nie niesie `adaptive_timestep`

To pokazuje, że problem nie jest tylko w runnerze, ale również w warstwie planowania dla FDM.

**Dowód:**

- `crates/fullmag-ir/src/lib.rs:646-665`
  - `FdmPlanIR` ma pola:
    - `integrator`
    - `fixed_timestep`
    - `relaxation`
  - ale **nie ma** pola `adaptive_timestep`
- `crates/fullmag-plan/src/lib.rs:840-860`
  - `FdmPlanIR` jest budowany z:
    - `integrator`
    - `fixed_timestep`
    - `relaxation`
- `crates/fullmag-plan/src/lib.rs:1589-1646`
  - kontrast: `FemPlanIR` już `adaptive_timestep` przenosi

**Wniosek:**

W FDM adaptacyjna konfiguracja ginie już na etapie planu wykonania.

---

### 5) To bardzo dobrze tłumaczy objaw „energia prawie stała, spiny stoją”

Runner kończy relaksację po spełnieniu jednego z dwóch warunków:

- konwergencja, albo
- `step_count >= max_steps`

**Dowód:**

- `crates/fullmag-runner/src/cpu_reference.rs:330-341`
- `crates/fullmag-runner/src/fem_reference.rs:257-264`
- `crates/fullmag-runner/src/dispatch.rs:575-582` (CUDA FDM)

Jeżeli `RK23` zacznie schodzić z krokiem np. do `1e-16` albo `1e-18`, to przy domyślnym `max_steps = 50_000` fizyczny czas końcowy wyniesie odpowiednio tylko:

- `50_000 * 1e-16 = 5e-12 s`
- `50_000 * 1e-18 = 5e-14 s`

To są bardzo małe czasy. Jeśli skalar zapisujesz np. co `10e-12 s`, to możesz dostać prawie zerowy postęp w zarejestrowanym oknie. Układ **może wykonywać kroki numeryczne**, ale w sensie fizycznego czasu praktycznie stoi w miejscu.

To jest dokładnie zgodne z Twoim opisem:

- energia całkowita niemal nie drga,
- spiny nie zdążają zauważalnie obrócić się między zapisami,
- cały układ wygląda jak „zamrożony”.

---

### 6) `solver(max_error=...)` w flat API jest obecnie martwy

To wygląda na normalny parametr użytkownika, ale nie dochodzi do obiektu `LLG` ani do runnera.

**Dowód:**

- `packages/fullmag-py/src/fullmag/world.py:722-751`
  - `solver(max_error=...)` zapisuje wartość do `_state._max_error`
- `packages/fullmag-py/src/fullmag/world.py:840-848`
  - przy budowie `LLG(**llg_kwargs)` przekazywane są tylko:
    - `fixed_timestep`
    - `integrator`
    - `gamma`
  - `max_error` nie jest nigdzie uwzględniany

**Wniosek:**

Jeżeli po zmianach próbowałeś sterować adaptacją przez `solver(max_error=...)`, to obecny kod tego po prostu nie wykonuje.

---

### 7) `fm.relax()` w flat API ma dwie dodatkowe pułapki

#### 7a) `until_seconds` jest liczone jak dla stałego kroku

**Dowód:**

- `packages/fullmag-py/src/fullmag/world.py:922-950`
  - `until_seconds = (fixed_timestep or 1e-13) * max_steps`

**Wniosek:**

To ma sens tylko wtedy, gdy krok jest rzeczywiście stały. Po przejściu relaksacji na adaptacyjny `RK23` to założenie przestaje być prawdziwe.

#### 7b) `fm.relax(); fm.run(...)` wygląda na nieseansowane łączenie etapów

**Dowód:**

- `packages/fullmag-py/src/fullmag/world.py:922-950`
  - `relax()` buduje problem i wywołuje `Simulation(problem).run(...)`
- `packages/fullmag-py/src/fullmag/runtime/simulation.py:100-104`
  - `Simulation.run(...)` po prostu zwraca `run_result`
- `examples/py_layer_hole_relax_150nm.py:33-34`
  - przykład robi dokładnie `fm.relax()` a potem `fm.run(5e-10)`

**Wniosek (wysokie prawdopodobieństwo, ale to jest już wniosek z przepływu kodu):**

Nie widzę mechanizmu, który po `fm.relax()` aktualizowałby `world` / `m0` końcową magnetyzacją. To sugeruje, że `fm.run(...)` po `fm.relax()` może startować od starego stanu początkowego, a nie od stanu zrelaksowanego.

---

### 8) Dodatkowy sygnał regresji: przykład mówi „Heun”, ale kod już go nie wymusza

**Dowód:**

- `examples/exchange_relax.py:1-16`
  - docstring mówi: `LLG with Heun integrator`
- `examples/exchange_relax.py:35-40`
  - rzeczywisty kod ma tylko `dynamics=fm.LLG(fixed_timestep=1e-13)`
  - nie ustawia jawnie `integrator="heun"`
- po obecnej logice planera taka relaksacja trafia w `auto -> RK23`

**Wniosek:**

Dokumentacyjny i kodowy obraz solvera już się rozjechał. To bardzo mocny sygnał, że regresja wynika ze zmiany semantyki integratora, a nie z fizyki problemu.

---

### 9) Nie wygląda to na problem typu „RHS = 0”

Nie znalazłem w aktualnej analizie oznak, że pole efektywne lub sam RHS LLG zostały globalnie wyzerowane.

**Dowód wspierający:**

- `crates/fullmag-engine/src/lib.rs:2523-2529`
  - implementacja `llg_rhs_from_field()` wygląda spójnie znakowo dla standardowego tłumionego LLG
- testy w `crates/fullmag-engine/src/lib.rs`:
  - `damped_relaxation_reduces_exchange_energy_for_small_dt()` (`~2979`)
  - `zeeman_only_relaxation_reduces_external_energy()` (`~3003`)
  - `total_energy_decreases_during_demag_relaxation()` (`~3085`)

**Wniosek:**

Najmocniejsza hipoteza to **usterka warstwy sterowania solverem / krokiem czasu**, a nie błąd samej siły napędowej w silniku.

---

## Ranking przyczyn

### P1 — wysoka pewność

**Regresja semantyki relaksacji:** `auto` dla `Relaxation` przełącza się na `RK23`, a adaptacyjne ustawienia nie są poprawnie dostarczane do wykonania.

### P2 — wysoka pewność

**Runner kończy się po `max_steps`, nawet jeśli przez adaptacyjne ścinanie kroku fizyczny czas prawie nie urósł.** To bezpośrednio daje „zamrożone” przebiegi.

### P3 — średnia pewność

**Flat API `solver(max_error=...)` jest martwe**, więc próby ręcznej regulacji adaptacji z poziomu skryptu nie działają.

### P4 — średnia/wysoka pewność

**`fm.relax(); fm.run(...)` nie wygląda na stanowe łączenie etapów**, więc pre-relaksacja może nie mieć wpływu na następny etap.

---

## Co sprawdzić od razu, żeby potwierdzić diagnozę

### Test A — wymuś Heun

W relaksacji ustaw jawnie:

```python
fm.Relaxation(
    algorithm="llg_overdamped",
    dynamics=fm.LLG(integrator="heun", fixed_timestep=1e-13),
    ...
)
```

albo w flat API:

```python
fm.solver(dt=1e-13, integrator="heun")
```

**Jeśli układ znowu zacznie schodzić z energią i obracać spiny, to diagnoza jest praktycznie potwierdzona.**

### Test B — porównaj czas końcowy z oczekiwanym `max_steps * dt`

Jeśli masz `max_steps = 50_000` i myślisz, że lecisz na `1e-13`, oczekujesz ok. `5e-9 s`.

Jeżeli w wyniku zobaczysz czas końcowy rzędu `1e-12 ... 1e-14 s`, to znaczy, że adaptacyjny solver silnie ścina krok.

### Test C — obserwuj jednocześnie `time`, `dt`, `max_dm_dt`

Najbardziej diagnostyczny zestaw to:

- `time`
- `dt`
- `max_dm_dt`
- `E_total`

Interpretacja:

- `max_dm_dt` niezerowe, ale `time` rośnie śladowo -> problem jest w kroku czasu / solverze
- `max_dm_dt ~ 0` od pierwszych kroków -> wtedy trzeba osobno sprawdzić stan początkowy i symetrię problemu

---

## Rekomendowane poprawki w repo

### 1) Przywrócić przewidywalność `Relaxation + fixed_timestep`

Najbezpieczniejsza zmiana:

- gdy `study == Relaxation`
- i `integrator == auto`
- i użytkownik podał `fixed_timestep`

=> rozwiązywać to do `Heun`, a nie `RK23`

To przywróci dawną intuicję: „podałem `dt`, więc mam krokowy relaks”.

### 2) Albo jawnie rozdzielić semantykę

Jeśli relaksacja ma domyślnie używać `RK23`, to `fixed_timestep` nie powinien nazywać się jak krok stały. W adaptacyjnym solverze to jest raczej **`dt_initial`**.

Dziś nazwa i rzeczywista semantyka są mylące.

### 3) Dopracować przenoszenie `adaptive_timestep`

Minimalny porządek techniczny:

- dodać `adaptive_timestep` do `FdmPlanIR`
- przekazywać go do CPU FDM runnera
- przekazywać go do CPU FEM runnera
- przekazywać go do CUDA FDM backendu zamiast wpisywania zer
- używać `LlgConfig::with_adaptive(...)`

### 4) Naprawić flat API `solver(max_error=...)`

Obecnie są tylko dwa sensowne wyjścia:

- albo usunąć ten parametr z publicznego API, dopóki nic nie robi,
- albo faktycznie przełożyć go na konfigurację adaptacyjnego integratora.

### 5) Naprawić łączenie `fm.relax()` -> `fm.run(...)`

Jeśli flat API ma wspierać styl mumax-like, to `fm.relax()` powinno:

- albo modyfikować bieżący stan świata,
- albo zwracać końcową magnetyzację i mieć publiczny mechanizm ustawienia jej jako nowego `m0`

W obecnym przepływie to wygląda na nieintuicyjne i prawdopodobnie błędne.

### 6) Dodać telemetrykę solvera

Do debugowania takich regresji bardzo pomogłyby od razu w logach / `StepStats`:

- liczba odrzuconych kroków,
- minimalny zaakceptowany `dt`,
- średni/medialny `dt`,
- informacja, który integrator został ostatecznie wybrany po `auto`.

---

## Minimalna poprawka, którą wdrożyłbym najpierw

Jeśli zależy Ci na szybkim odblokowaniu projektu, zrobiłbym w tej kolejności:

1. **W relaksacji tymczasowo wymusić `Heun` dla `integrator="auto"`**, jeśli podano `fixed_timestep`.  
2. **Naprawić przekazywanie adaptive config** do runnerów i backendu.  
3. **Naprawić flat `solver(max_error=...)`**.  
4. **Naprawić stanowość `fm.relax()`**.  

To powinno przywrócić „żywy” ruch spinów bez ryzyka, że solver będzie po cichu stał w ultra-małym kroku.

---

## Konkluzja

W aktualnym kodzie widzę **spójną ścieżkę regresji**, która dokładnie tłumaczy zgłaszany objaw:

- relaksacja przeszła na `RK23` przez `auto`,
- adaptacyjne ustawienia nie są poprawnie przenoszone,
- `fixed_timestep` przestał zachowywać się jak krok stały,
- runner nadal obcina wszystko po `max_steps`,
- a flat API ma jeszcze dodatkowe problemy z `max_error` i sekwencją `relax(); run()`.

To razem bardzo łatwo daje sytuację, w której **układ formalnie „idzie”, ale fizycznie prawie nie przesuwa się w czasie**, więc na wykresach energia i magnetyzacja wyglądają jakby całkiem stanęły.
