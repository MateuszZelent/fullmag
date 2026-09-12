# Raport Task 1 — frozen spins: ADR, kontrakt fizyczny i kwalifikacja

## Status

`DONE_WITH_CONCERNS`

Sześć wymaganych artefaktów Task 1 zostało utworzonych. Bezpośredni walidator
noty naukowej, jego 23 testy, test granicy bieżącego Python API, skan
niedomkniętych markerów, sprawdzenie whitespace i strict Sphinx zakończyły się
powodzeniem. Dwa repo-wide guardy `public_docs` są czerwone wyłącznie na
istniejących stronach poza zakresem Task 1; nie zostały naprawione, aby nie
naruszyć zamrożonego zakresu i cudzych zmian.

Nie wykonano `git add`, `git commit`, `git push` ani modyfikacji kodu.

## Zrealizowany zakres

Utworzono:

1. `docs/adr/0026-frozen-spins-constraint-and-selection-model.md`
2. `docs/physics/0996-frozen-spins-constraint.md`
3. `docs/physics/0996-frozen-spins-constraint.source-map.json`
4. `docs/specs/selection-expr-v1.md`
5. `docs/specs/frozen-spins-v1.md`
6. `docs/validation/frozen-spins-qualification-matrix.md`

Raport wykonania:

7. `.superpowers/sdd/task-1-report.md`

Istniejąca modyfikacja `.superpowers/sdd/progress.md` była obecna przed Task 1
i nie została dotknięta.

## Zamknięte decyzje

### Semantyka i IR

- `FrozenSpins` jest osobnym `MagnetizationConstraintIR`, nie parametrem
  materiałowym ani właściwością `ObjectRegionIR`.
- `ProblemIR` ma docelowo top-level `selections[]` i
  `magnetization_constraints[]`; Python stage sugar obniża się do top-level
  definicji z activation scope.
- Publiczne wersje to `selection_expr.v1` i `frozen_spins.v1`; ADR przyjmuje
  docelowy bump `ProblemIR 0.3.0 -> 0.4.0` z addytywną migracją pustych
  kolekcji.
- Typed AST odrzuca `eval`, lambdy i stringowe programy. Zwykłe float `==` nie
  należy do V1; używa się `approx` lub `between`.
- Publiczny `disk` obniża się do skończonego cylindra. `through_object` wymaga
  obiektu, skończonych bounds i przecięcia z jego domeną.

### Capture i runtime

- V1 wspiera `static` i `snapshot_at_activation`.
- `capture_current_at_activation` materializuje maskę i przechwytuje referencję
  atomowo z tej samej stabilnej rewizji, po zwykłej normalizacji/walidacji
  stanu stage i przed pierwszą próbą kroku.
- Constraint obowiązuje od początku zarówno w relaksacji, jak i dynamice.
- Backend maskuje pełny RHS dopiero po LLG, STT, SOT, termice i pozostałych
  źródłach, odtwarza referencję po każdym kandydacie i liczy autorytatywne
  redukcje po swobodnych DOF.
- Energia i pola pozostają pełnodomenowe; frozen spiny nadal wpływają na free
  DOF.
- TPI używa essential true DOF albo równoważnej eliminacji w operatorze.
- All-frozen kończy się bez iteracji z
  `stop_reason="all_active_dofs_frozen"`.

### Dyskretyzacja, pamięć i produkt

- FDM otrzymuje osobny `frozen_mask`; `region_mask` nie może go zastępować.
- Authoritative FEM preview i solver używają magnetic true DOF. Node/centroid
  preview może być tylko jawnie nieautorytatywny.
- Referencyjna reprezentacja runtime V1 jest dense: `u8` maska i dense
  trójskładnikowa referencja w precyzji backendu, z osobnym no-mask fast path.
- API pozostaje resource-first: cienki status, rewizjonowane resources i
  binarna data plane dla ciężkiej maski.
- Requested intent i resolved execution są zachowywane osobno; forced lane nie
  może wykonać cichego fallbacku ani pominąć constraintu.

## Kontrakt naukowy

Nota definiuje i mapuje:

- $F \subseteq A$ oraz $U=A\setminus F$;
- $\mathbf m_i(t)=\mathbf m_i^\star$ na $F$;
- constrained energy $E_c(\mathbf m_U)=E(\mathbf m_U,\mathbf m_F^\star)$;
- pełny złożony RHS wraz z LLG, STT, SOT i termiką;
- final-RHS masking;
- candidate restore;
- free-domain RHS i torque reductions;
- TPI essential increment;
- all-frozen, checkpoint, provenance i free/all telemetry.

