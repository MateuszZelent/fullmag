# Luka accepted FEM execution dla P6-60 i P6-61

**Status:** OPEN / NOT VERIFIED
**Data audytu:** 2026-10-01
**Zakres:** accepted `run-json` → native FEM CPU → zapis stanu `m` → `SolutionSet`/pinned source → P6-60/P6-61

## Werdykt

W aktualnym źródle i w pakiecie build192 nie ma kompletnej, wspieranej ścieżki, która tworzy zaakceptowany zapis stanu FEM i prowadzi go do przypiętego `SolutionSet`. Przygotowanie siatki i przestrzeni FEM jest zaimplementowane jako osobny etap, ale nie jest wykonaniem solvera, publikacją pola ani dowodem P6-60/P6-61.

Nie znaleziono publicznej alternatywy, która omijałaby ten brak bez naruszenia kontraktu. Publiczne `run-json` zatrzymuje się na preparation dla FEM, bieżący worker accepted wykonuje wyłącznie FDM CPU/GPU, a trasa sesji live nie tworzy niezmiennego łańcucha accepted run → attempt → output → `SolutionSet` → pinned source. Bezpośredni orchestrator/ProblemIR może uruchamiać natywny FEM w innych scenariuszach, lecz nie jest zamiennikiem accepted run i nie może być użyty do zamknięcia tej bramki.

Wniosek: P6-60 i P6-61 pozostają otwarte. Plan nie powinien opisywać ogólnego accepted FEM execution jako ukończonego na podstawie obecnego preparation source/packaging.

## Tożsamość dowodu

| Element | Wartość | Znaczenie |
|---|---|---|
| commit źródła | `fa7378e72018e8d98157ff37a27861c48f670626` | dokładny materiał build192 |
| build | `5d750ed66e584869ab6e88e48c457c86` | profil `fem-cpu-release` |
| source capsule | `de865d2422d8f2e5ba7f1d4979128512701cc0157770f8016af7555cbb328d49` | tożsamość wejścia źródłowego |
| native snapshot | `540bb2ff7be94c4b6a21efb31b73a66c65346d89b41c12a1a9f0b8a75a3f7934` | tożsamość snapshotu native builda |
| receipt | `C:\git\fullmag\storage\runs\fullmag-0950f4dca4ffe38f\5d750ed66e584869ab6e88e48c457c86` | receipt zakończony kodem 0, 113/113 artefaktów |
| fixture | `tests/fixtures/runtime/accepted-fem-preparation-run-v2.json` | strict FEM CPU, double, exchange-only, box 200×20×6 nm, seed 42 |
| zamierzony stan P6 | finalne `m` | nie `H_ex`; mikroprzypadek sprawdza lifecycle/integrity, nie parytet fizyczny |
| kwalifikacja | `NOT VERIFIED` | receipt builda nie jest dowodem wykonania runtime ani naukowej kwalifikacji |

Build receipt jest wiarygodnym dowodem kompletności zarejestrowanego builda, ale nie dowodzi, że pakiet zawiera wszystkie programy wymagane przez accepted FEM route.

## Tożsamość audytowanych źródeł lokalnych

Odczyt aktualnego kodu wykonano przy checkout HEAD
`1b85ddd8759ed34b16e05bc201cb23c2f773ba81` na `masterze`. Współdzielony
checkout zawiera także cudze niezacommitowane zmiany; nie traktujemy go jako
czystego odpowiednika źródeł buildu 192 i nie dołączamy tych zmian do commita.
Poniższe hashe identyfikują odczytane pliki niezależnie od build receiptu.

| Plik | SHA-256 |
|---|---|
| `crates/fullmag-api/src/accepted_study_worker.rs` | `d17273c3f5ab81eb81d770d50ebb567be069013530c892fc46b5eb26bdae1346` |
| `crates/fullmag-api/src/accepted_fem_preparer.rs` | `43f8d2bc321b64b41940d725cc39d7229ea1a6ebe19e8b19a5d457e855efad83` |
| `scripts/verify_accepted_fem_preparation_runtime.py` | `c306009603b8c9e86d85647ed712469a7564c5dcbef98dda6e5ee6ed73d0e730` |
| `crates/fullmag-runner/src/artifacts.rs` | `e5b074bc3797e25d49de41b4eb28572e7998f557882330e0b488382a96b2cca5` |

