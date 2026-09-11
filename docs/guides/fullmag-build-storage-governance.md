# Fullmag — polityka worktree, buildów i storage

**Status:** obowiązujący kontrakt organizacyjny oraz implementacja resolvera
i adapterów w izolowanym worktree; zakres dowodów opisuje
[raport weryfikacji](../superpowers/plans/2026-09-09-storage-governance-verification.md).

Ten dokument jest jednym źródłem zasad dla worktree, buildów, cache, runtime’ów,
logów i wyników tworzonych przez Fullmag, w tym przez ręcznie uruchamiane
recepty `just`. Określa wymagane zachowanie resolvera i launcherów. Sam dokument,
`AGENTS.md` ani skill nie są blokadą systemową; dopóki preflight nie jest
podpięty do danego wejścia, jego zgodność pozostaje **NOT VERIFIED**.

## Bieżący status implementacji

Stan repozytorium na 2026-09-09 jest częściowy i musi być oceniany warstwami:

- istnieją wspólny resolver `scripts/fullmag_storage.py`, testy storage,
  adapter PowerShell oraz podpięcia do wybranych launcherów Windows, helperów
  Linux, `justfile`, Make, Compose i wyjść frontendu; testy kontraktowe są
  uruchamiane przez `.github/workflows/contract-guard.yml`;
- obecność tych podpięć dowodzi ochrony źródłowej i kontraktowej tylko dla
  sprawdzonych wejść. Nie dowodzi jeszcze pełnego end-to-end dla każdej recepty,
  ręcznego uruchomienia `just`, Docker Desktop, obu profili platformy ani
  rzeczywistego runtime’u solvera. Każdą niezweryfikowaną ścieżkę oznaczaj
  **NOT VERIFIED**;
- komenda `register` zapisuje rekord ownera, a `finish` zapisuje jego stan, lecz
  bieżące `resolve`, `prepare-links` i `run` nie wymagają aktywnego rekordu
  ownera przed mutacją lub wykonaniem. Rejestr jest więc obecnie śladem
  operacyjnym, a nie runtime’owym wymuszeniem własności. Nie wolno przedstawiać
  samej obecności wpisu jako dowodu tej kontroli;
- `profile-id` opisuje ABI jako element zgodności, ale resolver nie wylicza ani
  nie weryfikuje automatycznego hash/fingerprint ABI kompilatora, nagłówków,
  bibliotek i linkera. Nazwa profilu, commit lub feature flags nie są dowodem
  zgodności ABI. Dopóki taki fingerprint nie jest generowany i sprawdzany w
  manifeście, ponowne użycie przy nieznanym ABI pozostaje **NOT VERIFIED**;
- wykonanie managed solvera, walidacja fizyki, dowód parytetu oraz kwalifikacja
  wydania pozostają osobnymi bramkami i nie wynikają z zielonego testu resolvera.

Przyszłe wdrożenie runtime powinno wymagać aktywnego ownera związanego z task/session,
hostem, procesem i worktree przed pierwszym zapisem oraz atomowo rejestrować
ABI fingerprint w profilu i manifeście. Do czasu tych zmian dokument opisuje
kontrakt i wykrywalne braki, a nie pełną gwarancję wykonawczą.

## Granica projektu

Fizyczną ścieżkę storage danego hosta deklaruje operator w `.env` głównego
checkoutu przez `FULLMAG_PROJECT_STORAGE_ROOT`. `.env.example` dokumentuje klucz,
ale nie narzuca lokalizacji Windows/Linux. Resolver czyta tylko zarządzane
zmienne storage, bez wykonywania kodu i interpolacji; zmienne procesu mają
pierwszeństwo (w szczególności dla ścieżek wewnątrz kontenera). Wszystkie
worktree korzystają z `.env` głównego checkoutu. Nie kopiuj pliku z sekretami.
Poniższy układ rodzeństwa jest wyłącznie fallbackiem zgodności przy braku
konfiguracji; nowe buildy agenta wymagają jawnej deklaracji w `.env`.
Niestandardowy root nadal wymaga zatwierdzonego markera projektu. Instrukcje
i skille odsyłają do resolvera, nie ustalają fizycznych ścieżek hosta.