Każde równanie ma labelled MyST math, kompletną tabelę symboli i jednostek SI
oraz source-map. Planowane równania wskazują wyłącznie na unikalne
`DOC-ANCHOR` z `evidence_status=planned_contract`. Aktualne źródła kodu mapują
jedynie istniejących właścicieli i luki: granicę wersji IR, dwa różne
evaluatory geometrii, FEM membership preview, `ObjectRegion` i `fm.study`.

Nie utworzono fałszywego immutable linku dla nowych, niecommitowanych plików.
Ich indeks jawnie używa `worktree/uncommitted; path + anchor only`. Linki do
aktualnych źródeł kodu używają pełnego audytowanego SHA
`d9518082eaee2131c3e7160bd8ae952ed2f45899`.

## Macierz kwalifikacji

Macierz zawiera wymagane kolumny `IR`, `planner`, `runtime`, `scientific`,
`managed`, `browser`. Wszystkie komórki wszystkich lane'ów zaczynają jako
`UNQUALIFIED`, w tym:

- FDM CPU/reference FP64;
- FDM CUDA FP64 i FP32;
- FDM multilayer CPU/reference i CUDA;
- FEM CPU/MFEM FP64;
- FEM GPU MFEM/hypre/libCEED/CUDA FP64.

Osobna macierz algorytmów nie dziedziczy kwalifikacji między overdamped LLG,
dynamiką, explicit/adaptive RK, ABM, PG-BB, NCG, TPI, STT, SOT, termiką i
all-frozen. Dokument określa minimalny ledger dowodu z pełnym SHA, dokładną
komendą, runtime/device identity, immutable artefaktem, oraclem, tolerancjami i
reviewerem.

## Weryfikacja

### Bezpośrednie gate'y Task 1 — PASS

1. Source-map validator:

   ```text
   python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0996-frozen-spins-constraint.source-map.json --repo-root .
   exit 0
   ```

2. Testy walidatora:

   ```text
   python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
   Ran 23 tests — OK
   ```

3. Bieżąca granica Python API:

   ```text
   env PYTHONPATH=packages/fullmag-py/src python3 -c <feature detection>
   FrozenSpins: False
   select: False
   exit 0
   ```

4. Skan niedomkniętych markerów dokładnie dla plików wymaganych briefem:

   ```text
   rg -n "T[B]D|T[O]DO|do ustalenia" <cztery wymagane dokumenty>
   0 wyników
   ```

5. Checkpoint whitespace:

   ```text
   git diff --check -- docs/adr docs/physics docs/specs docs/validation
   exit 0
   ```

   Pliki są nowe i untracked, dlatego uzupełniający skan trailing whitespace
   objął wszystkie sześć dokładnych ścieżek i zwrócił 0 wyników.

6. Testy guardów dokumentacyjnych:

   ```text
   python3 -m unittest scripts/test_check_public_doc_examples.py -v
   Ran 5 tests — OK

   python3 -m unittest scripts/test_public_docs_information_architecture.py -v
   Ran 22 tests — OK

   python3 scripts/check_public_docs_boundary.py
   public documentation boundary: passed
   ```

7. Strict Sphinx:

   ```text
   sphinx-build -b html -W -n --keep-going public_docs/site /tmp/fullmag-task1-sphinx-html
   build succeeded
   ```

Nowa nota jest wewnętrzna pod `docs/physics`, a obecny Sphinx renderuje
`public_docs/site`; dlatego nie istnieje rendered HTML tej konkretnej strony do
przekazania drugiemu trybowi `validate_scientific_docs.py --rendered-html`.
Bezpośrednia walidacja źródła i strict build dostępnego drzewa zostały wykonane.

### Niezależne repo-wide gate'y — FAIL poza zakresem

1. `python3 scripts/check_public_doc_examples.py --root public_docs/site`
   zwraca exit 1 dla pięciu istniejących stron:

   - `python-api/interactions/drift-diffusion-spin-torque.md`;
   - `python-api/interactions/interfacial-dmi.md`;
   - `python-api/interactions/magnetoelastic.md`;
   - `python-api/interactions/spin-orbit-torque.md`;
   - `python-api/interactions/spin-transfer-torque.md`.

   Każda ma blok Python niespełniający pełnego wzorca
   `fm.study(...)` + `study.stages.add_*`. Task 1 nie modyfikował
   `public_docs/site`.

