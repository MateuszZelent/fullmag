---
name: fullmag-docker-build
description: "Build or rebuild Fullmag from a selected checkout in its Docker Compose development group, with build data confined to persistent Docker volumes. Use for fresh-host builds, backend rebuilds and package cache-hit restarts, frontend HMR, and build disk-usage or retention checks."
---

# Fullmag — build DEV w wolumenach Docker

Wynik: jedna grupa `fullmag-master` albo `fullmag-worktree-<worktree-id>`, dwie
stałe usługi aplikacji, jeden wybrany readonly checkout i trwałe prywatne oraz
współdzielone dane zgodnie z ich retencją. Aplikację buduje i uruchamia ten sam `backend`; Next/HMR działa w
`frontend`. Zależności obrazu przygotowuje Compose/BuildKit dla tej samej grupy.

## Granica danych ustalona przez użytkownika

- **Dane budowania wyłącznie w Dockerze:** zależności, Cargo/CMake/pnpm/Next,
  cień źródeł, kandydaci/pakiety, staging, wygenerowane konteksty, logi i receipty
  builda. Używaj jawnych trwałych named volumes oraz magazynu obrazów/BuildKit.
  Hostowe `storage`, checkout i duże hostowe katalogi tymczasowe nie są
  alternatywnym miejscem zapisu tych danych.
- **Dane użytkownika nadal na hoście:** sesje, wyniki, projekty, ustawienia i
  historia ostatnich projektów. Zachowaj ich dotychczasowy kontrakt/mounty;
  polecenie dotyczące builda nie autoryzuje przeniesienia ich do Dockera.
  Windows używa `windows-folder-v1`, Linux/WSL `linux-native-v1` na lokalnym
  ext4/xfs/btrfs; oba profile mają osobne dowody storage. WSL używa bieżącego
  endpointu Docker, a Windows contextu `desktop-linux`. Szczegóły i granice:
  [ADR 0064](../../../docs/adr/0064-docker-development-linux-wsl-host.md).
- Współdzielone cache zależności i pakiet current/rollback zachowują własną
  retencję; prywatne compiler outputs podlegają ADR 0076. Usunięcie kontenera
  nie usuwa named volumes ani obrazów/BuildKit.
  Wycofanie build-data grupy wymaga osobnej, precyzyjnej operacji.
  Wolumen nie jest quota ani gwarancją braku wzrostu: wymagane są pomiary,
  kontrola generacji i bezpieczna retencja.

## Jeden prywatny volume grupy Docker DEV

Daily DEV ma dokładnie jeden prywatny named volume na worktree/grupę Compose:
istniejący, stabilnie nazwany `BuildControl.volume`. Nazwa nie zależy od
toolchaina, profilu, dependency hash ani próby. Root zachowuje dotychczasowy
control/lock/namespace; prywatne dane używają subpaths `private/backend`,
`private/frontend` i `private/ledger`. Frontend montuje wyłącznie swój subpath,
bez rootu control, backendu i ledgeru. Shared Cargo/pnpm/packages oraz obrazy i
BuildKit pozostają współdzielone poza prywatnym volume. Fingerprint ABI/toolchain
nadal warunkuje zgodność cache, nie tożsamość volume. Compiler outputs, cache-hit,
failed generation i retencję pakietu opisuje sekcja 7 ADR 0076.
Migracja dotyczy jednej zatrzymanej/drained grupy naraz; stare wolumeny zostają
do archiwizacji i kontroli referencji. Ten kontrakt nie potwierdza implementacji:
Compose, launcher, mounty i runtime pozostają **NOT VERIFIED** do sprawdzenia.
Szczegóły i zakres supersession: [ADR 0076](../../../docs/adr/0076-single-private-volume-per-dev-group.md).

## Lokalizacja nowych obrazów ext4 na tym hoście

Decyzja użytkownika z 24.10.2026: nowe pliki obrazów ext4 (backing images)
mają powstawać w `E:\git\storage` (WSL: `/mnt/e/git/storage`), zamiast
w `storage/build-volumes` projektu. Jest to lokalizacja plików obrazów,
nie mount linuksowego filesystemu ani zmiana storage danych użytkownika.
Nie zmienia to obowiązku named volumes/BuildKit dla danych buildu Docker DEV.
Przed utworzeniem obrazu sprawdź, czy właściwy launcher/resolver obsługuje
wybraną lokalizację. Brak obsługi oznacza `NOT VERIFIED`; nie twórz obrazu
w starej lokalizacji jako fallbacku. Ta instrukcja nie zmienia konfiguracji
Dockera/WSL ani nie przenosi istniejących obrazów. Ich migracja wymaga
osobnego planu i kontroli właścicieli, procesów oraz mountów.
Historyczne ścieżki w audycie writerów opisują wcześniejszy stan kodu,
a nie obowiązujące miejsce tworzenia nowych obrazów.

## Dobierz instrukcje do zadania

Przed uruchomieniem Docker DEV przeczytaj główny [AGENTS.md](../../../AGENTS.md),
[reguły backendu](../../instructions/backend.md), [justfile](../../../justfile)
oraz [procedurę od zera](references/procedure.md). Rutynowy start lub restart
nie wymaga ładowania pełnego audytu 612 recept.

- Nowy klon/host: wykonaj konfigurację hosta z procedury, a następnie jej
  --check.
- Retencja, pomiar miejsca lub plan sprzątania: użyj kontraktu danych builda
  i bieżącej części inwentarza writerów.