Tożsamość projektu wyznacza się z Git, a nie z bieżącego katalogu procesu:

1. rozwiąż bieżący checkout przez `git rev-parse --show-toplevel`;
2. odczytaj `git worktree list --porcelain -z` i użyj pierwszego rekordu
   `worktree` jako głównego checkoutu; na starszym Git bez `-z` użyj
   `--porcelain` z dekodowaniem cytowanych ścieżek; działa to także dla
   checkoutu z osobnym katalogiem Git;
3. ustal `project root` jako katalog nadrzędny głównego checkoutu;
4. użyj rodzeństwa głównego checkoutu `storage` i `worktrees`.

Dla obecnego układu Windows oznacza to logicznie:

```text
C:\git\fullmag\
  fullmag\       główny checkout
  worktrees\    dodatkowe checkouty źródeł
  storage\      wszystkie nowe kontrolowane dane
```

Na Linuxie obowiązuje ten sam układ. Jeżeli główny checkout znajduje się pod
`/zfn2/mateuszz/git/fullmag/fullmag`, project rootem jest
`/zfn2/mateuszz/git/fullmag`, a storage rootem
`/zfn2/mateuszz/git/fullmag/storage`. Jest to przykład wynikający z tożsamości
checkoutu, a nie stała ścieżka zaszyta w launcherze.

Worktree położone na innej głębokości nie mogą zmienić project rootu przez użycie
`cwd.parent`. Jawny `FULLMAG_PROJECT_STORAGE_ROOT` jest dopuszczalny wyłącznie
po walidacji absolutnej ścieżki, markera storage, containment, junctionów/
symlinków, właściciela i przeznaczenia projektu. Nie może wskazywać rootu
dysku, checkoutu, worktree ani płaskiego katalogu legacy.

## Kanoniczny układ danych

Nowe dane Fullmag trafiają wyłącznie pod jeden `storage root` projektu:

```text
storage/
  builds/<worktree-id>/<profile-id>/
    cargo-target/           domyślne mutowalne wyjście Rust/Cargo
    cargo-targets/          dodatkowy korzeń targetów profilu
    native-fdm/             domyślne mutowalne wyjście CMake/CUDA FDM
    build-status.json       atomowy stan ostatniego managed runu/builda
  builds/<worktree-id>/frontend/
    ...                     output i cache frontendu dla worktree
  cache/                    tylko cache możliwe do bezpiecznego współdzielenia
  runtimes/<worktree-id>/  compatibility/staging root dla `.fullmag`
  runs/<worktree-id>/      logi, manifesty i wyniki uruchomienia
  tmp/<worktree-id>/<profile-id>/ krótkotrwały staging profilu
  index/                    rejestr worktree i linków
  locks/<worktree-id>.*     blokada oraz właściciel worktree
  build-volumes/            backing images nowych ciężkich buildów Linux
```

`builds/<worktree-id>/<profile-id>` zawiera wyjścia przypisane do worktree i
profilu. `frontend` jest korzeniem przypisanym do worktree, a nie do profilu;
`cache` zawiera wyłącznie dane obsługiwane przez narzędzie jako współdzielone.
`runtimes/<worktree-id>` jest także korzeniem zgodności i stagingu: link
`.fullmag` wskazuje na ten katalog, więc znajdujące się tam raporty, lokalne
narzędzia lub dane tymczasowe nie są automatycznie zweryfikowanym runtime’em.
Runtime kwalifikowany musi być rozpoznawalny po własnym artefakcie/manifestcie.
`runs` nie jest katalogiem builda, a `tmp` nie jest trwałym magazynem. Wynik naukowy wskazany przez użytkownika jawnie może
pozostać w jego lokalizacji, ale musi być zapisany w manifeście runu.

