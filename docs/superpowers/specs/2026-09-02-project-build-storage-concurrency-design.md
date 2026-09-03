# Zarządzanie buildami projektu i równoległością — specyfikacja

- Status: draft po korekcie granicy storage przez użytkownika, przed przeglądem specyfikacji
- Data: 2026-09-02
- Zakres: storage buildów, cache, runtime’ów i artefaktów uruchomień dla Windows i Linux
- Checkout referencyjny: `C:\git\fullmag\fullmag`

## Cel

Wprowadzić jeden, wymuszany model przechowywania buildów Fullmag, który pozwala
na wiele równoległych sesji Codexa, worktree i buildów bez kolizji, płaskich
katalogów na głównym poziomie dysku ani współdzielenia mutowalnego `target/`.

Dla obecnego checkoutu katalogiem projektu jest nadrzędny katalog repozytorium:

```text
repo root:       C:\git\fullmag\fullmag
project root:    C:\git\fullmag
storage root:    C:\git\fullmag\storage
```

Linux zachowuje obecny trwały root zarządzanego runnera, ale przyjmuje ten sam
układ logiczny:

```text
repo root:       /zfn2/mateuszz/git/fullmag/fullmag
project root:    /zfn2/mateuszz/git/fullmag
storage root:    /zfn2/mateuszz/git/fullmag/storage
```

`storage root` pozostaje konfigurowalny w przyszłości. Zmiana dysku nie zmienia
układu, identyfikacji ani zasad współbieżności. Domyślna lokalizacja jest
jednym katalogiem `storage` pod katalogiem projektu, dzięki czemu cała
generowana zawartość jest widoczna w jednym miejscu i może być resetowana jako
jedna, jawnie zweryfikowana granica.

## Problem i dowody wejściowe

Obecny Windows launcher domyślnie wyprowadza trzy płaskie katalogi z rootu
dysku zawierającego checkout:

```text
<drive>:\fullmag-build
<drive>:\fullmag-cache
<drive>:\fullmag-tmp
```

Jest to opisane w `AGENTS.md`, `docs/guides/windows-first-development.md` oraz
zaimplementowane w `scripts/windows/run_fullmag_wsl.ps1`. Reguła chroni checkout,
ale nie izoluje projektu, worktree ani pojedynczej sesji. Co więcej, wszystkie
buildy Fullmag są rozproszone bez wspólnej granicy projektu, więc nie da się
bezpiecznie rozpoznać, co należy do tego projektu i co można wyzerować.

Pomiar wykonany 2026-09-02 dla C: wykazał:

| Katalog | Rozmiar logiczny |
|---|---:|
| `C:\fullmag-build` | około 193,4 GB |
| `C:\fullmag-cache` | około 53,2 GB |
| `C:\fullmag-tmp` | około 0,8 GB |
| Razem | około 247,4 GB |

Na C: pozostawało około 63,7 GB wolnego miejsca. Docker Desktop pokazywał
wiele zatrzymanych kontenerów Fullmag oraz aktywny BuildKit; `docker system df`
nie mogło zostać odczytane, ponieważ daemon Docker nie odpowiadał. Te fakty
uzasadniają zmianę polityki, ale nie uprawniają do automatycznego kasowania
istniejących danych.

## Założenia i niezmienniki

1. Checkout zawiera kod i małe, jawne artefakty repozytoryjne; nie jest
   magazynem Cargo, CMake, CUDA, pnpm, Docker ani dużych wyników.
2. Każdy aktywny build ma własny katalog roboczy i własny `target`/native tree.
3. Cache może być współdzielony tylko wtedy, gdy jego format i blokady są
   bezpieczne dla współbieżności; mutowalne wyniki builda nie są współdzielone.
4. Build jest identyfikowany przez źródła, worktree, platformę, backend,
   urządzenie, precision i komendę, a nie przez przypadkową nazwę procesu.
5. Niedokończony lub niezweryfikowany build nie może stać się aktywnym runtime’em.
6. Awaria kandydata zachowuje poprzedni aktywny runtime i jego manifest.
7. Windows i Linux mają ten sam model logiczny; różnią się tylko resolverem
   ścieżek i wymaganiami filesystemu.