## Granice odpowiedzialności planu

| Etap | Co rzeczywiście obejmuje | Stan względem accepted FEM snapshot |
|---|---|---|
| P3 | immutable study/RunSpec, plan wykonania, lease, claim, worker protocol, supervisor i scheduler; bieżący accepted worker ma ograniczony one-shot lane FDM | infrastruktura lifecycle jest częściowo gotowa, lecz nie ma FEM execution lane |
| P4 | `PreparationPlan`, producenci oraz receipt siatki/przestrzeni, w tym preparer, supervisor, scheduler i pakowanie | preparation source/contract jest osobnym, prawidłowym osiągnięciem; nie uruchamia solvera |
| P5 | accepted state, readback i kontrakty źródeł dla FDM; FEM state materialization pozostaje zależne od rzeczywistego native outputu | brak accepted FEM final-state producer |
| P6 | writer, typed FEM tensor materializer, manifest, geometry/support readers, pinned source, P6-60 i P6-61 | consumer-side source jest obecny, ale nie ma poprawnego producer chain do odczytu |

Wartości procentowe w `final/README.md` są wskaźnikami zakresu planu, a nie kwalifikacją produkcyjnego runtime. Szczególnie wpis o accepted-run FEM preparation należy czytać jako dowód preparation/packaging; nie jako dowód pełnego FEM execution i zapisu `m`.

## Dostępne trasy i punkt zatrzymania

### Publiczne `run-json`

`scripts/verify_accepted_fem_preparation_runtime.py` wymaga publicznego transportu `fullmag run-json`, następnie oczekuje:

1. HTTP 201 i stanu `accepted_task_awaiting_preparation`;
2. meshing lease z `fullmag-api-preparation-resource-pool`;
3. procesu `fullmag-api-accepted-fem-preparer` uruchomionego przez `fullmag-api-accepted-fem-preparation-scheduler`;
4. durable preparation receipt, launch/exit receipts i zwolnienia lease;
5. przejścia taska do `accepted_task_awaiting_dependency_resolution`.

To jest poprawny test granicy preparation. `crates/fullmag-api/src/accepted_fem_preparer.rs` wywołuje `prepare_fem_mesh_space` i publikuje `preparation_plan.v2`; nie wykonuje kroku czasowego, nie tworzy finalnego pola, nie publikuje `SolutionSet` i nie tworzy pinned tensor source.

### Worker accepted i scheduler

`crates/fullmag-api/src/accepted_study_worker.rs` odrzuca wszystko poza FDM CPU/GPU, double, strict. Dalszy kod wymaga `BackendPlanIR::Fdm`, buduje FDM accepted-state ref i zbiera FDM observation source. Wspólne elementy claim/lease/heartbeat/stop/completion barrier oraz `publish_study_outputs` są użyteczne jako infrastruktura, ale nie stanowią FEM wykonania.

Nie wolno rozszerzyć tego warunku przez cichy fallback do FDM. Requested `backend=fem`, `device=cpu`, `precision=double`, `mode=strict` musi zachować resolved `fem_cpu_native` i zakończyć się błędem, jeśli FEM lane nie jest dostępny.

### Trasa sesji live

`/v2/sessions/current/simulation/*` oraz `live_scene_preparation` potrafią obniżyć scenę do ProblemIR i dla FEM przygotować mesh/space. Są to zasoby live/preparation/control plane. Nie publikują niezmiennego accepted attempt, final native snapshot receipt, `SolutionSet` revision/member/artifact ani `PinnedSolutionTensorSource`. Nie są wspieraną alternatywą dla P6-60.

### Bezpośredni orchestrator/ProblemIR

`fullmag-cli` i runner mają overloady z FEM mesh identity, native final snapshot receipt i node map. To potwierdza, że niższa warstwa ma potrzebne klocki. Bezpośrednie wywołanie omija jednak publiczny accepted transport, task claim/lease/attempt i durable publication chain. Użycie go jako dowodu P6 byłoby bypassem, nie alternatywną trasą produkcyjną.

