# P8-53B — status kompilacji i dwuminutowe okno ciszy

Data: 03.10.2026. Zakres jest ukończonym fragmentem P8-53; cały restart
workspace pozostaje w realizacji.

## Zachowanie

`just windows-ui dev` uruchamia jeden watcher. Kompilacja backendu zaczyna się
domyślnie dopiero po 120 sekundach bez zmian jego źródeł. Kolejny zapis zeruje
odliczanie. Zmiana podczas kompilacji daje `superseded`, następnie `waiting`
i pełne nowe okno. Nie wywołuje restartu ani przerwania symulacji. HMR
frontendu nadal działa od razu.

`FULLMAG_BACKEND_DEV_DEBOUNCE_SECONDS` ustawione przed startem pozwala wybrać
1–300 sekund. Zero jest dopuszczone tylko w wewnętrznym trybie `--once`.
Już działający watcher zachowuje konfigurację i kod ze swojego startu;
nie wymienialiśmy go podczas sesji użytkownika.

## Zasób i granice

`GET /v2/platform/development-backend` otrzymał generated OpenAPI i fasadę
`ControlRoomApi.platform.developmentBackend()`. Zwraca tylko stan, rewizję,
tożsamości bieżącego/gotowego buildu oraz kod powodu blokady. Konfiguracja
jest przypięta przy starcie API do generacji launchera i worktree.

Prywatny `fullmag.backend-watch.v2` ma heartbeat co około 2 sekundy, również
podczas synchronicznej kompilacji. Heartbeat nie zmienia rewizji ani ETag;
zmiana stanu zmienia ETag. Status starszy niż 10 sekund, obcy worktree lub
generacja, błędny schemat/hash, nadmiarowe pola albo niebezpieczna ścieżka
nie stają się gotowym buildem. Odczyt jest ograniczony do 8192 bajtów.

Watcher publikuje `ready` dopiero po exit 0, niezmienionych źródłach i
sprawdzeniu manifestu oraz kompletnej listy hashy EXE. Standalone watcher
bez generacji managera nie publikuje statusu dla API. Launcher usuwa zmienne
dev w release/non-dev.

`restart_available` pozostaje `false`: gotowa kompilacja nie potwierdza
bezpiecznego zastosowania wersji. Hook, banner, komenda restartu, admission,
drain, rozwiązanie szkiców i odtworzenie modelu/pina są nadal do wykonania.
Nie podnosimy procentu całego planu na podstawie tego fragmentu.

## Weryfikacja

- `just verify-windows-development-handoff`: 27 interpretowanych regresji,
  0 skipów, exit 0. Receipt `1ebed10c2dad4a9196c013bf57b1ff4f`; tożsamość
  źródeł przed/po `66b85c26df35d9b6c2cb844fb5b0916928c32553784ce93e0a860a3f6f418c88`.
  Obejmuje 120 sekund od ostatniego zapisu, pełne okno po superseded,
  heartbeat podczas zablokowanej kompilacji i odrzucenie złego manifestu.
- `just verify-windows-development-backend-api`: 21 sprawdzeń rzeczywistego
  natywnego API, exit 0. Receipt `7468010777fd4922b7a9387acfa7b1da`.
  Źródła przed/po `e2556dbf289b4b7f6dca6917e00c7c5618cce31a8b3c6c7935e5c2b225e711bb`,
  API SHA256 `453735a8c2bbcdb1f67fcc739720be118fd2fd9533dc30750c534154f378d6ff`.
  Trzy własne puste procesy API sprawdzają konfigurację, stany, stare/obce
  obserwacje, ograniczenie pliku, ETag/304 i brak dostępnego restartu.
  Weryfikator kończy wyłącznie te dzieci i potwierdza wait oraz exit każdego;
  wymuszone zakończenie fixture nie jest dowodem graceful shutdown produktu.
- Kanoniczny OpenAPI wyeksportowano przez `--print-openapi-v2` zweryfikowanej
  kopii EXE, sprawdzono commit/snapshot i hash artefaktu, a następnie
  znormalizowano tożsamość generated artifact i wygenerowano TypeScript.
  Receipt generacji: `68671d140854412585ba867585345c05`.
- Produkcyjne typy frontendu i higiena API przeszły; receipts odpowiednio
  `3133d3b40b5c4e3b93561bbf10003032` i `51a0c0f63988435cacf2f0964eee05e1`.
  Finalny eksport po ostatniej poprawce watchera jest identyczny po
  normalizacji, więc nie powtarzano niezmienionej generacji. Testy Rust/TypeScript
  nie były kompilowane. Kontrola składni PowerShell i diff przeszły.
- Niezależne review handlera/schematu/weryfikatora nie znalazło błędu;
  wskazany brak sprawdzenia zmiany ETag uzupełniono rzeczywistym testem HTTP.

Receipts znajdują się w kanonicznym storage, pod profilami
`development-handoff-checks`, `development-backend-api-checks` i
`windows-control-room-source-check`. Ich scope nie obejmuje UI/browser,
restartu aktywnego workspace, solverów ani kwalifikacji wydania.

## Następny krok

Podłączyć jedną obserwację resource hook i banner do workspace oraz komendę
restartu z admission zamykanym przed session transition. Następnie połączyć
kanoniczny handoff z launcherem i restore przed listen. Ochrona przyjętych
zadań niezależnego runtime service wymaga potwierdzonego drain, nie samego
odczytu statusu.
