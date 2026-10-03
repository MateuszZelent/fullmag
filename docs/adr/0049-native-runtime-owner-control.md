# ADR 0049 — właściciel lokalnego runtime i kanał drain schedulerów

Status: accepted; usługa i jawne podłączenie launchera/desktopu zaimplementowane w źródłach; domyślny produkt, instance lease, cutover i recovery planned, runtime NOT VERIFIED.
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

## Realizacja źródłowa usługi — 03.10.2026

`fullmag-runtime-service` z `--config <absolute-json-path>` zajmuje jedną
natywną blokadę dla całego SessionStore. Descriptor nie jest lease zadania
ani dowodem zdrowia procesu. Poprzedni starting/ready/draining/unknown bez
blokady wymaga kontrolowanego recovery; PID i wiek nie pozwalają przejąć ownera.

Usługa publikuje jawnie skonfigurowane pule compute/preparation przez istniejące
publikatory. Oba schedulery startują z zamkniętą bramką admission. Boot event
potwierdza PID, owner token, rolę, protokół oraz pełny commit i snapshot buildu
przed odczytaniem store i uruchomieniem zadań. Dopiero po zgodności obu eventów
usługa zwalnia bramki. Ready wymaga potwierdzenia generacji obu pul.

Własny endpoint TCP na losowym porcie loopback przyjmuje ograniczony JSON line
`runtime_service_control.v1`, owner_token i command=drain. Jest prywatnym
adapterem procesu, nie nowym publicznym OpenAPI. Żądanie wymaga tokenu z lokalnego
descriptora; katalog stanu musi pozostać niedostępny niezaufanym użytkownikom.
ACK draining nie jest terminalnym receiptem. Zamknięcie UI nie wysyła drain.

Przy błędzie usługa zamyka admission obu dzieci przed czekaniem na którekolwiek.
Drained wymaga obu terminalnych wyników exit=0 i przypiętych eventów drained.
Błąd obserwacji procesu zachowuje unknown, a pozostałe błędy nie stają się sukcesem.
Operational owner/lock/logs są poza naukowym grafem CAS i eksportem FMS;
import nadal wymaga pustego, izolowanego store. Ten fragment nie uruchamia usługi
automatycznie z obecnego launchera i nie zmienia działającej sesji 3104.

Dokładny kontrakt: [native-runtime-service-v1](../specs/native-runtime-service-v1.md).

HTTP API ma osobny UUID procesu. Opcjonalny pin żądania odrzuca replacement
przed handlerem, a launcher porównuje UUID przed i po ensure. To nie jest
autoryzacja ani pełny lease. Nieprzypięte klienty pozostają zgodne. CLI/desktop
przekazują pin do workspace, facade obejmuje JSON/binary, a WebSocket przesyła
go jako towarzyszący subprotocol przed upgrade. Obserwowany mismatch zatrzymuje
kolejne HTTP tego klienta; reconnect realtime nie adoptuje replacement.
Usunięcie ograniczenia reuse API nadal wymaga dowodu runtime tych ścieżek.

Publikatory również sprawdzają przypięty commit/snapshot przed otwarciem store.
Procesy są obserwowane z deadline: niepotwierdzony publisher/scheduler pozostaje
unknown z zachowanym PID i lease, bez automatycznego przejęcia. Częściowo
opublikowane generacje są odczytywane także po błędzie drugiego publishera.
Ready preparation jest niezależne od slotu zajętego przez odzyskiwany task.

## Authoring i dołączenie usługi — P8-37

Otwarcie okna wymaga zgodnego API i jego UUID; przy jawnej konfiguracji
sprawdza również accepted-store binding. Gotowość native runtime jest osobną
obserwacją. CLI i Tauri otwierają UI przed posiadanym wątkiem dołączenia,
więc błąd/missing binary/start timeout nie zamyka edycji projektu.
Ścieżka konfiguracji jest przechwycona raz, a jej parsing i walidacja store
odbywają się w tle przed jakąkolwiek inicjalizacją lub startem usługi.

Observer thread ma cancellation i join przed teardown API. Zamknięcie UI
nie wysyła service drain ani kill. Po spawn zachowuje się launch record
i PID; outcome unknown nie pozwala uruchomić replacement. Pin API/store
jest powtarzany przed config write, nowym launch i po attach. Jest to nadal
obserwacja, nie pełny lease; brak runtime proof nie pozwala ogłosić cutover.

Źródła: `application_attach.rs`, `runtime_service_client.rs`, CLI `main.rs`,
Tauri `api_sidecar.rs` i `main.rs`. Source/parser/review nie zastępują buildu,
prób fault/shutdown ani Windows bez Docker/WSL. Regresje Rust pozostają
NOT COMPILED/NOT RUN zgodnie z aktualną instrukcją operatora.
