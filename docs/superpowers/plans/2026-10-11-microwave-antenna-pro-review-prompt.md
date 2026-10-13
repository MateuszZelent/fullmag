# Prompt do niezależnej recenzji postępów modułu anten

## Jak przekazać materiał

Wklej poniższy prompt do ChatGPT Pro razem z pełnym SHA checkpointu podanym
przez Codex po pushu. Udostępnij repozytorium lub archiwum tego commita.
Sam link do prywatnego repozytorium nie zapewnia modelowi dostępu do kodu.
Nie przekazuj `.env`, tokenów, lokalnych danych sesji ani wielkich cache buildów.

Repozytorium: https://github.com/MateuszZelent/fullmag

Branch: `codex/microwave-antenna-latest-20260909`.

Punkt odniesienia dla najnowszego niezatwierdzonego wcześniej przyrostu:
`41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`.

Odczytany przed publikacją SHA remote master:
`2a3c6becb9c7e111ae1497ec0cd9ac9576acba95`.
To pin odniesienia, nie zapewnienie, że master nie zmieni się później.

## Prompt

Przeprowadź niezależną, szczegółową recenzję naukowo-techniczną implementacji
modułu anten mikrofalowych Fullmaga. Recenzowany commit: **[WKLEJ PEŁNY SHA]**.
Nie implementuj poprawek ani nie zmieniaj repozytorium. Zwróć raport po polsku.

Najpierw potwierdź dostęp do rzeczywistych plików tego commita. Jeśli go nie
masz, wskaż brakujący materiał i ogranicz wnioski do udostępnionych dowodów.
Nie twórz nazw funkcji, endpointów, wyników testów ani fizycznych capabilities.
Dokumentacja opisuje intencję; dopiero kod i adekwatne wyniki potwierdzają
implementację. Nie powielaj bez sprawdzenia deklaracji autora.

### 1. Cel produktu i kryteria oceny

Użytkownik ma móc zbudować falowód magnetyczny oraz osobny przewodnik anteny
z rzeczywistą geometrią 3D, doprowadzeniami i powrotem prądu. Zachowujemy
obecny model microstrip; nie zastępuj go automatycznie CPW.

Wymagany workflow obejmuje:

1. Samodzielne rozwiązanie przewodnictwa i pola anteny bez LLG oraz Relax.
2. Potencjał V [V], konserwatywną gęstość prądu J [A/m²] i pole Oersteda
   H [A/m], wraz z poprawnymi domenami, siatkami i jednostkami.
3. Osobną, podpisaną bazę pola na jednostkę prądu H/I [A/m/A], obliczaną raz
   dla niezmiennego liniowego modelu; prąd czasowy skaluje ją w LLG bez
   ponownego solve w każdym kroku. Zmiana geometrii lub modelu wymaga
   właściwego unieważnienia. Surowe H nie jest automatycznie bazą na 1 A.
4. Projekcję/próbkowanie na właściwy target oraz użycie pola w Relax lub Run
   zgodnie z jawnie określoną aktywacją; nie przypadkowe RF w relaksacji.
5. Analizę przestrzennego widma pola źródła oddzieloną od odpowiedzi m(k,ω).
   Widmo H(k) samo nie dowodzi wzbudzenia propagujących fal spinowych.
6. Pełny Python DSL → ProblemIR → planner → runtime → artefakty oraz zgodny
   UI → Python round-trip bez alternatywnego modelu fizycznego w frontendzie.
7. Explorer i osobny Inspector dla każdego semantycznego węzła anteny.
   Wizualizacja ma korzystać ze wspólnego szablonu magnetyków, ale wyłącznie
   z prawidłowych antenowych quantities i właściwych domen. Antena nie ma
   magnetyzacji m ani automatycznie fizyki ferromagnetyka.
8. Odtwarzalne wyniki, jawne requested/resolved execution, integralność,
   aktualność, własność danych i stabilność UI podczas pending/ACK.

