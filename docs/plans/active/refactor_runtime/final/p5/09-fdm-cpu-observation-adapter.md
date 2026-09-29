# P5-C — adapter `ObservationRuntime` dla prostego FDM CPU

Data: 29.09.2026

Status: **SOURCE CHECK PASS / END-TO-END NOT QUALIFIED**.

## Wynik

Nowe snapshoty accepted state prostego FDM CPU zachowują dwa dodatkowe,
opcjonalne dowody:

- preimage primary carriera `transactional_state_digest`, z którego można
  ponownie wyliczyć kanoniczny `state_digest`;
- `magnetization_digest` obliczony z liczby wektorów oraz bitów `f64` w porządku
  big-endian.

Pola są opcjonalne w wire v1, dzięki czemu historyczny snapshot pozostaje
dekodowalny. Produkcyjny generator zapisuje oba. Adapter
`ObservationRuntime::from_fdm_cpu_accepted_state` wymaga obu pól, dokładnej
zgodności clock/state z `AcceptedStateId`, zgodności digestu dostarczonej
magnetyzacji i poprawnego gridu. Historyczny snapshot bez preimage albo bez
wiązania magnetyzacji jest fail-closed i nie uruchamia evaluatora.

Po poprawnej walidacji adapter udostępnia wyłącznie quantity `m`. Nie promuje
pól efektywnych, energii ani innych danych, których adapter nie materializuje.

## Weryfikacja

- `cargo check -p fullmag-runner --lib`: **PASS**;
- `git diff --check`: **PASS**;
- zapisano regresję poprawnego `m` i odrzucenia magnetyzacji o innym digescie;
- testów jednostkowych nie budowano ani nie uruchamiano zgodnie z tymczasową
  regułą repozytorium.

## Granica dowodu

Adapter działa na zweryfikowanych obiektach w pamięci. Nie ładuje jeszcze
manifestu/CAS, nie ma publicznej operacji `ComputeQuantities`, admission ani
receiptu batchu. Nie kwalifikuje coupled/Frozen Spins, FDM GPU, FEM, managed
runtime, browsera ani zgodności naukowej pól pochodnych.

P5 rośnie do **98%**. Cały plan pozostaje około **49%**.
