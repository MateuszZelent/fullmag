# FEM CPU — rozdzielenie zależności modalnych

Data: 2026-10-03. Status: poprawka źródeł; obraz, eksport i runtime NOT VERIFIED.

## Problem i dowody

[Diagnostyka startupu](2026-10-03-fem-cpu-startup-cuda-dependency-audit.md)
wykazała brak wejścia do main nawet dla --help. Ostatni zapis loadera celu
wskazuje inicjalizację libcublasLt.so.12. Nie dowodzi to wewnętrznego błędu
NVIDIA ani nie wyjaśnia wszystkich zależności przyczynowych.

Dockerfile zawierał osobny CPU HYPRE/MFEM, ale CPU MFEM korzystał ze wspólnego
libCEED, a profil runtime-v2 nie wybierał osobnych PETSc/SLEPc. Wspólne PETSc
jest skonfigurowane z CUDA i GPU HYPRE. W ten sposób realizacja CPU wciągała
biblioteki GPU oraz drugi SONAME HYPRE. Osobna realizacja CPU nie powinna
wymagać inicjalizacji CUDA. To poprawka rozdzielenia zależności, a nie zmiana
operatora, demaga, tolerancji lub modelu analitycznego.

## Przyrost implementacji

- Dockerfile dodaje osobne, czyste drzewa budowy libCEED/PETSc/SLEPc CPU.
  Wersje pozostają przypięte jak w istniejącym obrazie. CPU PETSc jest
  real/double, z MPI i tym samym CPU HYPRE co CPU MFEM. Akceleratory są
  wyłączone; libCEED zachowuje dostępne realizacje CPU.
- CPU MFEM wybiera CPU libCEED i CPU HYPRE z jednego prefiksu.
- runtime-v2 jawnie wybiera CPU discovery: CMake, pkg-config, PETSC_DIR,
  SLEPC_DIR, nagłówki i linkowanie. PETSC_ARCH jest pusty dla instalacji
  prefiksowej. Historyczne profile i zapisane kapsuły nie są zmieniane.
- Atestacja nowego CPU v2 pomija discovery/preload sterownika CUDA. Regresja
  sprawdza brak wywołań loadera w tej trasie oraz zachowanie historycznej
  trasy v1. Mockowane wywołania nie uruchamiają rzeczywistych bibliotek.
- Preflight przed produkcyjnym Make sprawdza wymagane pliki i ich zawieranie
  w prefiksie, brak flag akceleratorów PETSc oraz real/double. Stary obraz
  daje konkretny błąd zamiast kolejnego długiego builda mieszanego stosu.

Preflight jest kontrolą konfiguracji/pliku, nie dowodem pełnego grafu ELF.
Nie wykonuje ldd, CDLL ani żadnego załadowania biblioteki. Nie zastępuje
atestacji rzeczywistych zależności i startupu po nowym managed buildzie.
Dedykowany docker/fem-cpu/Dockerfile ma obecnie SLEPc OFF i nie jest
zastępczą kwalifikacją modalną. Nie usuwamy GPU stosu z obrazu dualnego.

## Weryfikacja i dalsza bramka

45 interpretowanych regresji sterownika Python PASS; obejmują odrzucenie
brakującego SLEPc, konfiguracji akceleratorów oraz złej precyzji.
Składnia czterech instrukcji RUN CPU sprawdzona przez bash -n: PASS,
bez wykonania builda. Diff check zakresu PASS. Nie kompilowano unit tests.

Potrzebne są: miejsce na storage; autoryzowana trasa utrzymania obrazu
według governance runnera; przypięcie nowego immutable image ID; nowa
kapsuła aktualnych źródeł i terminalny managed receipt. Aktywnego runnera
ani FIFO nie zmieniono. #213 nie zawiera tego przyrostu.
Następnie: --help/fem-availability, potwierdzenie rzeczywistego zamknięcia
zależności CPU, serial/adaptive na identycznych wejściach, eksport OpenAPI,
matched GUI/browser i kampania signed Γ/DE/BV. Pełny zakres S00–S12 pozostaje
OPEN, w tym COMSOL A1, zbieżności, falowód, interakcje i GPU.

