# Fullmag

**Fullmag** to rozwijana platforma do symulacji mikromagnetycznych, projektowana jako kompletna aplikacja naukowo-inżynierska: od opisu problemu w Pythonie, przez planowanie wykonania i backendy FDM/FEM, po lokalny panel przeglądarkowy, artefakty, diagnostykę oraz odtwarzalną historię obliczeń.

Główna zasada projektu:

> użytkownik opisuje problem fizyczny, a nie układ pamięci solvera, siatkę numeryczną ani szczegóły backendu.

Fullmag ma być warstwą wspólną dla różnych metod numerycznych, runtime’ów i środowisk obliczeniowych. Ten sam model fizyczny powinien dać się uruchomić na backendzie FDM lub FEM, lokalnie lub przez runtime zarządzany, z zachowaniem jawnego śladu: co użytkownik zadał, co planner wybrał i co solver realnie wykonał.

---

## Najważniejsze cele projektu

Fullmag jest budowany jako platforma, która ma umożliwiać:

1. opis symulacji mikromagnetycznej w kanonicznym Python DSL,
2. przekształcenie modelu do wspólnego, backend-neutralnego `ProblemIR`,
3. walidację jednostek, geometrii, oddziaływań, siatki i możliwości backendu,
4. uruchamianie obliczeń w FDM lub FEM,
5. wykorzystanie CPU, CUDA/GPU oraz runtime’ów zarządzanych,
6. obserwację pól i przebiegu obliczeń w lokalnym panelu przeglądarkowym,
7. zapis artefaktów: pól, energii, skalarów, metadanych i provenance,
8. eksport lub odtworzenie tej samej symulacji z poziomu kodu.

Projekt nie jest tylko solverem. Docelowo ma być pełną aplikacją do pracy z mikromagnetyką: modelowanie, uruchamianie, diagnostyka, wizualizacja, walidacja i analiza wyników.

---

## Model fizyczny

Podstawą symulacji jest równanie Landaua–Lifshitza–Gilberta z opcjonalnymi członami napędzającymi:

```text
∂m/∂t = -γ μ0 m × H_eff + α m × ∂m/∂t + τ_spin + η_th
```

gdzie:

- `m` — zredukowana magnetyzacja, `|m| = 1`,
- `γ` — współczynnik żyromagnetyczny,
- `μ0` — przenikalność magnetyczna próżni,
- `α` — tłumienie Gilberta,
- `H_eff` — pole efektywne,
- `τ_spin` — opcjonalne momenty spinowe, np. STT,
- `η_th` — opcjonalny składnik termiczny.

Typowy model pola efektywnego:

```text
H_eff = H_ex + H_demag + H_Zeeman + H_anis + H_DMI + H_Oe + H_me + ...
```

Fullmag traktuje oddziaływania jako elementy modelu fizycznego, które powinny mieć spójną semantykę energii, pola, jednostek, operatorów i artefaktów. To jest kluczowe dla utrzymania zgodności między FDM i FEM.

---

## Obsługiwane i projektowane oddziaływania

