# P8-53R — stabilne ścieżki Windows i niezawodność przejęcia API

Checkpoint 04.10.2026. Przyrost nie zamyka pełnego restartu workspace.

## Zmiana

Zapora przypisuje zwykłą regułę programu do pełnej ścieżki EXE. Kolejne kopie
UUID powodowały nowe pytania o zgodę. Launcher zachowuje immutable bundle,
ale świeży start publikuje 13 sprawdzonych EXE w
`runtime_root/native-launch/dev/bin` albo `native-launch/release/bin`.
Weryfikator API używa stałego `build_root/runtime-bin`, z oddzielnym archiwum
dowodów każdej próby. Nie zmieniono reguł ani ustawień zapory.

Publikacja wymaga `starting`, zgodnego checkoutu, profilu, namespace, nonce,
żywego managera i PID rodzica publishera. Runtime lease serializuje starty,
osobny lock chroni kopiowanie. Reparse points, nieznane pliki i błędne hashe
blokują start. Manifest pojawia się po sprawdzeniu wszystkich EXE; `ready.v2`
ponownie waliduje kopię przed zwolnieniem build lease. Aktywnych EXE nie podmieniamy.
Zestaw nie jest atomowy jako całość: awaria częściowa odrzuca gotowość,
zachowuje staging i wymaga kolejnego kontrolowanego startu. Odmowa zastąpienia
pliku nie wywołuje zabijania procesu ani retry.

Zamknięto też trzy błędy wykryte w produkcyjnych procesach:

- Odrzucony POST podczas freeze odczytuje body strumieniowo do 128 MiB,
  przez najwyżej 2 sekundy. Kompletne body otrzymuje 409 bez resetu TCP;
  niekompletne — 409 i zamknięcie HTTP/1.
- HTTP, WebSocket, prywatny owner i prefiks epoki używają jednego UUID procesu.
  Licznik epoki sesji pozostaje osobny.
- Idle fence ponawia wyłącznie typowany `StoreWriterBusy`, do 5 sekund.
  Każda próba ponownie sprawdza idle i tworzy fence w jednej transakcji.

## Dowody

- `just windows-workspace-build dev dev 3197 auto`: exit 0, bez kompilacji testów Rust.
- 45 interpretowanych sprawdzeń lease/filesystem: exit 0. Stała ścieżka po zmianie
  bundle, niezmienność źródła, odmowa obcej/aktywnej publikacji, wykrycie korupcji
  i naprawa po symulowanej odmowie zastąpienia. Resolver fixture jest podstawiony;
  nie jest to dowód całego zarządzanego startu ani rzeczywistego Windows EXE locka.
- Parser PowerShell i diff check: exit 0. Review źródłowy bez actionable defect.
- `just verify-windows-development-backend-api`: exit 0, **79 sprawdzeń**,
  **16 własnych procesów**, wszystkie potwierdzone przez wait.
  Receipt względem zarządzanego build root:
  `development-backend-api-checks/checks/41bcab52b7224c6189714b6de68aba7c/receipt.json`.
- Backend digest przed/po:
  `7ba2a79453979af9ee308b0f286b2a2e1e00278fa538156d52b71369ecbae91a`.
  Snapshot: `520b58b7501eab4af59e91f989135e0fd3c84a4471b194b8240d344662e93214`.
  Baza: `e7c04d50bb6a1c62477c52bd12f1eb1174680185` + ten przyrost.
- Runtime sprawdza Content-Length/chunked 64 KiB oraz następny GET na tym samym
  połączeniu, niekompletne body, UUID i drain po wymuszonej konkurencji o istniejący
  WRITER lock. Nie sprawdzono body >128 MiB.

## Otwarte bramki

Aktywne UI 3197 zachowano na poprzedniej kopii UUID. Pełny świeży start launchera
i zachowanie zgody zapory po kolejnych buildach są **NOT VERIFIED**. Pierwszy start
z nowej ścieżki może wymagać zgody; dev/release mają osobne ścieżki.
Do pracy na localhost nie potrzeba udostępnienia w sieci publicznej.

Manager wymiany API, trwały ACK kapsuły, shutdown, szkice, repin i hydration
pozostają otwarte. Stała kopia świeżego startu nie realizuje podmiany API podczas
działania CLI. Publiczny restart pozostaje wyłączony; procenty etapów bez awansu.