## Ograniczenie build192

W zarejestrowanych 113 artefaktach znajdują się między innymi:

- `fullmag-api`, `fullmag`, `fullmag-bin`;
- `fullmag-api-accepted-supervisor` i `fullmag-api-accepted-worker`;
- `libfullmag_fem.so`, `.so.0`, `.so.0.1.0`.

Brakuje binariów wymaganych do odtworzenia pełnego preparation/accepted route:

- `fullmag-api-preparation-resource-pool`;
- `fullmag-api-accepted-fem-preparer`;
- `fullmag-api-accepted-fem-preparation-scheduler`;
- `fullmag-api-resource-pool`;
- `fullmag-api-accepted-scheduler`.

Braki są ograniczeniem artefaktu, nie powodem do użycia ręcznego solvera. Zgodnie z polityką fail-closed nie należy uruchamiać fallbacku ani dopisywać brakujących programów do raportu jako istniejących. Do dalszej kwalifikacji potrzebny jest nowy, dokładnie zidentyfikowany build zawierający wymagane binaria; w tym audycie nie wykonywano nowego builda.

## Minimalny brakujący increment implementacyjny

Zakres powinien być zamkniętym incrementem accepted FEM CPU, a nie zmianą ogólnego znaczenia FDM worker:

1. **Admission i provenance.** Przyjąć wyłącznie immutable accepted study z `backend=fem`, `device=cpu`, `precision=double`, `mode=strict`; sprawdzić resolved plan `fem_cpu_native`, exact preparation binding oraz jedną solver CPU lease. Zachować `requested` i `resolved` bez auto/fallback.
2. **Deterministyczne wejście.** Związać wykonanie z preparation receipt i exact mesh/space identity. Seed 42 z fixture należy zachować jako część immutable accepted ProblemIR; nie stosować blanket rejection wszystkich seedów tylko dlatego, że bieżący FDM worker ma taki guard.
3. **Worker FEM.** Dodać jawny accepted FEM CPU execution branch albo osobny `accepted_fem_study_worker`, korzystający z istniejącego supervisor/scheduler/claim/heartbeat/stop/completion protocol. Rust pozostaje orchestration; produkcyjny solver pozostaje w `backends/fem` przez MFEM/hypre/libCEED.
4. **Native output.** Wywołać runner overload z FEM mesh identity (oraz autosave, jeśli wymagany przez wybraną trasę), a następnie wymagać native final snapshot receipt, final node map i indexed geometry. Brak któregokolwiek artefaktu ma kończyć attempt jako failure.
5. **Accepted state.** Wprowadzić jawny FEM accepted-state ref związany z run/step/attempt/epoch i finalnym `m`; nie reinterpretować `FdmCpuAcceptedStateSnapshotV1` ani FDM observation jako FEM.
6. **Publikacja.** Przepuścić `m` i `total_energy` przez typed output catalog oraz `publish_study_outputs`; dopiero po terminalnej publikacji uruchomić FEM tensor materializer, `SolutionSet` revision/member/artifact i manifest `MaterializedDataset`.
7. **Pin i gate.** Utworzyć `PinnedSolutionTensorSource` z historycznej rewizji, użyć exact `source_artifact_id = field_binding.item_id`, a następnie uruchomić `fullmag-bin runtime verify-saved-fem-snapshot` oraz archive roundtrip P6-61 na tym samym cold store. Każdy gate musi zachować `scientific_qualification: not_verified`, dopóki nie ma oddzielnych dowodów naukowych.

Nie należy w ramach tego incrementu implementować nowej ścieżki przez live session, zmieniać semantyki FDM, generować domyślnej siatki zamiast preparation bindingu ani publikować syntetycznego snapshotu.

## Oczekiwany przebieg po implementacji

Prawidłowa sekwencja dowodowa jest następująca:

