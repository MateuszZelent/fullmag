# P7-C / P8 — kanał właściciela lokalnego runtime

Data: 03.10.2026. Fragment źródłowy; runtime i pełna usługa NOT VERIFIED.

## Wykonano

Oba rezydentne schedulery obsługują `--owner-control stdin-v1`. Kanał jest
prywatnym pipe rodzica runtime, niezależnym od UI. Bajt `0x01` oraz utrata
writera zamykają admission i drenują aktywne workery. EOF bez jawnego żądania,
niepoprawne dane i błędy IO również drenują, następnie zwracają błąd.
Monitor ustawia shutdown przed powiadomieniem, a ścieżka szybkiego zakończenia
pętli zachowuje błąd monitora.

Windows w tym trybie nie wymaga handlerów konsoli. Tryb dotychczasowy pozostaje
bez zmian. Obsługa błędu sygnału także czeka teraz na drain zamiast porzucać
wynik pętli. Nie zmieniono fizyki, wyboru lane, OpenAPI ani przechowywania runów.
Decyzja i wymagania: [ADR 0049](../../../../../adr/0049-native-runtime-owner-control.md).

## Dowody i granice

Regresje Rust zapisane dla wersji, trybu resident, tokenu, EOF, jawnego żądania
oraz IO failure. Unit tests nie są kompilowane ani uruchamiane — obowiązuje
zakaz operatora. Parser wszystkich trzech plików Rust PASS; scoped formatowanie
PASS; `cargo metadata --locked --offline --no-deps` PASS; scoped diff PASS.
Kontrole źródeł nie są kwalifikacją procesu Windows ani solvera.
Build 212 nadal queued i dotyczy starszego SHA, więc nie dowodzi kompilacji
tego fragmentu. Niezależny review po poprawkach nie wykazał P0/P1.
Poprawiono także zbieżny sygnał Unix: marker owner_observed pozwala odebrać
błąd kanału po drain bez oczekiwania na zdrowy, otwarty pipe.

## Pozostało

Uruchomić niezależną usługę z resource publishers i oboma schedulerami,
ustanowić single-owner/discovery/reconnect oraz podłączyć UI przez attach/detach.
Lease zadania nie jest lease właściciela usługi. Awaria jednego schedulera
wymaga drain drugiego i jawnego failed/unknown dla całej usługi.
Następnie wykonać rzeczywiste bramki lifecycle, leases i receipts. Kanał drain
sam nie daje działającego produktu. Nie zwiększono procentów całego planu.
Instancja 3104 pozostaje zachowana; nie wymaga jej dalsza implementacja.