Nie redukuj zakresu do działającej inspekcji V/J/H. To fragment celu, nie jego
ukończenie. Oddziel FDM CPU, FDM GPU, FEM CPU i FEM GPU; brak dowodu oznacza
not_qualified, a nie zgodność albo cichy fallback.

### 2. Dokumenty i dwie perspektywy diffu

Przeczytaj `AGENTS.md`, właściwe `.agents/instructions/*`, następnie:

- `docs/superpowers/plans/2026-09-08-microwave-antenna-refactoring-plan.md`:
  wszystkie T00–T18, kontrakty przekazania i końcowe kryteria akceptacji;
- `docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`
  i sąsiedni source-map;
- `docs/physics/0980-dynamic-current-and-oersted-coupling.md`, jeżeli występuje
  w recenzowanym drzewie, oraz właściwe ADR/specy przywołane przez plan;
- `docs/specs/resource-first-control-room-api-v2.md`.

Sprawdź najnowszy przyrost względem `41a5b8936b3eaa38420e9ba358cbf22ac7e2d803`
oraz całe odchylenie brancha od wspólnego przodka z przypiętym masterem.
Rozróżnij istniejące wcześniej problemy od regresji nowego checkpointu.
Historia checkpointów nie jest dowodem aktualnego stanu każdego pliku.

### 3. Ścieżki wysokiego ryzyka

Prześledź rzeczywistych producentów i konsumentów, nie tylko helpery:

- Python: `packages/fullmag-py/src/fullmag/model/study.py`,
  `runtime/run_config_export.py`, `runtime/script_builder.py` oraz testy
  standalone authoring i rzeczywiste przykłady.
- IR/planner: `crates/fullmag-ir/src/study.rs`, `validation.rs`,
  `crates/fullmag-plan/src/antenna_field_solve.rs`,
  `antenna_current_source.rs`, `study_catalog.rs`.
- Application: `script_stage_materialization.rs`,
  `script_pipeline_compilation.rs`, `script_antenna_inspection_planning.rs`,
  `study_execution_materialization.rs`, `run_intent_materialization.rs`.
- Accepted execution: `crates/fullmag-api/src/accepted_fem_preparer.rs`,
  `accepted_study_worker.rs`, `accepted_antenna_inspection_worker.rs`,
  CLI `accepted_run_transport.rs`, runtime-control `study.rs`.
- Dane: nowy `crates/fullmag-antenna-artifacts`, runner publication/package,
  API handlers `accepted_antenna_inspection.rs`, `accepted_antenna_payload.rs`,
  `accepted_antenna_resource.rs`, quantities i session import.
- Frontend: antenowe panele Inspectora, `AntennaFieldSolveStageInspector`,
  `AntennaStudyStageComposer`, `studyStageSource`, Explorer,
  `antennaFieldIntent`, `useAntennaFieldOverlay` i command contributions.
- Weryfikacja: `scripts/accepted_antenna_runtime.py`,
  `scripts/smoke_accepted_antenna_inspection.py` i ich testy;
  fixture `tests/fixtures/runtime/antenna-standalone-pipeline.json`.

Sprawdź szczególnie:

1. Pełne zamknięcie prądu, terminale, znaki, gauge, bilans, RT0 i zgodność
   prądu wykorzystywanego przez Oersteda z transportem.
2. Jednostki H/B oraz H/I; brak podwójnego μ₀ lub podwójnego skalowania prądu.
3. Opcjonalny canonical selection stage/port: obie wersje IR, złe referencje,
   wiele definicji, brak fallbacku dla błędnego jawnego wyboru i pełny digest.
4. Oddzielenie ID autora, definicji fizycznej, ekspansji, wykonania i wyniku.
   Wygenerowane ID mają być przenośne do trwałego magazynu; tekst autora
   pozostaje w provenance, nie jako niezabezpieczona ścieżka.
