# P6-C — adapter TensorDescriptor/CAS do dataset slice

Data: 29.09.2026

Status: **SOURCE VERIFIED / UNIT TESTS NOT RUN / API/RUNTIME NOT VERIFIED**

## Zakres przyrostu

Nowy `fullmag_session::dataset_slice_adapter` łączy istniejące
`TensorDescriptor`/`TensorChunk` i `CasStore` z kontraktem
`DatasetFieldSlice`. Adapter:

- wymaga `fullmag.tensor.v1`, little-endian oraz F32 albo F64,
- wiąże shape z `total_elements × component_count`,
- wymaga niepustych, unikalnych logical axes zgodnych z rankiem,
- odrzuca luki, overlap, zero-length i misalignment chunków,
- wymaga jednakowej precyzji wszystkich płaszczyzn,
- waliduje legalny zestaw `values` albo `real/imaginary`,
- sprawdza harmonic convention przed I/O,
- czyta obiekt przez `CasStore::get`, który weryfikuje jego pełny SHA-256,
- wycina tylko żądany zakres i oblicza jego osobny `sha256:<hex>`,
- buduje manifest oraz bajty w tej samej kolejności i ponownie je waliduje,
- może bezpośrednio wywołać bounded decoder z poprzedniego przyrostu.

W tym przyroście `CasStore` nie miał integralnego range-read, dlatego adapter
odrzucał chunk większy niż 64 MiB. Ograniczenie zostało następnie usunięte przez
[strumieniowy integralny range-read](12-streaming-cas-range-read.md). Suma
zwracanych zakresów nadal musi mieścić się w `max_response_bytes` żądania.

## Dowody

- `rustfmt` dla nowego modułu: **PASS**.
- `cargo check -p fullmag-session --lib`: **PASS**; raportuje cztery istniejące
  ostrzeżenia poza adapterem (`store.rs` i `writer.rs`).
- `cargo clippy -p fullmag-session --lib --no-deps -- -D warnings ...`:
  **PASS** po jawnych allow dla istniejących lintów innych plików crate'u.
- `git diff --check`: **PASS**.
- Regresja cross-chunk exact-range i decode została zapisana, lecz pozostaje
  **NOT RUN** zgodnie z tymczasowym zakazem budowania i uruchamiania testów
  jednostkowych w `AGENTS.md`.

## Otwarte elementy

Brakuje publicznego API i generated clienta, adaptera pola do właściwego
descriptoru datasetu, profilu peak RAM/throughput oraz realnego artefaktu
FDM/FEM. FINAL-09 i kwalifikacja runtime pozostają **NOT VERIFIED**.
