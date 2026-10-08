# CPW — edytor stacji i regresja stabilności Inspectora

## Zakres i właściciel

Kontynuacja T04/T15 planu `2026-09-08-microwave-antenna-refactoring-plan.md`.
Przyrost dotyczy authoringu geometrii, nie nowej fizyki ani kwalifikacji solve.
Worktree: `D:/git/fullmag/worktrees/microwave-antenna-latest-20260909`;
branch `codex/microwave-antenna-latest-20260909`, bazowy HEAD tego przyrostu
`37b929503ecf95dd99de121f86236b61063b9899`. PR #147 pozostaje Draft.

## Implementacja

- `apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.ts::antennaLayoutGeometry`
  rozpoznaje kanoniczny microstrip lub CPW po geometrii i niezmiennym ID obiektu,
  nigdy po nazwie użytkownika. Dotychczasowy `microstripGeometry` pozostaje wąski.
- `::widthStationDraft`, `::insertWidthStation`, `::widthStationsEqual` obsługują
  signal width, left/right gap i left/right ground width. Wstawiona stacja
  interpoluje wszystkie pięć wymiarów. ID wiersza jest wyłącznie lokalne UI;
  porównanie liczb nie traktuje zmiany formatowania jako zmiany fizycznej.
- `::buildAntennaLayoutGeometry` wymaga dodatnich skończonych wymiarów w metrach,
  uporządkowanych stacji od 0 do 1 i zachowuje rodzaj geometrii oraz pozostałe
  parametry: długość, grubość, przewodność, transformację i ID przewodników.
  Nie eksportuje UI row ID ani nieaktualnych bounds. `buildMicrostripGeometry`
  nadal odmawia CPW; istniejący kontrakt narrow API nie zmienia znaczenia.
- `apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditor.tsx::MicrostripGeometryEditor`
  pokazuje dla CPW wszystkie pięć wymiarów stacji, korzystając z istniejącego
  właściciela szkiców `(sessionScopeKey, objectId)`, typowanej transakcji
  `patchObjectGeometryTransaction` i tej samej ścieżki publikacji committed scene.
  ACK musi zawierać ten sam rodzaj geometrii. Nie dodano kontekstu/stora sesji,
  własnego HTTP ani kopii produkcyjnego mechanizmu draft/ACK.

## Wykonane dowody

`apps/control-room/scripts/check-antenna-station-drafts.mjs`: **4 PASS**.
Interpretacja rzeczywistego modelu TS bez bundlowania testów. Sprawdzono wszystkie
wymiary, odmowy, interpolację, zachowanie parametrów, narrow microstrip guard,
wybór po ID oraz brak kolizji klucza przesuniętej stacji z nową stacją serwera.

`just check-control-room-production-source`: **passed/0**, receipt
`2b05dbf24cb24143aa4a9542c8aafed6`. Digest przed/po:
`5bc3857098f3bef991504b50aef231c36191f71ab102654c8beaa1fb96a1f96f`.
Po tej kontroli zmieniono wyłącznie położenie scrolla w skrypcie przeglądarkowym,
nie produkcyjny TypeScript; jego późniejszy fingerprint jest odrębny.

`just verify-antenna-microstrip-stations-browser`: **passed/0, 19/19 PASS**,
receipt `7047de1a16bc4048adccff9afe570ac9`. Digest przed/po:
`972a5ff0f61dc08f077c9357d8d511732c9d6156df8778f7d0825626f6e96531`;
`source_changed_during_run=false`, `owned_server_terminal=true`.
Izolowany fixture na 3253 zatrzymał tylko własny serwer. Działającego workspace
użytkownika na 3197 nie zamknięto ani nie odtworzono.

Ten sam produkcyjny edytor i resource hooks wykonano osobno dla microstrip oraz
CPW. Dowód obejmuje remove/insert z zachowaniem DOM identity, typowany POST
z exact revision i session scope, niezależne pola CPW w kanonicznym JSON,
zachowanie pozostałych parametrów, opóźniony ACK, nowszą edycję w locie,
numeric-equivalent formatting, jawny revert, niezwiązany refresh oraz insertion
w poprzedniej pozycji przesuniętej stacji. Dodatkowy CPW POST zapisuje left gap
25 nm, zachowując nowszy lokalny szkic 27 nm po ACK.

Stabilność pending/ACK: zero zmian root/control identity, disabled/opacity,
zero aktywnych animacji opacity, zachowane focus, selection i scroll.
Microstrip: 8 żądań i 28 render commits; CPW: 9 żądań i 32 render commits.
Po ustaleniu stanu brak nowych żądań/renderów, błędów strony i konsoli.
To **kontrolowany transport**, nie rzeczywiste wykonanie backendu.
Airbox nie jest właścicielem geometrii CPW i nie był mutowany w tym fixture;
pełna regresja Object/Airbox całego workflow pozostaje osobną bramką.

Obejrzano screenshot `browser/cpw-14-cpw-gap-ack.png` w powyższym katalogu
receiptu. CPW ma oddzielne pola szczelin i szerokości groundów; aktywne pole
left gap zachowuje 27 nm po ACK. Zrzuty before/pending/after obu wariantów są
zapisane obok raportu. Obraz fixture nie jest dowodem CPW w viewport 3D.

Pełny `just lint-control-room-source`: **passed/0**, receipt
`8fc2f1f6db55467f90e914a287bc18da`, digest przed/po identyczny z browserem;
`source_changed_during_run=false`. Architecture hygiene: PASS, wykonane z
katalogu `apps/control-room`. Nie kompilowano ani nie uruchamiano
bundli Vitest czy testów Rust. Pierwszy browser start odmówił blokady zajętej
przez typecheck; wykonano go po terminalnym zakończeniu tej samej kontroli.

## Build 38 i próba RAM

Job `ff4035657e4a40ad84e15ca2a07764a0`: worker `exited`, kod 0;
trzy etapy build receipt mają kod 0 i stan `succeeded`, 127 artefaktów.
Koordynator nadal raportował job jako `running`, exit null, bez końcowego
`receipt.json` w root joba. Brak terminalnego journalu oznacza brak odbioru
managed build, mimo zakończonego workera.

Zatwierdzona recepta RAM odmówiła w `validate_managed_build` przed alokacją
naukowego runu i przed uruchomieniem solvera: `Managed document must be a regular
file`. Nie ominięto zabezpieczeń, nie uruchomiono ponownie buildu, nie wykonano
hostowego recovery ani nie zmieniono allowlisty trwałego SessionStore.
Koordynator jest żywy, health `worker_alive=true`, `worker_error=null`,
lecz stan queue wymaga domknięcia przez własną kontenerową ścieżkę recovery.

## Granice i następny krok

| Realizacja | Nowy dowód |
|---|---|
| FDM CPU | Wspólny model UI; brak nowej kwalifikacji antenowego solve |
| FDM GPU | Wspólny model UI; brak runtime/device proof |
| FEM CPU | Authoring CPW i fixture; brak nowego V/RT0/H solve |
| FEM GPU | Wspólny authoring; brak runtime/device proof |

Pozostały CPW creator z sześcioma terminalami i jawnym portem, conductor details,
placement above/below, rzeczywisty viewport bez box fallback i jego WebGL smoke,
backendowy round-trip oraz naukowe current→field→basis→LLG/FFT. Niniejszy przyrost
nie zamyka T04/T15/T18 ani całego T00–T18. Dalej: commit/push tego
przyrostu; następnie połączenie CPW z viewportem i kreatorem oraz terminalna
walidacja joba 38 przed ponowieniem zatwierdzonej recepty RAM.