2. `python3 scripts/public_docs_information_architecture.py --check --root
   public_docs/site` zwraca exit 1 z istniejącymi rozjazdami `status` metadata
   względem manifestu na wielu stronach `python-api` i `physics`. Testy samego
   narzędzia przechodzą 22/22, a strict Sphinx przechodzi. Task 1 nie zmieniał
   manifestu ani tych stron.

Zgodnie z zamrożonym zakresem nie wykonano drive-by napraw tych gate'ów.

## Samoocena i concerns

1. W self-review wykryto, że `0014` jest już zajęty przez
   `docs/adr/0014-native-fem-backend-modularization.md`. Controller rozstrzygnął
   konflikt przez użycie pierwszego wolnego numeru `0026`; semantyka dokumentu
   i wszystkie odwołania pozostały niezmienione.
2. Nowe pliki pozostają untracked zgodnie z zakazem stage/commit. Z tego powodu
   branch-diff validator `validate_changed_scientific_docs.py --base ... --head
   HEAD` nie widzi ich; uruchomiono bezpośredni, właściwy walidator adjacent
   source-map. Changed-page gate zadziała dopiero po włączeniu plików do
   przyszłego commita przez właściciela.
3. Nie ma dowodu runtime frozen spins. Każde twierdzenie wykonawcze jest opisane
   jako target/planned, a wszystkie lane'y są `UNQUALIFIED`.
4. Użycie capability w bieżącym `docs/specs/capability-matrix-v0.md`, OpenAPI,
   generated transport i UI jest obowiązkiem kolejnych zadań. Task 1 definiuje
   słownik, ale nie promuje aktualnych capabilities ani nie modyfikuje plików
   poza listą briefu.

## Wniosek

Task 1 zamyka architekturę i publikacyjny kontrakt potrzebny kolejnym zadaniom.
Można rozpocząć implementację typed selektora i constraintu bez otwartej
niejednoznaczności dotyczącej właściciela semantyki, capture timing,
free/all metrics, all-frozen, FEM true DOF, dense V1, snapshot V1 oraz zakresu
relaksacja+dynamika. Nie wolno jednak traktować dokumentacji jako kwalifikacji
któregokolwiek lane'u.

## Poprawki po review Task 1

### Zamknięte findings

1. Default `membership` jest wyprowadzany deterministycznie z klasy AST:
   geometry-only normalizuje się do jawnego `static`, a state-dependent do
   jawnego `snapshot_at_activation`. Jawne `static` dla state-dependent AST
   jest błędem; jawne `snapshot_at_activation` jest legalne dla obu klas.
2. Publiczny `boundary` domyślnie jest `inclusive`; canonical IR zapisuje jawny
   znormalizowany obiekt z wersjonowanymi tolerancjami `0.0` i `1e-12`.
3. Zdefiniowano maszynę epoki aktywacji dla kolejnych i nieciągłych stage IDs,
   inactive-to-active, ponownego capture oraz checkpoint resume bez recapture.
4. `inactive_selection=warn_and_intersect` dotyczy wyłącznie raw authored
   candidate mask. Bit poza aktywną domeną w resolved/runtime/checkpoint mask
   jest twardym błędem inwariantu.
5. `max_rhs_all` i `max_torque_all_Apm` mają jawne równania i powstają na $A$
   z pełnego pre-constraint RHS/torque, z tego samego stanu i rewizji co
   redukcje `free` po $U$: po candidate restore, przed final-RHS masking.
6. Każdy overlap wymaga dokładnej równości resolved reference na wspólnych DOF
   po konwersji do precyzji lane. Dotyczy to capture-current z różnych epok;
   konflikt odrzuca całą aktywację atomowo.
7. $\dot{\mathbf m}_i$ i $\mathbf m_i^{\mathrm{candidate}}$ mają osobne wpisy
   w tabeli symboli i source-map z jednostkami odpowiednio
   $\mathrm{s^{-1}}$ oraz $1$.
8. $t$ oznacza wyłącznie czas fizyczny dynamiki w sekundach. PG-BB i NCG używają
   bezwymiarowego indeksu iteracji $k$; nie mają pseudoczasu w sekundach.

Wszystkie statusy w macierzy lane i algorytmów pozostają `UNQUALIFIED`.

### Zmienione pliki

