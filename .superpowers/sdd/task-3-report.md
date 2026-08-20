# Raport Task 3 — Python geometry parity i convenience `disk`

## Status

`IMPLEMENTED_WITH_EXTERNAL_REGRESSION_BLOCKER`

Zakres Task 3 jest zaimplementowany i focused testy są zielone. Szeroka bramka
`test_api.py` dobiegła do końca, ale ujawniła jeden powtarzalny, niezwiązany z
Task 3 błąd istniejącego kontraktu tekstur. Bramka szeroka pozostaje formalnie
niezaliczona; nie zmieniono będących poza zakresem `test_api.py` ani
`fullmag/init/textures.py`.

## Zakres wykonany

- Dodano równoległy, niemutowalny AST `SelectionGeometry` w
  `packages/fullmag-py/src/fullmag/model/geometry.py`. Nie zastępuje on
  istniejącego scenicznego `Geometry`, więc nie zmienia legacy payloadów
  geometrii, regionów ani eksportu skryptów.
- `fm.shapes.disk(...)` tworzy finite cylinder z kanonicznymi polami
  `center_m`, `axis`, `radius_m` i `height_m`; normalna jest normalizowana.
- `fm.shapes.disk(..., extrusion="through_object", object_id=...)` zachowuje
  nierozstrzygniętą typed policy z obiektem. Nie udaje wyznaczonej wysokości
  przed loweringiem bounds obiektu.
- `fm.shapes.affine(...)`, `fm.shapes.rotate(...)` i `fm.shapes.scale(...)`
  tworzą wyłącznie serializowalny AST `affine` z `translation_m`,
  `rotation_xyzw`, `scale` i `pivot_m`; nie wykonują selekcji punktów w
  Pythonie.
- Gotowe buildery są także eksportowane na poziomie `fullmag`:
  `fm.disk`, `fm.affine`, `fm.rotate`, `fm.scale`.

## Dowód TDD

### RED

Pierwsze uruchomienie bez ustawionego lokalnego import path zakończyło się
collection error `ModuleNotFoundError: No module named 'fullmag'`; nie jest
traktowane jako dowód RED.

Po ustawieniu `PYTHONPATH=packages/fullmag-py/src` uruchomiono:

```text
pytest -q packages/fullmag-py/tests/test_selection_geometry.py
```

Wynik: `9 failed`. Wszystkie oczekiwane zachowania failowały przez brak
`fullmag.shapes.disk`, `fullmag.shapes.rotate` i `fullmag.shapes.affine`
(`AttributeError`), a nie przez błąd test harnessu.

### GREEN

Po minimalnej implementacji uruchomiono:

```text
PYTHONPATH=packages/fullmag-py/src pytest -q packages/fullmag-py/tests/test_selection_geometry.py
```

Wynik: `9 passed in 0.48s`.

Testy obejmują finite disk lowering, normalizację normalnej i center,
`radius <= 0`, `thickness <= 0`, zerową normalną, brak `object_id` dla
`through_object`, nierozstrzygniętą typed policy, JSON round-trip z nested
`scale`/`rotate`/`affine` oraz nieodwracalną skalę.

## Weryfikacja

| Bramka | Wynik |
|---|---|
| Focused selection geometry | PASS — 40 passed in 0.30s po fixupie review |
| `git diff --check -- packages/fullmag-py` | PASS — exit 0 |
| Wymagany `test_api.py` | NIEZALICZONE — pełny wynik: 313 passed, 1 skipped, 1 unrelated failure w 92.40s |

## Self-review

- Legacy `Geometry` nadal serializuje poprzedni scene/region IR; nowy typ ma
  jednoznaczną nazwę `SelectionGeometry` i nie jest do niego podstawiany.
- Finite `disk` nie ma wrappera extrusion i dokładnie emituje cylinder
  wymagany przez kontrakt.
- `through_object` przechowuje wyłącznie requested intent; wysokość nie jest
  lokalnie szacowana ani wykonywana.
- Walidacja odrzuca niefinityczne wektory, zerową normalną, zerowy komponent
  skali i zerowy quaternion. Skala ujemna pozostaje legalna, bo jest
  odwracalna.
- Nie dodano `SelectionExprIR`, `FrozenSpins`, lokalnego point-in-geometry ani
  zmian w lowering/runtime.

