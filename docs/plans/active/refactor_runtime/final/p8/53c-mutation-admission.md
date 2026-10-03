# P8-53C — bramka wejścia do handoffu backendu dev

Data: 03.10.2026. Status: implementacja w toku; pełny restart NOT VERIFIED.

## Zmiana

`DevelopmentAdmission` jest współdzielona przez `AppState`. Produkcyjny
router zakłada jeden permit przed wejściem do handlerów i middleware scope
sesji. Permit pozostaje do zakończenia przyszłości obsługi żądania. Kolejność
jest jawna: admission → session transition → zasoby/ledger/queue.

GET i HEAD również otrzymują permit: niektóre odczyty uzgadniają lifecycle
prezentacji lub materializują zasoby. Wyjątki dotyczą OPTIONS i konkretnych
obserwacji procesu: healthz, OpenAPI i status buildu dev. Wewnętrzny
`control/wait` pobiera permit przy rzeczywistym dequeue, przed transition;
nie utrzymuje go podczas oczekiwania na komendę.

Właściciel handoffu może zamknąć wejście atomowym CAS przed oczekiwaniem na
wyłączną blokadę. Nowe żądania dostają `409 development_restart_in_progress`,
ze wspólnymi nagłówkami instance, contract version i request id. Już przyjęte
operacje kończą się przed uzyskaniem exclusive guard. Ponowna kontrola po
uzyskaniu read permit obejmuje wyścig rozpoczęcia freeze.

RAII ponownie otwiera admission po anulowaniu oczekiwania albo nieudanym
handoffie. Konkurencyjny freeze nie może otworzyć bramki pierwszego właściciela.
Trwałe zamknięcie wymaga jawnego potwierdzenia przez ownera procesu.

## Granice i następny krok

Nie ma jeszcze endpointu aktywującego freeze, więc ta zmiana nie dowodzi
odrzucenia rzeczywistego restartu podczas Start ani odtworzenia workspace.
Komenda restartu musi wejść osobną, ściśle przypiętą ścieżką właściciela:
nie wolno wywołać `begin_freeze` z handlera trzymającego zwykły read permit.
Po exclusive guard należy przejąć transition, sprawdzić autorytatywne
run/preparation/mesh i ledger, zapisać pełny handoff oraz uzyskać potwierdzenie
supervisora. Dopiero ten przebieg pozwoli zastosować nowy EXE.

Spontaniczne publikacje tła i autonomiczny runtime service nie stają się
zatrzymane przez samo HTTP admission. Snapshot wymaga transition, a niezależny
owner nadal wymaga własnego drain/recovery. Istnienie descriptoru albo
nieznany stan blokuje dalszy krok; nie uruchamiamy cichego kill/fallbacku.

## Weryfikacja

Dodano pięć źródłowych regresji Rust: drain, anulowanie, konkurencyjny freeze,
trwałe zamknięcie i rzeczywistą warstwę HTTP z nagłówkami. Zgodnie z bieżącym
zakazem kompilacji testów są **NOT COMPILED / NOT RUN**.

Zarządzana obserwacja natywnego API została rozszerzona o Create scratch,
odczyt po mutacji i pusty dequeue. Te sprawdzenia dowodzą zwykłej ścieżki
otwartej bramki, a nie freeze ani bezpiecznego restartu. Produkcyjny build
`just windows-workspace-build dev dev 3197 auto` zakończył się exit 0;
manifest zweryfikował 13 EXE dla `x86_64-pc-windows-msvc`, bez kompilacji testów.
Tożsamość manifestu: `85df683a3bc034bcd7d2a30689a02249bedaa4cf7a511f2474f15253935ad3e1`.
Snapshot źródeł: `914e9349f97eb9be6be0d8099f72892505e7e62a46ca03f379ef3fa2ef506a19`.

`just verify-windows-development-backend-api` zakończył się exit 0, **24
sprawdzenia**. Receipt: `db0775d950f14bfc9964a9cc940297a2` w profilu
`development-backend-api-checks`. Trzy własne procesy API zostały zakończone
i zebrane przez verifier; wymuszone zakończenie tych fixtures nie dowodzi
graceful shutdown. Testy Rust freeze pozostają niewykonane.

Review wskazało mutujący GET kompozycji wizualizacji; domyślne objęcie GET/HEAD
zamknęło tę lukę bez zagnieżdżania permitów w helperach. Review bannera
wskazało zasłanianie Inspektora; banner przesunięto do normalnego flow nad
gridem workspace. Produkcyjne typowanie: exit 0, receipt
`b3ecd49e755f4a498bfd5a9a81e54f74`; higiena API: exit 0, receipt
`28608623e75f4d2791798beb1f441676`.

Przebieg browser na 3197 utworzył własną sesję `P8-53 browser verification`
(`session-18db11b15de9214000023b44`). Banner mieści się nad głównym workspace:
jego dolna krawędź 38.5 px, początek main 42.5 px. Inspektor schowano i
przywrócono przez View → Panels; banner nie przykrywa tych kontrolek.
Widoczny canvas miał 514 × 304 piksele. Ten dowód dotyczy układu i interakcji;
nie zmieniano viewportu, nie sprawdzano `contextLost` ani wykonania solvera.
Zrzut: `p8-53-workspace.jpg` w katalogu wizualizacji bieżącego zadania.
Odtworzenie niepustego modelu po restarcie pozostaje NOT VERIFIED.