8. Żaden domyślny fallback nie może wskazać rootu dysku, checkoutu ani jednego
   wspólnego katalogu `target`.
9. Czyszczenie jest jawne, raportowane i domyślnie wykonywane jako dry-run.
10. Aktywne procesy, kontenery, lease’y i runtime wskazywany przez `current`
    są chronione przed usunięciem.

## Kanoniczny układ storage

Każdy projekt ma jeden `storage root`. Poniższy układ jest wspólny dla Windows
i Linux; separator ścieżki zależy od platformy.

```text
<project-root>/storage/
  builds/
    <UTC-date>/
      <worktree-id>/
        build_001/
          manifest.json
          status.json
          logs/
          cargo-target/
          native/
          staging/
        build_002/
  cache/
    cargo/<toolchain>/<cache-key>/
    cmake/<toolchain>/<cache-key>/
    cuda/<toolchain>/<cache-key>/
    pnpm/<lockfile-key>/
    python/<environment-key>/
    buildkit/<builder-key>/
  runtimes/
    <backend>/<device>/<source-or-manifest-hash>/
      manifest.json
      bin/
      lib/
    current/<backend>/<device>
  runs/
    <UTC-date>/
      <worktree-id>/
        <run-id>/
          command.json
          runtime-manifest.json
          logs/
          artifacts/
  locks/
    <project-id>.allocation.lock
    <project-id>.publication.lock
    <project-id>.<resource>.lease
  index/
    builds.jsonl
    runtimes.jsonl
```

### Rozdział buildów, cache, runtime’ów i wyników

- `builds` zawiera konkretne próby kompilacji, w tym nieudane i przerwane,
  dzięki czemu log i przyczyna awarii nie są nadpisywane.
- `cache` zawiera dane możliwe do ponownego użycia. Klucz cache nie może być
  używany jako ścieżka do mutowalnego `target` konkretnego builda.
- `runtimes` zawiera tylko zweryfikowane, hash-addressed runtime’y. Alias
  `current` jest przełączany atomowo po walidacji.
- `runs` zawiera artefakty naukowego uruchomienia i nie jest mieszany z buildem.
- `locks` i `index` są metadanymi koordynacji; nie zawierają dużych binariów.

Linuxowe `build-volumes/` pozostaje infrastrukturą ext4/managed Docker dla
ciężkich buildów, a nie publicznym katalogiem prób buildów. Konkretna próba
otrzymuje identyfikowalny podkatalog w `builds`; bezpośredni build na CIFS jest
nadal zabroniony.

Wszystkie wymienione katalogi są potomkami jednego `storage root`. Nie tworzy
się równoległych `fullmag-build`, `fullmag-cache`, `fullmag-tmp`, `builds` lub
`cache` w rootach dysków, repozytorium albo przypadkowych katalogach
tymczasowych.

## Identyfikacja projektu, worktree i builda

### Project root i storage root

Resolver działa w tej kolejności:

1. jawne `FULLMAG_PROJECT_STORAGE_ROOT`, jeśli jest absolutne, istnieje lub
   może zostać utworzone i przechodzi walidację;
2. root projektu wyprowadzony z git common directory, tak aby główny checkout
   i jego worktree używały tego samego storage projektu, a następnie dołączone
   `storage`;
3. brak bezpiecznego wyniku kończy działanie z błędem — nie ma fallbacku do
   rootu dysku ani do checkoutu.

Dla obecnego checkoutu domyślny wynik musi być `C:\git\fullmag\storage`. Dla
dedykowanego Linux runnera musi być `/zfn2/mateuszz/git/fullmag/storage`.

`project root` i `storage root` są różnymi pojęciami: pierwszy wskazuje
organizację projektu, drugi jest jedyną granicą generowanych danych. Checkout
`C:\git\fullmag\fullmag` nigdy nie jest storage rootem.