| Oddziaływanie / zjawisko | Znaczenie fizyczne | Aktualny status w projekcie |
|---|---|---|
| Exchange | lokalne sprzężenie wymienne, wygładzanie magnetyzacji | public-executable w FDM i FEM |
| Demag / dipolar | nielokalne pole magnetostatyczne | public-executable w FDM i FEM; FEM używa ścieżek Poissona/airbox i nadal wymaga ostrożnej walidacji produkcyjnej |
| Zeeman | pole zewnętrzne | public-executable w FDM i FEM |
| LLG / time evolution | dynamika magnetyzacji | public-executable w FDM i FEM |
| Relaxation | relaksacja do stanu bliskiego równowagi | public-executable dla podstawowych algorytmów; część zaawansowanych ścieżek pozostaje bootstrapowa |
| Slonczewski STT | moment spinowy CPP/MTJ | public-executable dla pojedynczego modułu w FDM CPU/GPU oraz natywnym FEM CPU/GPU |
| Zhang–Li STT | moment spinowy CIP zależny od gradientów magnetyzacji | public-executable dla pojedynczego modułu w FDM CPU/GPU oraz natywnym FEM CPU/GPU |
| CurrentTransport `prescribed_density` | zadana gęstość prądu jako źródło dla STT/Oersted | public-executable w FDM i natywnym FEM |
| OerstedCylinder | analityczne pole Oersteda od prądu cylindrycznego | public-executable w FDM i natywnym FEM dla wybranych obwiedni czasowych |
| Oersted from current solution | pole Oersteda z zadanego źródła prądowego | public-executable dla `prescribed_density`; pełny solver kontaktowo-przewodnościowy nadal nie jest gotowy |
| Thermal noise | termiczne pole losowe zgodne z modelem Browna/FDT | obecne w ścieżkach STNO/termicznych; wymaga dalszej walidacji zakresowej dla wszystkich workflow |
| Interfacial DMI | chiralne oddziaływanie interfejsowe | opisane semantycznie; nie traktować jako public-executable w bazowej macierzy capability |
| Bulk DMI | objętościowe DMI | opisane semantycznie / planowane |
| Anizotropia jednoosiowa i kubiczna | energia osi łatwej / krystalograficzna | planowana jako klasyczny brakujący element solvera |
| Surface anisotropy | anizotropia powierzchniowa/interfejsowa | planowana |
| Magnetoelastic coupling | sprzężenie magnetyzacja–odkształcenie | wewnętrzny/reference scope; pełna dwustronna magnetoelastyka pozostaje celem roadmapy |
| SOT | spin–orbit torque | semantic-only |
| Spin diffusion / drift diffusion | pełniejszy transport spinowy | semantic-only |
| Periodic / Floquet spin waves | periodyczne/floquetowe problemy fal spinowych | semantic-only w aktualnym publicznym zakresie FEM |
| NEB | bariera energetyczna i ścieżki przejścia | roadmap / semantic-only |
| Parameter sweep / optimization | automatyczne przeszukiwanie przestrzeni parametrów | roadmap / semantic-only |

---

## Architektura

Fullmag rozdziela opis fizyczny od wykonania numerycznego.

```text
Python DSL
   ↓
ProblemIR
   ↓
Validation + planning + capability checks
   ↓
Session / run / stage runtime
   ↓
FDM backend     FEM backend     future hybrid paths
   ↓
Artifacts + provenance + live fields
   ↓
Browser control room / export / diagnostics
```

### Warstwy projektu

| Warstwa | Rola |
|---|---|
| Python DSL | publiczny interfejs opisu modelu fizycznego |
| `ProblemIR` | wspólny, typowany opis problemu niezależny od backendu |
| Planner | walidacja, normalizacja, wybór backendu i ścieżki wykonania |
| Runner / session | wykonanie etapów, lifecycle, artefakty, logi, status |
| FDM backend | regular-grid micromagnetics, szybkie ścieżki CPU/GPU |
| FEM backend | geometrie nieregularne, MFEM/libCEED/hypre, natywne CPU/GPU |
| Control room | lokalny panel przeglądarkowy do obserwacji, diagnostyki i eksportu |
| Docs / physics notes | obowiązkowy zapis semantyki fizycznej i walidacji |

---

## Mapa repozytorium

| Ścieżka | Rola |
|---|---|
| `packages/fullmag-py` | Python DSL i warstwa ładowania skryptów użytkownika |
| `crates/fullmag-ir` | kanoniczny model `ProblemIR` |
| `crates/fullmag-plan` | planner i logika capability |
| `crates/fullmag-cli` | publiczny launcher `fullmag` |
| `crates/fullmag-api` | lokalne API panelu kontrolnego |
| `crates/fullmag-runner` | wykonanie sesji, etapów i artefaktów |
| `crates/fullmag-engine` | referencyjne solvery i logika wykonawcza |
| `crates/fullmag-py-core` | most Python ↔ Rust |
| `apps/web` | przeglądarkowy control room |
| `native/` | natywne backendy produkcyjne |
| `docs/` | specyfikacje, ADR-y, noty fizyczne, plany walidacji |
| `examples/` | przykłady uruchamialnych workflow |
| `tests/` | testy jednostkowe, regresyjne i benchmarkowe |

---

## Przykładowe workflow

Repozytorium zawiera przykłady obejmujące różne poziomy dojrzałości.

| Przykład | Zakres |
|---|---|
| `examples/exchange_relax.py` | najprostsza relaksacja exchange-only na geometrii `Box` |
| `examples/exchange_demag_zeeman.py` | FDM: exchange + demag + Zeeman + artefakty pól i energii |
| `examples/fem_exchange_zeeman.py` | podstawowy przypadek FEM z exchange i polem zewnętrznym |
| `examples/fem_exchange_demag_zeeman.py` | FEM z exchange, demag i Zeeman |
| `examples/fem_eigenmodes.py` | bootstrap/reference eigenmodes dla zlinearyzowanego LLG |
| `examples/dw_track.py` | ścieżka dla ścian domenowych |
| `examples/fdm_multibody_two_layer_stack.py` | FDM dla wielu ciał / stacków warstwowych |
| `examples/stno_vortex_ref_minimal.py` | minimalny benchmark STNO w aktualnym publicznym slice |
| `examples/stno_vortex_mtj_workflow.py` | szerszy workflow STNO/MTJ z artefaktami i postprocessingiem |

