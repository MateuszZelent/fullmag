# P6-B — receipts projekcji i metryki błędu

Data: 29.09.2026
Status: **SOURCE CHECK PASS, REGRESJE ZAPISANE / NOT RUN**

## Zakres

Kontrakt rozdziela `FieldProjection` jako edytowalną recepturę od
`FieldProjectionReceipt` jako dowodu wykonanej projekcji. Receptura zachowuje
metodę, docelową przestrzeń oraz wersję producenta. Receipt wiąże ją z
dokładnymi identity źródła i celu:

- topology ID,
- carrier ID,
- function-space ID,
- kanoniczny layout digest.

Receipt musi zawierać co najmniej jedną jawną metrykę błędu. Każda metryka ma
rodzaj (`l1`, `l2`, `l_inf`, `relative_l2` albo
`conservation_residual`), skończoną nieujemną wartość, jednostkę oraz znaczenie
wartości: `measured`, `estimated_upper_bound` lub `certified_upper_bound`.
Duplikat tego samego rodzaju jest odrzucany.

`validate_field_compatibility` przy różnym topology/carrier/space/layout
wymaga receipt'u projektującego prawą stronę dokładnie do layoutu lewej.
Receipt dla innej rewizji layoutu, bez metryk albo z niezgodną przestrzenią
docelową jest odrzucany. Projekcja nie jest dopuszczana dla pól globalnych bez
przestrzeni funkcji.

`DatasetTransform::Projection` zachowuje teraz także `producer_version`, aby
receptura nie zależała od niejawnej bieżącej implementacji projektora.

## Dowody

- `cargo check -p fullmag-quantities --lib`: **PASS**;
- `cargo clippy -p fullmag-quantities --lib -- -D warnings
  -A clippy::manual_is_multiple_of`: **PASS**;
- scoped `rustfmt` i `git diff --check`: **PASS**.

Regresja porównania różnych przestrzeni używa exact receipt'u z
`relative_l2`. Nowa regresja odrzuca brak metryk oraz receipt związany z innym
layoutem. Testy pozostają **NOT RUN** zgodnie z tymczasowym zakazem budowania
testów jednostkowych w `AGENTS.md`.

## Granica

Nie istnieje jeszcze projector FDM/FEM ani runtime receipt z rzeczywistego
wykonania. Kontrakt nie kwalifikuje metody, tolerancji ani fizyki. Brak także
publicznego API, zapisu CAS i scenariusza CAE-40 na reprezentatywnych polach.

P6 rośnie z **13% do 15%**. Cały plan pozostaje około **49%**.