- `docs/adr/0026-frozen-spins-constraint-and-selection-model.md` — zamknięte
  defaulty, epoka, raw/resolved invariant, pipeline metryk i overlap.
- `docs/physics/0996-frozen-spins-constraint.md` — równania `all`, dokładne
  symbole/jednostki, czas kontra iteracja, default membership, epoka i błędy.
- `docs/physics/0996-frozen-spins-constraint.source-map.json` — nowe równania,
  symbole, anchor overlap i poprawiony kontrakt parametru `membership`.
- `docs/specs/selection-expr-v1.md` — default `inclusive`, klasyfikacja
  geometry-only/state-dependent oraz raw/resolved mask semantics.
- `docs/specs/frozen-spins-v1.md` — maszyna epok i restartu, pipeline metryk,
  dokładna zgodność overlap i znormalizowany payload geometry-only.
- `docs/validation/frozen-spins-qualification-matrix.md` — przyszłe gate'y dla
  wszystkich poprawek bez promocji statusu.
- `.superpowers/sdd/task-1-report.md` — niniejszy fix ledger i dowód testów.

### Dokładne focused validators po ostatniej zmianie

1. Source-map validator:

   ```text
   python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0996-frozen-spins-constraint.source-map.json --repo-root .
   <brak stdout/stderr>
   exit 0
   ```

2. Testy walidatora:

   ```text
   python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
   .......................
   ----------------------------------------------------------------------
   Ran 23 tests in 0.777s

   OK
   exit 0
   ```

3. Skan niedomkniętych markerów:

   ```text
   rg -n "T[B]D|T[O]DO|do ustalenia" docs/adr/0026-frozen-spins-constraint-and-selection-model.md docs/physics/0996-frozen-spins-constraint.md docs/specs/selection-expr-v1.md docs/specs/frozen-spins-v1.md
   <brak wyników>
   exit 1 (oczekiwany status `rg` przy braku dopasowań)
   ```

4. Checkpoint whitespace:

   ```text
   git diff --check -- docs/adr docs/physics docs/specs docs/validation
   <brak stdout/stderr>
   exit 0
   ```

Nie uruchamiano repo-wide guardów poza fix contract. Nie wykonano `git add`,
`git commit` ani `git push`; niezwiązane zmiany współdzielonego worktree nie
zostały dotknięte.

## Poprawki po residual re-review Task 1

### Zamknięte findings

1. `selection_expr.v1` rozdziela teraz dwie fazy kontraktu. Publiczny authored
   input Python/UI może pominąć `inside_geometry.boundary` i otrzymuje default
   `inclusive`. Canonical normalized `SelectionExprIR` zawsze wymaga jawnego
   obiektu `boundary`; brak pola na granicy deserializacji canonical IR jest
   błędem schematu. Tabela required fields jest jawnie opisana jako tabela
   canonical normalized IR.
2. Równanie direct minimizer
   $\mathbf m_i^{(k)}=\mathbf m_i^\star$ dla $i\in F$ znajduje się teraz pod
   `DOC-ANCHOR:frozen-v1-constraint-model`, czyli dokładnie pod anchorem
   wskazanym przez wpis `eq-frozen-minimizer-constraint` w source-map.

Zmieniono wyłącznie:

- `docs/specs/selection-expr-v1.md`;
- `docs/specs/frozen-spins-v1.md`;
- `.superpowers/sdd/task-1-report.md`.

Statusy wszystkich lane'ów pozostają `UNQUALIFIED`.

### Dokładne focused validators po residual re-review

1. Source-map validator:

   ```text
   python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0996-frozen-spins-constraint.source-map.json --repo-root .
   <brak stdout/stderr>
   exit 0
   ```

2. Testy walidatora:

   ```text
   python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
   .......................
   ----------------------------------------------------------------------
   Ran 23 tests in 0.757s

   OK
   exit 0
   ```

3. Skan niedomkniętych markerów:

   ```text
   rg -n "T[B]D|T[O]DO|do ustalenia" docs/adr/0026-frozen-spins-constraint-and-selection-model.md docs/physics/0996-frozen-spins-constraint.md docs/specs/selection-expr-v1.md docs/specs/frozen-spins-v1.md
   <brak wyników>
   exit 1 (oczekiwany status `rg` przy braku dopasowań)
   ```

4. Checkpoint whitespace:

   ```text
   git diff --check -- docs/adr docs/physics docs/specs docs/validation
   <brak stdout/stderr>
   exit 0
   ```

