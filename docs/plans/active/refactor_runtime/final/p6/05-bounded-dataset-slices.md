# P6-B/P6-C — ograniczone partial reads datasetów

Data: 29.09.2026
Status: **SOURCE CHECK PASS, REGRESJE ZAPISANE / NOT RUN**

## Zakres

`fullmag-quantities` zawiera teraz storage-neutralny kontrakt partial read dla
pola materializowanego datasetu. Nie powstał drugi magazyn, tensor descriptor
ani kodek viewportu. `fullmag-session` nadal jest właścicielem CAS i
`TensorDescriptor`, a FMVP pozostaje istniejącym transportem renderera.

`DatasetFieldSliceRequest` wskazuje dokładny dataset/revision, sample, item i
field oraz zakres elementów. Żądanie musi podać dodatni limit odpowiedzi.
Kontrakt narzuca stałe granice:

- maksymalnie 8 Mi elementów,
- maksymalnie 64 MiB payloadu,
- maksymalnie 4096 fragmentów CAS.

`DatasetFieldSlice` zachowuje layout digest, precision, little-endian byte
order, component count, całkowitą liczbę elementów i dokładny zwrócony zakres.
Dla danych rzeczywistych wymaga jednej płaszczyzny `values`. Dla danych
zespolonych wymaga osobnych `real` i `imaginary` oraz jawnej konwencji
harmonicznej. Każda płaszczyzna musi być pokryta od bajtu zero do końca bez luk
i nakładania fragmentów.

Fragment rozróżnia istniejący 64-znakowy CAS `object_ref` od prefiksowanej
sumy `sha256:` dokładnie zwróconego zakresu. Walidator sprawdza długości,
overflow, budżet requestu, identity odpowiedzi oraz checksumy otrzymanych
bajtów. Checksum całego obiektu pozostaje obowiązkiem CAS; range checksum nie
podszywa się pod hash pełnego obiektu.

## Dowody

- `cargo check -p fullmag-quantities --lib`: **PASS**;
- `cargo clippy -p fullmag-quantities --lib -- -D warnings
  -A clippy::manual_is_multiple_of`: **PASS**;
- scoped `rustfmt` i `git diff --check`: **PASS**.

Trzy regresje zapisano dla bounded requestu, serde + checksum roundtrip
`real/imag` oraz odrzucenia luki między fragmentami. Pozostają **NOT RUN**
zgodnie z tymczasowym zakazem budowania testów jednostkowych w `AGENTS.md`.

## Granica

To kontrakt i walidator, jeszcze bez adaptera `TensorDescriptor`/CAS, endpointu
HTTP, OpenAPI ani generated clienta. Nie wykonano profilu cold/warm, peak RAM,
throughput i kosztu checksum; ta bramka wymaga rzeczywistego dużego datasetu po
podłączeniu storage. Slice nie wykonuje solve ani derived compute.

P6 rośnie z **9% do 11%**. Cały plan pozostaje około **49%**.
