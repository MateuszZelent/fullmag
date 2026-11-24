# Zachowanie intencji wykonania

(problem-statement)=
## Zakres

Intencja wykonania należy do authoringu sesji; nie zmienia transportu, Biota–Savarta ani LLG. Eksport ma zachować każdy etap oraz końcowy workspace. Capture nie może włączać interaktywności ani uruchamiać solvera.

Implementację i lekkie testy zatwierdzono 07.11.2026. Odbiór managed nowego pakietu jest osobną bramką. Wyniki GSG i ich kwalifikacja nie są zmieniane.

(governing-equations)=
## Aktualizacja sterowania

To reguła aktualizacji metadanych, nie równanie fizyczne:

```{math}
:label: eq-execution-intent-override
q_k^{(n+1)} =
\begin{cases}
p_k^{(n)}, & k \in P_n,\\
q_k^{(n)}, & k \notin P_n.
\end{cases}
```

Oba obecne klucze waliduje się przed zapisem. Błąd parsera lub materializera odtwarza poprzednią wartość albo brak klucza. Źródło: `crates/fullmag-application/src/script_stage_materialization.rs::materialize_pipeline_primitive`.

(symbols-and-si-units)=
## Symbole i SI

| Token | Znaczenie | SI |
|---|---|---|
| $q_k^{(n)}$ | Stan klucza przed etapem | $1$ |
| $p_k^{(n)}$ | Jawna wartość w payloadzie | $1$ |
| $k$ | Klucz interactive_session_requested lub wait_for_solve | $1$ |
| $n$ | Indeks deklaracji etapu | $1$ |
| $P_n$ | Zbiór obecnych kluczy etapu | $1$ |

(assumptions-and-validity)=
## Założenia

Brak klucza, `False` i `True` są różnymi stanami override. Pola study nie dodają pól fizycznych `ProblemIR`. Istniejące mapy stage `extra` i primitive `payload` zachowują intencję konkretnego etapu.

Otwarte `runtime_metadata` zachowuje surowe wartości i ich typy, także historyczny tekst `"false"`. Dopiero typowana scena, renderer i wykonanie nowego primitive wymagają booleanów. Nie stosuje się tam truthiness.

(python-api)=
## Python API

Obie metody są również dostępne przez StudyBuilder. Ich dotychczasowa konwersja `bool(enabled)` nie jest zmieniana.

| Python | Typ | Domyślna wartość | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| fm.interactive(enabled) | bool | True przy wywołaniu; początkowy stan False | $1$ | setter zachowuje bool(enabled); scena wymaga bool | Żądanie pozostawienia sesji otwartej | wspólny authoring FDM/FEM CPU/GPU | problem_meta.runtime_metadata.interactive_session_requested |
| fm.wait_for_solve(enabled) | bool | True przy wywołaniu; początkowy stan False | $1$ | setter zachowuje bool(enabled); scena wymaga bool | Żądanie bramki Compute | wspólny authoring FDM/FEM CPU/GPU | problem_meta.runtime_metadata.wait_for_solve |

Pola study w builderze i scenie mają `Option<bool>`: brak to `None`, obecny boolean to `Some`. Obecne `null`, tekst, liczba, tablica lub obiekt są odrzucane. JSON Merge Patch `null` usuwa klucz przed walidacją dokumentu.

Przykład jest małą regresją authoringu, a nie modelem publikacji. Loader z `lightweight_assets=True` nie wykonuje Solve.

```python
# %% Deklaracja
import fullmag as fm
from pathlib import Path
from tempfile import TemporaryDirectory
from fullmag.runtime.script_builder import render_loaded_problem_as_script

script = '''import fullmag as fm
study = fm.study('execution-intent-example')
study.engine('fdm')
study.device('cpu')
study.mode('strict')
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(10e-9, 10e-9, 5e-9), name='film')
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1, 0, 0)
study.interactive(True)
study.wait_for_solve(True)
study.stages.add_run(stage_id='first', until=1e-12)
study.interactive(False)
study.wait_for_solve(False)
study.stages.add_run(stage_id='last', until=2e-12)
study.interactive(True)
study.wait_for_solve(False)
'''

# %% Odczyt i eksport bez solvera
with TemporaryDirectory() as folder, fm.ExecutionContext():
    path = Path(folder) / 'example.py'
    path.write_text(script, encoding='utf-8')
    loaded = fm.load_problem_from_script(path, lightweight_assets=True)
    rendered = render_loaded_problem_as_script(loaded)
    print(rendered)
```

