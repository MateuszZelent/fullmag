# P6-B — pełny descriptor pola K11

Data: 29.09.2026
Status: **SOURCE CHECK PASS, REGRESJE ZAPISANE / NOT RUN**

## Zakres

`DatasetFieldDescriptor` nie opiera już zgodności pola wyłącznie na quantity,
jednostce i identyfikatorze przestrzeni. Zachowuje teraz wymagane przez K11:

- tensor rank, frame i sample location;
- aktywny support z fingerprintem i opcjonalną stabilną selekcją;
- topology i carrier identity;
- `FunctionSpaceDescriptor` z family, order, vector dimension, ordering,
  basis, constraints, partition oraz opcjonalnym orientation/mapping ref;
- layout digest, typowane osie i component axis;
- real albo real/imag z jawną harmonic convention;
- normalization oraz rozdzielenie `quantitative` od `preview_only`.

Globalne pola nie mogą nieść przestrzeni funkcji, a pola node/cell/DOF/
integration-point muszą ją mieć. Native ordering wymaga jawnego mapping ref.
Skalar nie może mieć component axis, natomiast pole o dodatnim tensor rank musi
wskazać oś istniejącą w swoim zestawie axes. Osie mają dodatnią długość i
unikalne identity. `layout_digest` musi być kanonicznym `sha256:`.

Porównanie pól sprawdza pełną semantykę: frame, sample location, support, axes,
complex convention i normalization. Różnica topology/carrier/function-space/
layout nadal może przejść wyłącznie przez jawną, wersjonowaną projekcję.

## Dowody

- `cargo check -p fullmag-quantities --lib`: **PASS**;
- `cargo clippy -p fullmag-quantities --lib -- -D warnings
  -A clippy::manual_is_multiple_of`: **PASS**;
- scoped `rustfmt` i `git diff --check`: **PASS**.

Dwie nowe regresje zapisano dla odmowy native ordering bez mappingu oraz
real/imag bez harmonic convention. Wcześniejsze regresje porównania przestrzeni
zostały przepisane na pełny descriptor. Testy pozostają **NOT RUN** zgodnie z
tymczasowym zakazem budowania testów jednostkowych w `AGENTS.md`.

## Granica

Descriptor nie inline'uje dużych indeksów DOF, constraints, partition ani map
orientacji. Ich materialne payloady mają trafić do binary data plane przez
referencje CAS. Nadal brak adapterów producentów FDM/FEM, realnego real/imag
artefaktu, API/OpenAPI i kwalifikacji roundtrip na czterech lane'ach.

P6 rośnie z **11% do 13%**. Cały plan pozostaje około **49%**.
