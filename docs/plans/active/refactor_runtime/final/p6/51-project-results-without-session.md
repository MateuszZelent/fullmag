# P6-51 — zapisane wyniki projektu bez aktywnej sesji

Data: 01.10.2026. Status: przyrost opublikowany na remote master, zweryfikowany na poziomie źródeł i browser fixture;
P6 pozostaje **IN PROGRESS, 52%**, cały plan około **49%**.
Baza: `d10e7912726f4e902d64cf242d3c63823a985b0f`.
Commit kodu: `91f6656fe1e9196ccffabaa09ea3ecf5b4219bd6`.

## Zachowanie i granice

Otwarty projekt udostępnia Saved Results w istniejącym WorkspaceDockLayout
również przy pustej kolekcji sesji. Results Navigator i readonly Inspector
korzystają z tego samego kernelu, rejestru modułów i selekcji. Lokalny context
React `project | session` określa montowaną treść; nie jest drugim workspace,
store, transportem ani capability solvera. Decyzję zapisuje
[ADR 0039](../../../../../adr/0039-project-workspace-without-runtime-session.md).

Loading, error oraz potwierdzony brak sesji pozostają odrębnymi stanami.
Zapisane zasoby otwartego projektu są niezależne od dostępności kolekcji:
błąd listy nie jest zamieniany w fikcyjne `sessions=[]`. Last-good kolekcja
zachowuje wcześniejszy kontrakt refresh failure. Bez projektu pozostają
dotychczasowe ekrany bramki i EmptyWorkspace.

Projekt montuje Saved Results, przypięty Inspector i jawny placeholder
podglądu. Nie montuje bieżących wyników, canvasu, pomocniczego viewportu,
ribbonu sesji ani dolnych paneli runtime'u. Menu i skróty mają wspólną jawną
politykę poleceń dokumentu i lokalnego układu. Utworzenie sesji wymaga jawnej
akcji użytkownika; eksport skryptu bieżącego modelu i polecenia runtime'u
pozostają niedostępne. Ikona Hide Inspector oraz Show Inspector przywracają
ten sam panel. Focus oraz Apply są niedostępne dla readonly wyniku projektu.

## Zabezpieczenia przejść

- Runtime connectory wymagają tożsamości ze statusu zgodnej z dokładnie jednym
  wpisem `current=true` w potwierdzonej kolekcji. Sama stara odpowiedź statusu
  nie daje prawa do komend ani WebSocketu. Bootstrap statusu działa dopiero
  przy niepustej potwierdzonej kolekcji; projekt bez sesji go nie uruchamia.
  Tę samą confirmed identity stosują cały runtime shell, menu oraz wspólne
  resource hooks. Kolekcja B przy statusie A pozostaje project/loading.
- Scope komend subskrybuje status i kolekcję. Realtime hello, zmiana sesji
  oraz resync invalidują także kolekcję sesji.
- Utrata lub zmiana scope usuwa selekcję runtime'u, również mimo starego dirty
  draft guard. Inspector projektu filtruje Object/Airbox oraz ich breadcrumbs.
  Przypięty dataset nadal podlega istniejącej granicy projektu.
- Kamera przekazuje request scope i signal. Zmiana scope resetuje dirty,
  pending i inflight, anuluje żądanie i zwiększa generation. Dynamiczny odczyt
  scope oraz generation odrzucają późny wynik poprzedniej sesji.
- Controller dokumentu odrzuca konkurencyjne create/open podczas loading;
  późniejsza odpowiedź wcześniejszej operacji nie może nadpisać kolejnego
  dokumentu. Zamknięcie projektu pozostaje lokalne i usuwa jego widok.

## Dowody

Wszystkie poniższe kontrole zakończyły się exit 0; testów jednostkowych nie
kompilowano i nie uruchamiano zgodnie z bieżącym zakazem AGENTS.md.

