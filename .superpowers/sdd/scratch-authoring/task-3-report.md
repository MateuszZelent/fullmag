# Task 3 — stan bez sesji i New Problem

## Zakres

- `GET /v2/sessions` otrzymał fasadę `kernel.api.sessions.list` oraz hook
  `useSessionCollection`; pusta kolekcja jest mapowana wyłącznie na
  prezentacyjny stan `no-session`.
- Shell i AppMenu pozostają zamontowane bez sesji, natomiast sloty i hooki
  zależne od `/v2/sessions/current/...` są montowane dopiero po wykryciu sesji.
- `workspace.new-problem` jest widoczną komendą globalną z `Ctrl+N`; otwiera
  dialog, który tworzy problem FDM/FEM wyłącznie jako CPU/double.
- Dialog żąda jawnego potwierdzenia zastąpienia aktywnej sesji, utrzymuje
  lokalny pending i błąd tylko dla akcji Create oraz po ACK unieważnia
  sessions, current status i model scene.

## Weryfikacja

- RED (bezpośredni Vitest): dwa oczekiwane błędy asercji: brak New Problem w
  File oraz brak `api.sessions.list`; 16 istniejących testów startup przeszło.
- GREEN/regresja: 27 testów w `useSessionCollection`, New Problem,
  `SimulationStartupOverlay` i `SimulationPreparationMounted` przeszło.
- ESLint zmienionych plików: bez ostrzeżeń.
- Typecheck: żadnego błędu z Task 3; pozostaje sześć znanych błędów bazowych w
  visualizationCommandContributions, FrozenSpinsInspectorPanel,
  ribbonCommands i Resizable.

## Uwagi

OpenAPI dla istniejącego `GET /v2/sessions` nie deklaruje jeszcze schematu
odpowiedzi; fasada używa lokalnego typu odzwierciedlającego aktualny zasób.
Nie zmieniano kontraktu serwera ani wygenerowanego transportu w tym zadaniu.

## Poprawki po przeglądzie

### Naprawione ustalenia

1. `GET /v2/sessions` zwraca teraz typowany `SessionListResource` z elementami
   `SessionSummaryResource`. Oba schematy są rejestrowane w OpenAPI, odpowiedź
   `200` wskazuje schemat JSON, a frontend korzysta z typu wygenerowanego z
   OpenAPI. Usunięto ręcznie utrzymywany typ transportowy i rzutowanie.
2. Shell rozróżnia `loading`, `error` oraz potwierdzone `no-session`. Pusty ekran
   authoringu i komenda New Problem pojawiają się wyłącznie dla potwierdzonej
   pustej kolekcji; SSR i pierwszy render klienta zachowują stan ładowania.
3. Po ACK utworzenia/zastąpienia sesji unieważniane są kanoniczne zasoby:
   `SESSIONS_PATH`, `SESSION_STATUS_RESOURCE_KEY`, cały prefix
   `SESSION_CURRENT_PATH` oraz `MODEL_SCENE_PATH`, zawsze z dokładnym
   `state_version` odpowiedzi.
4. Testy montują realny shell i formularz. Obejmują SSR/hydration, osobne stany
   loading/error/confirmed-empty, ACK, FDM/FEM, zachowanie formularza po błędzie,
   zastąpienie sesji oraz dokładne klucze i rewizje unieważnień.
5. Pola formularza używają współdzielonych prymitywów `Input` i `Checkbox`.

### RED

- Kontrakt OpenAPI/hook/shell: 5 oczekiwanych błędów przy 12 przejściach — brak
  schematu listy sesji, lokalny typ transportowy oraz zlanie loading/error ze
  stanem bez sesji, także podczas SSR.
- Dialog: 3 oczekiwane błędy przy 2 przejściach — niewłaściwy klucz statusu,
  brak unieważnienia prefixu bieżącej sesji i brak współdzielonych prymitywów.

### GREEN i bramki

- Vitest, regresja UI: 5 plików, 36/36 testów.
- Vitest, kontrakt wygenerowanego OpenAPI i hook: 2 pliki, 13/13 testów.
- Rust: `cargo test -p fullmag-api session_collection --no-fail-fast` — 2/2,
  1010 testów odfiltrowanych.
- Generator API: `pnpm --dir apps/control-room generate:api` — zakończony
  poprawnie; zaktualizowane są wyłącznie kanoniczne artefakty OpenAPI v2.
- ESLint dla wszystkich zmienionych plików frontendowych — bez błędów.
- `scripts/ci-resource-first-gates.sh --strict` — wszystkie bramki przeszły.
- `scripts/check-api-hygiene.mjs` — bez naruszeń.
- `scripts/update_readme_version_dashboard.py --check` — dashboard zgodny.
- `git diff --check` — bez błędów białych znaków.
- TypeScript nie ma nowych błędów. Pozostaje dokładnie sześć błędów bazowych:
  `visualizationCommandContributions.ts:166`,
  `FrozenSpinsInspectorPanel.tsx:77`, `ribbonCommands.ts:882` oraz
  `Resizable.tsx:10`, `Resizable.tsx:143`, `Resizable.tsx:150`.
- `cargo fmt -p fullmag-api -- --check` nadal zgłasza istniejące różnice
  formatowania w szerokim pakiecie; własne nowe asercje zostały dopasowane do
  formatu rustfmt, bez wykonywania masowego refaktoru poza zakresem.

### Kontrakt zasobów

Źródłem prawdy pozostaje HTTP v2 i wygenerowany transport jest wyłącznie
niskopoziomową warstwą transportową. Zmiana nie dodaje legacy API ani
bezpośrednich fetchy. Nie zmieniono kontraktu websocket, semantyki eventów,
kodeków binarnych, zunifikowanego viewportu ani ribbonu. Po mutacji odświeżane
są kolekcja sesji oraz zasoby bieżącej sesji/modelu przez istniejący resource
store; nie powstała równoległa ścieżka stanu.
