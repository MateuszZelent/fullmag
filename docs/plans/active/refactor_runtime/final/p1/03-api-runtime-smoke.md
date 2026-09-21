# P1 — smoke runtime-free API projektu

Data: 21.09.2026. Checkout klienta: lokalny `master`, HEAD
`14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, dirty. Najnowszy wynik pochodzi z
recepty zarządzanej `just verify-project-api-runtime`; lokalna obserwacja na
porcie 8081 pozostaje niżej jako wcześniejszy, pomocniczy zapis.

## Zakres

Wykonano bezpieczny scenariusz runtime-free na `http://localhost:8081`:

1. `POST /v2/persistence/projects` z nową nazwą projektu.
2. `POST /v2/persistence/projects/open` z otrzymanym `archive_base64`.
3. `GET /v2/sessions/current/persistence/recovery`.
4. Kontrolowane zatrzymanie procesu API.
5. Ponowne uruchomienie API z tym samym source identity i `FULLMAG_STATE_ROOT`.
6. Ponowne `POST /v2/persistence/projects/open` z tymi samymi bytes oraz
   ponowny odczyt recovery.

Projekt był wyłącznie pamięciowym dokumentem testowym. Nie uruchamiano
solvera, meshera, GPU ani Restore Runtime State.

## Wynik

```json
{
  "name": "codex-p1-runtime-20260920214036328",
  "create_project_id": "project-a233a5fec6214ca6acd833b94a2eb491",
  "create_revision": 0,
  "create_dirty": true,
  "create_mode": "read_write",
  "open_project_id": "project-a233a5fec6214ca6acd833b94a2eb491",
  "open_revision": 0,
  "open_dirty": false,
  "open_mode": "read_write",
  "recovery_snapshots": 0
}
```

Wynik potwierdza, że API przyjęło nowy dokument, zwróciło archiwum bytes-only,
ponownie otworzyło ten sam `ProjectId` bez uruchomienia runtime, a po
kontrolowanym restarcie ponownie otworzyło te same bytes z `revision=0` i
`dirty=false`. Oba procesy zwróciły poprawne health/build identity, a
`runtime_mutations` pozostało puste. Jest to dowód odporności lifecycle projektu
na przerwanie procesu API; nie jest to jeszcze rekonsyliacja aktywnego runu,
utrata połączenia WebSocket, trwałość filesystemu ani fizyczny desktopowy
Open/Save. Te wymagania pozostają `NOT VERIFIED`.

## Wykonanie zarządzane z tożsamością źródła

```text
just verify-project-api-runtime
exit code: 0
receipt state: passed
run_id: 62b8f2e3f5bf4678aeb36895921b752a
source_snapshot_sha256: 14ef2051a2e97d7fac63a78fe075a31798fcbc69950bb5bc84936fb6f1aad81f
source_changed_during_run: false
binary_sha256: e51ca97aba4405a5a6f1d7af34755ab075acd0f28385607412b4c851871a7811
create_project_id: project-67163aee96d94630856268fca3a5d7a5
open_project_id: project-67163aee96d94630856268fca3a5d7a5
reconnect_open_project_id: project-67163aee96d94630856268fca3a5d7a5
create_revision: 0
open_revision: 0
reconnect_open_revision: 0
create_dirty: true
open_dirty: false
reconnect_open_dirty: false
archive_bytes: 943
recovery.snapshots: []
reconnect.recovery.snapshots: []
runtime_mutations: []
reconnect.same_project_id: true
server_exit_codes: [1, 1] (kontrolowane zatrzymanie procesów)
```

Receipt: `C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-project-api-runtime\project-api-runtime\62b8f2e3f5bf4678aeb36895921b752a\receipt.json`.
SHA-256 receiptu: `0F2AA5B6767D8F116D96BC4E92C29DF0B7916732CE4D7845805213CABB7BD462`.
Recepta zbudowała `fullmag-api` z dokładnym snapshotem źródła, sprawdziła
identity w `/v2/platform/openapi.json`, wykonała New/Open i odczyt recovery,
zatrzymała proces, uruchomiła go ponownie, sprawdziła ponownie identity i
otworzyła te same bytes po reconnect. `cargo.log`, `server.log` i
`server-reconnect.log` są zachowane w tym samym run root.

To jest kwalifikowany dowód zarządzanej trasy P1 runtime-free API, ale nie
pełna kwalifikacja runtime/session-recovery: nie symuluje zerwania WS,
rekonsyliacji aktywnego runu, power-loss ani solvera. Frontendowy reconnect
guard jest potwierdzony osobnymi testami źródłowymi (3 pliki, 75 testów), a
transportowy handshake/reconnect pustej sesji ma osobny receipt w
[managed smoke WebSocket](05-realtime-ws-smoke.md). Aktywne odtworzenie sesji
pozostaje `NOT VERIFIED`.
