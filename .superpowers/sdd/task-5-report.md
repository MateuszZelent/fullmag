# Raport Task 5 — `MagnetizationConstraintIR` i frozen spins authoring

Data: 2026-08-20

## Wynik

Task 5 zamyka warstwę authoringu i typed IR dla `frozen_spins.v1`.
Nie implementuje planera, resolved mask, runtime, solverów ani UI. Wszystkie
lane'y FDM/FEM CPU/GPU pozostają `UNQUALIFIED`.

Naprawy findings 1–9 z review są wdrożone i przeszły świeże bramki GREEN.
Ostateczny verdict pozostaje własnością niezależnego re-review; ten raport nie
zastępuje jego decyzji.

Publiczny writer Pythona pozostaje przejściowo na `ProblemIR 0.3.0`, zgodnie z
istniejącą bramką atomowego cutover. Zapisuje jednak addytywne kolekcje
`selections[]` i `magnetization_constraints[]`. Osobny typed `ProblemIRV04`
zawiera te same kolekcje, a migracja `0.3.0 -> 0.4.0` dodaje je jako puste, gdy
nie istniały.

## Zaimplementowany kontrakt Rust

- Dodano strict, internally tagged `MagnetizationConstraintIR::FrozenSpins`.
- Dodano `FrozenSpinsIR` i polityki:
  `FrozenReferencePolicyIR`, `SelectionMembershipPolicyIR`,
  `ConstraintActivationIR`, `EmptySelectionPolicyIR` oraz
  `InactiveSelectionPolicyIR`.
- Serde odrzuca unknown fields i normalizuje brakujące defaulty. Geometryczny
  selector domyślnie otrzymuje `static`, a state-dependent selector
  `snapshot_at_activation`.
- Bezpośrednia deserializacja `ProblemIRV04` wykonuje normalizację na poziomie
  całego problemu przed typed lowering, więc referencja do state-dependent
  named selection korzysta z pełnego grafu definicji, a nie z pustego kontekstu.
- `ProblemIR` i `ProblemIRV04` zawierają top-level `selections[]` i
  `magnetization_constraints[]`.
- `MagnetIR.object_id` jest jawne i opcjonalne. Nowe constrainty rozstrzygają
  referencje wyłącznie względem jawnych ID; nazwa użytkowa nie jest źródłem
  tożsamości constraintu.
- Walidacja obejmuje: schema version, puste i zduplikowane ID, object/region/
  selection/stage references, state-dependent `static` oraz niepoprawne
  polityki. Overlap nie jest zgadywany z authored policy: zgodnie ze specyfikacją
  dopiero runtime porównuje dokładne resolved reference values.
- Legacy `MagnetIR.object_id`, jeśli jest obecne, musi być niepuste i unikalne;
  constraint nie może używać nazwy użytkowej jako zastępczej tożsamości.
- Migracja zachowuje dotychczasowy model obiektowy v0.4, referencje właścicieli
  i nieznane pola legacy wymagane przez round-trip. Legacy top-level
  `RegionIR.name` definiujący geometrię całego magnesu nie jest już fałszywie
  emitowany jako `ObjectRegionIR.region_id`; assignment i moduł celują w cały
  obiekt przez `RegionRefIR { object_id, region_id: None }`. Jawne typed region
  targets v0.4 pozostają obsługiwane.

## Zaimplementowany kontrakt Python

- Dodano publiczne `fm.FrozenSpins` ze strict `from_ir()` i copy-safe `to_ir()`.
- Dodano `ObjectRegion.freeze_spins(...)` oraz
  `Ferromagnet.freeze_spins(...)`.
- Convenience regionu tworzy `select.in_region(object_id, region_id)`;
  convenience obiektu wymaga jawnego `object_id` i tworzy
  `select.in_object(object_id)`.
- Constraint nie jest zapisywany jako materiał ani właściwość regionu.
- `Problem`, `TimeEvolution` i `Relaxation` przyjmują typed constraints i
  obniżają je do jednej top-level kolekcji.
- `StudyStagesBuilder` scala ponowne użycie tego samego constraint ID do jednej
  definicji z uporządkowanymi `activation.stage_ids`. Merge jest transakcyjny:
  kandydat powstaje na kopii, pełny stage jest walidowany i capture'owany przed
  publikacją constraint registry oraz stage listy.
- `add_run` waliduje i scala kandydat constraintów przed rozwinięciem
  deprecated legacy run configuration. Odrzucony constraint nie pozostawia
  ghost `table_autosave`, autosave/FFT action ani stage'u. Walidacja obejmuje
  cały złożony `Problem`, nie tylko sprawdzenie typu `FrozenSpins`, więc także
  semantycznie błędny selector kończy się przed pierwszą mutacją konfiguracji.
- Legacy run configuration jest najpierw walidowana w całości: unsupported
  keys, `table_autosave`, pełna sekwencja `outputs`, `spin_wave_response` i
  `output_every`, a oba deprecation warnings są emitowane przed commit boundary.
  Dopiero po tej fazie powstają widoczne configuration actions; późny błędny
  output ani warning traktowany jako wyjątek nie może pozostawić wcześniejszych
  table/autosave nodes.
- `Problem` odrzuca zduplikowane named-selection IDs i waliduje cały graf
  referencji przed membership inference; cykl kończy się typed
  `selection_reference_cycle`, nie `RecursionError`.
- Jawne API i oba convenience API emitują ten sam kanoniczny payload.
- Source map wskazuje aktualne symbole Rust constraint IR, publiczny Python
  `FrozenSpins` i stage builder.

## TDD — RED

- Rust: `cargo test -p fullmag-ir frozen_spins` początkowo nie kompilował się z
  powodu braku `MagnetizationConstraintIR`.
