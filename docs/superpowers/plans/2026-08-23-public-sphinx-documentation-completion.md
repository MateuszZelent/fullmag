# Domknięcie publicznej dokumentacji Sphinx — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przejrzeć, poprawić i niezależnie zweryfikować każdy z 227 dokumentów Markdown publikowanych lub utrzymywanych w `public_docs/site`, tak aby treść odpowiadała aktualnym kontraktom Fullmag, nawigacja była kompletna, a wszystkie bramki Sphinx i dokumentacji naukowej przechodziły bez ostrzeżeń.

**Architecture:** Istniejąca architektura informacji i hierarchia źródeł prawdy pozostają bez zmian. Praca jest dzielona na rozłączne fale domenowe; autor poprawki czyta stronę, jej bezpośrednie źródła oraz strony nadrzędne/podrzędne, a drugi agent wykonuje niezależny przegląd kontraktu. Strony naukowe zachowują sąsiadujące mapy źródeł i przechodzą walidację zarówno tekstu źródłowego, jak i wyrenderowanego HTML.

**Tech Stack:** Python 3.11/3.12, Sphinx, MyST Markdown, `unittest`, repozytoryjne walidatory architektury informacji i przykładów, `scientific-documentation-contract`, JSON source maps, PowerShell na stacji roboczej i Bash w CI.

## Global Constraints

- Publiczna treść pozostaje po angielsku; plan, audyt i raport końcowy są po polsku.
- Źródła prawdy mają kolejność z `AGENTS.md`: `docs/physics`, specyfikacje/ADR, publiczne API Python, `ProblemIR`, planner/runtime, a dopiero potem tekst publiczny.
- Przykłady Python używają wyłącznie kanonicznego, stage-first `fm.study(...).stages`; nie wolno przywracać `fm.Problem`.
- Nie wolno promować `planned`, `partial` ani `unsupported` do `implemented` bez sprawdzalnego dowodu w kodzie, testach i ścieżce runtime.
- Każda zmieniana strona naukowa spełnia pełny `scientific-documentation-contract`: równania, symbole i SI, założenia, realizacje FDM/FEM i CPU/GPU, pełną tabelę API, Python→ProblemIR, round-trip, walidację, źródła i aktualną mapę źródeł.
- Każda strona dostaje uczciwy status, właściciela, odbiorcę, rodzaj dokumentu i źródło prawdy; brak dowodu jest opisany jako ograniczenie, nie zamaskowany.
- Zmiany są chirurgiczne: poprawiamy fakty, kompletność, nawigację, przykłady, metadane i czytelność, bez przebudowy produktu lub API.
- Agent implementujący i agent recenzujący nie mogą być tą samą osobą dla tej samej partii.
- Żaden wpis manifestu nie zostaje oznaczony jako ukończony przed przeglądem źródeł, lokalną walidacją i niezależną recenzją.

## Definicja ukończenia pojedynczej strony

Strona jest ukończona dopiero, gdy:

1. ma poprawny front matter, stabilną etykietę MyST i jednoznaczny cel dla wskazanej grupy odbiorców;
2. jest osiągalna z właściwego `toctree` albo jawnie oznaczona jako plik utrzymaniowy/strona osierocona z uzasadnieniem;
3. wszystkie twierdzenia, domyślne wartości, jednostki, nazwy API i deklaracje wsparcia mają sprawdzone źródła;
4. przykłady są kanoniczne, minimalne, wykonywalne tam, gdzie kontrakt tego wymaga, i nie używają nieistniejących symboli;
5. linki, odwołania, nagłówki, tabele i kod renderują się bez ostrzeżeń Sphinx;
6. dla strony naukowej mapa źródeł istnieje, wskazuje unikalne aktualne symbole i przechodzi walidację źródła oraz HTML;
7. niezależny recenzent potwierdził zgodność ze specyfikacją i jakość redakcyjną.

---

### Task 1: Utrwalić bazę testową i rejestr wyników

**Files:**
- Modify: `.agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py`
- Modify: `public_docs/site/_extensions/documentation_changelog.py`
- Modify: `public_docs/site/_extensions/page_last_modified.py`
- Create: `scripts/test_public_docs_timezone_fallback.py`
- Modify: `.github/workflows/documentation.yml`

