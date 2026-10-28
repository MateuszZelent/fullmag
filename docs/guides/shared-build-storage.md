# Współdzielenie zasobów builda pomiędzy grupami DEV

Status: implementacja projektu `shared-build-storage-20261027`. Dowody odbioru
są zapisywane oddzielnie od kontraktu; testy Python nie kwalifikują aplikacji GPU.

## Granice

| Dane | Właściciel / współdzielenie | Zapis i blokada |
| --- | --- | --- |
| Obraz toolchaina | zgodne wejścia i immutable image ID | warstwy BuildKit |
| Cargo registry/git | projekt, named volume `fullmag-shared-cargo-v1-*` | Cargo zarządza blokadami swojego cache; bez hostowych credentials/config |
| Store pnpm | projekt, `fullmag-shared-pnpm-v1-*` | flock tylko podczas instalacji; import `copy` |
| Gotowy pakiet backendu | dokładny klucz wejść, `fullmag-shared-packages-v1-*` | jeden publisher na klucz; atomowa publikacja i walidacja SHA-256 |
| Bieżący pakiet / rollback | `groups/<unit_key>` w wolumenie pakietów | regularne, zapieczętowane hardlinki do payloadu; prywatne receipty |
| Workspace, Cargo target, CMake, log kompilacji | grupa / worktree | prywatny `/build`; blokada buildu grupy |
| node_modules, `.next`, frontend workspace | grupa / dependency seed | prywatny wolumen frontendu |
| Control, ledger, sesje, wyniki | dotychczasowi właściciele | bez współdzielenia przez mechanizm cache |

Nowe rendery zarządzanego launchera włączają ten układ. Starsze obrazy i zachowane
konfiguracje bez zmiennych `FULLMAG_SHARED_*` zachowują dotychczasowe zachowanie.
Nie kopiujemy ani nie usuwamy automatycznie starych wolumenów przy migracji.
Recreate nadal wymaga istniejącego protokołu drain i przypiętej konfiguracji.

Grupy należą do jednego zaufanego użytkownika/zespołu lokalnego. Cały mount
magazynu pakietów jest zapisywalny dla publishera; to protokół współpracy, a nie
izolacja od wrogiego kodu w innym worktree. Nie współdzielić między tenantami.

## Zgodność i współbieżność

Klucz pakietu obejmuje runtime digest rzeczywistych źródeł, commit i pełną native
source identity, toolchain/dependency manifest, profil i features, rozwiązane
architektury CUDA, helpery buildera oraz jawne flagi kompilatora. Nie obejmuje
nazwy agenta ani katalogu worktree. Binaria zawierają commit: nie wolno przedstawiać
pakietu z innego commita jako nowej kompilacji. Dlatego różne commity mogą
współdzielić zależności, ale nie muszą trafić w cache gotowego backendu.

`Store.claim` utrzymuje blokadę konkretnego klucza przez build/publication.
Druga grupa o identycznych wejściach czeka i sprawdza opublikowany wynik; inne
klucze budują równolegle. Istniejąca blokada control/grupy nadal chroni dwa
wątki pracujące na tym samym masterze/worktree.

Linki powstają przez jeden root mount wolumenu: `/opt/fullmag/shared-backend`.
Prywatny mount `/opt/fullmag/package` jest sprawdzanym aliasem katalogu grupy.
Nie tworzymy hardlinków między odrębnymi mountami (możliwe `EXDEV`). Payload ma
tryb bez bitów zapisu. Cache hit zapisuje własny receipt z kluczem i hashem
receiptu producenta; nie udaje lokalnego uruchomienia Make.

Przy porównywaniu zapieczętowanych artefaktów walidacja uwzględnia inode,
rozmiar, mtime, tryb i hash. Samo ctime zmienia się również wskutek link/unlink
innej grupy. Mutowalne pliki źródeł nadal mają rygorystyczną kontrolę ctime.

Przerwany restore ma trwały intent przed pierwszym hardlinkiem. Recovery może
usunąć tylko zapisane w nim, zweryfikowane pliki. Gotowy shared kandydat jest
najpierw zachowany w cache, a potem zwalniany; następny start ponownie dobiera
pakiet do aktualnych źródeł. Nie wymaga fikcyjnego Make attempt. Ostatni receipt
recovery i diagnostyka (do 64 MiB) zostają w control grupy.