- Python: `pytest -q packages/fullmag-py/tests/test_frozen_spins_contract.py`
  początkowo zakończył się pięcioma oczekiwanymi porażkami z powodu braku
  `FrozenSpins`, pól `Problem` i stage `constraints`.
- Review RED: odrzucone `add_run(until=-1, constraints=[frozen])` i
  `add_relax(..., constraints=[frozen])` pozostawiały ghost stage ID
  `rejected` w top-level activation; migracja v0.4 emitowała
  `region_id: "strip"` bez `ObjectRegionIR`; duplicate selection ID był
  akceptowany, a cykl named selections kończył się `RecursionError`.
- Review RED w Rust potwierdził brak walidacji pustych/zduplikowanych
  `MagnetIR.object_id` i błędne odrzucenie overlap wyłącznie z powodu różnych
  authored reference policies. Test kompletności source map również najpierw
  nie znalazł nowych symboli implementacji.
- Końcowe review RED odtworzyło ghost `flat_table_autosave` dla
  `add_run(..., table_autosave=False, constraints=[object()])`, przestarzały
  anchor `StudyStagesBuilder._register_constraints` w nocie oraz błędny default
  `static` przy bezpośredniej deserializacji v0.4 referencji do state-dependent
  named selection. Każdy przypadek otrzymał osobny test regresyjny przed
  naprawą.
- Finalny re-review RED ujawnił, że wczesny test typu nie obejmował poprawnego
  `FrozenSpins` z semantycznie błędnym `select.in_object("missing")`. Dokładna
  regresja potwierdziła ghost `flat_table_autosave`; po naprawie capture i pełna
  walidacja kandydata poprzedzają legacy expansion, a test potwierdza brak akcji,
  stage'u, rejestracji constraintu i mutacji authored activation.
- Następny RED objął późny błąd legacy options: poprawne
  `table_autosave=False` i poprawny constraint, lecz `outputs=[object()]`,
  pozostawiały `flat_table_autosave` i `flat_autosave`. Parametryzowana regresja
  obejmuje teraz nieważny run stage, relax stage, table option, późny output i
  semantycznie nieważny typed constraint. Szósty wariant traktuje warning
  `legacy output_every` jako wyjątek i sprawdza tę samą granicę transakcji;
  każdy wariant wymaga zerowej liczby ghost nodes i niezmienionego authored
  state.

## Weryfikacja — GREEN

- `CARGO_TARGET_DIR=/tmp/fullmag-task5-ir-target cargo test -p fullmag-ir`
  — PASS: 321 testów crate'a, 0 failed; doc-testy 0 failed.
- `CARGO_TARGET_DIR=/tmp/fullmag-task5-ir-target cargo test -p fullmag-ir frozen_spins`
  — PASS: 3 testy, 0 failed.
- Bezpośrednia normalizacja v0.4:
  `problem_ir_v0_4_direct_deserialize_normalizes_ref_membership_with_named_definitions`
  — PASS: 1 test, 0 failed.
- `PYTHONPATH=packages/fullmag-py/src pytest -q packages/fullmag-py/tests/test_frozen_spins_contract.py`
  — PASS: 15 passed.
- Frozen/selection/stages regression:
  `test_frozen_spins_contract.py`, `test_selection_contract.py`,
  `test_selection_graph_limits.py`, `test_study_stages.py`
  — PASS: 78 passed, 4 subtests passed.
- `CARGO_TARGET_DIR=/tmp/fullmag-task5-rust-target cargo check -p fullmag-plan --tests`
  — PASS po addytywnym uzupełnieniu 20 legacy test literals o
  `object_id: None`.
- `cargo fmt -p fullmag-ir -- --check` — PASS po formatowaniu.
- `ruff check` i `ruff format --check` dla nowego modułu constraintów i jego
  testu — PASS.
- `python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0996-frozen-spins-constraint.source-map.json --repo-root .`
  — PASS.
- Testy validatora scientific docs — PASS: 23 tests.
- `git diff --check -- crates/fullmag-ir packages/fullmag-py docs/physics/0996-frozen-spins-constraint.md docs/physics/0996-frozen-spins-constraint.source-map.json .superpowers/sdd/task-5-report.md .superpowers/sdd/task-5-review.md`
  — PASS.

## Niezależne, odziedziczone bramki

- Pełny `packages/fullmag-py/tests/test_api.py`: 273 passed, 1 skipped,
  1 failed. Jedyna porażka jest poza Task 5:
  `test_random_initializer_serializes_to_ir` oczekuje payloadu bez
  `preset_version`, podczas gdy bieżący serializer zwraca
  `preset_version: 2`. Kod tekstur nie został zmieniony w Task 5.
- Pełny lint dotkniętych dużych modułów Pythona raportuje istniejące błędy w
  `problem.py`, `study.py` i `world.py`, niezwiązane z frozen spins. Nowy moduł
  i nowy test przechodzą lint.
- `cargo fmt -p fullmag-plan -- --check` zatrzymuje się na istniejącym
  formatowaniu `crates/fullmag-plan/src/util.rs`; 20 zmienionych literals w
  `tests.rs` są wyłącznie mechanicznym dodaniem pola.

## Granice akceptacji

Kod obecny oznacza wyłącznie `AUTHORING/IR IMPLEMENTED`. Nie wolno raportować
`FrozenSpins` jako wykonywalnej capability, dopóki kolejne zadania nie dodadzą
plannerowej materializacji maski, reference capture, runtime enforcement,
telemetrii/provenance oraz lane-specific kwalifikacji naukowej.

Nie wykonano commita, stage ani push.