- [x] Odtworzyć błąd CRLF w walidatorze map źródeł na Windows i dodać regresję.
- [x] Naprawić porównanie plików bez zmiany semantyki walidatora; uruchomić pełne 23/23 testów kontraktu naukowego.
- [x] Odtworzyć brak bazy stref czasowych przy ścisłym buildzie, dodać test i bezostrzeżeniowy fallback UTC.
- [x] Uruchomić świeży build `-E -a -b html -W -n --keep-going`; wynik bazowy: sukces.
- [x] Zweryfikować 77 istniejących map źródeł; wynik bazowy: 75 PASS, 2 FAIL (`response-solver`, `fdm-grids`).

### Task 2: Usunąć dwa bazowe błędy kontraktu naukowego

**Files:**
- Modify: `public_docs/site/numerical-methods/frequency-domain/response-solver.md`
- Modify: `public_docs/site/numerical-methods/frequency-domain/response-solver.source-map.json`
- Modify: `public_docs/site/numerical-methods/meshing/fdm-grids.md`
- Modify: `public_docs/site/numerical-methods/meshing/fdm-grids.source-map.json`

- [ ] Agent A sprawdza aktualne typy planera, solver odpowiedzi, artefakty i publiczne API, następnie uzupełnia `response-solver` bez wymyślania niedostępnych ścieżek.
- [ ] Agent B sprawdza aktualne struktury siatki FDM, demagnetyzację, periodyczność i publiczne API, następnie uzupełnia `fdm-grids`.
- [ ] Agent C wykonuje krzyżowy przegląd obu stron i map, w tym unikalność każdego symbolu źródłowego.
- [ ] Root uruchamia walidator źródła, świeży Sphinx HTML i walidator rendered HTML dla obu map.

### Task 3: Fala 1 — powłoka produktu, onboarding i powierzchnie operacyjne

- [ ] Rozdzielić manifest Fali 1A i 1B między dwóch implementerów; trzeci agent recenzuje nawigację między sekcjami.
- [ ] Dla każdej strony porównać opis z aktualnymi specyfikacjami, konfiguracją Sphinx, API v2 i bieżącym UI/runtime.
- [ ] Ujednolicić metadane, status, odnośniki wejścia/wyjścia i nazewnictwo bez zmiany istniejącej architektury informacji.
- [ ] Uruchomić walidatory IA, granicy publiczne/wewnętrzne, przykładów oraz ścisły build.

### Task 4: Fala 2 — kompletne publiczne Python API

- [ ] Równolegle przydzielić cztery rozłączne domeny 2A–2D; przy limicie agentów wykonać je w dwóch podfalach.
- [ ] Dla każdego konstruktora sprawdzić eksport w `packages/fullmag-py`, sygnaturę, domyślne wartości, walidację, obniżanie do `ProblemIR` i round-trip.
- [ ] Dla stron indeksowych sprawdzić kompletność dzieci oraz spójność ścieżek użytkownika od modelu do wyników.
- [ ] Uruchomić testy udokumentowanego API, guard stage-first, walidację wszystkich map API i rendered HTML.
- [ ] Wykonać krzyżową recenzję każdej domeny przez agenta, który jej nie edytował.

### Task 5: Fala 3 — fizyka i metody numeryczne

- [ ] Równolegle przydzielić domeny 3A–3D, zachowując osobnych właścicieli źródeł i map.
- [ ] Przed zmianą każdej strony przeczytać odpowiadającą notę `docs/physics`, specyfikację/ADR i symbole implementacji wskazane przez mapę.
- [ ] Dodać lub świadomie rozstrzygnąć mapy dla sześciu stron naukowych, które dziś ich nie mają; żadna merytoryczna strona naukowa nie może pozostać bez mapy.
- [ ] Zweryfikować równania, znaki, jednostki SI, warunki brzegowe, założenia, obsługę backendów, ograniczenia i plan walidacji.
- [ ] Uruchomić wszystkie mapy źródłowe i rendered HTML, a następnie przekazać partie do niezależnej recenzji naukowej.