Store pnpm jest wspólny, ale `node_modules` nie: `--package-import-method=copy`
chroni grupy przed modyfikacją wspólnych plików przez skrypty instalacyjne.
Blokada pnpm pozostaje zajęta przy niepewnym zakończeniu procesu aż do dowodu,
że jego grupa procesów jest pusta. Next działa już bez tej blokady.

## Retencja i zakończenie pracy

Kontener backendu z `FULLMAG_AUTO_CACHE_MAINTENANCE=1` automatycznie uruchamia
retencję po zapisaniu gotowości API/runtime. Obejmuje to również zwykły Start lub
Restart w Docker Desktop. Nadzorowany proces działa z niskim priorytetem; API
pozostaje dostępne, a launcher nie uruchamia drugiej kopii sprzątania.
Pod nieblokującą blokadą buildu zachowuje current oraz
bezpośredni rollback, usuwa starszy zweryfikowany łańcuch i ogranicza prywatny
Cargo incremental do 8 GiB zaalokowanych bloków plików. Usuwa najstarsze całe
katalogi cache crate; następny build może odtworzyć brakujący incremental.
Nie usuwa `deps`, native CMake ani źródeł. Zmiana układu Cargo, symlink lub obcy
owner zatrzymuje operację zamiast rozszerzać zakres kasowania. Wynik trafia do
`runtime-service/cache-maintenance.json` w technicznym runtime control.
Receipt zawiera identyfikator próby, PID API, klucz cache i rzeczywisty wynik;
hostowy receipt zawiera odwołanie, nie deklaruje zakończenia przed workerem.
Zajęta blokada grupy oznacza `deferred-busy`, błąd oznacza `failed`. Kolejny start
ponawia próbę. Zatrzymanie kontenera najpierw zamyka admission API, następnie
kończy maintenance w ograniczonym czasie i wykonuje zwykły native drain.
Przerwane usuwanie historycznego backupu jest wznawiane z trwałego intentu;
obce pliki lub zmieniona tożsamość zatrzymują sprzątanie. Bieżący pakiet i
bezpośredni rollback pozostają nietknięte.

Ta funkcja wymaga nowego obrazu oraz konfiguracji kontenera. `docker restart`
nie zmienia obrazu, zmiennych ani mountów istniejącego kontenera. Stare grupy
muszą przejść zarządzaną migrację; w szczególności działającej grupy nie wolno
odtwarzać w trakcie pracy innego wątku.

Wspólny cache gotowych pakietów zachowuje domyślnie do 8 wpisów i 64 GiB
logicznych payloadów. Aktywna publikacja/użycie przez inną grupę odkłada globalny
GC (`deferred-busy` w receipcie); kolejny start kontenera ponawia próbę.
Usunięcie wpisu cache nie usuwa hardlinków current/rollback innych grup. Te
limity nie są kwotą całego dysku Docker ani całego Cargo target.

Ręczne uruchomienie tej samej retencji na przypiętej zdrowej grupie:

```sh
just docker-dev-maintain-cache <attempt> <config_sha256> <source_root>
```

Przed usunięciem zakończonego worktree zatrzymaj z drain i usuń dokładnie jego
kontenery. Następnie, jeszcze z istniejącego worktree, uruchom:

```sh
just worktree-finish <task_id> <owner> <powód_i_dowód_integracji> completed
```

`finish` wymaga dokładnego właściciela z rejestru i wykonuje kwalifikowaną
retencję Docker pod lease grupy. Obejmuje wszystkie zweryfikowane prywatne
wolumeny backend build/package i frontend tej grupy, także wcześniejszych
konfiguracji, oraz odpowiadające im `groups/<unit_key>` we wspólnym magazynie.
Aktywny lub zachowany kontener, obcy konsument, nieznana tożsamość albo błąd
Dockera blokuje oznaczenie `completed`. Najpierw zapisuje trwały plan i znacznik
zamykania; blokuje to nowe zarządzane starty tej grupy. Przerwaną operację należy
wznowić tym samym poleceniem. Kontrolny receipt potwierdza usunięte zasoby.
Dopiero potem usuń worktree i zintegrowany branch, a wynik zapisz w jego rekordzie.

**Nigdy nie usuwaj całego `fullmag-shared-*` razem z pojedynczym worktree.**
Wspólne pakiety, Cargo/pnpm, control, ledger, sesje i wyniki pozostają.
Nie ma automatycznej migracji ani zbiorczego kasowania dawnych, nieznanych grup.
Cargo registry/git i pnpm store są współdzielone, ale ta zmiana nie ustanawia
ich wspólnego limitu bajtowego. Prywatny pełny target zostaje usunięty przy
kwalifikowanym zakończeniu worktree; długotrwały master nadal wymaga obserwacji
pozostałych części target i BuildKit.