## Pozostały blocker

Wymagana regresja została uruchomiona do końca:

```text
PYTHONPATH=packages/fullmag-py/src pytest -q packages/fullmag-py/tests/test_selection_geometry.py packages/fullmag-py/tests/test_api.py
```

Broad gate ma świeży wynik końcowy, ale nie jest PASS z powodu opisanej niżej
niezależnej rozbieżności `preset_version`.

## Fixup po review

### Domknięty kontrakt

- `SelectionGeometry` jest zamkniętą klasą bazową canonical AST, a konstruktor
  `SelectionAffine` akceptuje wyłącznie dokładne typy
  `SelectionCylinder | SelectionAffine`. String, mapping, dowolny obiekt,
  subclass i obiekt z własnym `to_ir()` nie są przyjmowane jako dzieci.
- Authored AST jest rozdzielony od canonical `geometry_predicate.v1`.
  `SelectionThroughObjectDisk` ma wyłącznie `to_authored_ir()` z
  `kind="disk"` i typed `ThroughObjectExtrusion`; nie ma `to_ir()` i nie może
  serializować się jako skończony canonical cylinder przed loweringiem bounds
  obiektu i przecięciem z `in_object` w Task 4.
- Canonical affine i authored affine są osobnymi immutable dataclasses.
  Transformacje przez `fm.affine`, `fm.rotate` i `fm.scale` zachowują tę
  granicę również dla zagnieżdżonego `through_object`.
- Wszystkie składowe liczbowe przechodzą ścisłą walidację przed konwersją.
  `bool`, stringi i nienumeryczne sekwencje są odrzucane; NaN/Inf są
  odrzucane; radius/thickness muszą być dodatnie; normal/quaternion niezerowe;
  każdy komponent scale niezerowy.
- `SelectionGeometry.from_ir()` i
  `AuthoredSelectionGeometry.from_authored_ir()` odtwarzają typed AST,
  odrzucają nieznane/brakujące pola oraz złe warianty, kopiują wejściowe
  listy/mappingi do immutable tuples i zwracają świeże listy/dicty przy każdej
  serializacji.
- Publiczny namespace eksportuje dokładnie aliasy builderów `affine`, `disk`,
  `rotate`, `scale`; wewnętrzne klasy AST nie zostały dodane do
  `fullmag.__all__`.

### RED po review

Pierwsza próba nowych testów zakończyła się collection error przez bezpośredni
import jeszcze nieistniejącej klasy `AuthoredSelectionGeometry`; nie jest
zaliczona jako behavioural RED. Po zmianie testu na odwołanie przez moduł:

```text
PYTHONPATH=packages/fullmag-py/src pytest -q packages/fullmag-py/tests/test_selection_geometry.py
19 failed, 20 passed in 0.40s
```

Failowały oczekiwane klasy zachowania: akceptacja `bool`/stringów, brak
runtime closure dzieci AST, `through_object` udający cylinder, brak typed
`from_ir`/`from_authored_ir`, brak copy-safe round-trip oraz brak walidacji
typed extrusion policy.

### GREEN po review

Po minimalnej implementacji i końcowym wzmocnieniu copy-safety:

```text
PYTHONPATH=packages/fullmag-py/src pytest -q packages/fullmag-py/tests/test_selection_geometry.py
40 passed in 0.30s
```

### Pełna bramka i niezależny blocker

Wymagany proces nie został przerwany i dobiegł do końca:

```text
PYTHONPATH=packages/fullmag-py/src pytest -q \
  packages/fullmag-py/tests/test_selection_geometry.py \
  packages/fullmag-py/tests/test_api.py
1 failed, 313 passed, 1 skipped, 41 warnings in 92.40s
```

Jedyny failure to
`ProblemApiTests.test_random_initializer_serializes_to_ir`. Aktualne
`fm.texture.random(seed=42)` emituje `preset_version: 2` z
`packages/fullmag-py/src/fullmag/init/textures.py`, a istniejące oczekiwanie w
`test_api.py:2160` nadal nie zawiera tego pola. Celowana reprodukcja zakończyła
się identycznie (`1 failed in 0.46s`). Ani producent tekstury, ani test nie są
częścią Task 3; zgodnie z zakresem nie zostały zmienione.
