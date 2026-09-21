# Status realizacji całego planu refaktoryzacji

Data rewalidacji: 21.09.2026. Checkout: lokalny `master`, HEAD `15af8b95e40a85d34403b8cc6f9b9c589bc7adc6` (dirty). Receipt'y i starsze smoke'y zachowują własną przypiętą tożsamość źródła.

Procenty poniżej opisują **zakres implementacyjny planu**, a nie gotowość
produkcyjną. Etap liczę jako wykonany tylko wtedy, gdy istnieje odpowiadający
mu kod lub kontrakt oraz adekwatny dowód. Zielony test jednego wycinka nie
zamyka całego etapu. Szacunek całości jest konserwatywnym przybliżeniem
ważonym liczbą pakietów roboczych z planu; nie jest metryką jakości ani
kwalifikacją wydania.

## Tabela zbiorcza

| Etap | Zakres planu | Postęp | Co jest zrealizowane | Co nadal blokuje zamknięcie |
|---|---|---:|---|---|
| **P0** | Baza, storage, identity, kontrakty i baseline | **85%** | Inventory P0-A: 300 operacji OpenAPI, 300 rozpoznanych handlerów, 0 unresolved; minimalna bramka session/storage: 70 passed; kontrakty ADR/capability i containment mają zapisane przyrosty oraz ograniczone regresje. | Pełna macierz P0-B/C/F, power-loss i profile innych systemów plików, bieżący baseline P0-E, runtime/API evidence oraz release gate. |
| **P1** | Projekt niezależny od solvera | **98%** | `fullmag-application`, repository `.fms`, lifecycle New/Open/Save/Close, bytes-only API, CLI/Python/desktop Open, browser project lifecycle, mounted-workspace reconnect, managed API/WS/active-run smoke, ikona chowania Inspektora. | Fizyczny smoke Tauri, pełna session-recovery, część runtime/release qualification. |
| **P2** | Authoring, Python i historia edycji | **50%** | P2-A: canonical bytes/digest, wersjonowany AST parametrów SI, `Problem.parameters`, flat/study facade, detekcja cykli, display metadata poza numerical hash i generated Python round-trip. P2-B: sekwencja cech geometrii, stable IDs/paths, CSG lineage, jawny transform, `resolved/ambiguous/empty` oraz selective invalidation. P2-C: izolowane konteksty Python, owner fencing i jawna materializacja. P2-D: revision-fenced semantic Undo/Redo przez `replace_scene`, wspólne menu/ribbon/shortcut, registry aktywnego formularza Inspectora dla Apply/Reset, wrapper historii dla staged session hooków oraz revision-fenced immediate mutations dla komend i paneli region/coupling, texture, absorbing boundary, antenna, material fields, spin/transport delete, spin interface delete i monitora. | Pełny Model/Component/PhysicsConfiguration i browser/Rust round-trip; meshing evaluator/repair i selekcje; provenance resolved/executed, study/run materialization, `fullmag-py-core`, równoległe capture/load; pozostałe wieloetapowe i bezpośrednie panele authoringu, zachowanie selection/focus i browserowy Apply → Undo → Redo. |
| **P3** | Studies, RunSpec, durable Submit i katalog artefaktów | **0%** | Zdefiniowane kontrakty i scenariusze w planie. | Brak implementacji i dowodów durable submit/idempotency/output publication. |
| **P3a** | Jawny kontekst requestów API i migracja klientów | **0%** | Inventory oraz docelowy kontrakt identity są zapisane. | Brak pilotażu przez `await`, migracji facade/resources/cache/decode i usunięcia niejawnego `current`. |
| **P4** | Preparation, geometria/grid/mesh/space | **0%** | Wymagania PreparationPlan i certyfikatów są opisane. | Brak producer fingerprints, certyfikatów meshu, selective reuse i pełnego UI preparation. |
| **B** | Modularizacja backendu FDM/FEM/ABI/state/observables | **0%** | Granice właścicieli, cztery lane’y i orakle są rozpisane. | Brak kwalifikowanych ekstrakcji i dowodów FDM CPU/GPU oraz FEM CPU/GPU; nie wykonano refaktoru solverów. |
| **P5** | Izolowany runtime, fencing, cancel/recovery, live steering | **0%** | Scenariusze i wymagane accepted-state/lease contracts są zdefiniowane. | Brak nowego coordinatora, journal/lease evidence, recovery i steering qualification. |
| **P6** | Trwałe wyniki, quantities, datasets i frontend analityczny | **0%** | Docelowe manifesty, dataset identity i wymagania Control Room są opisane. | Brak migracji artifact keys, evaluator/codec, bounded I/O i pełnej kwalifikacji wyników/viewportu. |
| **P7** | Studies złożone, wiele projektów i targety | **0%** | Zależności, case mapping i target contracts są zaplanowane. | Brak study compiler, wieloprojektowego runtime, target adapters i raportów reprodukowalnych. |
| **P8** | Cutover, dystrybucja, macierz CAE i wydanie | **0%** | Cutover, rollback, packaging i release gates są zdefiniowane. | Brak usunięcia legacy writers, managed build/package, pełnej macierzy CAE, review/CI/merge i release qualification. |