Nie tworzymy nowych katalogów `C:\fullmag-build`, `C:\fullmag-cache`,
`C:\fullmag-tmp`, płaskich `builds`/`cache` w rootach dysków ani dużych
`/tmp/fullmag-*`. Istniejących katalogów legacy nie przenosi się ani nie usuwa
automatycznie. Ponieważ storage jest rodzeństwem checkoutu, wpis `../storage`
w `.gitignore` nie jest jego ochroną; granicę zapewniają resolver, marker,
containment i uprawnienia. Instalacje systemowe, wewnętrzny magazyn Codex i
wewnętrzny magazyn Docker Desktop pozostają osobnymi zasobami zarządzanymi
przez hosta.

## Worktree i rejestr własności

Przed utworzeniem lub ponownym użyciem worktree sprawdź `git status --short`,
`git worktree list --porcelain`, wspólny katalog Git oraz rejestr w
`storage/index`. Najpierw użyj istniejącego worktree tego samego zadania, jeżeli
nie ma aktywnego właściciela. Dla audytu, planu albo małej edycji dokumentu nie
twórz nowego worktree.

Domyślnie jedno zadanie ma jedno worktree w
`<project-root>/worktrees/<task-id>`. Dodatkowe worktree wymaga konkretnej,
niezależnej potrzeby zapisanej w rejestrze. Sama nazwa katalogu nie jest dowodem
własności.

Resolver zapisuje rekord worktree w `index/<worktree-id>.json` z polami
`schema`, `worktree_id`, `repo_root`, `task_id`, `owner`, `purpose`, `state`,
`branch`, `head`, `base_commit`, `created_at` i `updated_at`; `purpose` musi
zawierać powód oraz następny krok. Rekordy linków zgodności są zapisywane jako
`index/<worktree-id>.links.json`. Każdy dodatkowy operatorowy rejestr musi
zachować co najmniej task-id, właściciela/sesję, absolutną ścieżkę, branch lub
ref, bazowy pełny commit, cel, czas utworzenia, bieżący stan i następny krok.
Współdzielony dirty checkout nie może być resetowany,
stashowany, stage’owany ani commitowany bez osobnej autoryzacji.

Utworzenie worktree nie uruchamia automatycznie `fetch`, `pull`, `rebase`,
aktualizacji submodułów ani instalacji wszystkich zależności. Pracuj na lokalnie
rozwiązanym refie. Synchronizacja z remote jest osobnym, jawnie opisanym
działaniem i zapisuje użyty ref bazowy w rejestrze.

## Profile buildów i ponowne użycie

`profile-id` opisuje zgodny zestaw platformy/architektury, toolchainu, trybu
debug/release, backendu, feature flags, ABI i zależności. Nie jest skrótem
brancha ani jednorazowego procesu.

Zwykła kolejna kompilacja tego samego worktree używa tego samego zgodnego
profilu oraz jego mutowalnych katalogów `cargo-target`/`native-fdm` pod
blokadą worktree. Resolver zapisuje blokadę jako
`storage/locks/<worktree-id>.lock` i stan właściciela jako
`storage/locks/<worktree-id>.owner.json`; jeden worktree nie wykonuje
współbieżnych zapisów przez różne profile. Drugi zapis do profilu czeka albo kończy się czytelnym błędem; nie tworzy
automatycznie kolejnego katalogu tylko dlatego, że poprzednia kompilacja jeszcze
trwa. Osobna generacja jest uzasadniona zmianą niezgodnego toolchainu/ABI,
izolowaną kwalifikacją albo publikacją runtime’u i wymaga wpisu w rejestrze.

Nie kopiuj `cargo-target`, katalogów CMake/CUDA ani `node_modules` pomiędzy
worktree. Domyślne `CARGO_TARGET_DIR` wskazuje na
`builds/<worktree-id>/<profile-id>/cargo-target`; `FULLMAG_FDM_NATIVE_BUILD_ROOT`
wskazuje na `native-fdm` w tym samym katalogu. Współdziel tylko cache, których format i blokady danego narzędzia to wspierają.
Ścieżki `CARGO_TARGET_DIR`, CMake `-B`, temp CUDA, store pnpm/npm/uv/pip,
cache testów i przeglądarek muszą pochodzić z zaakceptowanego profilu lub
`storage/cache`; brak uprawnień nie tworzy alternatywnego katalogu.