Stałe przykładu są w SI: komórka 5 nm, próbka 10×10×5 nm, $M_s=800000\,\mathrm{A/m}$, $A=13\,\mathrm{pJ/m}$, bezwymiarowe $\alpha=0.02$, magnetyzacja jednostkowa w osi x, końce etapów 1 i 2 ps. Nie jest to kwalifikacja solvera.

(problem-ir)=
## Python → scena → ProblemIR

| Kanał | Właściciel wartości |
|---|---|
| metody study | Stan zadany w skrypcie |
| builder top-level / scene.study | Opcjonalne flagi końcowego workspace |
| stage.extra / primitive.payload | Flagi migawki etapu |
| problem_meta.runtime_metadata | Skuteczne flagi istniejącego launchera |
| canonical Python | Flagi przed etapem, finalny workspace po deklaracjach |

Nie dodaje się operatora planera. `_build_problem` zachowuje pomijanie domyślnego wait=False i priorytet `_extra_runtime_metadata`. Nie migruje się wyników ani historycznego provenance.

Poniższy wycinek stage IR pochodzi z rzeczywistego export-run-config --skip-geometry-assets dla powyższego przykładu; wybrano wyłącznie dwa omawiane klucze runtime_metadata. Pominięte wait oznacza skuteczne False.

```json
[
  {
    "problem_meta": {
      "runtime_metadata": {
        "interactive_session_requested": true,
        "wait_for_solve": true
      }
    }
  },
  {
    "problem_meta": {
      "runtime_metadata": {
        "interactive_session_requested": false
      }
    }
  }
]
```

Pełny run-config, rendered.py i canonical-flags.json są zachowane w prywatnym control volume pod verification/antenna-authoring-roundtrip-20261107/documentation-v2. Export base, pierwszy etap i końcowy workspace są osobnymi nośnikami; nie wolno utożsamiać export base z pierwszą migawką etapu. Odbiór managed pozostaje niewykonany.

(round-trip-and-failure-semantics)=
## Roundtrip i odmowy

Zadana intencja (requested intent) jest odrębna od rozstrzygniętego wykonania (resolved execution). Błędy walidacji (validation errors) obejmują niebooleany na typowanych granicach. Niewspierane kombinacje (unsupported combinations): nowa scena wymaga spójnego pakietu Python/authoring/API; starszy runtime z deny_unknown_fields odrzuci dokument z nowymi polami.

Stare dokumenty bez kluczy pozostają czytelne. Rollback do starego pakietu używa zachowanego projektu sprzed nowych pól; nie usuwa się flag automatycznie.

Pierwszy etap, ostatni etap i finalny workspace nie są spłaszczane. CLI nadal wybiera wait z pierwszego, keep-alive z ostatniego; jawne flagi launchera zachowują pierwszeństwo. Zmiany Ms/geometrii nadal powodują odmowę nieobsługiwanego wieloetapowego eksportu. Z fizycznej sygnatury wyłączono tylko dwa klucze sterowania.

(discrete-realization)=
## Realizacje i backendy

| Solver | Urządzenie | Zakres i ograniczenia |
|---|---|---|
| FDM | CPU | Wspólny authoring, lekkie regresje bez Solve |
| FDM | GPU | Wspólny authoring, brak nowej kwalifikacji GPU |
| FEM | CPU | Wspólny authoring, managed odbiór niewykonany |
| FEM | GPU | Wspólny authoring, brak nowej kwalifikacji GPU |

Nie ma odrębnej fizyki ani dyskretyzacji flag dla urządzeń. Tolerancje, precyzja i budżety siatki pozostają bez zmian. Shared primitive zachowuje tylko poprzednie wartości dwóch kluczy; nie klonuje ciężkiego ProblemIR dla rollbacku intencji.