| Bramka | Dowód | Wynik i zakres |
|---|---|---|
| Production source | `windows-control-room-source-check/production-source/958e697016a54ae6a05e6110584f6b41/receipt.json` | PASS; TypeScript produkcji, testy wykluczone |
| API hygiene | `windows-control-room-source-check/api-hygiene/c9927b2877b54efda79068c4b1d4dd20/receipt.json` | PASS |
| Architecture hygiene | `node scripts/check-architecture-hygiene.mjs` | PASS |
| Repository consistency | `python scripts/check_repo_consistency.py` | PASS |
| React Doctor 0.9.12 | 23 zmienione pliki; lokalny zainstalowany binary | 93/100; dwa wcześniejsze ostrzeżenia ResultsNavigator |
| Managed browser fixture | `windows-control-room-browser-fixture/pinned-dataset-browser/b9944ecab1de494bae232da19d7572eb/receipt.json` | PASS; Chrome, źródła nie zmieniły się podczas przebiegu, własny serwer zakończony |

Rootowy hook przed commitem skanował 23 pliki bez rozpoznanego frameworka
i zgłosił trzy wcześniejsze array lookups w RealtimeInvalidationBridge
(score 87/100). Porównanie z bazą potwierdziło, że te fragmenty nie zmieniły
się w przyroście. Hook zakończył commit; osobny scan aplikacji powyżej jest
właściwym dowodem analizy React dla tego zakresu.

Receipt paths są względne wobec rozwiązanego
`storage/builds/fullmag-0950f4dca4ffe38f`. Browser report i cztery screenshoty
znajdują się w `browser/` tego samego przebiegu. Zweryfikowano zdjęcia widoku
przypiętego wyniku i jawnego błędu kolekcji po zakończeniu lazy mount Inspectora.

Fixture potwierdził rzeczywiste `sessions=[]`, zero current-session HTTP i WS
bez realtime bypass, zero canvasów i mutacji runtime'u, readonly Apply/Focus,
hide/restore Inspectora, odrzucenie fałszywego manifestu, zachowanie przypięcia
przy zmianie runu, ochronę starego payloadu przy zmianie projektu, zamknięcie
projektu oraz niezależny pusty katalog trzeciego projektu przy GET sessions=503.
Osobna faza potwierdziła kolekcję B przy statusie A: bootstrap GET status
pozostaje dozwolony, lecz pozostałe current-session zasoby, menu runtime'u,
ribbon, canvas oraz WS pozostają niezamontowane. Raport jawnie rozdziela tę
fazę od faz bez sesji i błędu kolekcji, w których current-session HTTP wynosi zero.
Znany wcześniejszy startup warning React zachowano w raporcie; limit wynosi
jeden na każde załadowanie strony, inne błędy i powtórzenia są odrzucane.

Wcześniejsze nieudane próby fixture zachowano: pierwszy klik menu poprzedzał
hydratację, a scenariusz trzeciego projektu początkowo błędnie zakładał
niepusty katalog. Korekty dotyczą drivera i nie ukrywają niepowodzeń.

Niezależny końcowy review źródeł nie wykazał P0/P1 po zamknięciu granicy
tożsamości całego drzewa runtime'u. Review nie zastępuje wykonania regresji.

Dodano źródłowe regresje dla mismatch identity, empty collection, konkurencyjnego
otwierania, resetu selekcji mimo guard i późnej odpowiedzi kamery. Ich wykonanie
jest **NOT VERIFIED**, ponieważ aktualny zakaz obejmuje kompilację testów.

## Otwarte bramki i dalsza praca

Browser używa kontrolowanych odpowiedzi page.route. Nie jest dowodem backend
HTTP, managed runtime, parytetu FDM/FEM CPU/GPU, nauki ani release. Scenariusz
aktywna sesja A → projekt/no-session → aktywna sesja B oraz dirty-camera flush
w rzeczywistym runtime wymaga osobnej kwalifikacji. Nie podniesiono procentów
P6 ani całego planu na podstawie fixture.

Następny zakres P6: ograniczone binarne wycinki trwałego datasetu i typed
resource/codec dla jego faktycznego renderera z topologią, function space,
jednostkami i granicą source identity. Viewport nadal uczciwie pokazuje brak
podglądu; nie zastępuje pola zerami ani nie wykonuje niejawnego solve.
Pozostałe bramki P0–P8 nadal obowiązują. Zachowano cudze dirty pliki i submoduły.
