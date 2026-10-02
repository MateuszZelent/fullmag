# ADR 0046 — właściciel Node w natywnym pakiecie Windows

Status: accepted; implementacja źródłowa, instalacja NOT VERIFIED.
Data: 02.10.2026.

## Kontekst i decyzja

Użytkownik produktu Windows nie powinien potrzebować developerskiego
checkoutu, Dockera, WSL ani narzędzi buildu. Statyczny Control Room korzysta
z wrappera Node, dlatego jego runtime jest odpowiedzialnością pakietu.
Container-first z ADR 0002 dotyczy rozwoju; nie ustanawia obowiązku
kontenerów na komputerze użytkownika produktu Windows.

MSI dostarcza natywne x64 `bin/node.exe` i odpowiadający dystrybucji plik
licencji. Operator buildu podaje jawny absolute `FULLMAG_WINDOWS_NODE_RUNTIME_ROOT`
z `node.exe` i `LICENSE`. Nie kopiujemy losowej instalacji Node z PATH.
Wersja musi należeć do istniejącego przedziału projektu 24.18–24.99.
Źródła są przypięte SHA-256 przed buildem, a staging odrzuca zmianę wejść.
Node podlega wspólnemu audytowi PE/DLL wraz z innymi plikami wykonywalnymi.

Statyczny launcher wybiera kopię z `bin` przed Node z PATH. Tryb developerski
zachowuje developerski Node. Obsługa dotychczasowych eksportów ze zewnętrznym
Node pozostaje ścieżką zgodności; nowy MSI zawsze wymaga własnej kopii.
Jeśli istniejący bundled executable nie działa, launcher nie próbuje zastąpić
go programem z PATH. Nie zmieniamy API v2, workspace, Python DSL, ProblemIR
ani requested/resolved execution solverów.

## Obowiązki i ograniczenia

Packager sprawdza PE AMD64, wersję, niepuste pliki, hashe i obecność licencji;
nie potwierdza sam autentyczności dystrybucji ani jej podpisu wydawcy.
Operator dostarcza zatwierdzone wejście; audyt pochodzenia/licencji i clean
machine są bramką kwalifikacji wydania. Aktualny fragment nie dostarcza
Pythona i nie zamyka niezależności całego produktu od setupu użytkownika.

Implementacja: `scripts/windows/stage_node_runtime.py`, producent MSI,
workflow Windows, `control_room.rs`. Regresje: inventory/staging/zmiana
wejść oraz actual copied Node z pustym PATH; produkcyjny check źródeł CLI.
Pełna instalacja MSI, start CLI/UI, WebGL, upgrade/rollback i cztery lane'y
wymagają osobnych dowodów. Rollback to cofnięcie tego przyrostu; nie wymaga
migracji danych użytkownika i przywraca jawne wymaganie zewnętrznego Node.
