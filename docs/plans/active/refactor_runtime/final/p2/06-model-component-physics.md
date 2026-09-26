# P2-A — projekcja Model/Component/PhysicsConfiguration

Data checkpointu: 24.09.2026. Ten dokument opisuje ograniczony slice granicy
authoringu Python → typowany model. Nie zamyka jeszcze pełnego kontraktu P2-A,
ponieważ Rust/browser nie mają wspólnego round-trip i nie ma loweringu tej
projekcji do nowego ProblemIR.

## Wykonany zakres

`packages/fullmag-py/src/fullmag/model/authoring.py` wprowadza trzy
niemutowalne DTO:

- `ComponentDefinition` — stabilny `component_id`, nazwa, kanoniczna geometria,
  referencja materiału, regiony, przypisania pól materiałowych, przypisane
  moduły fizyki, stan początkowy i recepta mesha;
- `PhysicsConfiguration` — identyfikator konfiguracji, typy aktywnych energii,
  payloady energii, źródła, constraints i moduły z istniejącego grafu fizyki;
- `ModelDefinition` — komponenty, konfiguracje fizyczne, sprzężenia,
  dyskretyzacja oraz wersjonowana biblioteka parametrów.

`Problem.to_model_definition()` buduje projekcję z istniejącego immutable
`Problem`. Nie uruchamia meshera, nie wybiera backendu i nie tworzy drugiego
mutable source of truth. Zagnieżdżone mapowania są zamrażane, a `to_ir()` zwraca
kopię JSON-ową, więc modyfikacja payloadu eksportowego nie zmienia modelu.

`component_id` korzysta z jawnego `Ferromagnet.object_id`; dla starego wejścia
bez tego pola używany jest deterministyczny identyfikator migracyjny
`component:<name>`. Taki fallback nie jest jeszcze obietnicą odporności na
zmianę nazwy i pozostaje do zastąpienia przy pełnej migracji trwałych ID.

Każdy DTO ma parser `from_ir()`, który wymaga właściwej wersji schematu,
odrzuca nieznane pola i ponownie zamraża zagnieżdżone payloady. Dzięki temu
Python ma jawny, odwracalny odczyt `authoring_model.v1` bez tworzenia drugiego
mutowalnego writera; równoważność z serializacją Rust pozostaje osobną bramką.

Biblioteka parametrów pozostaje jednym źródłem wartości. Projekcja zachowuje
pełny payload display/provenance oraz zapisuje `parameter_numerical_sha256`;
`ModelDefinition.numerical_sha256()` pomija nazwę modelu, nazwy komponentów i
geometrii oraz `display_unit`, `description` i `authored_unit`. Zachowuje
stabilne ID, referencje i wartości geometryczne. Pełny `canonical_sha256()`
nadal obejmuje nazwy i display metadata, więc eksportowany wire payload nie
traci informacji prezentacyjnych.

`crates/fullmag-authoring/src/authoring_model.rs` udostępnia ten sam kształt
kontraktu po stronie Rust jako projekcję `SceneDocument`. Projekcja ma także
`ModelDefinition::from_value()` / `model_definition_from_value()` jako
read-only decoder wire payloadu. Projekcja:

- najpierw uruchamia walidację authoringową sceny i normalizację grafu fizyki;
- zachowuje stabilne identyfikatory obiektów, regionów, przypisań materiałowych
  i modułów oraz jawne `geometry`, `initial_state` i `mesh_recipe`;
- przenosi couplingi, intencję dyskretyzacji i aktywne termy fizyczne do
  wersjonowanych payloadów `authoring_model.v1`, `component_definition.v1` i
  `physics_configuration.v1`;
- nie uruchamia meshera, nie materializuje `ProblemIR` i nie wybiera backendu;
  pola `parameters` i `parameter_numerical_sha256` pozostają `None`, ponieważ
  Rust nie ma jeszcze wspólnego canonical parameter AST.

