# Raport: alternatywny trwały storage zarządzanego runtime FEM/CUDA

## Status

Zaimplementowano jawny, opcjonalny wybór trwałego rootu przez jedną zmienną:

```bash
FULLMAG_MANAGED_FEM_STORAGE_ROOT=/mnt/g/git/fullmag
```

Bez tej zmiennej zachowany jest dotychczasowy kontrakt:

| Element | Domyślna ścieżka |
|---|---|
| trwały root | `/zfn2/mateuszz/git/fullmag` |
| obraz ext4 | `/zfn2/mateuszz/git/fullmag/build-volumes/fullmag-native.ext4` |
| mount buildowy | `/mnt/fullmag-zfn2-native` |
| archiwa runtime | `/zfn2/mateuszz/git/fullmag/runtimes` |

Dla `FULLMAG_MANAGED_FEM_STORAGE_ROOT=/mnt/g/git/fullmag` wszystkie ścieżki są
wyliczane przez wspólny helper exportu i restore:

| Element | Alternatywna ścieżka |
|---|---|
| trwały root | `/mnt/g/git/fullmag` |
| obraz ext4 | `/mnt/g/git/fullmag/build-volumes/fullmag-native.ext4` |
| mount buildowy | `/mnt/g/git/fullmag/build-volumes/fullmag-native.mount` |
| archiwa runtime | `/mnt/g/git/fullmag/runtimes` |
| warianty runtime | `<mount>/managed-fem-runtime/<worktree-id>/runtime-variants` |

`/mnt/g` jest filesystemem 9p. Może przechowywać trwały obraz i archiwa, ale
nie jest dopuszczony jako bezpośredni target kompilacji. Export i restore nadal
wymagają ext4 na urządzeniu loop, sprawdzają dokładny backing image przez sysfs,
odrzucają inny filesystem, inne urządzenie, inny obraz, symlink rootu i root
`/`. Export kończy się przed pierwszym wywołaniem Dockera, jeżeli kontrakt nie
jest spełniony.

Jeżeli worktree ma już lokalny alias `fem-gpu-variants` wskazujący dokładnie
wyliczony kanoniczny variants root pod `/mnt/fullmag-zfn2-native`, jawny wybór
alternatywnego storage atomowo przepina ten lokalny alias po zweryfikowaniu
nowego wariantu. Stary variants root i jego dane pozostają nietknięte. Bez
jawnej zmiennej albo dla dowolnego innego celu symlinka operacja nadal kończy
się fail-closed.

## Przygotowanie alternatywnego obrazu

Poniższe polecenia tworzą nowy obraz o rozmiarze 160 GiB. `mkfs.ext4 -F` kasuje
zawartość wskazanego pliku, dlatego wolno użyć go wyłącznie dla nowo utworzonego
`/mnt/g/git/fullmag/build-volumes/fullmag-native.ext4`. Nie wolno wskazywać
istniejącego obrazu spod `/zfn2`.

```powershell
wsl.exe -d Ubuntu2 -u root -- mkdir -p /mnt/g/git/fullmag/build-volumes
wsl.exe -d Ubuntu2 -u root -- truncate -s 160G /mnt/g/git/fullmag/build-volumes/fullmag-native.ext4
wsl.exe -d Ubuntu2 -u root -- mkfs.ext4 -F /mnt/g/git/fullmag/build-volumes/fullmag-native.ext4
wsl.exe -d Ubuntu2 -u root -- mkdir -p /mnt/g/git/fullmag/build-volumes/fullmag-native.mount
wsl.exe -d Ubuntu2 -u root -- mount -o loop,rw,noatime /mnt/g/git/fullmag/build-volumes/fullmag-native.ext4 /mnt/g/git/fullmag/build-volumes/fullmag-native.mount
wsl.exe -d Ubuntu2 -u root -- chown 1000:1000 /mnt/g/git/fullmag/build-volumes/fullmag-native.mount
```

Po restarcie WSL wystarczą trzy ostatnie polecenia dotyczące katalogu mount,
montowania i właściciela. Skrypty drukują te same wyliczone ścieżki przy błędzie
preflight; nie tworzą ani nie formatują obrazu automatycznie.

