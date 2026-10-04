# P5-C — potwierdzenie granicy zastosowania komendy Live

Data: 28.09.2026

Status: **SOURCE/API CONTRACT PASS / MANAGED RUNTIME NOT VERIFIED**.

## Wynik

Wykonawca interaktywnego etapu zapisuje teraz rzeczywistą granicę, na której
zaakceptowana komenda zaczęła obowiązywać:

- `applied_step` — zaakceptowany krok solvera przed rozpoczęciem nowego odcinka,
- `applied_time_seconds` — odpowiadający mu czas fizyczny,
- `segment_id` — deterministyczną tożsamość nowego odcinka, związaną z
  `run_id`, `command_id`, krokiem i bitowym zapisem czasu.

Pola są przechowywane w `CurrentLiveStageExecutionRecord`, kopiowane do
`StageExecutionRecord` i zachowywane przy przejściu etapu do stanu terminalnego.
`GET /v2/sessions/current/simulation/commands/{command_id}` projektuje te dane
z rekordu etapu powiązanego przez dokładne `command_id`. Pola opcjonalne
pozostają nieobecne dla historycznych rekordów oraz ścieżek, które nie mają
potwierdzonej granicy zastosowania.

Kontrakt OpenAPI v2 oraz generowane typy TypeScript zawierają te trzy pola.
Dzięki temu klient może odróżnić przyjęcie i dispatch komendy od faktycznego
zastosowania jej przez solver.

## Weryfikacja

- `cargo test -p fullmag-cli active_sequence_records_the_exact_application_boundary_and_segment --bin fullmag -- --nocapture`: **1/1 PASS**.
- `cargo test -p fullmag-api command_detail_endpoint_exposes_stage_state_linkage --bin fullmag-api -- --nocapture`: **1/1 PASS**.
- `cargo check -p fullmag-api --bin fullmag-api`: **PASS**.
- `cargo check -p fullmag-cli --bin fullmag`: **PASS**.
- generacja OpenAPI v2, typów TypeScript i klienta: **PASS**; generator typów wymagał ponowienia poza sandboxem po hostowym `EPERM` przy odczycie własnego pliku z `node_modules`.
- `pnpm --dir apps/control-room typecheck`: **PASS**.
- `git diff --check`: **PASS**.

Pełny workspace `cargo fmt --all -- --check` nadal wykazuje wcześniejszy,
rozległy baseline formatowania w plikach poza tym przyrostem. Fragmenty dodane
w tym przyroście zostały dopasowane do wyniku `rustfmt`; nie wykonano
masowego formatowania niezwiązanego kodu.

## Granica dowodu

Ten przyrost zamyka źródłowy i publiczny kontrakt potwierdzenia bezpiecznego
punktu dla istniejącej ścieżki wykonywania komend Live, w tym replanu
`apply_frozen_spins`. Nie wprowadza pełnego współdzielonego `AcceptedStateRef`,
nie dowodzi wykonania po restarcie procesu solvera i nie kwalifikuje
sterowania FEM CPU/GPU ani FDM GPU. Managed runtime pozostaje **NOT VERIFIED**,
ponieważ koordynator Docker Desktop nie odpowiadał w bieżącym środowisku.

P5 rośnie konserwatywnie z **89% do 90%**. P4 pozostaje **50%**, a cały plan
około **49%**.