---

## Szybki start

### 1. Przygotowanie środowiska

```bash
cp .env.example .env
# opcjonalnie uzupełnij ustawienia środowiskowe
```

### 2. Uruchomienie środowiska developerskiego

```bash
make up
make shell
```

### 3. Build

```bash
just build fullmag
```

Dla ścieżek FEM/GPU można użyć runtime’u zarządzanego:

```bash
just build fem-gpu-runtime-host
```

### 4. Uruchomienie przykładu

```bash
fullmag examples/exchange_relax.py
fullmag examples/exchange_demag_zeeman.py
fullmag examples/fem_eigenmodes.py --headless
```

Tryb interaktywny:

```bash
fullmag -i examples/exchange_relax.py
```

### 5. Control room

```bash
just control-room
# albo
./scripts/dev-control-room.sh
```

---

## Minimalny przykład Python DSL

```python
import fullmag as fm

strip = fm.Box(size=(200e-9, 20e-9, 5e-9), name="strip")

mat = fm.Material(
    name="Py",
    Ms=800e3,
    A=13e-12,
    alpha=0.5,
)

magnet = fm.Ferromagnet(
    name="strip",
    geometry=strip,
    material=mat,
    m0=fm.texture.random(seed=42),
)

problem = fm.Problem(
    name="exchange_relax",
    magnets=[magnet],
    energy=[fm.Exchange()],
    study=fm.Relaxation(
        algorithm="llg_overdamped",
        torque_tolerance=5e-2,
        energy_tolerance=1e-21,
        max_steps=50_000,
        dynamics=fm.LLG(fixed_timestep=1e-13),
        outputs=[
            fm.SaveField("m", every=100e-12),
            fm.SaveField("H_ex", every=100e-12),
            fm.SaveScalar("E_ex", every=10e-12),
        ],
    ),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(cell=(2e-9, 2e-9, 5e-9)),
    ),
)

result = fm.Simulation(problem, backend="fdm").run(until=2e-9)
print(result.status)
```

---

## Artefakty i provenance

Fullmag powinien zawsze zachowywać rozróżnienie między:

1. tym, co użytkownik opisał w Pythonie,
2. tym, co zostało zapisane w `ProblemIR`,
3. tym, co planner uznał za wykonalne,
4. tym, jaki backend, device i precision zostały wybrane,
5. tym, co solver realnie wykonał,
6. tym, jakie pola, energie, skalary i metadane zostały zapisane.

Typowe artefakty:

- `m` — magnetyzacja,
- `H_ex` — pole wymienne,
- `H_demag` — pole demagnetyzujące,
- `H_ext` — pole zewnętrzne,
- `H_eff` — pole efektywne,
- `E_ex`, `E_demag`, `E_ext`, `E_total` — wkłady energetyczne,
- `current_transport/.json` — artefakty prądowe dla `prescribed_density`,
- `scalars.csv` — przebiegi skalarne,
- `metadata.json` — informacje o modelu, backendzie i parametrach wykonania.

---

## Status dojrzałości

Fullmag używa jawnego słownika statusów. Każda funkcja powinna być opisana jednym z poniższych stanów:

| Status | Znaczenie |
|---|---|
| `semantic_only` | API i IR mogą opisać funkcję, ale publiczna ścieżka wykonawcza jej jeszcze nie uruchamia |
| `reference_executable` | funkcja działa na ścieżce referencyjnej używanej do poprawności |
| `production_executable` | funkcja działa na docelowej ścieżce produkcyjnej |
| `validated` | funkcja działa i ma jawne testy/benchmarki dla danego workloadu |

To rozróżnienie jest ważne: obecność klasy w Pythonie lub wpisu w `ProblemIR` nie oznacza jeszcze pełnej implementacji numerycznej w każdym backendzie.

---

## Aktualnie najmocniejsze strony projektu

- spójna koncepcja `ProblemIR`,
- publiczny Python DSL,
- rozdział modelu fizycznego od wykonania numerycznego,
- jednoczesne projektowanie FDM i FEM,
- jawny model capability zamiast ukrywania ograniczeń,
- silny nacisk na dokumentację fizyki przed implementacją,
- rozwijane ścieżki CPU/GPU,
- artefakty i provenance jako część produktu,
- rosnąca obsługa STNO/STT/Oersted dla FDM i natywnego FEM.