```text
accepted run-json
  → accepted study/task + immutable RunSpec/plan
  → meshing resource pool + preparation receipt
  → solver CPU resource pool + FEM worker claim/attempt
  → fem_cpu_native execution on exact prepared mesh/space
  → native final snapshot receipt + node map + indexed geometry
  → typed m / total_energy output publication
  → SolutionSet revision/member/artifact
  → FEM tensor materializer + MaterializedDataset manifest
  → exact PinnedSolutionTensorSource
  → P6-60 saved native snapshot integrity
  → P6-61 archive roundtrip
```

Microcase exchange-only jest przydatny do sprawdzenia lifecycle, identity, CAS i odtwarzalności. Nie dowodzi poprawności fizycznej, zbieżności LLG-TD ani parytetu z FDM. Te dowody muszą pozostać osobnymi bramkami.

## Macierz dowodów

| Bramka | Stan | Dowód / ograniczenie |
|---|---|---|
| source commit i build receipt | PASS dla receipt | build192 ma 113/113 artefaktów i exit 0 |
| preparation source/contract | SOURCE PRESENT; runtime NOT VERIFIED | `accepted_fem_preparer.rs`, verifier preparation |
| pełny pakiet preparation | BLOCKED dla build192 | wymagane binaria nie są w artefakcie |
| accepted FEM execution | NOT IMPLEMENTED / NOT VERIFIED | accepted worker ma FDM-only guard |
| native FEM final receipt/map | SOURCE PRESENT; producer chain NOT VERIFIED | runner/artifacts ma walidatory, brak accepted FEM producer |
| `SolutionSet`/tensor/materialized dataset | SOURCE PRESENT; runtime NOT VERIFIED | consumer-side writer/materializer istnieje, brak wejściowego FEM outputu |
| P6-60 | SOURCE GATE PRESENT; runtime NOT VERIFIED | gate wymaga exact pinned source/artifact i native map/geometry |
| P6-61 | PROCEDURE PRESENT; runtime NOT VERIFIED | brak przypiętego accepted FEM snapshotu do roundtrip |
| scientific qualification | NOT VERIFIED | lifecycle microcase nie jest testem naukowym |

## Decyzja dla planu

Ten audyt potwierdza postęp w P3/P4 oraz przygotowanie konsumentów P6, ale nie zamyka accepted FEM execution. P5/P6 mogą zachować wartości procentowe jako orientacyjny zakres prac, jednak status bramki produkcyjnej musi pozostać `OPEN`/`NOT VERIFIED` do czasu przejścia pełnej sekwencji i zebrania receiptów z exact source/build/run/pin.

Następny krok implementacyjny to wyłącznie jawny accepted FEM CPU producer i jego managed runtime proof. Dopiero po tym można oceniać P6-60, a następnie P6-61; samo preparation packaging, live preparation, build receipt albo bezpośredni native FEM run nie wystarcza.

## Źródła audytu

- `scripts/verify_accepted_fem_preparation_runtime.py`
- `crates/fullmag-api/src/accepted_fem_preparer.rs`
- `crates/fullmag-api/src/accepted_study_worker.rs`
- `crates/fullmag-api/src/accepted_study_supervisor.rs`
- `crates/fullmag-api/src/live_scene_preparation.rs`
- `crates/fullmag-runner/src/artifacts.rs`
- `crates/fullmag-runtime-control/src/study.rs`
- `crates/fullmag-session/src/solution_tensor_source.rs`
- `crates/fullmag-cli/src/saved_fem_snapshot_gate.rs`
- `docs/plans/active/refactor_runtime/final/README.md`
- `docs/plans/active/refactor_runtime/final/p6/21-accepted-study-solution-writer.md`
- `docs/plans/active/refactor_runtime/final/p6/45-recorded-fem-state-tensor-materializer.md`
- `docs/plans/active/refactor_runtime/final/p6/55-native-final-snapshot-receipt.md`
- `docs/plans/active/refactor_runtime/final/p6/60-saved-native-snapshot-integrity-gate.md`
- `docs/plans/active/refactor_runtime/final/p6/61-saved-fem-archive-roundtrip-route.md`

Źródła zostały przejrzane read-only. W tym audycie nie uruchamiano builda, solvera, Dockera ani kompilacji testów.
