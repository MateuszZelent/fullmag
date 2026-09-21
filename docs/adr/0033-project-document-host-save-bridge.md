# ADR 0033 — Hostowy zapis dokumentu projektu przez Tauri

**Status:** accepted for implementation

**Data:** 2026-09-20

**Decydenci:** Fullmag core

## Kontekst

P1 wprowadza runtime-free dokument projektu i bytes-only zasoby HTTP. Taki
transport może utworzyć i zwalidować archiwum `.fms`, ale nie może zapisywać
arbitralnej ścieżki systemu plików. Sam browserowy download nie daje
hostowego Save, a dodanie drugiego writera w Tauri rozeszłoby się z
`ProjectApplication<FileProjectRepository>`.

Desktop Tauri jest hostem tego samego Control Room, więc potrzebuje jawnej
granicy między webview a lokalnym filesystemem. Granica musi zachować
OpenDocument jako operację bez GPU/meshera/solvera, a Save musi raportować
rzeczywistą klasę durability i respektować ProjectId oraz rewizję dokumentu.

## Decyzja

1. Browser zachowuje bytes-only `ControlRoomApi.persistence.projects` oraz
   pobieranie archiwum. HTTP nie przyjmuje ścieżki hosta i nie publikuje celu
   plikowego.
2. Tauri wystawia dwa jawne polecenia:
   - `open_project_archive_dialog` otwiera dialog hosta, waliduje wybrany plik
     przez `ProjectApplication<FileProjectRepository>` i przekazuje do
     webview bytes oraz hostowy target;
   - `save_project_archive` przyjmuje bytes i metadane projektu, używa dialogu
     Save, gdy target nie jest jeszcze przypięty, a następnie zapisuje przez
     ten sam application/repository writer.
3. Pierwszy zapis dokumentu otwartego z bytes używa
   `ProjectApplication::save_detached`. Jest create-only i nie nadpisuje
   istniejącego celu.
4. Zapis istniejącego celu wymaga zgodnego ProjectId i bazowej rewizji.
   `FileProjectRepository` pozostaje jedynym właścicielem locka, stagingu
   `.part`, `sync_all`, atomowego rename i sprawdzenia symlink/reparse-point.
5. `ProjectDocumentController` wykrywa wyłącznie jawny
   `window.__TAURI__.core.invoke`; poza Tauri używa zwykłego browserowego
   flow. `withGlobalTauri` jest częścią konfiguracji desktopu.
6. Receipt przenosi klasę `DurabilityGuarantee` do DTO hosta. Windows nie
   deklaruje `power_loss_qualified`, gdy nie ma potwierdzonej bariery katalogu.

## Niezmienniki

- Open projektu nie wykonuje skryptu, nie przywraca runtime'u i nie uruchamia
  solvera.
- ProjectId nie jest SessionId ani hostową ścieżką.
- Webview nie otrzymuje prawa do bezpośredniego zapisu przez HTTP.
- Błąd walidacji, konflikt rewizji albo błąd publikacji pozostawia poprzedni
  plik czytelny; nie raportuje sukcesu bez receipt'u repozytorium.
- Nieznany schema pozostaje read-only.

## Konsekwencje

Hostowy Save jest dostępny dla desktopu bez tworzenia drugiego modelu danych.
Web zachowuje przenośny flow bez uprawnień filesystemu. Pierwszy zapis
detached ma osobny create-only semantics; aktualizacja istniejącego pliku
wykorzystuje optimistic concurrency na ProjectId/revision.

Fizyczny smoke w zbudowanym oknie Tauri pozostaje osobną bramką. Testy Rust i
TypeScript potwierdzają kontrakt adaptera, ale nie kwalifikują power-loss,
innych platform ani pełnego runtime API.

## Implementacja i rollback

Zaimplementowano `save_detached`, polecenia Tauri, globalny bridge, ścieżkę
kontrolera oraz regresje create-only/stale revision. Rollback może wyłączyć
hostowy adapter i pozostawić reader/Open oraz browserowy download; nie wolno
przywrócić drugiego writera ani cichego zapisu HTTP.

## Walidacja

- `cargo test --locked -p fullmag-application --offline`: 5 testów adaptera,
  13 testów lifecycle, 0 błędów;
- `cargo test --locked -p fullmag-desktop --offline`: 4 testy, 0 błędów;
- ukierunkowany Vitest kontrolera i komend: 2 pliki, 13 testów, 0 błędów;
- `pnpm --dir apps/control-room typecheck` oraz ESLint zmienionych plików:
  PASS;
- fizyczny Tauri/browser smoke: `NOT VERIFIED`.