Dalsze migracje starych pakietów lub cleanup nieznanego stagingu wymagają
inwentarza i jawnej kwalifikacji. Wiek wolumenu lub brak uruchomionego kontenera
nie dowodzą, że dane nie są potrzebne.

## Aktualizacja istniejącej grupy ze starszego worktree

Kod aplikacji i wersja narzędzi operacyjnych mają osobne tożsamości. Przy
zarządzanym `recreate-volume` można wskazać `--helper-source-root` oraz
`--helper-source-commit` jako parę. Launcher musi pochodzić z tego przypiętego
checkoutu helperów; pliki infrastruktury muszą odpowiadać jego commitowi,
indeksowi Git i bajtom na dysku. Oba checkouty należą do tego samego Git common
directory i korzystają z właściwego adaptera hosta: Windows lub Linux/WSL.

```sh
python <helpers>/scripts/docker_dev.py --repo-root <main-checkout> recreate-volume \
  --source-root <app-worktree> --attempt <retained-attempt> \
  --config-sha256 <retained-compose-sha256> --port <retained-port> \
  --helper-source-root <helpers> --helper-source-commit <full-commit-sha>
```

Wskazanie helperów zmienia tylko obraz narzędzi oraz szablon Compose. Live
source, Git aplikacji, jej tożsamość, toolchain, sesje i wybór cache nadal
pochodzą z `--source-root`. Pin trafia do trwałych receipts przed usunięciem
starych kontenerów i jest ponownie sprawdzany przy starcie oraz wznowieniu.
Nie znosi żadnej bramki stopped/drain, kontroli ID i konfiguracji ani recovery.
Nieobsługiwane kombinacje recovery są odrzucane przed mutacją.

Nowy obraz przypina również bajty pary helperów aktywacji. Późniejsze operacje
aktualnym launcherem mogą odczytać je ze wskazanego niezmiennego obrazu; nie
wymagają zachowania tymczasowego worktree helperów. Zwykły restart kontenera
używa wyłącznie już zainstalowanego obrazu i konfiguracji. Dalsze operacje
hostowe na starym worktree wykonuj aktualnym launcherem: jego stara lokalna
kopia nie otrzymuje nowych funkcji przez samą zmianę obrazu.

Migracja jest sekwencyjna. Przed każdym krokiem ponownie sprawdź aktywność:
inny wątek może uruchomić grupę po inwentaryzacji. Działającą grupę odłóż do
naturalnego zatrzymania. Osierocony lease, brak potwierdzonego drain, niezgodne
ID, niedostępny ledger lub brak receipts wymagają właściwego recovery;
nie oznaczają zgody na `--fresh-state`, kasowanie markerów ani powtórzenie Solve.
`recreate-volume` uruchamia nowe usługi i czeka na kwalifikację. Zachowanie
grupy offline wymaga późniejszego zarządzanego zatrzymania z drain.

Stare prywatne wolumeny pozostają do czasu kwalifikacji nowej grupy. Nie
deklaruj odzyskanego miejsca ani współdzielenia na podstawie samego planu:
sprawdź rzeczywiste mounty, nowy receipt, wynik retencji i konsumentów starych
wolumenów przed ich oddzielnym kwalifikowanym usunięciem.

## Weryfikacja

Testy interpreted obejmują pojedynczego publishera przy równoległych żądaniach,
niezależne klucze, przerwanie procesu, niekompletną publikację, błędne ścieżki,
zmieniony payload, prywatny receipt, recovery building/ready, zmianę źródeł,
GC z zachowaniem hardlinków current/rollback i współbieżną rotację pakietu.
Testy host adaptera sprawdzają dokładne etykiety, subpath, inne grupy i blokowanie
własnych lub nieznanych konsumentów. Rzeczywiste mounty/UID muszą zostać sprawdzone
na Dockerze osobno. Pomiar przyspieszenia wymaga tego samego źródła/toolchaina,
zimnego i ciepłego uruchomienia; nie wynika z liczby przechodzących testów.

Dokumentacja pnpm: [store na różnych filesystemach](https://pnpm.io/faq),
[metoda importu pakietów](https://pnpm.io/settings#packageimportmethod).

Dokumentacja Cargo: [profile incremental](https://doc.rust-lang.org/cargo/reference/profiles.html#incremental), [target i miejsce na dysku](https://doc.rust-lang.org/cargo/faq.html).
