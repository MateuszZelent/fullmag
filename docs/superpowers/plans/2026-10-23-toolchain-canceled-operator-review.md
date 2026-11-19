# Przegląd końcowy propozycji recovery anulowanego toolchainu — v8

Status: zatwierdzona przez użytkownika i zastosowana 23.10.2026; natywny preview oraz recovery zakończone poprawnie. Testy modelu: **23/23 PASS**. Kontrola `git apply --check`: **PASS**. Prospektywny preview z rzeczywistymi odczytami hosta: **validated-only**.

## Problem i zakres decyzji

Operacja `185b3e45743f4cfe9621725a706daf80` pozostała w stanie `starting` po limicie czasu zewnętrznego procesu. BuildKit ma odpowiadający jej zachowany rekord `rglzww139nplvgl57j3t13tl1` ze stanem `canceled`; pierwotny helper czeka na terminalny zapis. Propozycja pozwala potwierdzić wyłącznie niepowodzenie tej operacji, aby helper naturalnie zwolnił własną blokadę.

Patch obejmuje nowy kontroler, jego testy, polski dokument, przepis `just` i dwa wąskie rozszerzenia istniejących walidatorów/transakcji. Zastosowanie wymaga decyzji dotyczącej wersjonowanej bramki runtime (§8 AGENTS.md). Przygotowanie tego przeglądu nie zmieniło rejestrów `active/current/receipt/terminal/verified`, repozytorium ani usług. Nie uruchomiono buildu ani Solve.

## Ochrona danych i przebieg po zatwierdzeniu

Kontroler przypina oryginalny receipt, Compose, pełny log, dokładną inkarnację helpera, engine ID, komplet builderów i worker IDs, szesnaście wejść toolchainu oraz stabilne pola rekordu BuildKit. Powtarza rzeczywiste odczyty przed publikacją. Sprawdza brak potencjalnego klienta buildu w Linux i Windows.

Publikacja korzysta ze współdzielonego commit lock, sprawdzenia trzymanej blokady pierwotnej operacji i CAS przypiętych dokumentów. Każdy zapis jest atomowy, a terminal jest zapisywany ostatni. Niezmienny dziennik pozwala dokończyć wyłącznie własny, dokładnie zgodny częściowy zapis. Helper sam zwalnia `active`; kontroler potwierdza również jego naturalne zniknięcie. Nie zabija procesów ani nie usuwa kontenerów.

Wynik pozostaje `failed-confirmed` i **NOT VERIFIED**. Nie przypisuje się fikcyjnego kodu wyjścia ani sukcesu. Poprzedni `verified.json`, obrazy, wolumeny, cache, wyniki i historia są zachowane. Następny build wymaga osobnego zarządzanego przepisu; ten kontroler niczego nie ponawia.

## Faktyczny preview i jego granice

W preview załadowano w pamięci trzy proponowane moduły kontrolerów, a wyłącznie odczyt ich własnych trzech plików zwracał bajty kandydata. Wszystkie odczyty engine, helpera, receipt, Compose, logu, źródeł toolchainu, BuildKit oraz procesów były rzeczywiste; nie zastępowano ich fixture'ami. To **prospektywny preview kandydata**, nie dowód uruchomienia patcha zainstalowanego w repo. Po zatwierdzeniu i aplikacji nadal trzeba wykonać natywny preview przez nowy przepis `just`, zanim dopuści się publikację.

Preview odczytał 154 procesów Linux oraz listę klientów Windows i nie znalazł potencjalnych klientów buildu. Potwierdził engine `8778c539-4a71-44f7-a6ee-03105e8a6a22`. Pełne inventory jest sprawdzane przed deduplikacją:

| Builder | Worker ID | Wersja | Stan |
|---|---|---|---|
| default | b8yruf7yaxm1m89wjz3ye13d9 | v0.32.2 | running |
| desktop-linux | b8yruf7yaxm1m89wjz3ye13d9 | v0.32.2 | running |
| fullmag-windows | i94buawj506t1ji1p03gfyz4h | v0.32.2 | running |

Dwa pierwsze wpisy są aliasami tego samego workera. Trzeci został odczytany oddzielnie. Dowolny rzeczywiście aktywny build, nieczytelny lub zatrzymany builder, zmiana inventory, inna wersja serwera, co najmniej 50 rekordów w zapytaniu lub drugi rekord naszej grupy powoduje odmowę.

Pierwotny build korzystał z Linux Docker CLI. Tylko obserwator historii wykorzystuje istniejący Windows Docker CLI `29.7.2`, jawnie z kontekstem `desktop-linux`; ustawień globalnych nie zmieniono. Ścieżka w WSL: `/mnt/c/Users/admin/AppData/Local/Programs/DockerDesktop/resources/bin/docker.exe`; SHA256: `0f97bc1111f59d859766ba938691ee07ed4e58d5fdaeb6f4dfb10a5ef5394753`. Linux nadal obsługuje kontrolę/helpera. Engine obu perspektyw musi być identyczny.

## Podstawa filtra i ograniczenie historycznego powiązania

