# P6-C — strumieniowy integralny range-read CAS

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

`CasStore::get_verified_range` odczytuje żądany zakres obiektu bez alokowania
całego obiektu. Implementacja:

- waliduje CAS object identity i dodatni budżet zakresu,
- sprawdza overflow oraz granice wobec długości pliku,
- czyta obiekt sekwencyjnie buforem 64 KiB,
- aktualizuje SHA-256 dla każdego bajtu całego obiektu,
- kopiuje wyłącznie przecięcie bufora z żądanym zakresem,
- po zakończeniu porównuje pełny hash z nazwą obiektu CAS,
- wykrywa zmianę długości podczas odczytu,
- zwraca exact bytes i zweryfikowaną długość obiektu.

Adapter `TensorDescriptor` używa tej ścieżki zamiast `CasStore::get`. Porównuje
długość całego obiektu z `TensorChunk.length`, a następnie tworzy checksum
dokładnego zakresu dla manifestu slice. Usunięto poprzedni limit 64 MiB na
pojedynczy chunk. Limit odpowiedzi i alokacji zakresu pozostaje kontrolowany
przez `DatasetFieldSliceRequest.max_response_bytes`.

Rozwiązanie ma bounded memory, lecz integralność pełnego CAS oznacza nadal I/O
proporcjonalne do rozmiaru obiektu. Profil cold/warm i ewentualny zaufany cache
zweryfikowanych generacji pozostają osobnym krokiem optymalizacyjnym.

## Dowody

- `rustfmt` dla zmienionych plików: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; cztery istniejące warningi
  `store.rs`/`writer.rs` pozostają poza zakresem.
- scoped Clippy `--no-deps -D warnings` z allow-listą istniejących lintów
  innych plików crate'u: **PASS**.
- `git diff --check`: **PASS**.
- Regresja odczytu podzakresu i budżetu została zapisana, lecz pozostaje
  **NOT RUN** zgodnie z tymczasowym zakazem testów jednostkowych w `AGENTS.md`.

## Otwarte elementy

Brakuje publicznego dataset/slice API, generated clienta, ETag/generation cache
zweryfikowanych obiektów, profilu dużego datasetu, fault injection zmiany pliku
w trakcie odczytu oraz runtime artefaktów FDM/FEM. Pełny FINAL-09 pozostaje
**NOT VERIFIED**.