Core runner zapisuje atomowo `build-status.json` w
`builds/<worktree-id>/<profile-id>/`. Rekord zawiera
`schema`, `worktree_id`, `profile`, `repo_root`, `head`, `source_dirty`, `pid`,
`host`, `started_at`, `state`, `executable`, `build_root`, `frontend_root`,
`runtime_root` i `qualification`; po zakończeniu dochodzą `exit_code` oraz
`finished_at`. Jest to ślad operacyjny, a nie pełny dowód kwalifikacji. Pełny
run/qualification manifest powinien dodatkowo zachować requested/resolved
device, precision, backend, komendę, wersje narzędzi, artefakty i logi.
`completed` opisuje ukończoną operację, ale nie jest samo w sobie dowodem
kwalifikacji runtime’u ani parytetu fizyki.

Wynik jawnie wskazany przez użytkownika ma pierwszeństwo i nie może być
automatycznie usunięty ani przeniesiony. Dla zwykłego `fullmag x.py` zachowaj
publiczny kontrakt sąsiedniego `x.zarr`; wyniki eksperymentów agenta kieruj do
`storage/runs/<worktree-id>/...`, używając task/run ID w nazwie podkatalogu i
zapisując ścieżkę w manifeście oraz rejestrze.

## `justfile` jako wejście operacyjne

Przed ręcznym `just ...` odczytaj repozytoryjny `justfile` i wybierz istniejącą
receptę odpowiadającą platformie, backendowi i celowi. `just` jest wspólnym
wejściem dla użytkownika i agenta, więc ręczne uruchomienie nie omija polityki
storage. Recepta build/run/package/install musi:

1. rozwiązać project root, storage root i profil;
2. wykonać preflight absolutnych ścieżek, markera, containment, właściciela,
   blokad i mountów;
3. ustawić ścieżki narzędziowe przed pierwszym `mkdir`, pobraniem lub zapisem;
4. zarejestrować operację i zawsze zapisać stan końcowy.

Jeżeli recepta zawiera jeszcze literalny `.fullmag`, `C:\fullmag-*`, checkout
albo `/tmp` jako miejsce dużych nowych danych, jest to ścieżka legacy do
naprawy. Nie wolno traktować samego wyszukania tekstu, udanego builda ani
wykrycia GPU jako dowodu, że recepta spełnia tę politykę. Dokładne nazwy
poleceń resolvera są opisane w sekcji poniżej; ich obecność w repozytorium nie
dowodzi jeszcze, że każda recepta z nich korzysta.

Dla FEM/MFEM/CUDA/hypre/libCEED domyślną trasą dowodu pozostaje zarządzana,
container-backed recepta `just`. Hostowy `cargo`, `cmake`, Docker lub binarium
może być diagnostyką, lecz nie zastępuje właściwej trasy runtime.

## Resolver i wejścia użytkownika

Docelowe wejścia użytkownika powinny być utrzymywane jako recepty `just`:

```text
just storage-info
just storage-inventory
just worktree-register ...
just worktree-finish ...
```

Jeżeli są obecne, muszą delegować do wspólnego resolvera; ich brak oznacza
**NOT VERIFIED** dla odpowiedniej ścieżki, a nie zgodę na stare katalogi.
Przed użyciem sprawdź ich obecność w bieżącym `justfile`. Resolver udostępnia
również bezpośrednie operacje `resolve`, `validate`, `run`, `register`,
`finish` i read-only `inventory`. Rozwiązanie może zostać wypisane jako JSON
albo shell environment; `run` przyjmuje komendę dopiero po `--` i wykonuje ją
w profilu. `finish` zapisuje stan `review`, `blocked`, `wip` albo `completed`
wraz z powodem/następnym krokiem. Dokładne opcje aliasów `just` pozostają
kontraktem samego `justfile`; nie należy ich odtwarzać ręcznie w każdej
recepcie.