[BuildKit v0.32.2 Controller.ListenBuildHistory](https://raw.githubusercontent.com/moby/buildkit/v0.32.2/control/control.go) przekazuje żądanie do [Queue.Listen](https://raw.githubusercontent.com/moby/buildkit/v0.32.2/solver/llbsolver/history/buildhistory.go). Queue odczytuje pełne zachowane rekordy i przekazuje je do [filterHistoryEvents](https://raw.githubusercontent.com/moby/buildkit/v0.32.2/solver/llbsolver/history/filter.go), które filtruje przed limitem. Aktywne rekordy są emitowane oddzielnie. [Buildx v0.36.1](https://raw.githubusercontent.com/docker/buildx/v0.36.1/commands/history/utils.go) przekazuje filtr i limit 50 oraz filtruje lokalnie aktywne rekordy.

V7 używa `startedAt>floor(start)-1s` i zachowuje dokładne porównanie czasu po stronie kontrolera. Oddzielne `status=running` nie ma ograniczenia czasu, projektu ani repozytorium. Zainstalowany Buildx zgłasza `github.com/docker/buildx v0.36.1-desktop.1 83d819cf8237b52ef45a2a9857eeb83a7b10977f`; pełny ten wynik jest osobno przypięty w request i sprawdzany przed każdą obserwacją historii. Zmiana niezależnego pluginu powoduje odmowę; nie zweryfikowano źródła tego konkretnego desktopowego forka. Podstawą jest zbadany kontrakt upstream v0.36.1, przypięty faktyczny Docker CLI, osobno przypięty wynik wersji Buildx, wersja serwera oraz pomyślnie wykonane zapytania rzeczywistego preview. V6 ujawnił błąd parsera: `cutAny` rozcina `>=` po `=`; v7 używa udokumentowanego `>` i ma regresję argumentu.

Oryginalny receipt nie zawierał BuildKit ref ani PID hosta. Jest to jawne powiązanie operatora z pełną tożsamością złożoną oraz unikalnością **zachowanej** historii, nie pierwotne kryptograficzne powiązanie operacji. Limit mniejszy niż 50 nie dowodzi, że wcześniejsze rekordy nigdy nie zostały usunięte przez GC. Ta ograniczona procedura nie jest uniwersalnym recovery dowolnego hosta.

## Przypięte artefakty

Wszystkie ścieżki poniżej odnoszą się do katalogu `/control/verification/universe-volume-policy-20261023/toolchain-timeout-proposal/v8` w istniejącym wolumenie kontrolnym grupy.

| Artefakt | SHA256 |
|---|---|
| proposal.patch | 677d39ff47f7117880872fcaf1338d4183ffc3979820fd878eff7daa8243a907 |
| request.json | 4e4998309dc11298d7ecbff23352cf3a58fc197e61c1721f60c88d1d449a5948 |
| prospective-preview.json | 6ae2abc93f75b88ccb9179d340d094710991010f165cef4682d970040b8bf665 |
| tests.json | cc6d1db0abd329de56335d5815b2bcaec07eff9674844f8b2770f18e78d29888 |
| git-apply-check.json | f4a2983b5b574d18781014d4ec1e6457849f362060ccaa952a2b671277955d38 |

Przygotowany wynik niepowodzenia: `fc90d480d831f52f81c834ca0695c74346d3fd9cb99b62123f72f9a5bcaa5a2f`. Oryginalny runtime i wszystkie wcześniejsze wersje dowodów pozostały zachowane. Pełne testy: `tests.log`; pełne proponowane pliki: `proposed/`; metadane: `proposal.json`.


## Zakres oczekującej decyzji operatora

Po zgodzie: zastosowanie przypiętego patcha, rzeczywisty preview przez `just`, potwierdzenie wyłącznie niepowodzenia operacji `185b3e45743f4cfe9621725a706daf80` i kontrola naturalnego zakończenia jej helpera. Kontroler nie usuwa kontenerów usług; pierwotny pomocnik kończy własny zarządzany cykl życia.

Następnie jedna kontynuacja istniejącej, zakończonej operacji odtworzenia usług `e47a16d91bd840b78a694b670e2da206`, SHA256 terminala `27acebcba18f050d85b81ff1691be012a253c424843a8b53a4bbe0e09b8d1b4a`, przez `docker-dev-recreate-volume` dla poprzedniej próby `4f5f21c2dc754f02b9135ae3a88bed6e` i konfiguracji `81fba96e475108187ca75f37b0bc582e2b3444e37ce1415033e954b3979ab409`. To kontynuacja po już zakończonym usunięciu własnych usług, bez powtarzania tego usuwania. Zachowuje dane i cache oraz port 3203. Długi build będzie uruchomiony bez zewnętrznego godzinnego timeoutu zabijającego klienta.

Świeża kontrola zachowania danych przed decyzją: 70 plików poprzedniego wyniku, pięć historycznych katalogów runów, dwa zachowane projekty i dwa oryginalne pliki użytkownika są identyczne bajtowo. Ręcznie przygotowany run Universe nadal ma wyłącznie run_catalog.json i run_intent.json. Dowód: `root-preservation-check.json` w powyższym katalogu kontrolnym.

Jedna próba Solve dla Universe jest już zatwierdzona odrębną decyzją użytkownika. Dotąd nie wysłano jej ani razu. Ten przegląd nie kwalifikuje solvera naukowo ani widoku WebGL.

Pytanie o wdrożenie wynika z §8 instrukcji AGENTS.md przekazanych przez użytkownika w rozmowie: „The change touches something you've been told is load-bearing, versioned, or has a migration path.” Jest to nowa bramka dla fazy toolchain; wcześniejsza zgoda dotyczyła innego, przypiętego patcha recovery.


## Wykonanie po zgodzie użytkownika — 23.10.2026

Recovery przez just zakończone: failed-confirmed, terminal SHA256 fc90d480d831f52f81c834ca0695c74346d3fd9cb99b62123f72f9a5bcaa5a2f; blokada zwolniona naturalnie. Wyniki i verified zachowane. Szczegóły wykonania i małej poprawki podłączenia recepty: [bieżący plan wdrożenia](2026-10-11-antenna-transport-e2e-implementation.md), końcowa sekcja z 23.10.2026.
