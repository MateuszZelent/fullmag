# Task 4 — typed `SelectionExprIR` i Python selection DSL

## Status

`READY_FOR_RE_REVIEW`

Wszystkie pięć findingów specyfikacyjnych z
`.superpowers/sdd/task-4-review.md` oraz dwa późniejsze findingi jakościowe
zostały naprawione w cyklu RED/GREEN. Nie wykonano stage, commit ani push. Capability
dla frozen spins pozostaje `UNQUALIFIED`: Task 4 dostarcza wyłącznie typowany
kontrakt selekcji, walidację, hash i authoring; nie implementuje
`MagnetizationConstraintIR`, `FrozenSpins`, planowania, materializacji maski ani
runtime z Task 5/6.

Normatywne limity są zgodne z `docs/specs/selection-expr-v1.md`:

- maksymalna głębokość: `64`;
- maksymalna liczba węzłów: `4096`;
- maksymalna liczba referencji: `1024`.

## Zakres napraw

### 1. Pełny `geometry_predicate.v1`

Rust i typowany parser Pythona obsługują `box`, `cylinder`, `sphere`,
`ellipsoid`, `union`, `intersection`, `difference`, `xor`, `complement` z
jawną domeną, `affine` oraz znany wariant `imported_solid`. Ten ostatni jest
parsowany jako element schematu, ale walidacja i publiczny kanoniczny hash
failują kodem `selection_imported_solid_unqualified`, dopóki runtime nie ma
kwalifikowanej realizacji.

Węzły geometryczne, scalar i selection uczestniczą w tych samych limitach
grafu bezpośredniego i tranzytywnie rozwiniętego. Publiczne `sel.inside`
przyjmuje również kompletny, wcześniej typowo sparsowany predykat geometrii.
Legacy `fm.Sphere` nadal obniża się do kanonicznego `sphere`, natomiast
niesferyczny `ellipsoid` zachowuje trzy promienie.

### 2. Typowany, kanoniczny i fail-closed hash Pythona

`fm.select.canonical_selection_sha256` najpierw wykonuje ścisły typed parse,
walidację grafu, normalizację osi/kwaternionów i spłaszczenie zagnieżdżonych
operatorów boolean. Odrzuca nieznane pola, string/callable expressions,
niepoprawną geometrię, puste operatory zbiorowe, nieznane referencje, cykle,
przekroczenia limitów i niekwalifikowany `imported_solid` przed hashowaniem.

Rust i Python zachowują ten sam wersjonowany encoding bitów `f64`, w tym dla
wykładników SI, oraz te same bajty UTF-8 dla Unicode.

### 3. Typed parse i round-trip

Dodano typed `from_ir`/`to_ir` dla:

- `SelectionDefinition`;
- `Selection`;
- `SelectionScalar` i wszystkich wariantów scalar;
- kompletnego predykatu geometrii;
- wszystkich wariantów expression.

Deserializacja Rust korzysta z prywatnego wire enum i przed zwróceniem
publicznego `SelectionExprIR` zawsze wykonuje canonicalization. Zagnieżdżone
`and`, `or` i `xor` są więc spłaszczane także po deserializacji, a nie tylko w
builderach.

### 4. Stabilne jawne `object_id` w rzeczywistym DSL

`select.in_object` i `select.in_region` działają z rzeczywistymi
`MagnetHandle` i `ObjectRegion`. Tożsamość nie jest wyprowadzana z nazwy
użytkowej. `StudyBuilder.geometry(..., object_id=...)` zachowuje jawne ID w:

- uchwycie obiektu;
- `Ferromagnet` i jego IR;
- builder draft;
- kanonicznym eksporcie skryptu;
- ponownym załadowaniu wyeksportowanego skryptu.

Test round-trip używa nazwy `User-facing free layer` i niezależnego
`object_id="free_layer"`, dzięki czemu regresja do identyfikacji przez nazwę
jest jawnie wykrywana. Nie jest generowane losowe ID podczas serializacji.

### 5. Dokumentacja i source map

`docs/specs/selection-expr-v1.md` oraz
`docs/physics/0996-frozen-spins-constraint.md` opisują aktualny stan: typed
`SelectionExprIR` i `fullmag.select` istnieją, natomiast constraint i runtime
frozen spins nadal nie istnieją. Source map wskazuje istniejące, stabilne
symbole i przechodzi focused validator.

### 6. Rozdzielenie odpowiedzialności modułu Pythona

Monolityczny `packages/fullmag-py/src/fullmag/model/selection.py` został
rozdzielony bez zmiany publicznych importów ani API:

- `_selection_wire.py` (`491` linii) jest właścicielem typed wire nodes,
  ścisłego parse i canonicalization;
- `_selection_validation.py` (`179` linii) jest właścicielem metryk, walidacji
  grafu, rozwiniętych limitów i kanonicznego hasha;
- `selection.py` (`706` linii) pozostaje publiczną fasadą oraz właścicielem DSL
  i lowering geometrii authored.

Kierunek importów jest acykliczny: oba prywatne moduły nie importują publicznej
fasady, a fasada deleguje do nich implementację. Zachowano dotychczasowe importy
`fullmag`, `fullmag.select` i `fullmag.model.selection`, łącznie z bezpośrednim
dostępem do `_validate_definition_graph` używanym przez focused testy.

