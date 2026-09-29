# P6-B — fundament kontraktu datasetów i wyników pochodnych

Data: 29.09.2026
Status: **SOURCE CHECK PASS, REGRESJE ZAPISANE / NOT RUN**

## Zakres

`fullmag-quantities` ma teraz wspólny, backend-neutralny kontrakt dla czterech
oddzielnych pojęć:

- `DatasetDefinition` jest edytowalną recepturą przypiętą do rozwiązania albo
  jawnie rozwiązanego źródła live;
- `MaterializedDataset` ma własny niezmienny `dataset_id`, rewizję i referencję
  do konkretnej rewizji receptury;
- `DerivedValueDefinition` opisuje operator, miarę całkowania, wymagane
  quantities, rozdzielczość i wersję producenta;
- `PlotDefinition` przechowuje wyłącznie recepturę prezentacji i wskazuje
  dataset albo definicję wartości pochodnej.

Materializowany wynik zachowuje stabilne identyfikatory osi, współrzędnych,
próbek, elementów i relacji gałęzi. Walidator odrzuca duplikaty, nieznane
współrzędne oraz branch members niewskazujące istniejącego elementu.

Stan dostępności rozróżnia `ready`, `not_recorded`, `not_applicable`,
`not_yet_computed`, `unsupported`, `missing` i `corrupt`. Tylko `ready`
oznacza obecność payloadu numerycznego. Pole dostępne jako `ready` musi mieć
resource key; pole niedostępne może zachować descriptor bez udawania wartości
zerowej.

Deskryptor pola wiąże quantity, jednostkę, tensor rank, przestrzeń funkcji,
topologię, layout, kodowanie real/imag i klasę rozdzielczości. Porównanie pól
odrzuca różną semantykę, a dla niezgodnego function-space/topology/layout
wymaga jawnej, wersjonowanej projekcji. Ilościowa wartość pochodna nie może
użyć `PreviewOnly`.

## Dowody

- `cargo check -p fullmag-quantities --lib`: **PASS**;
- `cargo clippy -p fullmag-quantities --lib -- -D warnings
  -A clippy::manual_is_multiple_of`: **PASS**;
- pierwszy strict clippy ujawnił wyłącznie wcześniejszy problem
  `manual_is_multiple_of` w niezmienionym `eval.rs`;
- scoped `rustfmt` i `git diff --check`: **PASS**.

Cztery regresje kontraktu zostały zapisane: rozróżnienie unavailable od zera,
zakaz `PreviewOnly` dla wyniku ilościowego, obowiązek projekcji między różnymi
przestrzeniami oraz rozdzielenie identity receptury i materializowanego
datasetu. Pozostają **NOT RUN** zgodnie z tymczasowym zakazem budowania testów
jednostkowych w `AGENTS.md`.

## Granica

Kontrakt nie jest jeszcze endpointem API ani formatem przechowywania. Otwarte
pozostają materializator/evaluator, paginacja i partial reads, integrity/CAS,
OpenAPI i generated client, frontend porównań i wykresów, real/imag roundtrip
na rzeczywistym artefakcie oraz kwalifikacja FDM/FEM.

P6 rośnie z **6% do 9%**. Cały plan pozostaje około **49%**.