---

## Najważniejsze ograniczenia

Aktualny stan nie powinien być przedstawiany jako kompletny solver mikromagnetyczny dla wszystkich znanych efektów. Szczególnie ostrożnie należy komunikować:

- DMI jest w dużej mierze etapem semantycznym/projektowym, a nie pełnym publicznym wykonaniem,
- anizotropia jednoosiowa/kubiczna nadal jest jednym z kluczowych brakujących elementów klasycznego solvera,
- pełny transport prądowy `ohmic_poisson` nie jest jeszcze wdrożony,
- `prescribed_density` nie zastępuje samokonsystentnego solvera kontaktów i przewodnictwa,
- SOT i spin diffusion są semantic-only,
- pełna dwustronna magnetoelastyka pozostaje celem roadmapy,
- FEM eigenmodes istnieje jako ścieżka bootstrap/reference, ale nie jako docelowy matrix-free, produkcyjny moduł,
- funkcje takie jak NEB, optymalizacja i parameter sweep są roadmapą, nie aktualnym publicznym wykonaniem.

---

## Roadmap

### Etap 1 — domknięcie klasycznej mikromagnetyki

- anizotropia jednoosiowa,
- anizotropia kubiczna,
- DMI interfejsowe i objętościowe,
- walidacja warunków brzegowych,
- rozszerzona walidacja demag,
- spójne testy FDM/FEM/GPU.

### Etap 2 — prąd i spintronika

- pełniejszy model `CurrentTransport`,
- `ohmic_poisson`, kontakty i przewodność zależna od regionu,
- Oersted z rzeczywistego rozwiązania prądowego,
- rozszerzenie STT poza pojedynczy moduł,
- SOT,
- spin diffusion / spin accumulation.

### Etap 3 — FEM high-fidelity

- mocniejszy FEM demag,
- lepsze open-boundary treatment,
- matrix-free eigensolve,
- linearyzacja operatorów dla eigenmodes,
- walidacja geometrii 3D.

### Etap 4 — pełna wielofizyka

- dwustronna magnetoelastyka,
- sprzężenie z mechaniką FEM,
- termika i Joule heating,
- coupling manager dla magnetyki, prądu, mechaniki i temperatury.

### Etap 5 — workflow inżynierskie

- parameter sweep,
- optimization studies,
- NEB,
- standardowe benchmarki mikromagnetyczne,
- raporty automatyczne,
- workflow dla urządzeń STNO, MTJ, racetrack, skyrmion, multilayer stacks.

---

## Kryterium „done” dla nowej funkcji

Nowa funkcja w Fullmag jest gotowa dopiero wtedy, gdy ma:

1. notę w `docs/physics/`,
2. API w Python DSL,
3. reprezentację w `ProblemIR`,
4. reguły planera i capability,
5. implementację backendową albo jawny status `semantic_only`,
6. artefakty i observables,
7. testy jednostkowe,
8. benchmark fizyczny,
9. walidację jednostek i znaków,
10. dokumentację użytkową.

Jeżeli działa tylko backend, ale nie ma API, IR, artefaktów i testów, funkcja nie powinna być oznaczana jako zakończona.

---

## Dla kogo jest ten projekt

Fullmag jest przeznaczony dla:

- badaczy mikromagnetyki,
- osób pracujących nad spintroniką i magnoniką,
- projektantów struktur STNO, MTJ, multilayer i racetrack,
- osób potrzebujących jednego modelu dla FDM i FEM,
- zespołów wymagających odtwarzalności, provenance i jawnego statusu solvera,
- użytkowników, którzy chcą pracować w Pythonie, ale korzystać z backendów Rust/CUDA/C++/MFEM.

---

## Charakter projektu

Fullmag jest projektem ambitnym i aktywnie rozwijanym. Aktualnie najlepiej opisywać go jako:

> rozwijaną, physics-first platformę mikromagnetyczną z działającymi publicznymi ścieżkami FDM/FEM dla rdzeniowych przypadków oraz jasno rozpisaną roadmapą dla pełnej spintroniki, DMI, wielofizyki, eigenmodes i optymalizacji.

Nie należy go opisywać jako w pełni zakończonego zamiennika dla wszystkich dojrzałych solverów. Mocną stroną projektu jest natomiast to, że architektura od początku wymusza jawność: model, backend, capability, artefakty, provenance i ograniczenia są częścią produktu, a nie dodatkiem.