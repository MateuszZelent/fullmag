# Produkcyjny FEM eigensolve K0 w pełni rezydentny na GPU

Data: 2026-08-11  
Status: zatwierdzony projekt przed planem implementacji

## 1. Cel

Celem jest produkcyjna realizacja FEM eigensolve K0 z demagnetyzacją Poisson-airbox, w której operator dynamiczny, redukcja Schura, rozwiązania Poissona, transformacja shift-invert oraz przestrzeń Kryłowa SLEPc pozostają na GPU przez cały solve. Żądanie GPU jest ścisłe: brak urządzenia, niewłaściwy typ PETSc, migracja do pamięci hosta albo niedostępny komponent CUDA kończą stage błędem. Nie wolno uruchamiać ukrytego solvera CPU ani trybu hybrydowego.

Zakres obejmuje pojedynczy punkt K0, okno częstotliwości, zapis spektrum i zespolonych pól modów oraz scenariusz `relax -> eigensolve` dla okresowej warstwy z dziurą. FDM nie jest częścią tej realizacji.

## 2. Kontrakt fizyczny

Realizacja GPU zachowuje dokładnie kontrakt opisany w `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`:

- ta sama zaakceptowana równowaga i ta sama siatka wspólnej domeny magnetyk-airbox;
- K0 i okresowe klasy węzłów zgodne z certyfikatem siatki v6;
- pełny operator styczny `full_2x2`;
- wymiana, Zeeman oraz demagnetyzacja Poisson-airbox;
- ten sam znak, układ jednostek SI, konwencja fazora i mapowanie wartości własnej na częstotliwość co w referencji CPU;
- brak ponownego meshowania i brak niejawnej interpolacji pomiędzy stage'ami;
- wynik nie jest uznawany za fizycznie zakwalifikowany bez porównania z CPU i przypadkami analitycznymi.

GPU jest osobną realizacją numeryczną wspólnego kontraktu, a nie osobnym modelem fizycznym.

## 3. Wybrana architektura

### 3.1. Stos wykonawczy

Produkcję realizują:

- PETSc z wektorami CUDA i macierzami `MATAIJCUSPARSE` tam, gdzie wymagana jest jawna macierz rzadka;
- SLEPc z rezydentną na urządzeniu bazą Arnoldiego, wektorami Ritz i operacjami ortogonalizacji;
- matrix-free operator zredukowany `L_eff` dla magnetycznych stopni swobody;
- hypre CUDA dla bloku Poissona airbox oraz preconditionera;
- istniejący zarządzany runtime FEM budowany przez repozytoryjne recepty `just`.

Nie powstaje drugi własny solver Arnoldiego ani gęsta pełna macierz rozwiązania produkcyjnego.

### 3.2. Podział odpowiedzialności

- `backends/fem/cpu/frequency_domain` pozostaje referencją i właścicielem CPU.
- `backends/fem/gpu/frequency_domain` posiada adapter PETSc/SLEPc CUDA, konfigurację typów urządzeniowych, lifecycle i diagnostykę GPU.
- `backends/fem/gpu/cuda/frequency_domain` posiada urządzeniowe działania operatorów i potrzebne workspace'y CUDA.
- backend-neutralne równania, digesty, certyfikaty i kontrakty artefaktów pozostają wspólne.
- Rust runner wybiera ścieżkę, przekazuje dane, egzekwuje fail-closed i publikuje artefakty; nie implementuje algorytmu eigensolvera.

Nie wolno dodawać solvera do `dispatch.rs`, `Context` ani `mfem_bridge.cpp`.

## 4. Przepływ danych

1. Stage relaksacji publikuje zaakceptowaną magnetyzację, identity siatki i artefakt równowagi.
2. Handoff weryfikuje pełny SHA-256 topologii, generację/revision, indeksowanie i liczbę węzłów.
3. Przy pierwszym wejściu do stage'u GPU siatka, materiały, równowaga i mapy redukcji są przesyłane jednokrotnie na urządzenie.
4. Adapter tworzy PETSc `Vec` CUDA, macierze AIJ cuSPARSE oraz hypre objects skonfigurowane dla pamięci urządzenia.
5. SLEPc wykonuje shift-invert Arnoldi. Każde zastosowanie operatora zredukowanego wywołuje GPU exchange/local terms i rozwiązanie Poissona hypre CUDA bez pełnego readbacku.
6. W trakcie solve na host mogą trafiać wyłącznie małe skalary telemetryczne: iteracja, liczba zbieżnych par, residual, czas i pamięć.
7. Po zbieżności na host wracają wartości własne oraz tylko wybrane, końcowe wektory modów wymagane przez format artefaktów i UI.
8. Writer zapisuje `spectrum.v2.json`, metadata modów, zespolone pola Zarr/binary oraz pełną provenance urządzenia i identity źródłowej siatki.

## 5. Inwariant pełnej rezydencji

Stage GPU jest poprawny tylko wtedy, gdy wszystkie poniższe warunki są spełnione:

- aktywny backend PETSc raportuje CUDA dla wszystkich wektorów przestrzeni rozwiązania;
- jawne macierze mają typ GPU, a działania matrix-free przyjmują i zwracają device pointers;
- hypre używa device execution/memory policy;
- basis, work vectors, Ritz vectors i preconditioner nie są host-backed;
- licznik pełnych transferów device-to-host podczas iteracji wynosi zero;
- nie wystąpił fallback, staging pełnego wektora ani host-projected Ritz solve;
- runtime i artefakty raportują rzeczywisty model GPU, UUID/compute capability i wersje PETSc/SLEPc/hypre.

Naruszenie któregokolwiek inwariantu daje jednoznaczny token błędu i nie publikuje wyniku jako zakończonego.

## 6. Obsługa błędów

Fail-closed następuje przed solve dla:

- braku urządzenia NVIDIA lub niedostępnego CUDA runtime;
- niezgodnej architektury GPU;
- PETSc/SLEPc bez CUDA albo hypre bez device policy;
- niezgodnej siatki, równowagi lub certyfikatu okresowości;
- nieobsługiwanego modelu demag, precyzji lub operatora;
- wykrytej migracji pełnego wektora na host;
- braku zbieżności, residualu ponad tolerancją, NaN/Inf albo przerwania.

Błąd zachowuje diagnostykę i nie uruchamia CPU. Żądanie użytkownika `gpu` pozostaje widoczne obok rozstrzygniętej rzeczywistości wykonawczej.

## 7. Telemetria i provenance

Stage publikuje co najmniej:

- fazę solvera, iterację, liczbę zbieżnych par i residual;
- typy `Vec`/`Mat`, backend SLEPc i konfigurację spectral transform;
- konfigurację hypre i urządzeniową politykę pamięci;
- liczbę i objętość transferów H2D/D2H, z rozróżnieniem inicjalizacji, iteracji i eksportu;
- peak GPU memory, czasy operatora, Poissona, preconditionera, ortogonalizacji i eksportu;
- solver reason, liczby iteracji i residual per mode;
- `gpu_device_resident_modal_eigensolver=true`, `fallback=None` i identity źródłowej siatki.

Heartbeat stage'u korzysta z prawdziwego postępu SLEPc, a nie wyłącznie z niezmiennego licznika kroków symulacji.

## 8. Artefakty i UI

Formaty naukowe pozostają wspólne dla CPU i GPU. Każdy zapisany mode zawiera:

- częstotliwość, wartość własną, residual i normalizację;
- zespolone składowe pola na źródłowej siatce;
- `source_mesh_identity` i digest handoffu relax-to-eigen;
- provenance solvera i urządzenia.

Control Room nie rozróżnia formatów CPU/GPU. Widok Results pokazuje spektrum, pozwala wybrać mode i przekazuje jego pole do zunifikowanego viewportu. Inspector pokazuje urządzenie, residual, normalizację, identity siatki i status pełnej rezydencji.

## 9. Walidacja

Kolejność kwalifikacji:

1. negatywne testy fail-closed bez GPU i przy CPU-backed PETSc objects;
2. syntetyczny mały problem urządzeniowy z kontrolą typów i transferów;
3. Kittel K0 z porównaniem częstotliwości;
4. okresowy Poisson-airbox K0 na małej siatce, parity wartości własnych i modów CPU-GPU;
5. convergence study względem siatki;
6. pełny `fem_periodic_antidot_relax_eigenmodes.py` z jednym meshem, zaakceptowanym handoffem, spektrum i polami modów;
7. test przerwania, wielokrotnych uruchomień, wycieku pamięci i stabilności;
8. pomiar przyspieszenia względem CPU przy tej samej fizyce i tolerancjach;
9. wizualne i binarne sprawdzenie spektrum oraz kilku modów w Control Room.

Status produkcyjny wymaga wykonania na realnym urządzeniu. Kompilacja CUDA i testy kontraktowe bez widocznego sterownika nie są dowodem runtime.

## 10. Kryteria ukończenia

Implementacja jest ukończona dopiero, gdy:

- wymuszony GPU solve kończy się bez fallbacku i bez hostowych iteracyjnych wektorów;
- wszystkie testy kontraktowe i negatywne przechodzą;
- runtime evidence potwierdza pełną rezydencję;
- Kittel oraz CPU-GPU parity mieszczą się w opublikowanych tolerancjach;
- pełny antydot tworzy poprawne spektrum i pola modów na tej samej siatce;
- artefakty przechodzą walidatory i są wyświetlane w Control Room;
- dokumentacja fizyczna, capability matrix i provenance odpowiadają faktycznemu statusowi;
- nie ma niewidocznego fallbacku, niekwalifikowanego claimu ani oznaczenia produkcyjnego opartego wyłącznie na source/tests.

## 11. Poza zakresem

- własny zamiennik SLEPc;
- pełna gęsta macierz dla problemów produkcyjnych;
- GPU single precision przed osobną kwalifikacją;
- ogólna ścieżka dla niezerowego K lub wszystkich modeli demag;
- optymalizacje FDM;
- automatyczne przełączanie GPU na CPU.

## 12. Aktualny blocker środowiskowy

Obecny obraz kompiluje CUDA, PETSc, SLEPc i hypre, lecz uruchomiony kontener nie widzi sterownika NVIDIA. Implementację i testy fail-closed można wykonać bez urządzenia, ale końcowa kwalifikacja, parity, pomiar transferów i wydajności wymagają przywrócenia dostępu do GPU w Docker/WSL.