Do jednorazowej diagnostyki resolvera można użyć jego bezpośredniego wejścia,
np. `python scripts/fullmag_storage.py resolve --repo-root . --profile
windows-native --format json`; uruchomienie z `--create` jest operacją zapisu i
wymaga wcześniejszego preflightu oraz rejestracji zadania.

## Windows

Windows ma dwa rozdzielone typy tras:

- natywny Windows/MSVC dla Rust, Python, Control Room, FDM CPU oraz
  Windows/MSVC + CUDA Toolkit dla FDM GPU;
- Docker Desktop Linux engine dla FEM CPU i FEM GPU.

Wszystkie nowe ścieżki tych tras są potomkami
`<project-root>\storage`. Bind mounty Docker wskazują zaakceptowane podkatalogi
storage, a nie checkout; build/cache projektu nie używa przypadkowych named
volumes. Windowsowy launcher FEM nie używa `wsl.exe` jako ukrytego fallbacku.

`FULLMAG_WINDOWS_CACHE_ROOT`, `FULLMAG_WINDOWS_BUILD_ROOT` i
`FULLMAG_WINDOWS_TEMP_ROOT` są nazwami zgodności. Mogą pozostać wejściem do
kontrolowanej migracji lub adaptera tylko po walidacji do kanonicznego storage;
nie są zgodą na tworzenie nowych rootów na początku dysku. Nowe domyślne
wywołanie nie tworzy `C:\fullmag-build`, `C:\fullmag-cache` ani
`C:\fullmag-tmp`.

## Linux

Linuxowy profil hosta (domyślnie `linux-host`) obsługuje natywne narzędzia tam,
gdzie dana recepta tego wymaga. Ciężkie buildy i runtime’y używają
container-backed `just` oraz
zarządzanego storage opartego na ext4. Bezpośredni zapis dużych danych na CIFS
jest odrzucany. Mount view, np. `/mnt/fullmag-zfn2-native`, nie jest storage
rootem i nie może być traktowany jako dowolny katalog projektu.

Backing images dla nowych wdrożeń kieruje się do
`<storage-root>/build-volumes`. Jeżeli kanoniczny obraz nie istnieje, resolver
może jawnie użyć istniejącego obrazu legacy wskazanego przez aktywny profil;
zwraca wtedy `native_storage_legacy=true`. Nie oznacza to migracji ani zgody na
tworzenie kolejnego obrazu. Istniejących aktywnych obrazów ext4 nie wolno
mechanicznie przenosić ani podmieniać w ramach tej polityki; pozostają objęte
osobnym planem migracji. Po restarcie wymagany mount musi zostać odtworzony
przed ciężkim buildem. Brak mountu, zła warstwa filesystemu lub brak zapisu
kończy preflight przed utworzeniem danych zamiast zapisu na CIFS albo zwykłym
`/tmp`.

`/tmp` może zawierać mały, krótkotrwały staging tylko wtedy, gdy wymaga tego
konkretne narzędzie i run ma ślad w rejestrze. Nie jest trwałym rootem Cargo,
CMake, CUDA, FEM ani wyników.

## Zakończenie, odzyskiwanie i sprzątanie

### Cykl integracji zadania

Domyślną decyzją użytkownika dla implementacji w worktree jest doprowadzenie
zmian do `master` przez PR i usunięcie worktree zadania po udanej integracji.
Ta autoryzacja obejmuje commit, push brancha zadania, utworzenie i scalenie PR
oraz usunięcie dokładnie tego worktree po kontrolach poniżej. Audyt, plan i jawne
ograniczenia użytkownika, np. „tylko lokalnie” lub „bez merge”, wyłączają
odpowiednie kroki. Nie obejmuje to starych, obcych worktree, cache ani wyników.

