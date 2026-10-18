# P8-53CG — finalizacja późnego preview standalone inspection

Data: 14.10.2026. Baza `d7e00d968b15fbfa8ac8979e8f23a9719dc786c3`.
Diagnoza: CI job `115771144769` na bazie 6357af85 — 85 API session tests PASS,
2 FAIL. Jeden błąd fixture; drugi rzeczywisty błąd produkcyjnej kolejności.

## Poprawka produkcyjna

Tryb `antenna_external_lead_inspection` ma osobny niemagnetyczny read model.
Istniejący finalizer usuwa pozostałe magnetyczne carriers, także late frame,
jednak wcześniej runtime apply walidował H_eff jako aktywne publikowane pole
magnetyczne i zwracał 400 przed finalizacją. Poprawka używa wspólnego predykatu
tego konkretnego trybu: transient active preview nie jest promowany do
preview_cache ani walidowany jako publikowany physical resource. Pozostałe
operacje apply i istniejący finalizer działają nadal; generation history
nie jest kasowana. Zwykłe trasy magnetyczne nadal wywołują
validate_preview_field_sources przed publikacją. Nie zmieniono record-kind,
admission ani ogólnych provenance fences.

Regresja `standalone_read_model_does_not_retain_late_magnetic_runtime_frame`
zachowuje late H_eff i FEM mesh oraz asercje ich całkowitego usunięcia.
Nie usunięto problematycznych danych, aby zazielenić test.

## Korekta fixture przyjętej obserwacji

`snapshot_reconciliation_requires_fresh_exact_identity_for_compute_and_import_results`
w przypadku compute_fields tworzy accepted physical observation frame przez
istniejący add_physical_observation z step 0/time None, zanim umieści preview m
w cache. Readiness nadal wymaga właściwej observation/provenance; nie obniżono
produkcji do przyjmowania samego blobu w cache. Asercje świeżości i exact
identity oraz pozostałe przypadki command completion zachowano.

## Dowody i otwarte bramki

Review root diffu i konsumentów, Rust parser stdin bez zapisu oraz diff check:
PASS. Worker sam nie uzyskał parsera z powodu odmowy hosta; wynik root jest
odrębnym dowodem. Lokalnych unit tests nie kompilowano ani nie wykonywano.
CI musi potwierdzić obie zachowane regresje i całą serię API session —
**NOT VERIFIED** do odczytu wyniku na poprawionym SHA. Managed runtime/browser,
pełny native pakiet, A→B→C, nauka i wydanie nie są tym dowodem.

Lokalny generate-client `2e6ed73f7bf6484c89d6758ba902dd76`: PASS, ale bez
semantycznej zmiany types/client wobec checked JSON. Nie odtworzył driftu
CI generated-api-determinism; ta bramka pozostaje otwarta i wymaga porównania
obu producentów/źródłowego eksportu. Nie edytować generated ręcznie.

**P8 i cały plan pozostają IN PROGRESS.**