Istniejące `FULLMAG_WINDOWS_BUILD_ROOT`, `FULLMAG_WINDOWS_CACHE_ROOT`,
`FULLMAG_WINDOWS_TEMP_ROOT` oraz linuxowe `FULLMAG_BUILD_ROOT` są traktowane
przejściowo jako kompatybilność. Nowa polityka nie może pozwolić, by wskazywały
bezpośrednio root dysku, checkout albo wspólny płaski katalog builda. Jeżeli
pozostają ustawione, resolver musi jawnie oznaczyć je jako legacy i odrzucić
ich użycie do nowego builda, chyba że wywołanie migracji wskazuje konkretny
stary katalog. Ich
ostateczne wycofanie nastąpi dopiero po migracji i aktualizacji wszystkich
zarządzanych recept.

### Granica Git

`C:\git\fullmag\storage` jest poza drzewem repozytorium Git. Dlatego wpis
`../storage` w `C:\git\fullmag\fullmag\.gitignore` nie jest mechanizmem
ochrony — Git nie ignoruje plików poza własnym worktree. Nie dodajemy takiego
pozornego wpisu. Ochronę zapewniają: resolver ścieżki, marker storage,
manifesty, test `storage root` oraz operacje prune/reset ograniczone do jednej
wcześniej rozwiązanej ścieżki.

Jeżeli w przyszłości storage zostanie umieszczony wewnątrz checkoutu, będzie to
osobna decyzja migracyjna i dopiero wtedy można dodać `/storage/` do
`.gitignore`. Ten projekt pozostaje przy storage obok repozytorium.

### Worktree id

`worktree-id` składa się z bezpiecznej nazwy worktree oraz krótkiego, stabilnego
hasha kanonicznej ścieżki worktree. Nazwa jest tylko etykietą; hash zapobiega
kolizji dwóch worktree o tej samej nazwie. Identyfikator nie jest oparty
wyłącznie na commicie, ponieważ kolejne commity w tym samym worktree muszą
otrzymać osobne manifesty, ale mogą zachować wspólną tożsamość worktree.

### Build id

Allocator rezerwuje `build_001`, `build_002`, ... pod datą UTC i konkretnym
worktree. Numer jest przydzielany atomowo pod `allocation.lock`; nie wolno go
wyliczać przez niezabezpieczone `ls`/`find`, ponieważ dwie sesje mogłyby wybrać
ten sam numer.

Po rezerwacji powstaje `status.json` ze stanem `allocated` oraz lease’em
zawierającym PID, host, platformę, start UTC, worktree, źródłowy snapshot i
komendę. Stany końcowe to `completed`, `failed`, `cancelled` albo `abandoned`.

## Protokół równoległości

### Dwa worktree

Różne worktree mogą budować równolegle. Każdy otrzymuje własny `worktree-id`,
`build_N`, Cargo target i native tree. Mogą korzystać ze wspólnego cache tylko
przez mechanizm bezpieczny dla danego narzędzia.

### Ten sam worktree

Równoległe procesy tego samego worktree również otrzymują różne `build_N`.
Żaden proces nie może użyć istniejącego `build_N` jako współdzielonego katalogu
roboczego ani nadpisać jego manifestu. Snapshot źródeł jest zapisywany przed
kompilacją, a zmiana źródeł w trakcie builda powoduje niekwalifikowanie lub
fail-closed zgodnie z istniejącą polityką source identity.

### Cache

Cache ma klucz narzędzia, toolchainu, platformy i wejść. Cache nie może
przechowywać ścieżek zależnych od przypadkowego checkoutu jako jedynego
identyfikatora. Współbieżny zapis używa natywnego mechanizmu blokady narzędzia
albo osobnego stagingu i atomowego publish.

Cargo `target`, CMake `native`, CUDA compilation outputs i podobne wyniki są
zawsze per-build. Registry Cargo, pnpm store, pobrane toolchainy i cache
kompilatora mogą być współdzielone, ale nie mogą zmienić manifestu ukończonego
builda.

### Publikacja runtime’u

Kompilacja i publikacja to dwie różne sekcje krytyczne:

1. build pracuje bez globalnego locka publikacji;
2. walidacja kandydata sprawdza binaria, biblioteki, manifest, source identity,
   platformę, backend i urządzenie;