1. Ustal lokalny `master`, główny checkout i istniejący rejestr. Utwórz lub
   wykorzystaj jedno `<project-root>/worktrees/<task-id>` z branchem
   `codex/<task-id>`; zapisz ownera, cel i pełny bazowy commit. Domyślną bazą
   jest `master`, chyba że zadanie wskazuje inną. Nie przejmuj aktywnego worktree.
2. Buduj i testuj z worktree przez właściwe recepty `just`, korzystając z
   resolverowego `storage/builds/<worktree-id>/<profile-id>`. Zachowaj dowody
   testów i wymaganych bramek; wykonaj review zmian przed integracją.
   Po każdym ukończonym, logicznie spójnym i adekwatnie zweryfikowanym etapie
   wykonaj osobny commit na branchu zadania. Nie czekaj do końca całej pracy.
   Commit zawiera powiązany kod, testy i dokumentację; nie rozdzielaj zależnych
   zmian na commity łamiące build lub kontrakt. Przejrzyj staged diff i sprawdź
   listę staged files w osobnym poleceniu przed każdym commitem. Zapisz pełny
   hash oraz dowody w checkpointcie. Dokumentacja wymaga adekwatnej kontroli,
   a nie sztucznego testu; niezmienionych zielonych kontroli nie ponawiaj.
   Commity etapów są objęte autoryzacją zadania i nie oznaczają ukończenia
   integracji ani kwalifikacji runtime. Nie uruchamiają oddzielnego merge.
3. Sprawdź osobno listę staged files i commituj tylko zmiany zadania. Wypchnij
   branch zadania do zweryfikowanego remote. Utwórz PR z bazą `master` albo
   kontynuuj istniejący PR tego samego brancha. Zapisz URL i HEAD PR w rejestrze.
4. Sprawdź wymagane CI, review i branch protection dla aktualnego HEAD PR.
   Napraw błędy i konflikty na branchu zadania, ponów dotknięte kontrole.
   Synchronizacja remote potrzebna do tego cyklu jest autoryzowana; zapisz
   użyty ref. Nie omijaj ochrony ani wymaganej akceptacji. Jeśli wszystko
   wymagane jest spełnione, scal PR metodą dozwoloną przez repozytorium.
5. Potwierdź na remote stan PR `MERGED` oraz wynikowy commit. Zakończ polecenia
   używające worktree i przejdź do głównego checkoutu. Sprawdź jego status;
   wybierz `master`, pobierz aktualny ref i aktualizuj wyłącznie fast-forward.
   Nie resetuj, nie stashuj ani nie commituj cudzych zmian. Jeśli aktualizacja
   koliduje z nimi lub lokalny `master` jest rozbieżny, zapisz blokadę.
   Zdalny merge musi mieć lokalny odpowiednik: potwierdź, że lokalny `HEAD`
   głównego checkoutu wskazuje wynikowy commit `master`. Jeżeli główny checkout
   nie może być użyty, ustaw pierwotny worktree na wynikowy ref dopiero po
   sprawdzeniu jego procesów i mountów. Po merge PR nie wykonuj kolejnego merge
   brancha zadania.
6. Zweryfikuj obecność wyniku PR na `master`, tożsamość źródeł i wymagane
   kontrole integracyjne. Sprawdź brak nowych commitów na branchu zadania od
   HEAD scalonego PR. Przy squash/rebase użyj też dowodu PR i porównania zmian;
   sam brak ancestry nie świadczy o utracie kodu ani o bezpiecznym usunięciu.
7. Przed cleanupem zapisz ścieżki buildów, logów i zachowanych wyników oraz
   stan integracji. Sprawdź dokładną rozwiązaną ścieżkę worktree, status
   obejmujący untracked files, unikalne zmiany, ownership, procesy, kontenery,
   mounty i linki. Z głównego checkoutu wykonaj `git worktree remove` dla
   pojedynczej zweryfikowanej ścieżki, bez `--force`. Zweryfikuj brak wpisu
   w `git worktree list` i brak katalogu. Następnie usuń lokalny branch zadania
   tylko wtedy, gdy wynikowy merge zawiera jego historię i żaden inny worktree
   go nie używa; potwierdź brak lokalnego brancha. Nie kasuj przy tym storage
   ani branchy innych zadań. Jeśli Git odmawia, zachowaj dane i zapisz powód.
