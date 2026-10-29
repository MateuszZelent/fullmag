# Rzeczywisty czas etapu accepted — checkpoint 26.10.2026

> Aktualny checkpoint integracji i zakres dowodów: [27.10.2026, PR #247](2026-10-27-antenna-master-pr247-checkpoint.md). Poniższe statusy opisują kolejne historyczne etapy.

Status: WIP źródeł backendu, bez managed kompilacji i publikacji przez API.
Poprawka nie zmienia fizyki, metody numerycznej, tolerancji ani procentu postępu.

## Źródło i kontrakt

`crates/fullmag-api/src/live_accepted_projection.rs::load_stage_journal_details`
odczytuje istniejący journal pod natywnym ReadTransaction i porównuje katalog
z wcześniejszym snapshotem. `stage_journal_details_for_task` wybiera wyłącznie
Started i zgodny z lifecycle event terminalny tej samej tożsamości
run/task/attempt/ownership_epoch, z walidacją lease, checkpoint i envelope.
`build_stage_execution` uzupełnia istniejące pola started_at_unix_ms oraz
completed_at_unix_ms. OpenAPI nie zmienia kształtu; serializer już je obsługuje.

Czas oznacza rozpoczęcie wykonania etapu przez worker i trwałą terminalną
publikację; nie czas CPU ani dokładny początek funkcji native. Nie użyto
status.run.started_at, czasu sesji, mtime albo Command::Start. Brak Started,
niepoprawny UTC i koniec wcześniejszy od początku pozostawiają odpowiednie
pole puste. Interrupted zachowuje powód awarii, ale nie otrzymuje zmyślonego
czasu końca z innego lifecycle. Zachowano powody Failed/Stop.

Prywatny cache jest ograniczony do bieżących tasków katalogu. Klucz zawiera
run_id, task_id, attempt_id, epoch, input_fingerprint i lifecycle. Heartbeat
oraz sidecar nie ponawia pełnego odczytu journalu. Zmiana próby, wejścia albo
lifecycle wymaga nowego odczytu; cold-load odtwarza dane bez tego cache.
To nie cache całego Study/loweringu ani zmiana polityki zasobów.

## Rzeczywisty odczyt i ograniczenia weryfikacji

Osobny diagnostyczny odczyt bieżącego journalu pod flock SH potwierdził
Started sequence 2 z UTC 2026-10-26T20:08:22.463704508Z, właściwy
run-live-62d110763485b10e2512922267a1aed284996710852d4fd27cb3f4ad71a1e496,
attempt-cf3de85649da4f35aa3acb1874b8ed79, epoch 1. Katalog rev1434 był
identyczny przed/po odczycie. Raport bez tokenów:
verification/antenna-solve-telemetry-20261026/actual-stage-journal-observation.json,
SHA256 1608b6a154a2c8dcbecd80ae45e10eaa0ad0e00dc0613790d1e06da9bb1262ce.
Nie jest to wykonanie nowej funkcji Rust.

Dodano siedem nieuruchomionych regresji: kopiowanie wyłącznie bieżącej próby;
Started kontra Command::Start i terminal/cold-read; failure/stop bez startu;
obce fences; stare próby i niewłaściwy terminal; UTC i cofnięty koniec;
cache heartbeat oraz invalidacja dokładnej tożsamości/fingerprintu.
Kontrola składni przez istniejący kontenerowy rustfmt stdin/emit stdout przeszła,
a diff przejrzano. Testów nie kompilowano zgodnie z zakazem repozytorium.
Kompilacja produkcji, typy i HTTP pozostają NOT VERIFIED. WIP nie został
zacommitowany jako zweryfikowana implementacja ani wdrożony do aktywnego API.

SHA256 live_accepted_projection.rs:
88c01f0dd8afc776e466213a621f2e00e701f21ba9d2be9abb158b00dfaee57b.
Po terminalnym wyniku aktualnego Solve potrzebne są managed Docker DEV build,
kontrola oryginalnego run/task/attempt bez ponawiania Solve oraz odczyt
StageExecution i sprawdzenie stałych czasów po ponownym otwarciu.

## Kompilacja produkcji — 27.10.2026

Managed iteration cb64d7ff17f144739d78745a9483d16a succeeded; podany wyżej
SHA256 jest identyczny w źródle i build shadow. Produkcja się skompilowała
i nowe API działa. Siedmiu testów Rust nadal nie kompilowano ani nie uruchomiono.
Zwykły restart nie przywrócił current live observation, dlatego wykonania
StageExecution HTTP na tej próbie jeszcze nie potwierdzono. Nie kwalifikujemy
czasów wyłącznie na podstawie poprawnej kompilacji.
