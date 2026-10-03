# P8-53S — natywny launcher jako właściciel kanału przejęcia API

Checkpoint 04.10.2026. Przyrost P8-53; pełny restart pozostaje otwarty.

## Zachowanie

Nowy, własny proces API pustego managed Windows workspace dev dostaje token
wygenerowany w CLI. Token trafia wyłącznie do środowiska tego dziecka API,
nie do frontendu ani logów. Static, backend release, workspace ze skryptem
i ponowne użycie obcego API nie otrzymują nowego ownera.

Przed otwarciem Tauri CLI potwierdza discovery względem PID własnego dziecka,
portu, UUID przypiętego HTTP, hasha tokenu oraz skompilowanych commit/snapshot.
Nieznana tożsamość buildu nie jest dowodem. Odczyt jest ograniczony do 8192 B,
bez linków/reparse points. Brakujący record można obserwować do 2 sekund;
niezgodność nie wywołuje retry ani przejęcia innego API.

Klient `development_api_owner.rs` obsługuje prywatne acquire/abort. Sprawdza
schema, nonce, UUID, dokładny kształt odpowiedzi, identity sceny i canonical
SHA256. Snapshot pozostaje pełnym JSON sceny. Odczyt i zapis mają bezwzględne
deadlines, response jest ograniczony do 64 MiB. Abort musi otrzymać zgodny ACK;
drop zamyka połączenie. Obserwatory attach i scratch kończą się przed API.

## Dowody

- Zarządzany build Windows dev: exit 0, bez kompilacji testów jednostkowych.
- `just verify-windows-development-backend-api`: exit 0, **89 sprawdzeń**,
  **18 procesów**, wszystkie potwierdzone przez wait.
  Receipt względem zarządzanego build root:
  `development-backend-api-checks/checks/7e03dae6d33e439884c2c45e93d6235f/receipt.json`.
- Dziesięć nowych sprawdzeń uruchamia produkcyjny CLI, który sam tworzy puste
  API. Sprawdza discovery, disabled dla static/script, odmowę obcego PID/tokenu
  i złego nonce, przejęcie pustego workspace, HTTP freeze, abort, canonical scene
  oraz zwolnienie po disconnect. Fixture nie otwiera frontendu ani desktopu.
- Backend digest przed/po:
  `ea483c05829a70b7cbf6b1539f4c389c887ade944427265dd04d16d80b94b3ed`.
  Snapshot: `2e77522c00d0358e3d6bf50756e8529a6d175cd4fa528050818d34d23bdfcf59`.
  Baza: `50177a3bc4ede4a9e96e08d43f8c5438a3e01edf` + ten przyrost.
- Test wykrył porównanie surowej ścieżki z prefiksem kanonicznym Windows
  oraz błędne oczekiwanie nagłówka UUID na `/healthz`; poprawiono je przed
  końcowym dowodem. Wcześniejsze nieudane receipts zachowano.
- Review źródłowe po poprawkach bez actionable defect. UI 3197 nadal HTTP 200.

## Otwarte bramki

Diagnostic kończy własne API przez istniejący teardown i wait. To **nie jest**
dowód kontrolowanego shutdownu protokołu ani odtworzenia modelu po restarcie.
Pełny managed `ui --dev`, reuse i backend release po tej zmianie pozostają
NOT VERIFIED; disabled dla static/script sprawdzono w produkcyjnym kliencie.

API ogranicza czas utrzymywania acquire do 30 sekund. Sam przechowywany
snapshot nie jest dowodem, że freeze nadal trwa. Manager musi połączyć zapis
kapsuły i trwały ACK z aktualnym przejęciem, przed commit/shutdown.
Potwierdzenie ownera w tym przyroście dotyczy początkowego API z tego samego
bundle co CLI. Replacement potrzebuje odrębnej tożsamości zweryfikowanego
kandydata; nie wolno porównywać jego nowego buildu wyłącznie ze starym CLI.

Następnie: trwały ACK kapsuły, global idle/drain, kontrolowany shutdown,
wymiana API przy zachowanym frontendzie, szkice, nowy pin i hydration.
Publiczny restart pozostaje wyłączony; procenty całych etapów bez awansu.
