# P2-A — wersjonowany AST parametrów i identity numeryczne

Data checkpointu: 21.09.2026. Ten dokument opisuje ograniczony, wykonywalny
slice P2-A. Nie oznacza jeszcze pełnego Model/Component/PhysicsConfiguration
ani podpięcia parametrów do wszystkich ścieżek ProblemIR, meshingu i UI.

## Zakres wykonany

`packages/fullmag-py/src/fullmag/model/parameters.py` udostępnia:

- `ParameterExpression` jako niemutowalny AST `parameter_ast.v1` z węzłami
  stałej, referencji oraz `+`, `-`, `*`, `/`;
- normalizację stałych do SI przy konstrukcji, z zachowaniem authored unit jako
  metadanych prezentacyjnych;
- statyczną kontrolę zgodności wymiarów dla znanych operandów i ponowną kontrolę
  podczas ewaluacji wartości rozwiązanych;
- `ParameterDefinition` z trwałym identyfikatorem, display unit i opisem;
- `ParameterLibrary` w schemacie `parameter_library.v1`, deterministyczną
  kolejność serializacji, DFS resolution, diagnostykę nieznanych referencji i
  cykli oraz `numerical_sha256()` oparty tylko o payload bez display metadata.

Publiczny eksport jest dostępny z `fullmag` i `fullmag.model`. Biblioteka jest
świadomie niezależna od solvera: nie uruchamia meshera, nie zmienia istniejącej
semantyki fizyki i nie tworzy drugiego ProblemIR. `Problem.parameters` oraz
`fm.parameter(...)`/`study.parameter(...)` są teraz wspólną granicą authoringu;
`Problem.to_ir()` zapisuje blok `parameter_library.v1`, a generated Python
script odtwarza go przez publiczny `ParameterExpression.from_ir()`.

## Kontrakt przykładowy

```python
import fullmag as fm

library = fm.ParameterLibrary()
library.define(
    "width",
    fm.ParameterExpression.constant(250.0, unit="nm"),
    display_unit="nm",
)
library.define(
    "double_width",
    2.0 * fm.ParameterExpression.reference("width"),
    display_unit="nm",
)

assert library.resolve("double_width").value_si == 500e-9
numeric_hash = library.numerical_sha256()
```

Zmiana `display_unit` z `nm` na `um` nie zmienia `numeric_hash`, ale zmienia
pełny zapis authoringu. Cykle i brakujące referencje kończą się jawnym błędem
przed loweringiem, zamiast przyjmować wartość domyślną.

## Dowody

- `python -m pytest packages/fullmag-py/tests/test_parameter_ast.py -q` przy
  `PYTHONPATH=packages/fullmag-py/src`: **7 passed** — także flat/study facade,
  ProblemIR lowering i generated-script round-trip.
- `test_script_builder_roundtrip.py`: **35 passed, 28 subtests passed**.
- `test_problem_ir.py`, `test_execution_context.py` i
  `test_scene_document_roundtrip.py`: **20 passed** po podpięciu biblioteki do
  `Problem`.
- `python -m compileall` dla modułu, eksportów i testu: **PASS**.
- `git diff --check`: **PASS** z wyłącznie windowsowym ostrzeżeniem LF/CRLF.

## Granice i następne kroki

Pozostaje podpięcie AST do pełnego Model/Component/PhysicsConfiguration,
browser round-trip, biblioteki materiałów i presets, provenance
resolved/executed, edycja display units w Inspectorze, walidacja zależności po
zmianie geometrii i migracja istniejących parametrów. Obecny blok parametrów
jest authoring metadata; nie zastępuje jeszcze typed material/physics fields.
Przed wejściem w P3 trzeba także przypiąć parametry do Study/RunSpec i
udowodnić, że requested intent oraz resolved execution nie są tracone.

Ten slice zalicza część kontraktu deterministycznej authoring identity, lecz
pełny odbiór P2-A pozostaje `IN PROGRESS`.
