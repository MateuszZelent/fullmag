# ADR 0049 — właściciel lokalnego runtime i kanał drain schedulerów

Status: accepted; kanał sterowania zaimplementowany w źródłach, usługa lokalna planned, runtime NOT VERIFIED.
Data: 03.10.2026.

## Kontekst i decyzja

Zamknięcie okna Fullmaga nie może porzucać zaakceptowanych obliczeń ani ich
leases. Docelowy natywny produkt Windows uruchamia niezależnego właściciela
runtime; UI dołącza do niego i odłącza się. Docker, Linux i WSL nie są
wymaganiami produktu Windows. API pozostaje adapterem i nie tworzy drugiego
schedulera. Jest to realizacja P7-C planu refaktoryzacji.

Właściciel uruchamia istniejące rezydentne schedulery solve i preparation.
Ich prywatny kontrakt `--owner-control stdin-v1` wymaga `--resident true`.
Właściciel zachowuje writer osobnego pipe stdin każdego schedulera.
Bajt 1 żąda drain; EOF oznacza utratę właściciela i również żąda drain.
EOF bez jawnego polecenia nie jest kontrolowanym shutdown: po drain proces
zwraca błąd. Błędny bajt lub błąd odczytu także zwraca błąd po drain.
Kontrakt jednokomendowy przyjmuje binarny bajt `0x01`, nie tekst `Drain`;
pozostałe bajty po pierwszym nie są interpretowane.
UI nie posiada tych writerów. W Windows kontrolowany scheduler nie wymaga
konsoli ani obsługi CTRL_C/CTRL_BREAK; kanał właściciela obsługuje jego lifecycle.
Bez opcji zachowuje dotychczasowe sterowanie sygnałami. Unix nadal obsługuje
SIGINT/SIGTERM także w trybie kontrolowanym.

## Konsekwencje i obowiązki implementacji

Drain nie jest Stop zadania: aktywne workery i preparery kończą się według
istniejącego protokołu supervisor/lease/receipt. Zapis bajtu nie jest dowodem
zakończenia. Właściciel musi odebrać terminalny wynik procesu i zweryfikować
trwały stan; błąd cleanup pozostaje jawny. Zadanie już przyjmowane w chwili
żądania może wejść do drain. Nie obiecujemy atomowego przerwania admission.

Jeden wątek blokującego odczytu na proces ustawia shutdown przed wysłaniem
wyniku do pętli async. Nie należy do puli Tokio, więc oczekiwanie na stdin
nie blokuje zakończenia runtime Tokio. Szybkie zakończenie pętli schedulerów
nie może ukryć błędu kanału po zamknięciu admission przez monitor.
Osobny marker obserwacji właściciela zabezpiecza też zbieżny SIGINT/SIGTERM:
błąd zaobserwowany przed końcową kontrolą po drain zostaje odebrany. Otwarty
zdrowy pipe nie blokuje zakończenia przez sygnał.

Usługa nadal wymaga startu resource publishers, single-owner/reconnect,
wersjonowanego discovery, nadzoru procesów, wspólnego store root z ADR 0048
oraz UI attach/detach. Sam kanał nie dowodzi implementacji usługi ani
zachowania obliczeń po zamknięciu dzisiejszego UI. Nie wolno zastąpić tych
obowiązków pozostawieniem osieroconego API.

## Weryfikacja i rollback

Źródła: `scheduler_owner_control.rs`, `accepted_scheduler_main.rs`,
`accepted_fem_preparation_scheduler_main.rs` w `crates/fullmag-api/src`.
Regresje obejmują wersję/opcję resident, bajt drain, EOF i błąd IO zamykający
admission przed powiadomieniem. Nie skompilowano ani nie uruchomiono unit tests
zgodnie z bieżącą instrukcją operatora. Parse/review nie zastępują typecheck
ani testu procesu na Windows bez konsoli.

Wymagane bramki: właściciel żywy → zadania pracują; zamknięcie UI → nadal
pracują; właściciel utracony → drain; invalid token → drain i exit nonzero;
reconnect/orphan bez podwójnego schedulera; receipt i leases zachowane.
Rollback usuwa opcję właściciela z uruchomienia schedulera i przywraca
sterowanie konsolą, dopiero po drain. Nie kasuje runów ani ich leases.