8. Zaktualizuj rekord pierwotnego worktree w `storage/index` (nie rekord
   głównego checkoutu): PR, merge commit, stan cleanupu, zachowane zasoby
   i następny krok. Istniejący `worktree-finish` jedynie zapisuje stan;
   nie tworzy PR, nie scala ani nie usuwa worktree. Zachowaj `worktree_id`
   i ścieżkę rekordu przed usunięciem. Raport końcowy zawiera te dowody.

Zadanie jest zakończone po integracji i cleanupie. Przy oczekiwaniu na CI,
review, uprawnienia lub zwolnienie zasobów zachowaj worktree i wpis `review`
albo `blocked`, z przyczyną i konkretnym następnym krokiem. Jawne polecenie
zachowania worktree jest wyjątkiem i musi być zapisane. Nie przedstawiaj
samej gotowości kodu ani PR jako ukończenia pełnego cyklu.

Każde zakończenie worktree, profilu, builda i runu zapisuje stan końcowy,
również po błędzie, anulowaniu lub przerwaniu. Stan musi wskazywać właściciela,
źródła, ścieżki, procesy/kontenery, lease, ostatnią aktywność, powód
pozostawienia i następny krok. Używane rozróżnienia to co najmniej:
`completed`, `ready-for-review`, `failed`, `blocked`, `wip-retained` oraz
`cancelled`/`abandoned` dla operacji przerwanych. Wygasły lease nie daje prawa
do kasowania.

Cleanup zaczyna się od read-only inventory i dry-runu. Dla worktree bieżącego
zadania autoryzację daje powyższy cykl; pozostałe usuwanie wymaga osobnej
autoryzacji dla dokładnych celów. Zawsze wymaga ponownego sprawdzenia dirty files,
unikalnych commitów i zmian, refów, właściciela, aktywnych procesów,
kontenerów, mountów, junctionów/symlinków i containment. Wiek, nazwa katalogu
ani status `prunable` nie są dowodem zbędności. Nie używaj szerokiego wildcardu
na root dysku i nie usuwaj aktywnego obrazu, runtime’u `current`, WIP ani
wyniku naukowego bez zweryfikowanego zakresu.

## Granica egzekwowania i odbiór

Instrukcje repozytorium wyznaczają zachowanie agenta, a wspólny resolver,
preflight, blokady i konfiguracja sandboxa wyznaczają granicę techniczną.
Preflight musi odrzucić przed pierwszym zapisem: root dysku, checkout,
niezatwierdzony env override, ścieżkę legacy, wyjście przez junction/symlink,
obcy marker, kolizję zapisu i brak wymaganego mountu. Rejestracja właściciela
zadania pozostaje regułą workflow; ręczne polecenie nie jest blokowane z powodu
braku takiego wpisu. Domyślny storage otrzymuje marker podczas inicjalizacji;
niestandardowy root musi mieć wcześniej zatwierdzony marker projektu.
Surowe polecenie uruchomione poza wrapperem może ominąć sam wrapper; dlatego
pełna ochrona wymaga kontrolowanych uprawnień i mountów hosta.

Obecność adapterów nie dowodzi działania wszystkich
launcherów, `justfile`, Make, Compose i helperów Linux. Przed oznaczeniem
polityki jako wdrożonej trzeba wykazać przynajmniej: zgodne rozstrzyganie z
worktree na innej głębokości, odmowę legacy/env/junction przed zapisem, reuse
profilu z blokadą, obowiązkowy stan po awarii, Windows Docker Desktop, Linux
ext4/mount guard oraz różnicę inventory przed i po ręcznie uruchomionej recepcie
`just`.
