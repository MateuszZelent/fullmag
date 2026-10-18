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
- **Dane użytkownika nadal na Windows:** sesje, wyniki, projekty, ustawienia i
  historia ostatnich projektów. Zachowaj ich dotychczasowy kontrakt/mounty;
  polecenie dotyczące builda nie autoryzuje przeniesienia ich do Dockera.
- Cache ma przetrwać restart i zmianę źródeł. Nie usuwaj go dla zwykłego buildu.
  Usunięcie kontenera nie usuwa named volumes ani obrazów/BuildKit.
  Wycofanie build-data grupy wymaga osobnej, precyzyjnej operacji.
  Wolumen nie jest quota ani gwarancją braku wzrostu: wymagane są pomiary,
  kontrola generacji i bezpieczna retencja.

## Przed pierwszym wykonaniem

Przeczytaj [procedurę od zera](references/procedure.md). Dla kontroli wszystkich
writerów i retencji stosuj [kontrakt danych builda](references/artifact-policy.md). Sprawdź `AGENTS.md`,
`justfile`, `.agents/instructions/backend.md` i aktualne
[ustalenia audytu storage](../../../docs/guides/docker-build-storage-lifecycle.md).
Kod i receipty rozstrzygają, czy dana recepta już spełnia nową granicę danych.
Przy wyborze lub zmianie komendy czytaj [audyt wszystkich recept](references/recipe-audit.md)
i manifest deklaracji. Porównaj hashe wejść; zmiana wrappera/resolvera wymaga
ponownej oceny także recept, których treść się nie zmieniła.

**Istotny stan bazowy:** audyt z 18.10.2026 potwierdził named volumes backendu
v2, lecz nie pełną zgodność. Bootstrap/launchery zapisywały konteksty i receipty
w hostowym storage, provenance miało writable bind, frontend używał backing
ext4 oraz logu w Windows. Nie uruchamiaj tych recept jako rzekomo zgodnej
ścieżki volume-only. Przeczytaj wskazane funkcje, sprawdź bieżący kod i mounty;
jeżeli niezgodność pozostaje, podaj ją konkretnie. W zadaniu implementacyjnym
napraw launcher przed buildem; samo wywołanie skilla nie rozszerza zakresu
zadania na przebudowę całego systemu.

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
