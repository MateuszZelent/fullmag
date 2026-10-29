# Zimny odczyt V/J/H przy pustym Workspace — 27.10.2026

## Problem i zmiana

Istniejący odczytowy walidator historycznego wyniku bezwarunkowo wymagał
HTTP 200 dla current scene/commands. Po poprawnym restarcie API nie ma aktywnej
sesji i te zasoby prawidłowo zwracają 404/not_found. Nie jest to brak wyniku
przypiętego do historycznego project/run.

`scripts/validate_accepted_antenna_closed_loop_http.py::workspace_snapshot`
sprawdza health.active_session jako jawny bool i health.status=ok. Zachowuje
listę sesji, scenę i komendy przed oraz po wszystkich odczytach. Dla aktywnej
sesji nadal wymaga 200; dla potwierdzonego braku wymaga dokładnie 404 z kodem
not_found. Błąd lub zmiana obecności sesji nie jest zamieniana w pustą scenę.
Nie dodano tworzenia sesji, importu, submitu, Solve lub mutacji API.

## Weryfikacja

RED odtworzył expected 200, got 404. Sześć interpretowanych regresji PASS:
pusty Workspace, zachowanie aktywnej sceny/komend, brak sceny przy aktywnym
health, zmiana sesji w trakcie odczytu, nieznany health/obca odmowa i porównanie
przed/po. Kontrola AST PASS. Nie kompilowano testów Rust.

Rzeczywisty walidator HTTP: exit 0, 33 kontrole, 132,277 s. API z managed
iteration cb64d7ff17f144739d78745a9483d16a, źródła buildu
5ad6613f649fb82acaceffb574758cd98b6beb79 + WIP, snapshot
af7b536b41562148c06975ac0562ffe42ab3ad25025eda9d7a4b4178ea3c4949.
Run: run-antenna-mpfr-confirmatory-v2-20261026-01.
Task: task-7db7d7ae980867760d8aa1f0fddf7bef5ef4c7b168714be87ff88fbc3048305e.
Attempt: attempt-ffeb99a13c9043be8ca5919ddd115edf, epoch 1.
Package: 84e0867160f5911575d8e5b1357a898dee1b6f03006ad46f2af6d987ffee7873.

Sprawdzono rzeczywiste V/J/H: SI, skończoność i niezerowe wartości, długości
i SHA256 payloadów, ETag/304, Range/206/416 oraz odrzucenie złej próby, epoch,
package i nieznanego payloadu. Native cold verifier przyjął cały zapisany bundle.
Intent/catalog/artifact_catalog zachowały identyczne bajty; lista sesji, scena
i komendy również. Workspace pozostał pusty. Nie wykonano nowego Solve.

Osobno istniejący `smoke_saved_antenna_fields.py` przeszedł na rzeczywiście
odkrytych solution/revision/member (exit 0 / 2,499 s). Potwierdzono saved-field
geometrię, topology/support, manifesty, fizyczne deskryptory i FMDS dla:

| Quantity | Liczba próbek | Komponenty | Jednostka |
|---|---:|---:|---|
| V_electric | 678 | 1 | V |
| J_charge | 7460 lokalnych węzłów 1865 Tet4 | 3 | A/m² |
| H_ant | 14 | 3 | A/m |

Hashe wartości obu fasad są identyczne. H ma własny mały obiekt sampling;
nie jest Global Universe. Brak przeglądarki i brak nowego importu FMS oznacza,
że browser/WebGL oraz pełne archive→cold-reopen nie są tu kwalifikowane.
Nie jest to kwalifikacja naukowa lub baza LLG; nadal inspection_only.
Pełna próba 1145/6428 i source1856 zakończyła się Failed bez artefaktów.

## Dowody

Control volume grupy: verification/cold-http-empty-workspace-20261027/.
red.json, green.json, accepted-14-http.json, accepted-14-http-execution.json,
saved-solution-discovery.json, saved-solution-members.json i
saved-fields-http-execution.json. SHA256 głównego raportu HTTP:
abb165d258b2fd10a235a7b181fdf235868925934548f26714f3151b7b593a3d.
