# Przygotowanie FDM przypięte do zaakceptowanego RunSpec

Data: 25.09.2026

Zakres: P3-B / P5-A — źródło planu przygotowania dla zaakceptowanego study step.

## Wynik

`PreparationPlan` zachowuje istniejący zapis v1 dla Live (`scene_revision`) i
dodaje v2 `accepted_run_step`, który przenosi `run_id`, fingerprint pełnego
RunSpecification oraz `step_id`. Wariant v2 nie zawiera `scene_revision`.
Deserializacja starego v1 pozostaje możliwa bez migracji jego payloadu.

`AcceptedStudySnapshot::materialize_fdm_preparation_receipt` pobiera wyłącznie
krok w stanie `Planned`, dokładny `ProblemIR` z immutable katalogu oraz jego
plan. Warstwa runtime-control ponownie planuje ProblemIR i wymaga pełnej
zgodności z planem snapshotu, po czym tworzy receipt v2 z tożsamością RunSpec
i kroku.
Nie przyjmuje ani nie syntetyzuje rewizji Live. Widok accepted-run używa
deterministycznego default marker, więc kamera i bieżący wybór w Live nie
zmieniają digestu receipt. Bieżący przyrost obejmuje materializację FDM;
accepted-run FEM wymaga osobnego producenta natywnych dowodów siatki i
przestrzeni.

Receipt waliduje zgodność v2 plan source z `accepted_run_source`. Nowy, nie
powiązany Live receipt nie może zostać dopięty do RunSpec. Dla kompatybilności
wcześniej zapisany receipt v1 z kompletnym, zgodnym markerem accepted-run
pozostaje czytelny; sam niepowiązany receipt v1 nie jest automatycznie
promowany. Marker to kontrola spójności danych, nie podpis kryptograficzny.
Decyzję o rozdzieleniu Live i accepted-run źródeł dopisano do
[`ADR-0009`](../../../../../adr/0009-geometry-invalidates-mesh.md).

## Zmienione obszary

- `crates/fullmag-plan`: jawne v2 source identity oraz walidacja rozdziału
  `scene_revision` i accepted-run.
- `crates/fullmag-application`: accepted-run receipt constructor i walidacja
  zgodności source markerów.
- `crates/fullmag-runtime-control`: wejście materializatora wyłącznie przez
  immutable `AcceptedStudySnapshot`, weryfikacja canonicalnego planu oraz
  deterministyczny display default.
- `crates/fullmag-api/src/router_v2/tests/project_documents.rs`: regresje dla
  nowego v2 receipt, odrzucenia niepowiązanego Live receipt i odczytu już
  powiązanego v1 receipt.
- `docs/adr/0009-geometry-invalidates-mesh.md`: kontrakt źródła i kompatybilność.

## Weryfikacja i ograniczenia

`rustfmt --edition 2021 --config skip_children=true` poprawnie sparsował i
sformatował zmienione moduły Rust. Testy API/application oraz kompilacja są
**NOT RUN / NOT VERIFIED**: zatwierdzony runner zgłosił `Container profile
allow-list mismatch`, a `runner-doctor` nie potwierdził kontekstu Docker
Desktop. Nie uruchamiałem hostowego Cargo.

To nie kończy P3-B ani P5-A. Nadal brakuje trwałego receiptu per task/step,
odblokowania readiness po przygotowaniu, odpornego na awarie admission claimu
i lease, podłączenia adaptera CLI/workera oraz accepted-run producenta FEM.
Procentów P3 i planu całości nie podnoszę przed przejściem wymaganych bramek.