- Zmiana komendy, resolvera, launchera lub recepty: przejrzyj audyt recept,
  inwentarz writerów i aktualny kod. Porównaj hashe wejść; zmiana wrappera lub
  resolvera wymaga ponownej oceny także recept, których treść się nie zmieniła.
- Pełny audyt zapisów: przejrzyj wszystkie sekcje inwentarza writerów i
  kontraktu danych builda.

Historia z pierwszego audytu 18.10.2026 opisuje problemy bazowe, które później
migrowano. Nie traktuj jej jako opisu aktualnego Docker DEV ani jako polecenia
wstrzymania bieżącej recepty. Bieżącą granicę opisuje sekcja Aktualny daily
live-shadow-v1 w inwentarzu writerów; mounty i zapis launchera nadal trzeba
sprawdzić, jeśli źródła się zmieniły.

## Granica danych i retencja

Polityka zachowuje bieżący pakiet i jeden zweryfikowany rollback do udanej
publikacji nowego pakietu; nie usuwa ostatniego dobrego pakietu przed kompilacją.
Cache backendu i frontendu wolno inwalidować wyłącznie w ich subpaths pod
blokadą. `worktree-finish ... completed` może wykonać kwalifikowaną retencję
dokładnego cache grupy i jej namespace pakietów; zachowuje root control,
`private/ledger`, shared Cargo/pnpm i dane użytkownika. Nie usuwa całego
`BuildControl.volume` jako skutku zwykłego cache cleanup. Aktualna implementacja
automatycznej retencji i jednego volume pozostaje **NOT VERIFIED**. Szczegóły:
[kontrakt retencji](../../../docs/guides/shared-build-storage.md) i
[ADR 0076](../../../docs/adr/0076-single-private-volume-per-dev-group.md).

Buildowe zależności, cache Cargo/CMake/pnpm/Next, pakiety, logi i techniczne
receipty aktywnej trasy są przypięte do named volumes grupy lub magazynu
BuildKit. Nie zapisuj ich do storage Windows. Hostowe storage zachowuje
jawne dane użytkownika oraz małe, wymagane handoffy runtime, rejestry/locki i
dowody przyjęcia storage; nie są one cache ani artefaktami buildu. Krótkotrwałe
pliki Compose w systemowym temp nie mogą zawierać źródeł, pakietów ani cache.

Named volumes, obrazy i BuildKit przeżywają usunięcie kontenera. Obecna ścieżka
nie ma ogólnego GC ani quota dla tych zasobów, więc wolumeny ograniczają miejsce
zapisu, ale same nie gwarantują ograniczonego zużycia dysku. Nie deklaruj
pełnej kontroli retencji, dopóki brakujący mechanizm nie zostanie wdrożony i
zweryfikowany. Nie używaj globalnego prune ani compose down -v.

## Kontrakt trasy DEV i status wdrożenia

Codzienne wejścia pozostają `docker-dev-toolchain`, `docker-dev-images`,
`docker-dev` i `docker-dev-build` przez launchery w `scripts/`. Wymagana
topologia jest opisana w [ADR 0076](../../../docs/adr/0076-single-private-volume-per-dev-group.md)
i [przewodniku DEV](../../../docs/guides/docker-volume-development.md).
Historyczny audyt writerów zachowuje swoje dowody, ale nie opisuje nowego
kontraktu. Dopóki kod, Compose, mounty oraz receipts nie potwierdzą tej topologii
w zarządzanym runtime, oznacz implementację jako **NOT VERIFIED**. Nie przenoś
wyników release/CI/nauki na DEV ani odwrotnie.

## Wykonanie i dowody

1. Ustal checkout, grupę, profil, wolumeny i stan istniejących konsumentów.
   Ten sam checkout musi być wybrany dla toolchaina i aplikacji.
2. Wykonaj kontrolę miejsca i granic zapisu przed alokacją. Dla renderowanego
   JSON Compose użyj
   `python -B scripts/audit_build_mounts.py --expected-project <project> <compose.json>`
   z katalogu tego skilla; `-` odczytuje stdin bez pliku na hoście. Skrypt jest
   tylko odczytowym audytem mountów. `PASS` dotyczy wyłącznie topologii;
   `build_data_qualification` pozostaje `NOT VERIFIED`. Nie zastępuje kontroli kodu launchera,
   BuildKit, ścieżek logów ani rzeczywistego `docker inspect`. Kod wyjścia 0
   tego helpera nie może samodzielnie otwierać bramki volume-only.
3. Przygotuj przypięty toolchain i wrapper, następnie uruchom stałe usługi
   zarządzaną receptą, która przeszła kontrolę zgodności. Nie używaj dawnego
   runnera, hostowego Cargo/CMake, osobnego `backend-build` ani źródłowego ZIP/TAR.
4. Zapisz dowód poprawnego buildu i startu API. Sprawdź restart bez zmian,
   małą zmianę backendu oraz frontend HMR, mierząc rzeczywistą pracę i zajętość.
   Nie obiecuj stałego czasu ani kompilacji tylko jednego crate.
5. Po etapie wykonaj kwalifikację retencji opisaną w procedurze. Zapisz wynik
   w wolumenie; raportuj pozostawione generacje i powód. Nie stosuj globalnego
   prune ani automatycznego usuwania wolumenów czy danych użytkownika.

Odróżniaj: plan, audyt źródeł, strukturalny test mountów, build, API, HMR,
wykonanie symulacji i pomiar odzyskanych bajtów. Brak dowodu oznacza
`NOT VERIFIED`. Nie nazywaj dokumentacji wdrożoną automatyką sprzątania.