Wire digest `ModelDefinition` ma osobny serializer autoryzacyjny w Pythonie i
Rust. Normalizuje skończone floaty do najkrótszego round-trip zapisu
wykładniczego z nieuzupełnionym wykładnikiem. Nie zmienia to
`canonical_json_sha256()` używanego przez istniejącą tożsamość `ProblemIR` ani
`numerical_sha256()`. Wspólny fixture zawiera m.in. `1.0`, ujemne zero,
wartości z małym i dużym wykładnikiem oraz Unicode; stanowi bramkę zgodności
Python↔Rust, a nie dowód GUI/Python/Rust round-trip.

Eksportowane funkcje `model_definition_from_scene_document()` i
`scene_document_model_definition()` są read-only; nie są jeszcze połączone z
endpointem API ani z browserowym serializatorem.

## Przykład

```python
import fullmag as fm

problem = fm.Problem(...)
model = problem.to_model_definition(model_id="model:film")

assert model.components[0].component_id == "component-film"
payload = model.to_ir()  # authoring_model.v1
```

Eksport klas jest dostępny przez `fullmag` i `fullmag.model`. To API jest
projekcją odczytową; nie udostępnia `fm.Project` ani mutatorów dokumentu.

## Dowody

- `packages/fullmag-py/tests/test_authoring_model_projection.py`: **12 passed**;
  stabilne ID i schematy, read-only nested payload, display unit poza
  numerical identity, nazwy display poza numerical identity, parser wire-formatu, canonical wire hash z odrzuceniem
  złej wersji/nieznanych pól oraz brak materializacji runtime.
- Połączona bramka `test_authoring_model_projection.py`,
  `test_parameter_ast.py`, `test_problem_ir.py` i
  `test_scene_document_roundtrip.py`: **33 passed**.
- `packages/fullmag-py/tests/test_parameter_ast.py` +
  `tests/test_problem_ir.py`: **17 passed** po dodaniu projekcji i eksportów.
- `python -m py_compile` dla nowego modułu, `Problem`, eksportów i testu:
  **PASS**.
- `cargo check --locked -p fullmag-authoring --lib`: **PASS** w poprzednim
  przyroście; obecny przyrost nie zmienia kodu Rust.
- Targeted Python shared-fixture test: **1 passed**; połączona bramka
  `test_authoring_model_projection.py` + `test_problem_ir.py`: **21 passed**.
  Fixture porównuje digest `ModelDefinition` z golden SHA-256 używanym również
  przez targeted test Rust; ProblemIR regresje zachowały dotychczasowy kontrakt.
- Targeted Rust shared-fixture test jest dodany, ale **NOT RUN**. Storage
  preflight wykrywa istniejące rzeczywiste katalogi `.fullmag` i `target`
  w checkoutcie i odmawia ich automatycznego podmienienia na linki; test Rust
  wymaga bezpiecznego profilu Cargo po zatwierdzonej migracji tych ścieżek.
- `git diff --check`: **PASS**; ostrzeżenia ograniczają się do normalizacji
  LF/CRLF w istniejącym checkoutcie Windows.

Nie uruchamiano testów Rust ani managed solver qualification. Python potwierdza
hash wspólnego fixture; zgodność digestu z wykonanym Rust pozostaje
**NOT VERIFIED** z powodu storage preflight, a nie pozytywnego wyniku testu.

## Otwarte bramki

1. Uruchomić wspólny fixture canonical digestu po stronie Rust przez zatwierdzony
   storage profil. Sam source-level normalizer i Python test nie potwierdzają
   jeszcze zgodności bajtów. Następnie dodać lowering obu projekcji do jednego
   ProblemIR bez drugiego writer truth.
2. Dodać GUI ↔ Python ↔ Rust round-trip z zachowaniem referencji, błędów i
   display metadata.
3. Zmapować pełne selekcje, provenance `authored/resolved/executed`, library /
   presets oraz typed material/physics fields.
4. Podpiąć Model/Component do jawnego Study/RunSpec dopiero po przejściu
   granicy P2-C definicja → materializacja.

Wynik tego przyrostu: **P2-A Python + Rust typed projection, ścisłe dekodery
wire i Rust canonical digest slice PASS / pełny P2-A i P2 overall IN
PROGRESS**. Rust testy jednostkowe pozostają nieuruchomione zgodnie z polityką
repozytorium.