Konfiguracja osobnych wariantów PETSc i libCEED opiera się na dokumentacji
[PETSc](https://petsc.org/release/install/install/) i
[libCEED](https://libceed.org/en/latest/gettingstarted/).

## Follow-up niezależnego review

Review e0ac047 wskazało cztery dodatkowe punkty. W źródłach poprawiono:

1. Wrapper scripts/local_runner/Dockerfile.build również buduje pełne CPU
   libCEED/PETSc/SLEPc i kieruje CPU MFEM do CPU CEED. Trzy nowe wersje są
   przypięte do exact40SHA, odczytanych z oficjalnych tagów upstream. Wrapper
   przygotowuje potrzebne CPU development BLAS/LAPACK/Fortran. Nie zmieniono
   domyślnego dostępu sieci, aktywnego obrazu ani zapisanych kapsuł.
2. Atestacja v2 odrzuca brakujące zależności, biblioteki akceleratorów,
   podwójnego HYPRE i każdą z pięciu bibliotek spoza CPU prefixu. Zapisuje
   rzeczywiste ścieżki i SHA-256 MFEM/HYPRE/CEED/PETSc/SLEPc. Konfiguracja
   PETSc/SLEPc oraz pkg-config musi wiązać się z tymi samymi plikami.
   Moduły FindPETSc/FindSLEPc muszą pochodzić z przejętych źródeł projektu;
   ich prawidłowa lokalizacja jest poza prefiksem bibliotecznym CPU.
   Konsument receiptów sprawdza te same rodziny, hashe, ścieżki i wiązania.
3. Macro PETSC_HAVE_* o wartości0 jest poprawnie traktowane jako wyłączone.
   Wartość1 lub pusta definicja oznacza support; nieznana wartość jest błędem.
4. Cargo obserwuje discovery env, a configure unieważnia konkretne wpisy
   PETSc/SLEPc/MFEM w zachowanym cache. Nie usuwa katalogu cache ani wyników.
   Regresja wykonuje CMake z LANGUAGES NONE: stary prefix pozostaje bez -U,
   a po argumentach bieżącego build.rs trzy zależności zmieniają się na nowy.

Weryfikacja: 47 interpretowanych regresji producenta i18 konsumenta PASS;
1 regresja konfiguracji CMake NONE PASS, bez kompilatora. Rustfmt parser
build.rs PASS. Składnia instrukcji RUN wrappera i bazowego Dockerfile
sprawdzana bez ich wykonania. To source/tool-contract evidence.
Nowy obraz, rzeczywisty ELF i startup, kompilacja produkcyjnego build.rs,
managed receipt oraz solver/runtime nadal NOT VERIFIED.
Historyczne receipty bez nowego pełnego wiązania CPU nie są dowodem tej
ostrzejszej bramki. Nie nadpisano historii wyników ±10 z #203.

### Domknięcie review — 2026-10-03

Niezależne review nie znalazło blokującego P1 w przyroście. Dodatkowo konsument profilu runtime-v2 wymaga jawnie pustych list preloadu i ścieżek zgodności CUDA. Konfiguracja usuwa również zapamiętany `CMAKE_PREFIX_PATH`; regresja sprawdza jego zastąpienie wraz z bibliotekami.

Końcowa weryfikacja źródeł: 47 kontroli producenta, 19 konsumenta oraz 1 kontrola CMake `project(... NONE)` — PASS. Pierwsza próba przez moduł unittest miała dwa błędy importu (`local_runner` poza ścieżką); wykonanie skryptów przez ich właściwe punkty wejścia przeszło. Nie kompilowano testów jednostkowych. Obraz, loader, solver i przyspieszenie adaptive pozostają NOT VERIFIED. Runner: zdrowy, brak aktywnych wykonań, `waiting_for_disk`, 6 656 266 240 bajtów wolnych (poniżej 8 GiB).
