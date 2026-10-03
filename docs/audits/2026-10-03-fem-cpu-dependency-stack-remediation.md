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