5. Faktyczny konsument pipeline compilation oraz kolejność/zależności Study.
   Nie uznawaj listy snapshotów za zintegrowany compiler; grupy i mutatory
   nie mogą dostać fikcyjnego solve. Worker raw inspection nie przyjmuje
   wejść — sztuczny port Artifact nie jest poprawną zależnością sterowania.
6. Profile, warstwy żądania, hash immutable archive, idempotency i pinning;
   preparation nie może potajemnie submitować albo mutować autora.
7. CAS/publication przed completed receipt, atomic failure, dokładny run,
   attempt, epoch i ownership; bounded decode, hash, ETag, ranges, stale refusal.
8. Czy endpointy są naprawdę zarejestrowane, OpenAPI jest aktualne, a frontend
   używa wygenerowanego klienta i resource hooks zamiast własnego fetch.
9. Quantity availability, komponenty/moduł, domena przewodnika versus target
   i airbox; brak magnetycznych kontrolek dla anteny oraz stale overlay.
10. Stabilność Inspectora, SSR/hydration, pending/ACK, drafty, subscriptions,
    kamera i WebGL; oddziel obecność kontrolek od działającego renderingu danych.
11. Czy extraction kodu do nowego crate zachowuje wszystkie walidacje,
    formaty i granice zależności zamiast ukrywać usuniętą funkcjonalność.

### 4. Stan dowodów — poddaj go weryfikacji

Formalna checklista przed publikacją checkpointu: 17/155 zamkniętych punktów,
138 otwartych, 0/19 etapów całkowicie zamkniętych; osobno 7 końcowych bramek.
Otwarty punkt może mieć kod. Nie wyceniaj ilości kodu jako gotowości produktu.

Ostatni odnotowany moduł Python standalone authoring: 10/10 PASS. Nowe testy
Rust istnieją w źródłach, ale nie zostały wykonane; obowiązuje tymczasowy
zakaz kompilowania testów jednostkowych. Rustfmt/diff są dowodem parsera
i higieny, nie typu, runtime ani nauki. Nie obchodź zakazu builda testów.

Wcześniejszy zarządzany build nr 56 zakończył się sukcesem i miał sprawdzone
artefakty, ale nie obejmuje najnowszego przyrostu. Job 67 nie obejmuje później
dodanych pipeline compilation, wspólnego helpera ani canonical selection.
Sprawdź manifesty i terminalne receipts, zanim przypiszesz build do tego SHA.
Nie zakładaj aktualnego stanu kolejki na podstawie historycznej notatki.

Istnieje historyczny test V/RT0/H w RAM. Nie jest to dowód trwałego workflow,
zbieżności całego modelu, normalizacji per A, sprzężenia LLG ani browser E2E.
Nie uruchamiaj ani nie restartuj sceny użytkownika w ramach read-only review.

### 5. Format raportu

Zwróć:

1. Krótki werdykt: co poprawia produkt, co jest nadal WIP i co blokuje merge.
2. Tabelę T00–T18: wymaganie, faktyczna implementacja, dowód, brakujący krok,
   stan (`verified`, `implemented_unqualified`, `partial`, `missing`).
3. Znaleziska `Blocker`, `Required`, `Suggestion`, każde z dokładnym path +
   symbolem, mechanizmem błędu, skutkiem, sposobem reprodukcji i poprawką.
4. Osobną macierz backendów oraz frontend/API/runtime/nauka z brakami dowodów.
5. Priorytetowy plan dalszej pracy: zależności, kamienie milowe i mierzalne
   kryterium odbioru każdego kroku, od pełnego standalone workflow do LLG/FFT.
6. Listę deklaracji z raportów, których kod lub dowody nie potwierdzają.

Nie zamykaj problemu dlatego, że test sprawdza występowanie tekstu w pliku.
Nie żądaj szerokich refaktorów bez konkretnego ryzyka. Nie obiecuj pełnego RF,
S-parametrów, skin/proximity ani spintroniki BORIS, jeśli ten model ich nie
rozwiązuje. Jeżeli brakuje danych do wyroku, nazwij brak i wymagany eksperyment.