### Task 6: Niezależny audyt kompletności 227/227

- [ ] Wygenerować ponownie listę `rg --files public_docs/site -g '*.md'` i porównać zbiór z manifestem poniżej: dokładnie 227, bez braków i duplikatów.
- [ ] Dla każdego wpisu zebrać: recenzenta, wynik faktograficzny, wynik redakcyjny, wynik nawigacji, wynik testu/mapy i ewentualne świadome `no-change`.
- [ ] Sprawdzić wszystkie statusy `partial/planned/draft` pod kątem uczciwości oraz wszystkie twierdzenia `implemented/supported/validated` pod kątem dowodu.
- [ ] Sprawdzić brak surowych delimiterów MathJax w źródle, ale nie odrzucać legalnego `\(...\)` generowanego w HTML.
- [ ] Oznaczyć checkbox strony dopiero po zamknięciu pełnego rekordu audytu.

### Task 7: Końcowe bramki publikacji

Uruchomić z czystym katalogiem build:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s .agents\skills\scientific-documentation-contract\scripts -p 'test_*.py' -v
.\.venv\Scripts\python.exe -m unittest scripts/test_public_docs_information_architecture.py -v
.\.venv\Scripts\python.exe scripts/check_public_docs_information_architecture.py --root public_docs/site
.\.venv\Scripts\python.exe -m unittest scripts/test_check_public_doc_examples.py -v
.\.venv\Scripts\python.exe scripts/check_public_doc_examples.py --root public_docs/site
.\.venv\Scripts\python.exe -m unittest scripts/test_public_docs_timezone_fallback.py scripts/test_public_docs_responsive_tables.py -v
.\.venv\Scripts\python.exe scripts/check_public_docs_boundary.py
$env:PYTHONPATH='packages/fullmag-py/src'
.\.venv\Scripts\python.exe -m unittest packages/fullmag-py/tests/test_public_python_api_documentation.py -v
.\.venv\Scripts\python.exe -m unittest packages/fullmag-py/tests/test_public_exchange_documentation.py -v
.\.venv\Scripts\python.exe -m unittest packages/fullmag-py/tests/test_material_dmi_units.py -v
.\.venv\Scripts\sphinx-build.exe -E -a -b html -W -n --keep-going public_docs/site public_docs/site/_build/html
.\.venv\Scripts\sphinx-build.exe -E -a -b changes -W -n --keep-going -D version=development public_docs/site public_docs/site/_build/version-changes
.\.venv\Scripts\sphinx-build.exe -E -a -b linkcheck -W -n --keep-going public_docs/site public_docs/site/_build/linkcheck
```

- [ ] Zweryfikować wszystkie mapy `.source-map.json` względem źródła i odpowiadającego HTML.
- [ ] Potwierdzić brak ostrzeżeń, błędnych linków, brakujących dokumentów i nieosiągalnych stron poza jawnie zatwierdzonymi wyjątkami.
- [ ] Poprosić niezależnego agenta o końcowy code/documentation review całego diffu.
- [ ] Sporządzić po polsku raport 227/227 z listą zmian, utrzymanych ograniczeń i dokładnymi wynikami bramek.

---

## Manifest przeglądu 227/227

Checkbox oznacza nie tylko przeczytanie pliku, lecz pełną definicję ukończenia pojedynczej strony oraz niezależną recenzję.

### Fala 1A — powłoka, start i changelog (9)

- [ ] `public_docs/site/changelog/index.md`
- [ ] `public_docs/site/getting-started/choosing-a-solver.md`
- [ ] `public_docs/site/getting-started/control-room.md`
- [ ] `public_docs/site/getting-started/first-fdm-simulation.md`
- [ ] `public_docs/site/getting-started/first-fem-simulation.md`
- [ ] `public_docs/site/getting-started/index.md`
- [ ] `public_docs/site/getting-started/installation.md`
- [ ] `public_docs/site/index.md`
- [ ] `public_docs/site/README.md`

### Fala 1B — produkt, architektura, backend i walidacja (26)

- [ ] `public_docs/site/architecture/index.md`
- [ ] `public_docs/site/architecture/planner-and-capabilities.md`
- [ ] `public_docs/site/architecture/product.md`
- [ ] `public_docs/site/architecture/provenance.md`
- [ ] `public_docs/site/architecture/runtime.md`
- [ ] `public_docs/site/architecture/semantic-model.md`
- [ ] `public_docs/site/architecture/ui-architecture.md`
- [ ] `public_docs/site/backend/index.md`
- [ ] `public_docs/site/frontend/control-room/index.md`
- [ ] `public_docs/site/frontend/index.md`
- [ ] `public_docs/site/frontend/meshing/airbox-mesh.md`
- [ ] `public_docs/site/frontend/meshing/build-lifecycle.md`
- [ ] `public_docs/site/frontend/meshing/fdm-grid-view.md`
- [ ] `public_docs/site/frontend/meshing/index.md`
- [ ] `public_docs/site/frontend/meshing/object-mesh.md`
- [ ] `public_docs/site/frontend/meshing/python-round-trip.md`
- [ ] `public_docs/site/frontend/meshing/quality-and-reports.md`
- [ ] `public_docs/site/frontend/meshing/region-mesh.md`
- [ ] `public_docs/site/frontend/state-and-commands/index.md`
- [ ] `public_docs/site/frontend/visualization/index.md`
- [ ] `public_docs/site/validation/analytical-cases.md`
- [ ] `public_docs/site/validation/cpu-gpu-parity.md`
- [ ] `public_docs/site/validation/fem-fdm-comparison.md`
- [ ] `public_docs/site/validation/index.md`
- [ ] `public_docs/site/validation/mumag-standard-problems.md`
- [ ] `public_docs/site/validation/qualification-status.md`

### Fala 2A — Python API: model autora (24)

- [ ] `public_docs/site/python-api/geometry/auxiliary-geometry.md`
- [ ] `public_docs/site/python-api/geometry/boolean-operations.md`
- [ ] `public_docs/site/python-api/geometry/imported-geometry.md`
- [ ] `public_docs/site/python-api/geometry/index.md`
- [ ] `public_docs/site/python-api/geometry/primitives.md`
- [ ] `public_docs/site/python-api/geometry/regions.md`
- [ ] `public_docs/site/python-api/geometry/transforms.md`
- [ ] `public_docs/site/python-api/geometry/universe-and-domain.md`
- [ ] `public_docs/site/python-api/index.md`
- [ ] `public_docs/site/python-api/magnets-and-textures/ferromagnet.md`
- [ ] `public_docs/site/python-api/magnets-and-textures/index.md`
- [ ] `public_docs/site/python-api/magnets-and-textures/initial-magnetization.md`
- [ ] `public_docs/site/python-api/magnets-and-textures/preset-textures.md`
- [ ] `public_docs/site/python-api/magnets-and-textures/uniform-texture.md`
- [ ] `public_docs/site/python-api/materials/elastic-materials.md`
- [ ] `public_docs/site/python-api/materials/index.md`
- [ ] `public_docs/site/python-api/materials/magnetostriction-laws.md`
- [ ] `public_docs/site/python-api/materials/material.md`
- [ ] `public_docs/site/python-api/materials/spatial-parameter-fields.md`
- [ ] `public_docs/site/python-api/problem/index.md`
- [ ] `public_docs/site/python-api/problem/problem-ir.md`
- [ ] `public_docs/site/python-api/problem/problem.md`
- [ ] `public_docs/site/python-api/problem/round-trip.md`
- [ ] `public_docs/site/python-api/problem/validation.md`

### Fala 2B — Python API: fizyka i wymuszenia (26)

- [ ] `public_docs/site/python-api/boundary-conditions/floquet-boundary-conditions.md`
- [ ] `public_docs/site/python-api/boundary-conditions/index.md`
- [ ] `public_docs/site/python-api/boundary-conditions/mechanical-boundary-conditions.md`
- [ ] `public_docs/site/python-api/boundary-conditions/periodic-boundary-conditions.md`
- [ ] `public_docs/site/python-api/current-and-excitations/cpw-antenna.md`
- [ ] `public_docs/site/python-api/current-and-excitations/current-transport.md`
- [ ] `public_docs/site/python-api/current-and-excitations/index.md`
- [ ] `public_docs/site/python-api/current-and-excitations/microstrip-antenna.md`
- [ ] `public_docs/site/python-api/current-and-excitations/prescribed-current.md`
- [ ] `public_docs/site/python-api/current-and-excitations/regional-field-drive.md`
- [ ] `public_docs/site/python-api/current-and-excitations/rf-drive.md`
- [ ] `public_docs/site/python-api/interactions/bulk-dmi.md`
- [ ] `public_docs/site/python-api/interactions/cubic-anisotropy.md`
- [ ] `public_docs/site/python-api/interactions/demagnetization.md`
- [ ] `public_docs/site/python-api/interactions/drift-diffusion-spin-torque.md`
- [ ] `public_docs/site/python-api/interactions/exchange.md`
- [ ] `public_docs/site/python-api/interactions/index.md`
- [ ] `public_docs/site/python-api/interactions/inter-region-couplings.md`
- [ ] `public_docs/site/python-api/interactions/interfacial-dmi.md`
- [ ] `public_docs/site/python-api/interactions/magnetoelastic.md`
- [ ] `public_docs/site/python-api/interactions/oersted-field.md`
- [ ] `public_docs/site/python-api/interactions/spin-orbit-torque.md`
- [ ] `public_docs/site/python-api/interactions/spin-transfer-torque.md`
- [ ] `public_docs/site/python-api/interactions/thermal-noise.md`
- [ ] `public_docs/site/python-api/interactions/uniaxial-anisotropy.md`
- [ ] `public_docs/site/python-api/interactions/zeeman.md`

### Fala 2C — Python API: dyskretyzacja i siatkowanie (28)

- [ ] `public_docs/site/python-api/discretization/discretization-hints.md`
- [ ] `public_docs/site/python-api/discretization/fdm-multilayer-convolution.md`
- [ ] `public_docs/site/python-api/discretization/fdm.md`
- [ ] `public_docs/site/python-api/discretization/fem.md`
- [ ] `public_docs/site/python-api/discretization/hybrid.md`
- [ ] `public_docs/site/python-api/discretization/index.md`
- [ ] `public_docs/site/python-api/discretization/mesh-controls.md`
- [ ] `public_docs/site/python-api/discretization/per-object-meshing.md`
- [ ] `public_docs/site/python-api/meshing/fdm/boundary-correction.md`
- [ ] `public_docs/site/python-api/meshing/fdm/grid.md`
- [ ] `public_docs/site/python-api/meshing/fdm/index.md`
- [ ] `public_docs/site/python-api/meshing/fdm/per-magnet-grids.md`
- [ ] `public_docs/site/python-api/meshing/fem/airbox/build.md`
- [ ] `public_docs/site/python-api/meshing/fem/airbox/geometry.md`
- [ ] `public_docs/site/python-api/meshing/fem/airbox/grading.md`
- [ ] `public_docs/site/python-api/meshing/fem/airbox/index.md`
- [ ] `public_docs/site/python-api/meshing/fem/build-and-quality.md`
- [ ] `public_docs/site/python-api/meshing/fem/ferromagnet/boundary-layers.md`
- [ ] `public_docs/site/python-api/meshing/fem/ferromagnet/free-tetrahedral.md`
- [ ] `public_docs/site/python-api/meshing/fem/ferromagnet/imported-mesh.md`
- [ ] `public_docs/site/python-api/meshing/fem/ferromagnet/index.md`
- [ ] `public_docs/site/python-api/meshing/fem/ferromagnet/swept-hex.md`
- [ ] `public_docs/site/python-api/meshing/fem/ferromagnet/swept-prism.md`
- [ ] `public_docs/site/python-api/meshing/fem/ferromagnet/thin-film-tetrahedral.md`
- [ ] `public_docs/site/python-api/meshing/fem/index.md`
- [ ] `public_docs/site/python-api/meshing/fem/regions.md`
- [ ] `public_docs/site/python-api/meshing/fem/study-defaults.md`
- [ ] `public_docs/site/python-api/meshing/index.md`

### Fala 2D — Python API: wykonanie, badania i wyniki (25)

- [ ] `public_docs/site/python-api/dynamics/adaptive-timestep.md`
- [ ] `public_docs/site/python-api/dynamics/field-refresh.md`
- [ ] `public_docs/site/python-api/dynamics/index.md`
- [ ] `public_docs/site/python-api/dynamics/integrators.md`
- [ ] `public_docs/site/python-api/dynamics/llg.md`
- [ ] `public_docs/site/python-api/outputs/autosave.md`
- [ ] `public_docs/site/python-api/outputs/dispersion-and-response.md`
- [ ] `public_docs/site/python-api/outputs/fields-and-scalars.md`
- [ ] `public_docs/site/python-api/outputs/index.md`
- [ ] `public_docs/site/python-api/outputs/modes-and-spectra.md`
- [ ] `public_docs/site/python-api/outputs/quantities.md`
- [ ] `public_docs/site/python-api/outputs/snapshots.md`
- [ ] `public_docs/site/python-api/runtime/artifacts.md`
- [ ] `public_docs/site/python-api/runtime/backend-policy.md`
- [ ] `public_docs/site/python-api/runtime/index.md`
- [ ] `public_docs/site/python-api/runtime/provenance.md`
- [ ] `public_docs/site/python-api/runtime/results.md`
- [ ] `public_docs/site/python-api/runtime/runtime-selection.md`
- [ ] `public_docs/site/python-api/runtime/simulation.md`
- [ ] `public_docs/site/python-api/studies/eigenmodes.md`
- [ ] `public_docs/site/python-api/studies/frequency-response.md`
- [ ] `public_docs/site/python-api/studies/hysteresis.md`
- [ ] `public_docs/site/python-api/studies/index.md`
- [ ] `public_docs/site/python-api/studies/relaxation.md`
- [ ] `public_docs/site/python-api/studies/time-evolution.md`

### Fala 3A — fizyka: fundamenty i strony zbiorcze (11)

- [ ] `public_docs/site/physics/conventions.md`
- [ ] `public_docs/site/physics/foundations/boundary-conditions.md`
- [ ] `public_docs/site/physics/foundations/conventions-and-units.md`
- [ ] `public_docs/site/physics/foundations/effective-field.md`
- [ ] `public_docs/site/physics/foundations/index.md`
- [ ] `public_docs/site/physics/foundations/llg-equation.md`
- [ ] `public_docs/site/physics/foundations/micromagnetic-energy.md`
- [ ] `public_docs/site/physics/foundations/observables.md`
- [ ] `public_docs/site/physics/geometry-and-materials.md`
- [ ] `public_docs/site/physics/index.md`
- [ ] `public_docs/site/physics/interactions/index.md`

### Fala 3B — fizyka: interakcje (26)

- [ ] `public_docs/site/physics/interactions/anisotropy/cubic.md`
- [ ] `public_docs/site/physics/interactions/anisotropy/index.md`
- [ ] `public_docs/site/physics/interactions/anisotropy/uniaxial.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/boundary-conditions.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/fdm-convolution.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/fem-bem.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/fem-poisson-airbox.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/index.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/mathematical-formulation.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/multilayer-convolution.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/periodic-demag.md`
- [ ] `public_docs/site/physics/interactions/demagnetization/validation.md`
- [ ] `public_docs/site/physics/interactions/dmi/boundary-conditions.md`
- [ ] `public_docs/site/physics/interactions/dmi/bulk.md`
- [ ] `public_docs/site/physics/interactions/dmi/index.md`
- [ ] `public_docs/site/physics/interactions/dmi/interfacial.md`
- [ ] `public_docs/site/physics/interactions/dmi/validation.md`
- [ ] `public_docs/site/physics/interactions/drift-diffusion-spin-torque/index.md`
- [ ] `public_docs/site/physics/interactions/exchange/index.md`
- [ ] `public_docs/site/physics/interactions/inter-region-couplings/index.md`
- [ ] `public_docs/site/physics/interactions/magnetoelastic/index.md`
- [ ] `public_docs/site/physics/interactions/oersted-field/index.md`
- [ ] `public_docs/site/physics/interactions/spin-orbit-torque/index.md`
- [ ] `public_docs/site/physics/interactions/spin-transfer-torque/index.md`
- [ ] `public_docs/site/physics/interactions/thermal-noise/index.md`
- [ ] `public_docs/site/physics/interactions/zeeman/index.md`

### Fala 3C — metody numeryczne: siatkowanie (28)

- [ ] `public_docs/site/numerical-methods/meshing/airbox.md`
- [ ] `public_docs/site/numerical-methods/meshing/fdm-grids.md`
- [ ] `public_docs/site/numerical-methods/meshing/fdm/boundary-correction.md`
- [ ] `public_docs/site/numerical-methods/meshing/fdm/index.md`
- [ ] `public_docs/site/numerical-methods/meshing/fdm/multi-magnet-grids.md`
- [ ] `public_docs/site/numerical-methods/meshing/fdm/periodic-grids.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem-shared-domain.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/airbox/boundary-closure.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/airbox/geometry.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/airbox/grading.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/airbox/index.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/airbox/periodic-airbox.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/ferromagnet/boundary-layers.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/ferromagnet/free-tetrahedral.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/ferromagnet/imported-mesh.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/ferromagnet/index.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/ferromagnet/mixed-elements.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/ferromagnet/swept-hex.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/ferromagnet/swept-prism.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/ferromagnet/thin-film-tetrahedral.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/index.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/shared-domain/assembly-and-conformity.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/shared-domain/build-modes-and-fallbacks.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/shared-domain/index.md`
- [ ] `public_docs/site/numerical-methods/meshing/fem/shared-domain/selectors-and-attributes.md`
- [ ] `public_docs/site/numerical-methods/meshing/index.md`
- [ ] `public_docs/site/numerical-methods/meshing/refinement.md`
- [ ] `public_docs/site/numerical-methods/meshing/swept-meshes.md`

### Fala 3D — metody numeryczne: pozostałe metody (24)

- [ ] `public_docs/site/numerical-methods/demag-solvers/fdm-convolution.md`
- [ ] `public_docs/site/numerical-methods/demag-solvers/fem-bem.md`
- [ ] `public_docs/site/numerical-methods/demag-solvers/fem-poisson-airbox.md`
- [ ] `public_docs/site/numerical-methods/demag-solvers/index.md`
- [ ] `public_docs/site/numerical-methods/demag-solvers/periodic-demag.md`
- [ ] `public_docs/site/numerical-methods/eigensolvers/index.md`
- [ ] `public_docs/site/numerical-methods/eigensolvers/linearized-llg.md`
- [ ] `public_docs/site/numerical-methods/eigensolvers/modal-validation.md`
- [ ] `public_docs/site/numerical-methods/frequency-domain/floquet-response.md`
- [ ] `public_docs/site/numerical-methods/frequency-domain/index.md`
- [ ] `public_docs/site/numerical-methods/frequency-domain/response-solver.md`
- [ ] `public_docs/site/numerical-methods/index.md`
- [ ] `public_docs/site/numerical-methods/interpolation-and-state-transfer/fdm-to-fem.md`
- [ ] `public_docs/site/numerical-methods/interpolation-and-state-transfer/fem-to-fdm.md`
- [ ] `public_docs/site/numerical-methods/interpolation-and-state-transfer/index.md`
- [ ] `public_docs/site/numerical-methods/relaxation/index.md`
- [ ] `public_docs/site/numerical-methods/relaxation/llg-relaxation.md`
- [ ] `public_docs/site/numerical-methods/relaxation/nonlinear-cg.md`
- [ ] `public_docs/site/numerical-methods/relaxation/projected-gradient.md`
- [ ] `public_docs/site/numerical-methods/relaxation/stopping-criteria.md`
- [ ] `public_docs/site/numerical-methods/time-integration/adaptive-stepping.md`
- [ ] `public_docs/site/numerical-methods/time-integration/explicit-runge-kutta.md`
- [ ] `public_docs/site/numerical-methods/time-integration/index.md`
- [ ] `public_docs/site/numerical-methods/time-integration/tangent-plane-methods.md`

**Suma manifestu:** 227/227 unikalnych plików.