## Użycie

Nowy build i publikacja archiwum:

```bash
FULLMAG_MANAGED_FEM_STORAGE_ROOT=/mnt/g/git/fullmag just rebuild-fem-runtime
```

Restore lub reuse przez standardową bramkę:

```bash
FULLMAG_MANAGED_FEM_STORAGE_ROOT=/mnt/g/git/fullmag just ensure-managed-fem-runtime
```

Ta sama zmienna musi być obecna przy późniejszym restore/reuse, aby skrypt nie
wrócił do domyślnego archiwum i mountu `/zfn2`.

## Testy i dowody

Cykl test-first został wykonany. Nowe testy najpierw failowały z brakiem
`resolve_managed_fem_runtime_storage_layout` i z ignorowaniem alternatywnego
rootu. Po implementacji:

```text
python3 -m pytest -q \
  scripts/test_managed_fem_runtime_target_mount.py \
  scripts/test_managed_fem_runtime_storage.py \
  scripts/test_restore_persistent_fem_runtime.py \
  scripts/test_export_fem_gpu_runtime_copy_helpers.py

93 passed in 6.72s
```

Dodatkowo przeszły:

```text
bash -n scripts/lib/managed_fem_runtime_storage.sh \
  scripts/export_fem_gpu_runtime.sh \
  scripts/restore_persistent_fem_runtime.sh

git diff --check
```

Testy obejmują domyślny root, alternatywne wyliczanie image/mount/archive,
odrzucenie ścieżki względnej, `/` i symlinków, fail-closed dla 9p przed Dockerem,
odrzucenie złego loop backing image oraz pełny restore/repair wariantu.
Obejmują też migrację lokalnego aliasu canonical → alternate, zachowanie starego
storage i odrzucenie takiego retargetu w trybie domyślnym.

## Aktualny blocker runtime

Na moment raportu `/mnt/g/git/fullmag` istnieje i ma wolne miejsce, ale nie ma
jeszcze obrazu:

```text
/mnt/g/git/fullmag/build-volumes/fullmag-native.ext4
```

Świeży managed preflight:

```bash
FULLMAG_MANAGED_FEM_STORAGE_ROOT=/mnt/g/git/fullmag just rebuild-fem-runtime
```

zakończył się kodem `2` przed Dockerem z komunikatem `expected a regular ext4
backing image`. Dlatego implementacja i kontrakty są zweryfikowane, natomiast
świeży build CUDA oraz publikacja runtime pozostają zablokowane do utworzenia i
zamontowania nowego obrazu ext4. Istniejące dane i obraz pod `/zfn2` nie zostały
przeniesione, usunięte ani zmodyfikowane.

## Uzupełnienie po review bezpieczeństwa

Druga runda review wykazała dwie luki kontraktu. Zostały zamknięte test-first:

1. Alternate root nie może już wskazywać dowolnego katalogu absolutnego.
   Dozwolony jest wyłącznie niezmieniony canonical
   `/zfn2/mateuszz/git/fullmag` albo jawny podkatalog bezpośredniego host mountu
   `/mnt/<mount>/...`. Dla alternate resolver odczytuje przez `findmnt` target,
   typ filesystemu i opcje; dopuszcza tylko `9p` lub `drvfs` z opcją `rw`.
   `/tmp`, checkout/worktree, `/`, ścieżki względne, read-only 9p i inne
   filesystemy są odrzucane przed utworzeniem katalogu i przed Dockerem.
2. `just ensure-managed-fem-runtime` uruchamia teraz
   `scripts/prepare_managed_fem_runtime_storage.sh` przed obliczeniem source
   identity i przed pierwszym `validate_current`. Przy jawnie wybranym storage
   preflight wymaga obrazu, poprawnego ext4 loop mountu i dokładnego backing
   image, a następnie porównuje lokalny `fem-gpu-variants` z wybranym rootem.
   Wyłącznie dokładnie rozpoznany canonical alias może zostać atomowo
   przepięty na alternate; inny alias lub zwykły katalog kończy się fail-closed.

