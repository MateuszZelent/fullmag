# P1-C — browserowy smoke lifecycle projektu

Data: 20.09.2026. Checkout: lokalny `master`, HEAD
`14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, dirty source. Aplikacja była
uruchomiona lokalnie na `http://127.0.0.1:3104/workspace`, a Playwright
przechwycił bytes-only API projektu.

## Zakres

Scenariusz wykonał bez aktywnej sesji:

1. sprawdzenie, że Save jest zablokowany przed utworzeniem projektu;
2. `New project` przez `POST /v2/persistence/projects`;
3. `Save project` jako browserowy download `.fms`;
4. `Open project` przez browserowy file chooser i `POST /v2/persistence/projects/open`;
5. ponowny `Save project` po Open;
6. `Close Project` z menu File i powrót do stanu `No project`.

Fixture zwracał wyłącznie pamięciowy bytes-only resource. Odczyty statusu i
preparation mogły wystąpić podczas montowania powłoki, ale smoke odrzuca każdą
mutację `/simulation`, `/preparation`, `/meshing`, `/restore`, `/compute` lub
`/model`.

## Wynik

```text
pnpm --dir apps/control-room smoke:project-lifecycle
exit code: 0
project_lifecycle: verified; new/open/save/close without runtime
close_project: verified
first_download: untitled-project.fms
second_download: roundtrip.fms
open_archive_bytes: 4
forbidden_runtime_requests: []
```

Dowód potwierdza browserowy lifecycle projektu oraz brak mutacji runtime w tym
scenariuszu. Nie jest to managed receipt, test filesystem durability, fizyczny
Tauri smoke ani kwalifikacja solvera/nauki/release. Fixture archive ma cztery
bajty i służy wyłącznie do sprawdzenia granicy transportu oraz wyboru/pobrania
pliku.
