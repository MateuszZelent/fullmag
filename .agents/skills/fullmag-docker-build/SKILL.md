---
name: fullmag-docker-build
description: "Build or rebuild Fullmag from a selected checkout in its Docker Compose development group, with build data confined to persistent Docker volumes. Use for fresh-host builds, incremental backend restarts, frontend HMR, and build disk-usage or retention checks."
---

# Fullmag — build DEV w wolumenach Docker

Wynik: jedna grupa `fullmag-master` albo `fullmag-worktree-<worktree-id>`, dwie
stałe usługi aplikacji, jeden wybrany readonly checkout i trwały przyrostowy
cache. Aplikację buduje i uruchamia ten sam `backend`; Next/HMR działa w
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
- Cache ma przetrwać restart i zmianę źródeł. Nie usuwaj go dla zwykłego buildu.
  Usunięcie kontenera nie usuwa named volumes ani obrazów/BuildKit.
  Wycofanie build-data grupy wymaga osobnej, precyzyjnej operacji.
  Wolumen nie jest quota ani gwarancją braku wzrostu: wymagane są pomiary,
  kontrola generacji i bezpieczna retencja.

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

## Wdrożona trasa DEV

`docker-dev-toolchain`, `docker-dev-images`, `docker-dev` i `docker-dev-build`
korzystają z `scripts/docker_build_control.py` oraz `scripts/docker_volume_dev.py`.
Opis uruchomienia, pinów restartu/odtwarzania i budżetów znajduje się w
[przewodniku DEV](../../../docs/guides/docker-volume-development.md).
Historyczny audyt powyżej pozostaje dowodem stanu bazowego, a nie opisem
bieżących zapisów tej trasy. Wyników release/CI/nauki nie przenoś na DEV ani
odwrotnie. Sprawdź bieżące źródła i wynik konkretnej próby.

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
