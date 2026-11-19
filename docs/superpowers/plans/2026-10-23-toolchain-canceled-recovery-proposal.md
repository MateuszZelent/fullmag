# Propozycja zakończenia anulowanego buildu toolchain — 23.10.2026

Status: zatwierdzona i zastosowana 23.10.2026. Natywny preview przez just oraz rozliczenie anulowanej operacji zakończyły się poprawnie. Procedura nie uruchamiała buildu, usług ani Solve.

## Problem i zakres decyzji

BuildKit zakończył rekord `rglzww139nplvgl57j3t13tl1` jako `canceled`. Utrata klienta hosta pozostawiła operację toolchain `185b3e45743f4cfe9621725a706daf80` ze stanem `starting`. Oryginalny helper potwierdził READY i LOGGED, nadal trzyma blokadę operacji i czeka na trwały terminal.

Proponowana recepta `docker-dev-reconcile-toolchain` domyślnie wykonuje preview. Tryb publikacji potwierdza wyłącznie `failed-confirmed`; nie publikuje obrazu, sukcesu, kwalifikacji ani wymyślonego kodu wyjścia procesu hosta.

## Warunki sprawdzane ponownie

- Żądanie jest przypięte SHA256. Receipt, Compose, log, tożsamość i czas startu helpera mają osobne piny.
- Helper musi mieć dokładne polecenie `BuildControl.operation_script`, właściwy obraz, etykiety źródła i grupy, mounty oraz namespace. Wymagane są READY i LOGGED.
- Ponownie haszowane są wszystkie zapisane wejścia toolchain. Aktualny HEAD może zawierać niezwiązane poprawki aplikacji; historyczny commit pozostaje przypięty do BuildKit.
- Buildery, worker IDs, wersje i silnik są przypięte. Kontroler nie uruchamia zatrzymanego buildera. Lista od początku operacji (filtr `startedAt>`, z zaokrągleniem w dół i marginesem jednej sekundy; ostrą nierówność wybiera parser Buildx, który rozcina `>=` najpierw po `=`) musi mieć mniej niż 50 rekordów. Osobne `status=running` nie ma ograniczenia czasu, projektu ani repozytorium.
- Dwa świeże odczyty BuildKit muszą zwrócić ten sam zakończony rekord. Porównywane są projekt i usługa Compose, VCS, Dockerfile, target, wszystkie argumenty i czas. Drugi rekord grupy po początku operacji powoduje odmowę.
- Odczytywane są procesy Linux i Windows: `docker.exe` może przeżyć klienta WSL. Aktywne lub niejednoznaczne klienty buildu blokują zapis. Niepełne argumenty i brak dostępu nie oznaczają nieobecności. Rozpoznawane polecenia diagnostyczne, np. Docker Desktop stats, są dozwolone.

To konserwatywna ścieżka: dowolny nadal aktywny build, również obcej grupy, albo potencjalnie ucięta lista historii w badanym oknie blokują recovery. Receptę należy uruchomić bezpośrednio, bez dodatkowego anonimowego `python -B -` z cwd tego checkoutu; taki klient jest celowo niejednoznaczny.

Historyczny receipt nie zawierał ref BuildKit ani PID klienta. Powiązanie opisano jawnie jako `operator-pinned-legacy-composite-identity`, a nie pierwotną rejestrację ref ani dowód zakończenia znanego PID. Surowy JSON historii pozostaje dowodem; porównanie świeżych odczytów pomija zmienny stos błędu i czas prezentacyjny.

## Publikacja i odtwarzanie po przerwaniu

Oryginalny helper stale trzyma blokadę operacji, więc nowy zarządzany build nie zostanie przyjęty. Obserwacje nie mutują runtime. Krótki helper publikacji używa istniejącego `commit_script`: osobnego commit flock, sprawdzenia nadal zajętej blokady operacji oraz CAS przypiętych dokumentów. Odczyty nie są obejmowane dodatkowym długowiecznym observerem.

Niezmienny oryginał i journal zawierają dokładny wynik. Receipt i current zastępowane są atomowo pojedynczo, terminal ostatni. To nie jest jedna atomowa transakcja wielu plików: po przerwaniu dopuszczony jest wyłącznie oryginał lub dokładny wynik tego samego żądania. Inna częściowa publikacja powoduje odmowę.