Nie uruchamiano innych gate'ów. Nie wykonano `git add`, `git commit` ani
`git push`; niezwiązane pliki nie zostały dotknięte.

## Task 1 — Analysis projection revision gate (2026-09-02)

### Status

`DONE_WITH_CONCERNS`

Task 1 został zaimplementowany w izolowanym worktree:

`C:\git\fullmag\fullmag\.worktrees\task-1-projection-gate`

Branch worktree:

`codex/results-task-1-projection-gate`

Dirty checkout nadrzędny pozostał bez zmian. Nie wykonano `git add`, `git
commit`, `git reset`, `git restore`, `git stash` ani `git push` na rodzicu.

### Zmienione pliki

Własny diff względem snapshotu rodzica obejmuje wyłącznie:

- `apps/control-room/src/modules/analysis-plots/useAnalysisResultProjectionController.ts`
- `apps/control-room/src/modules/analysis-plots/useAnalysisResultProjectionController.test.ts`

Kontroler otrzymał `analysisResultProjectionMatchesSelection`, który wymaga
jednoczesnej zgodności `run_id`, `dataset_id` i `dataset_revision` projekcji z
bieżącą selekcją oraz manifestem. Wynik gate'a zasila model wykresu, przekazany
`resource` i callback wyboru punktu; projekcja z obcą lub starą tożsamością nie
może więc wygenerować danych wykresu ani nowego stanu selekcji. Surowy
`resultProjection.status` jest nadal zwracany bez zmian, dzięki czemu
odrzucona odpowiedź zachowuje status transportu i nie jest przedstawiana jako
brakujący zasób.

Test zawiera dwa nowe przypadki: zgodną projekcję oraz projekcję ze starą
rewizją datasetu. Istniejące dwa testy własności overlay zostały zachowane.

Nie zmieniono kontraktów API, generated files, Results files ani plików poza
zakresem implementacji. Worktree używa junction do istniejącego
`apps/control-room/node_modules` wyłącznie dla narzędzi testowych; nie
kopiowano cache do checkoutu.

### Weryfikacja TDD i focused

1. Bazowy test istniejących zachowań przed zmianą:

   ```text
   vitest run src/modules/analysis-plots/useAnalysisResultProjectionController.test.ts
   Test Files  1 passed (1)
   Tests       2 passed (2)
   ```

2. RED po dopisaniu testów gate'a:

   ```text
   Test Files  1 failed (1)
   Tests       4 total; 2 failed, 2 passed
   TypeError: analysisResultProjectionMatchesSelection is not a function
   ```

   Testy padały z powodu brakującej implementacji gate'a, a nie błędu fixture'a.

3. GREEN po minimalnej implementacji:

   ```text
   vitest run src/modules/analysis-plots/useAnalysisResultProjectionController.test.ts
   Test Files  1 passed (1)
   Tests       4 passed (4)
   ```

4. Final focused test zakończył się ponownie wynikiem 4/4.

5. Pełny typecheck Control Room w worktree, bez zapisu incremental cache:

   ```text
   tsc --noEmit --incremental false --project tsconfig.typecheck.json
   exit=0
   ```

6. Targeted ESLint dla dwóch plików implementacji/testu:

   ```text
   eslint src/modules/analysis-plots/useAnalysisResultProjectionController.ts \
     src/modules/analysis-plots/useAnalysisResultProjectionController.test.ts --max-warnings=0
   exit=0
   ```

7. `git diff --check` nie zgłosił whitespace errors.

8. React Doctor:

   ```text
   npx --yes react-doctor@latest --verbose --scope changed
   Scanned 7 files
   Score: 98 / 100
   No issues found!
   exit=0
   ```

### Concerns i ograniczenia

- Narzędzia wieloagentowe (`spawn_agent`/`wait_agent`) nie były dostępne w tej
  sesji, więc nie można było uruchomić implementera i osobnego subagenta
  reviewera z procedury SDD. Wykonano lokalny task-scoped review diffu,
  niezależny focused test, typecheck, ESLint i React Doctor.
- Worktree został zbudowany z `HEAD`, a następnie otrzymał istniejące,
  niezatwierdzone pliki bazowe konieczne do odtworzenia bieżącego dirty
  kontrolera overlay. Są one tylko kontekstem snapshotu i nie należą do
  własnego diffu Task 1.
- Nie wykonano browser smoke; zmiana dotyczy fail-closed selekcji danych w
  kontrolerze i nie zmienia layoutu ani cyklu życia viewportu.
