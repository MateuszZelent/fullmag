# P2-A — deterministyczne bajty ProblemIR

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
przenosi canonicalizacji do Rust. Te decyzje pozostają dalszym P2-A i muszą
zachować istniejące benchmark identity oraz mapę źródeł.

## Dowody

- `test_problem_ir.py` + `test_scene_document_roundtrip.py`: **14 passed**.
- Test digestu benchmarku i kontraktu canonical JSON: **3 passed**.
- `python scripts/check_repo_consistency.py`: **PASS**.

Jeden szerszy filtr `test_fem_benchmark_config.py` zatrzymał się na
windowsowym imporcie unixowego modułu `resource`; nie jest to regresja tego
slice'u. Właściwe przypadki `executed_problem_ir_sha256_*` przeszły osobno.

## Granica odbioru

Wynik: **P2-A canonical-bytes slice PASS / P2-A overall IN PROGRESS**.
To dowód deterministycznego kodowania na poziomie Python source/contract; nie
jest to dowód pełnego roundtripu GUI↔Python↔Rust, managed runtime ani release.