3. pod `publication.lock` tworzony jest hash-addressed runtime;
4. alias `current` jest wymieniany atomowo;
5. stary runtime pozostaje dostępny do rollbacku.

Żaden proces nie może wskazać na katalog `staging` jako aktywny runtime.

### GPU i inne zasoby wykonawcze

Izolacja ścieżek nie rozwiązuje konfliktu o GPU. Uruchomienia wymagające tej
samej karty używają osobnego lease’a zasobu. Wymuszony `gpu` kończy się błędem,
jeżeli lease lub wymaganie runtime nie może zostać spełnione; nie ma cichego
fallbacku do CPU.

## Manifest i audyt

Każdy `build_N/manifest.json` musi zawierać co najmniej:

- schema manifestu;
- `project_id`, `worktree_id`, `build_id` i absolutny `storage_root`;
- platformę i host;
- repo root oraz kanoniczny worktree path;
- pełny commit i source snapshot hash;
- backend, urządzenie, precision i feature flags;
- dokładną komendę oraz wersje narzędzi;
- ścieżki `cargo_target`, `native`, cache i logu;
- start, koniec i status UTC;
- hash binariów i runtime manifestu, jeśli build został opublikowany.

`status.json` jest aktualizowany atomowo. `index/builds.jsonl` może być
indeksem pomocniczym, ale nigdy nie zastępuje manifestu w katalogu builda.

## Zasady platformowe

### Windows

- Domyślny storage to `C:\git\fullmag\storage` dla bieżącego projektu.
- `C:\fullmag-build`, `C:\fullmag-cache` i `C:\fullmag-tmp` stają się
  katalogami legacy; nowe launchery nie mogą ich samodzielnie tworzyć.
- Bind mounty Docker wskazują wyłącznie na podkatalogi
  `C:\git\fullmag\storage`.
- Cargo, Rustup, pnpm, npm, uv, pip, CUDA i Playwright otrzymują ścieżki
  wyprowadzone z `cache` lub `builds/<date>/<worktree>/build_N`.
- Launcher odrzuca root dysku, checkout, ścieżki względne oraz ścieżki
  przeznaczone dla innego projektu.
- Windows FEM nadal korzysta z Docker Desktop Linux engine i kanonicznego
  launchera; nie używa `wsl.exe` jako ukrytego fallbacku.

### Linux

- Domyślny trwały storage to `/zfn2/mateuszz/git/fullmag/storage`.
- Ciężkie buildy używają ext4-backed storage albo dedykowanego managed Docker
  volume; bezpośredni CIFS jest odrzucany.
- Każdy managed `just` recipe dostaje identyfikowalny build root, a nie wspólny
  `.fullmag/target` ani przypadkowy `/tmp` dla dużych danych.
- `/tmp` może zawierać tylko małe, krótkotrwałe stagingi, gdy kontrakt narzędzia
  tego wymaga; nie jest trwałym rootem buildów.
- Restart Linux/WSL musi odtwarzać wymagane mounty ext4 przed ciężkim buildem;
  brak mountu kończy preflight, zamiast zapisywać na CIFS.

## Retencja i migracja

### Bezpieczne czyszczenie

Prune działa dwuetapowo:

1. raport dry-run pokazuje kandydatów, rozmiary, wiek, status, lease i powód
   kwalifikacji;
2. osobne jawne wykonanie usuwa wyłącznie zatwierdzone kategorie.

Domyślnie chronione są: aktywne lease’y, buildy z aktywnym procesem lub
kontenerem, `current`, runtime’y używane przez manifest uruchomienia, ostatnie
zweryfikowane runtime’y oraz buildy młodsze niż retencja. Buildy `failed` i
`cancelled` zachowują logi do czasu jawnego prune.

Żadne polecenie migracji/prune nie może używać szerokiego wildcardu na root
dysku. Każdy cel jest wcześniej rozwiązany do absolutnej ścieżki i sprawdzany,
czy pozostaje pod dozwolonym storage root.

### Migracja istniejącego bałaganu

Pierwszy etap nie usuwa `C:\fullmag-build`, `C:\fullmag-cache`,
`C:\fullmag-tmp` ani istniejących obrazów Docker. Powstaje read-only inventory
z mapowaniem starej ścieżki, rozmiaru, ostatniego użycia, właściciela i statusu
procesu/kontenera.