Tylko oryginalny helper usuwa active po zauważeniu terminala. Kontroler czeka na brak active i potwierdzoną nieobecność helpera. Powtórzenie po zakończeniu weryfikuje identyczny wynik; nie wykonuje ponownego buildu ani Solve.

## Zachowane dane i dowody

Nie są usuwane kontenery, wolumeny, obrazy, cache, logi, wyniki ani historia. Ostatni `toolchain/verified.json` pozostaje niezmieniony. Nie zmieniają się cudze grupy. Kwalifikacja pozostaje `NOT VERIFIED`.

Testy interpretowane weryfikują błędne tożsamości, niepełną historię, aktywne klienty, zakaz publikowania sukcesu, częściowy zapis i dokładny replay. Ich wyniki i prospektywny preview są osobnymi artefaktami.

Prospektywny preview uruchamia kandydackie moduły z wolumenu w pamięci; jedynie odczyt trzech proponowanych plików kontrolera zastępuje ich kandydackimi bajtami. Fakty środowiska — helper, receipt, Compose, log, wejścia toolchain, silnik, historia BuildKit oraz procesy — muszą pochodzić z rzeczywistych odczytów bez atrap. Taki dowód nie jest instalacją patcha ani końcowym preview repozytorium. Po decyzji użytkownika nadal wymagane jest rzeczywiste preview przez just z zastosowanych plików.

Po zakończeniu recovery można osobno uruchomić zarządzany build bez godzinnego timeoutu klienta. Ukończone warstwy BuildKit pozostają dostępne; nieukończony etap MFEM może wymagać powtórzenia.

## Jawny obserwator Windows dla historii BuildKit

Linuxowy Docker w WSL widzi działający builder default oraz niedostępny kontekst desktop-linux (protocol not available). Nie pomijamy tego błędu ani nie uruchamiamy buildera. Żądanie może przypiąć istniejący Windows docker.exe z kontekstem desktop-linux wyłącznie do odczytów BuildKit.

Przypięte są absolutna ścieżka i SHA256 programu, wersja CLI, kontekst i silnik. Osobno przypięty jest dokładny wynik `buildx version`; przed każdym odczytem historii walidator odrzuca zmianę tego niezależnego pluginu. Obserwator Windows musi zgłaszać ten sam engine ID co kontroler Linux. Enumerowane są wszystkie widoczne buildery Windows; tylko identyczne worker IDs umożliwiają deduplikację aliasów. Różni workerzy pozostają odrębni nawet przy wspólnym silniku Docker.

Compose, helper, blokady i odczyt źródeł nadal używają dotychczasowego klienta Linux. Nie zmienia się żaden plik konfiguracji, domyślny kontekst ani globalne środowisko. Adapter nie obsługuje poleceń build, start, stop, prune lub usuwania.

Pierwotny anulowany build używał klienta Linux. Kontrola procesów Windows jest dodatkowym zabezpieczeniem współdzielonego silnika, a nie twierdzeniem o procesie, który wykonał tę konkretną kompilację.

## Kompletność historii w oknie operacji

Każdy obserwowany worker musi używać sprawdzonego BuildKit v0.32.2. W tej wersji filtrowane są wszystkie wydarzenia, a limit nakładany dopiero potem; mniej niż 50 rekordów po filtrze czasu pozwala zatem wykazać kompletność okna. Nie używamy górnego ograniczenia czasu, aby późniejszy build tej samej grupy nadal powodował odmowę. Oddzielna lista aktywnych rekordów nie zawiera filtra daty i wykrywa także build rozpoczęty przed tą operacją. Inna wersja serwera powoduje odmowę do czasu odrębnej weryfikacji kontraktu.

Źródła: [BuildKit v0.32.2 — filtr historii](https://raw.githubusercontent.com/moby/buildkit/v0.32.2/solver/llbsolver/history/filter.go), [Docker — domyślny driver powiązany z kontekstem i silnikiem](https://docs.docker.com/build/builders/drivers/docker/).


## Wykonanie po zgodzie użytkownika — 23.10.2026

Recovery przez just zakończone: failed-confirmed, terminal SHA256 fc90d480d831f52f81c834ca0695c74346d3fd9cb99b62123f72f9a5bcaa5a2f; blokada zwolniona naturalnie. Wyniki i verified zachowane. Szczegóły wykonania i małej poprawki podłączenia recepty: [bieżący plan wdrożenia](2026-10-11-antenna-transport-e2e-implementation.md), końcowa sekcja z 23.10.2026.
