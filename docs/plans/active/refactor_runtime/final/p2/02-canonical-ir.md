# P2-A — deterministyczne bajty ProblemIR

## Aktualizacja 24.09.2026 — wspólny fixture wykonany

Trasa `just verify-authoring-contracts` wykonała **104/104 testy Rust PASS**,
w tym `canonical_digest_matches_the_shared_python_authoring_fixture`.
Testy Python `test_authoring_model_projection.py` przeszły **12/12**
z `PYTHONPATH=packages/fullmag-py/src`; oba języki sprawdziły ten sam plik
`crates/fullmag-authoring/tests/fixtures/authoring_model_canonical.json`
oraz oczekiwany digest `.sha256`. Fixture obejmuje liczby zmiennoprzecinkowe,
ujemne zero, notację wykładniczą i Unicode, w tym znak spoza BMP.

Run Rust: `5fd7f5da290345e6ad8ae3b0c26ef9cd`, exit 0,
`source_changed_during_run=false`. Receipt i log są w zarządzanym storage:
`builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/authoring-contract-tests/5fd7f5da290345e6ad8ae3b0c26ef9cd/`.
Trasa obejmuje źródła i katalog fixture w identyfikacji wejść.

Pierwsze wykonanie (`11de932ce195450394274442260b6424`) miało 103 PASS
i jeden błąd fixture study. Test używał płaskiego `kind`, podczas gdy bieżący
`StudyStep` serializuje obiekt `StudyStepKind` pod polem `kind`. Poprawiono
fixture i dodano kontrolę zachowania pełnego nieznanego payloadu po zapisie
i odczycie oraz odmowy `validate_for_execution()`. Nie zmieniono wire format.

Poniższe wpisy z 21.09 są historyczne: ich `NOT RUN` dla tego fixture zostało
zastąpione powyższym dowodem. Nie jest to dowód wszystkich wartości IEEE-754,
pełnego GUI↔Python↔Rust round-trip, wspólnego AST Rust/Python ani runtime.

## Stan historyczny

Data: 21.09.2026. Zakres: mały slice canonicalizacji P2-A; bez zmiany pól IR,
semantyki fizyki, requested/resolved runtime ani realizacji solvera.

## Zmiana

`packages/fullmag-py/src/fullmag/model/canonical.py` udostępnia wewnętrzny
kontrakt `canonical_json_bytes` / `canonical_json_sha256`. Kod sortuje klucze,
usuwa whitespace, zachowuje stabilne kodowanie ASCII i odrzuca `NaN`/`Infinity`
zamiast emitować nieprzenośne tokeny JSON. `fullmag.runtime.helper` używa tej
samej funkcji przy zapisie tożsamości wykonanego ProblemIR.

Ten slice nie rozstrzyga jeszcze, które pola display/provenance są poza
tożsamością numeryczną, nie wprowadza versioned parameter libraries i nie
zamyka wspólnej canonicalizacji Rust/Python. Rust ma już osobny structural
canonicalizer dla `ModelDefinition`, ale formatowanie liczb oraz cross-language
fixture pozostają dalszym P2-A i muszą zachować istniejące benchmark identity
oraz mapę źródeł.

## Dowody

- `test_problem_ir.py` + `test_scene_document_roundtrip.py`: **14 passed**.
- Test digestu benchmarku i kontraktu canonical JSON: **3 passed**.
- `test_authoring_model_projection.py`: **10 passed**, w tym stabilność
  canonical wire hash po stronie Python.
- `cargo check --locked -p fullmag-authoring --lib`: **PASS** dla Rust
  `canonical_json_bytes()`/`canonical_sha256()`; test cross-language nie został
  uruchomiony.
- `python scripts/check_repo_consistency.py`: **PASS**.

Jeden szerszy filtr `test_fem_benchmark_config.py` zatrzymał się na
windowsowym imporcie unixowego modułu `resource`; nie jest to regresja tego
slice'u. Właściwe przypadki `executed_problem_ir_sha256_*` przeszły osobno.

## Granica odbioru

Wynik: **P2-A canonical-bytes plus Rust digest slice PASS / P2-A overall IN
PROGRESS**. To dowód deterministycznego kodowania na poziomie Python oraz
kompilowalnej granicy Rust; nie jest to jeszcze dowód identycznych bajtów
Python↔Rust, pełnego roundtripu GUI↔Python↔Rust, managed runtime ani release.