Świeża rozszerzona bramka po poprawkach:

```text
python3 -m pytest -q \
  scripts/test_managed_fem_runtime_target_mount.py \
  scripts/test_managed_fem_runtime_storage.py \
  scripts/test_restore_persistent_fem_runtime.py \
  scripts/test_export_fem_gpu_runtime_copy_helpers.py

100 passed in 7.33s
```

Testy dodane w tej rundzie najpierw wykazały, że `/tmp`, checkout, xfs i
read-only 9p błędnie przechodziły resolver oraz że `ensure` nie miało preflightu.
Po implementacji obejmują również kolejność preflight → source identity →
`validate_current`, canonical alias → alternate selection, odmowę nieznanego
aliasu oraz brak obrazu lub ext4 mountu bez zmiany lokalnego aliasu.

Stan zewnętrzny `/mnt/g` zmienił się podczas tej rundy: istnieje już nowy obraz
`/mnt/g/git/fullmag/build-volumes/fullmag-native.ext4` o rozmiarze 256 GiB.
Próby odczytu `findmnt` i `ls` dla
`/mnt/g/git/fullmag/build-volumes/fullmag-native.mount` zostały ograniczone
timeoutem i nie zwróciły wyniku, więc mount nie jest jeszcze dowodem poprawnego
ext4/loop/backing ani podstawą do uruchomienia builda CUDA. Poprzednia informacja
o braku obrazu jest historycznym wynikiem pierwszego preflightu; bieżącym
blockerem jest brak świeżo potwierdzonego, dostępnego mountu.

## Korekta po re-review atomowości transition

Kolejny review wykazał, że pierwszy wariant preflightu przepinał lokalny alias
`fem-gpu-variants` natychmiast po walidacji alternate mountu, zanim alternate
zawierał zweryfikowany wariant. Przy braku archiwum i późniejszej porażce
builda aktywny `fem-gpu-host` mógł przez to stać się dangling. Poprzednie
stwierdzenie o przepięciu aliasu w `prepare_managed_fem_runtime_storage.sh`
jest więc historyczne i zostaje zastąpione następującym kontraktem:

- `prepare_managed_fem_runtime_storage.sh` jest read-only względem lokalnych
  aliasów; waliduje root, obraz, ext4/loop/backing i zwraca wyłącznie status
  `ready` albo `transition-required`,
- `ensure-managed-fem-runtime` konsumuje status przed `validate_current`;
  `transition-required` nie pozwala zaakceptować starego canonical runtime,
  tylko wymusza próbę restore, a po jej porażce rebuild,
- restore i export pozostają jedynymi ścieżkami retargetu; oba przepinają
  `fem-gpu-variants`, a następnie `fem-gpu-host`, dopiero po walidacji staged
  albo nowego wariantu, a export także po walidacji trwałego archiwum,
- porażka restore lub builda nie zmienia żadnego z lokalnych aliasów.

Nowy test regresyjny uruchamia rzeczywistą receptę `ensure` w izolowanym
repozytorium: canonical runtime jest wykonywalny, alternate ma poprawne
metadane ext4/loop/backing, brakuje archiwum, restore failuje, a stub builda
jest wywołany i również failuje. Po obu porażkach oba aliasy nadal wskazują
canonical storage, a launcher nadal zwraca sukces.

Świeża bramka po tej korekcie:

```text
python3 -m pytest -q \
  scripts/test_managed_fem_runtime_target_mount.py \
  scripts/test_managed_fem_runtime_storage.py \
  scripts/test_restore_persistent_fem_runtime.py \
  scripts/test_export_fem_gpu_runtime_copy_helpers.py

101 passed in 7.62s
```

Dodatkowo przeszły `bash -n` czterech skryptów storage/export/restore/prepare,
`git diff --check`, `just --dry-run ensure-managed-fem-runtime` oraz
`just --dry-run rebuild-fem-runtime`. Skrypt prepare zachowuje tryb `100755`.
Nie wykonano świeżego buildu CUDA: zewnętrzny mount alternate ext4 nadal nie
ma świeżego, nieblokującego potwierdzenia.