## Wynik globalny

**Około 21–22% zakresu implementacyjnego planu** jest zrealizowane w
zweryfikowanych przyrostach. W komunikacji operacyjnej zaokrąglamy to do
**około 21%**. Największa część pozostałej pracy to P3/P3a, przygotowanie,
cztery lane’y backendowe, runtime, wyniki i kwalifikacja; dlatego procent nie
oznacza, że produkt jest w 20% gotowy do wydania.

## Dowody bieżącego checkpointu

| Przyrost | Dowód | Wynik |
|---|---|---|
| P2-A canonical bytes | `p2/02-canonical-ir.md` | PASS; stabilne bajty i digest ProblemIR. |
| P2-A parameter AST | `packages/fullmag-py/tests/test_parameter_ast.py` | **7 passed**; SI normalization, ProblemIR lowering, flat/study facade, generated-script round-trip, dimension/cycle diagnostics i display metadata. |
| P2-A regresje Python | `test_problem_ir.py` + `test_execution_context.py` | **16 passed**. |
| P2-B geometry | `p2/03-geometry-feature-sequence.md`, `cargo check --locked -p fullmag-authoring --lib` | PASS kompilacji biblioteki; testy Rust są zapisane, lecz nieuruchomione zgodnie z bieżącą polityką. |
| P2-C context | `p2/01-context-isolation.md` | 6 testów izolacji/fencingu plus istniejące regresje API/script/mesh. |
| P2-D semantic history | `p2/05-semantic-history.md`, `AuthoringHistoryController.test.ts`, `PendingFormRegistry.test.ts`, `InspectorHistoryBridge.test.ts`, `authoringHistoryMutation.test.ts`, `regionCommandContributions.test.ts` | **3 + 4 + 4 + 4 + 5 passed**; revision-fenced Undo/Redo przez `replace_scene`, rejestr aktywnego formularza, wrapper staged sesji oraz wspólny helper odczytu przed/po z base-revision dla immediate mutations. **116/116 testów** ukierunkowanej macierzy paneli Inspectora, 40 testów komend geometrii, 35 testów menu/skrótów i 28 testów bazowej bramki Inspectora; pozostałe direct handlers, selection/focus i browser gate pozostają otwarte. |
| P1 UI | `pnpm --dir apps/control-room smoke:inspector` | Exit 0; hide/restore przez wspólną komendę layoutu. |
| Spójność dokumentacji | `python scripts/check_repo_consistency.py`, checker linków, `git diff --check` | PASS; ostrzeżenia diff dotyczą normalizacji LF/CRLF. |

## Czego nie należy z tego wyniku wnioskować

- P0/P1 mają wysokie procenty zakresowe, ale nadal nie zamykają wszystkich
  dowodów produkcyjnych.
- P2-A/B/C to częściowe slice’y; nie są równoważne pełnemu authoringowi,
  meshingowi ani runtime.
- Nie wykonano kwalifikacji naukowej, parytetu FDM/FEM CPU/GPU, power-loss,
  pełnej session-recovery ani release qualification.
- Brakujące dowody mają status `NOT VERIFIED`, a nie `PASS`.
