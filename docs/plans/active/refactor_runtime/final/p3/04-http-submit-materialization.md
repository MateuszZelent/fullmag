# P3-B — przyjęcie i materializacja przez HTTP

Data: 24.09.2026. Zakres: runtime-free API i trwały katalog; bez uruchomienia solvera.

## Wykonana bramka

`just verify-api-project-runs` uruchamia istniejący moduł
`router_v2::tests::project_documents` przez rejestrowaną trasę
`api-project-run-tests`. Wynik: **3/3 PASS**, exit 0,
`source_changed_during_run=false`.

Run: `ac211a968f4d4df5867c424fdc390363`.
Źródła: dirty `master`, SHA-256
`ce56e35da4649a2cc77558e70894198f43e18dd6b4ed622a279bd92017fe5a4a`.
Receipt i log w zarządzanym storage:
`builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-project-run-tests/ac211a968f4d4df5867c424fdc390363/`.
Testy skryptu weryfikacyjnego: **14/14 PASS**.

## Pokrycie i granice

| Wymaganie | Dowód |
|---|---|
| Create/Open bez runtime | Utworzenie i ponowny odczyt archiwum nie zmienia stanu runtime; uszkodzone archiwum odrzucone. |
| Durable Submit | Pierwsze żądanie zwraca 201 i zapisuje intent; stan Live pozostaje pusty. |
| Idempotencja | Powtórzenie zwraca 200, `replayed` i ten sam RunId; zmieniony payload z tym samym kluczem zwraca 409. |
| Materializacja | Przed operacją brak tasków; po niej rewizja katalogu 1, jeden task `accepted/blocked` i stan `pending_preparation`. |
| Idempotentna materializacja | Ponowienie zwraca ten sam katalog; Submit po materializacji zachowuje `pending_preparation`. |
| Dwa runy | Osobny klucz i RunId tworzą drugi rekord; stronicowanie zwraca dwa różne runy bez duplikatu. |
| Izolacja projektu | Lista innego projektu jest pusta; odczyt i materializacja cudzego runu zwracają 409. |
| Trwały zapis | Końcowy odczyt magazynu potwierdza intent i jeden task w katalogu pierwszego runu. |

Test korzysta z routera HTTP w procesie testowym i syntetycznego magazynu.
Nie jest dowodem restartu procesu API, połączenia sieciowego ani wykonania workera.
Utrata odpowiedzi jest pokryta przez ponowienie identycznego żądania, bez
symulacji awarii sieci. Bieżąca regresja równoległych Submit/materializacji jest opisana w aktualizacji poniżej.

Ta bramka zastępuje wcześniejsze `HTTP NOT RUN` dla powyższego modułu.
Nie zamyka P3-B: nadal potrzebne są transport i supervisor workerów, pinned
preparation/dependencies, rzeczywiste outputy i kwalifikacja runtime. Nie
podnosimy procentów całego planu na podstawie samej tej bramki.

## Aktualizacja — konflikt pisarzy i równoległe żądania

Dodano typowany `StoreWriterBusy` w magazynie. Submit i materializacja mapują
ten konkretny błąd na `409` z kodem `run_store_busy`; inne błędy zachowują
swoje dotychczasowe mapowanie. Konflikt nie jest rozpoznawany po tekście.
Kształt odpowiedzi oraz istniejący status 409 w OpenAPI nie zmieniły się;
dopisano semantykę ponowienia do specyfikacji resource-first.

Regresja przed poprawką (`9a5e985c9b5d4472863df73bf134798b`) wykazała HTTP 400
zamiast konfliktu dla poprawnego Submit podczas zajętości magazynu.
Po poprawce deterministyczne utrzymanie blokady wykazuje 409 dla Submit
oraz materializacji, brak publikacji odpowiednio intentu/katalogu i sukces
tego samego żądania po zwolnieniu blokady. Dwie równolegle zlecone próby
Submit i materializacji dopuszczają identyczny replay albo `run_store_busy`;
jedna publikacja i późniejsze ponowienie zachowują ten sam RunId/katalog.
To regresja jednego procesu z równoległymi zadaniami, nie pełny stress test
ani dowód zachowania po utracie zasilania.

- Końcowe HTTP: **3/3 PASS**, run `ab9163b3688f409ebdfe6b352e07a586`, exit 0,
  `source_changed_during_run=false`, source SHA-256
  `fe73e41251c7d9374ebced81b08430f1dfde38e5d4e7f3d1ca0f785bfb903b5a`.
- Pełne session: **78/78 PASS**, run `11f500c18be64badaede980d6758be79`, exit 0,
  `source_changed_during_run=false`, source SHA-256
  `63cc8882263eb12e98a1f6feb46256fb3e956cb118438bb0156d36ba6e1e444a`.
- Kontrola diffu: PASS. Testy zakończone; nie pozostał proces tej weryfikacji.

Receipty pozostają w tych samych zarządzanych profilach. P3 nadal wymaga
restartu procesu API, transportu/supervisora workerów, wykonania i outputów.