(implementation-mapping)=
## Mapa implementacji

Capture/live zachowują zadany stan. Generic export kopiuje surowe wartości; adapter sceny, renderer i shared primitive sprawdzają bool. Ręczny adapter overrides również zachowuje obecność pól. Indeks kodu niżej wiąże regułę z konkretnymi symbolami.

(validation)=
## Walidacja

Python: etapy/workspace, publiczny run-config, raw typy full/thin, missing/False/True, stare sceny, live capture/trim oraz odmowa mutacji Ms. Lekkie assets i blokada procesu solvera ograniczają test do authoringu.

Rust: zapisane regresje serde/adapterów, flat/nested/disabled i rollbacku. Lokalnie ich nie kompilowano. CI poprzedniego commita nie kwalifikuje nowych źródeł.

Dziennik: `.superpowers/sdd/2026-11-07-execution-intent-roundtrip-implementation/progress.md`.
Dowody w prywatnym control volume grupy3203:
`verification/antenna-authoring-roundtrip-20261107/approved-implementation-python-v1`.
Raport odbioru zapisuje dokładne liczby i digesty. Ta strona nie deklaruje zielonego CI ani odbioru publicznego UI nowego pakietu.

(limitations)=
## Ograniczenia i kompletność

- [x] Wspólny model flag, bez nowych pól fizycznych.
- [x] Zachowanie starych dokumentów i surowych metadanych.
- [ ] Testy Rust w dozwolonym CI.
- [ ] Managed odbiór spójnego pakietu i UI bez Compute.
- [ ] Reprodukcja publikacji — osobny cel, niezaliczony tą poprawką.

Bez Solve, prepare-only, restartu lub zwalniania rezerwacji. Bramka niezakwalifikowanej bazy LLG pozostaje.

(scientific-bibliography)=
## Bibliografia kontraktu

Zmiana dotyczy sterowania aplikacją, nie nowej teorii fizycznej.
Semantykę usuwania kluczy opisuje [RFC7396 — JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396).
Wymagania i przypięty zakres: `docs/superpowers/plans/2026-11-07-execution-intent-roundtrip-implementation.md`.
Zgoda użytkownika i SHA planu są zapisane osobno; historyczna etykieta planu nie cofa zgody.

(source-code-index)=
## Indeks źródeł

| ID | Ścieżka | Symbol | Odpowiedzialność | Stan |
|---|---|---|---|---|
| capture | packages/fullmag-py/src/fullmag/world.py | capture_workspace_problem | Zachować stan końcowego workspace. | źródła; managed osobno |
| render | packages/fullmag-py/src/fullmag/runtime/script_builder.py | _render_stages | Odtworzyć flagi przed każdym etapem. | źródła; managed osobno |
| copy | packages/fullmag-py/src/fullmag/runtime/execution_intent.py | copy_execution_intent | Kopiować surowe wartości. | źródła; managed osobno |
| validate | packages/fullmag-py/src/fullmag/runtime/execution_intent.py | validate_execution_intent_fields | Walidować typowane granice. | źródła; managed osobno |
| builder | crates/fullmag-authoring/src/builder.rs | ScriptBuilderState | Przenieść opcjonalną intencję. | źródła; managed osobno |
| scene | crates/fullmag-authoring/src/scene.rs | SceneStudyState | Przenieść opcjonalną intencję sceny. | źródła; managed osobno |
| overrides | crates/fullmag-authoring/src/adapters.rs | scene_document_to_script_builder_overrides | Zachować obecność w eksporcie. | źródła; managed osobno |
| primitive | crates/fullmag-application/src/script_stage_materialization.rs | materialize_pipeline_primitive | Zastosować flagi; odtworzyć po błędzie. | źródła; managed osobno |
| regression | packages/fullmag-py/tests/test_execution_intent_roundtrip.py | class ExecutionIntentRoundtripTests | Sprawdzić roundtrip i odmowy. | źródła; managed osobno |