Dopiero po osobnym przeglądzie migracja może:

- przenieść nieaktywne buildy do `storage/builds/legacy/<date>/<legacy-id>/`;
- zachować manifest i log migracji;
- oznaczyć dane jako `legacy-migrated`;
- usunąć źródło dopiero po weryfikacji kopii i osobnej zgodzie.

Aktywny FDM build oraz aktywne Docker/BuildKit runtime’y nie są przenoszone
ani usuwane podczas migracji.

## Zakres wdrożenia

Po akceptacji tej specyfikacji implementacja ma objąć:

1. dokumentację `AGENTS.md` i przewodnik Windows/Linux;
2. wspólny kontrakt layoutu oraz resolver Windows/Linux;
3. atomowy allocator `build_N`, lease i manifest;
4. aktualizację `scripts/windows/run_fullmag.ps1`,
   `scripts/windows/run_fullmag_fem.ps1`,
   `scripts/windows/run_fullmag_wsl.ps1`, `justfile`, `Makefile` oraz
   managed storage helpers;
5. zachowanie kompatybilności z obecnym runtime’em przez jawny etap migracji;
6. testy ścieżek, kolizji równoległych allocatorów, blokad rootów, lease’ów,
   source identity i atomowej publikacji;
7. read-only inventory istniejących katalogów i Docker storage przed każdym
   etapem przenoszenia lub usuwania.

Nie obejmuje to automatycznego kasowania obecnych danych ani zmiany fizyki,
mesha, solvera, ProblemIR, API ani wyników naukowych.

## Kryteria akceptacji

Projekt jest wdrożony dopiero, gdy:

1. dwa równoległe buildy tego samego worktree otrzymują różne `build_N`;
2. dwa worktree nie współdzielą `cargo-target` ani `native`;
3. launcher odrzuca root dysku, checkout i legacy flat roots;
4. ścieżki Windows i Linux są przewidywalne z samego manifestu;
5. przerwany build nie zostawia fałszywego `completed` ani aktywnego runtime’u;
6. publikacja runtime’u jest atomowa i zachowuje poprzedni alias po awarii;
7. cache może być współdzielony tylko w kontraktowo bezpiecznej formie;
8. dry-run cleanup pokazuje rozmiar i powód każdego kandydata;
9. istniejące launchery `just` i Windows używają nowego resolvera;
10. testy kontraktowe i parsery obu platform przechodzą bez naruszenia
    niezależnych, już istniejących zmian w worktree.

## Ryzyka i ograniczenia

- Domyślna lokalizacja nadal znajduje się na C:, więc zmiana układu nie zwiększa
  dostępnego miejsca; potrzebna jest późniejsza retencja lub migracja na inny
  dysk.
- Wspólny BuildKit cache może być przechowywany przez Docker Desktop poza tym
  drzewem; jego inwentaryzacja wymaga działającego daemonu Docker.
- Worktree utworzone poza standardową strukturą wymagają jawnego
  `FULLMAG_PROJECT_STORAGE_ROOT`, jeśli resolver nie potrafi bezpiecznie ustalić
  nadrzędnego projektu.
- Zmiana istniejących launcherów może dotknąć bieżących niezatwierdzonych zmian;
  implementacja musi ograniczyć diff do resolvera, ścieżek i testów oraz nie
  może resetować ani commitować wspólnego worktree.

## Odrzucone warianty

### Tylko dokumentacja

Odrzucone jako rozwiązanie docelowe. Nie zapobiega tworzeniu nowych katalogów
`C:\fullmag-build` przez launcher ani kolizjom równoległych procesów.

### Jeden globalny target/cache dla projektu

Odrzucone. Minimalizuje miejsce, ale pozwala równoległym buildom nadpisywać
mutowalne wyniki i niszczy reprodukowalność.

### Tylko katalogi tymczasowe per proces

Odrzucone jako domyślny model. Izoluje procesy, ale utrudnia audyt, rollback,
reprodukcję i kontrolowane wykorzystanie ukończonych runtime’ów.