### 7. Trwałe testy grafu i hasha Pythona

Nowy `test_selection_graph_limits.py` sprawdza te same wejścia przez
`_validate_definition_graph` oraz publiczny `canonical_selection_sha256`:

- nieznaną referencję;
- cykl referencji;
- akceptację `64` i odrzucenie `65` poziomów rozwiniętego grafu;
- akceptację `4096` i odrzucenie `4097` węzłów;
- akceptację `1024` i odrzucenie `1025` referencji.

Test architektury był właściwym RED: przed refaktorem suite miał `1 failed,
5 passed`, ponieważ `_selection_wire` nie istniał. Po rozdzieleniu ten sam suite
ma `6 passed`; pięć testów kontraktu granicznego pozostało GREEN przez refaktor.

## Dowody RED

1. Pełna geometria i limity: focused Rust uruchomił sześć failures — brak
   `ellipsoid`, `xor`, `complement`, `imported_solid` oraz stare limity
   `32/1024/1024`.
2. Hash Pythona: pięć nowych negatywnych testów wykazało hashowanie bez typed
   parse/normalizacji oraz akceptację niepoprawnych payloadów.
3. Typed parse: cztery testy Pythona failowały przez brak `from_ir`, a test
   Rust pokazał, że zagnieżdżony boolean pozostawał nieskanonizowany po serde.
4. Rzeczywiste uchwyty: integracja DSL failowała na nieznanym argumencie
   `object_id`, a obiekt posiadający wyłącznie `name` był błędnie akceptowany.
   Dodatkowy test canonical script wykazał, że jawne ID znikało w eksporcie.
5. Dokumentacja: validator wskazał dwa nieistniejące symbole
   `point_in_region_shape` i `geometry_contains`; po aktualizacji mapy wykrył
   też niewspierany format deklaracji enum, który zastąpiono walidowalnym,
   istniejącym symbolem źródłowym bez fabrykowania deklaracji.
6. Jakość Pythona: nowy focused suite dał `1 failed, 5 passed`; failure
   `ModuleNotFoundError: fullmag.model._selection_wire` potwierdził, że typed
   wire/parse, graph/hash i publiczny DSL nadal były jednym modułem. Po podziale
   wszystkie sześć testów przeszło.

## Świeże bramki GREEN

```text
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_selection_contract.py \
  packages/fullmag-py/tests/test_selection_geometry.py \
  packages/fullmag-py/tests/test_selection_graph_limits.py
78 passed in 0.60s

CARGO_TARGET_DIR=/tmp/fullmag-task4-fix-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-ir selection -- --nocapture
22 passed, 0 failed w crates/fullmag-ir/tests/ir_tests.rs
pozostałe test binaries: 0 uruchomionych, 0 failed po filtrze selection

ruff check packages/fullmag-py/src/fullmag/model/selection.py \
  packages/fullmag-py/src/fullmag/model/_selection_wire.py \
  packages/fullmag-py/src/fullmag/model/_selection_validation.py \
  packages/fullmag-py/src/fullmag/select.py \
  packages/fullmag-py/tests/test_selection_contract.py \
  packages/fullmag-py/tests/test_selection_geometry.py \
  packages/fullmag-py/tests/test_selection_graph_limits.py
All checks passed

ruff format --check dla tych samych siedmiu plików
7 files already formatted

python3 -m py_compile packages/fullmag-py/src/fullmag/model/selection.py \
  packages/fullmag-py/src/fullmag/model/_selection_wire.py \
  packages/fullmag-py/src/fullmag/model/_selection_validation.py \
  packages/fullmag-py/src/fullmag/select.py
exit 0

git diff --check -- <pliki Task 4 quality>
exit 0

rustfmt --edition 2021 --check \
  crates/fullmag-ir/src/selection.rs \
  crates/fullmag-ir/src/validation.rs \
  crates/fullmag-ir/tests/ir_tests.rs
exit 0

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0996-frozen-spins-constraint.source-map.json --repo-root .
exit 0

python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
23 passed
```

## Granice i współdzielony worktree

- Nie dodano top-level constraintu do `ProblemIR`; to zakres Task 5.
- Nie dodano adaptera planner/runtime ani backendowej materializacji; to zakres
  Task 6 i dalszej kwalifikacji.
- Nie zmieniono OpenAPI ani capability matrix.
- Nie cofano ani nie formatowano globalnie współdzielonych dirty zmian Task 3 i
  innych zadań. Ruff dla całych współdzielonych plików zgłasza istniejące,
  niezwiązane naruszenia; bramka Task 4 obejmuje nowe moduły i focused testy.
- Pełny suite repo nie był ponownie uruchamiany w tej turze, ponieważ review
  wymagał focused gates i dokumentacji. Status nie jest deklaracją
  produkcyjnej kwalifikacji.

## Handoff do ponownej recenzji

Recenzent powinien ponownie sprawdzić pięć findingów z `task-4-review.md` oraz
dwa findingi jakościowe, szczególnie parity kanonicznego hasha, fail-closed
`imported_solid`, deserializację nested boolean, zachowanie jawnego `object_id`
w canonical script round-trip, acykliczny podział modułów i dokładne testy
limitów grafu. Oczekiwany status po pozytywnej recenzji: `READY`; do tego czasu
raport pozostaje `READY_FOR_RE_REVIEW`.
