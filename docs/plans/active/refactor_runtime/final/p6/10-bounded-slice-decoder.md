# P6-C — bounded decoder slice'ów datasetu

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / RUNTIME NOT VERIFIED**

## Zakres przyrostu

`DatasetFieldSlice::decode_part_bytes` wykonuje rzeczywisty, storage-neutralny
decode części odczytanych z CAS. Najpierw waliduje identity manifestu, globalny
budżet, długość i checksum dokładnego zakresu. Zgodność z konkretnym żądaniem i
jego mniejszym budżetem nadal sprawdza istniejące `validate_for_request`.
Następnie:

- porządkuje części według offsetu we właściwej płaszczyźnie,
- dekoduje little-endian `f32` albo `f64`,
- zachowuje osobne `values` albo `real`/`imaginary`,
- zachowuje harmonic convention, precision, shape i source identity,
- odrzuca NaN oraz nieskończoność z dokładnym plane/index,
- odrzuca offsety i długości części niewyrównane do scalar width.

Decoder nie składa dodatkowej kopii pełnego payloadu bajtowego. Alokuje
docelowe wektory liczb o rozmiarze ograniczonym istniejącym budżetem odpowiedzi
64 MiB. Manifest może przeplatać części real/imag, ale wynik zawsze ma
kanoniczną kolejność płaszczyzn.

## Dowody

- `rustfmt` dla zmienionych plików: **PASS**.
- `cargo check -p fullmag-quantities --lib`: **PASS**.
- `cargo clippy -p fullmag-quantities --lib -- -D warnings -A
  clippy::manual_is_multiple_of`: **PASS**. Wyjątek dotyczy istniejącego kodu
  `eval.rs`, poza zakresem przyrostu.
- `git diff --check`: **PASS**.
- Regresje real/imag F32 i odrzucenia NaN zostały zapisane, lecz pozostają
  **NOT RUN** zgodnie z tymczasowym zakazem budowania i uruchamiania testów
  jednostkowych w `AGENTS.md`.

## Otwarte elementy

Brakuje adaptera `TensorDescriptor`/CAS, publicznego slice API, generated
clienta, worker/browser decode, pomiaru peak RAM/throughput na dużym datasecie
oraz pełnego roundtripu FINAL-09. Przyrost nie dowodzi żadnego runtime'u FDM ani
FEM.
