# Projekt: skalowalny Fredkin–Köhler FEM/BEM CPU i GPU

**Data:** 2026-09-02  
**Status:** projekt docelowy; import źródła i diagnostyczny ACA H-matrix są
zaimplementowane, lecz A/B, managed receipt i fizyka pozostają NOT VERIFIED
**Zakres:** istniejący benchmark warstwy `500 x 500 x 10 nm`, body-only FK,
FEM CPU i strict FEM GPU

## Cel

Po kwalifikacji A/B zastąpić produkcyjną zależność od gęstej macierzy BEM
skalowalnym operatorem; bieżący ACA H-matrix pozostaje diagnostyczny i zachowuje
dotychczasową semantykę Fredkina–Koehlera:

\[
u=u_1+u_2,
\qquad
\Delta u_1=\nabla\cdot\mathbf M,
\qquad
\Delta u_2=0,
\qquad
\mathbf H_\mathrm{demag}=-\nabla u.
\]

Operator ma być skalowalny pamięciowo i obliczeniowo, deterministyczny,
kontrolowany błędem i dostępny jako niezależne realizacje CPU oraz GPU.
Żądanie GPU musi zakończyć się błędem, jeśli nie można wykonać całego FK na
GPU; nie wolno przenosić śladu granicznego ani operatora na CPU.

## Niezmienniki benchmarku

Nie zmieniać:

- geometrii `500e-9 x 500e-9 x 10e-9 m`;
- materiału Py: `Ms=800e3 A/m`, `Aex=13e-12 J/m`, `alpha=0.01`;
- braku PBC;
- biasu `B=(100e-3,0,0) T`;
- jednorodnego drive `B_y=1e-3*sinc(2*pi*10e9*(t-2e-9)) T`;
- czasu `40/10e9 = 4e-9 s` i istniejącego próbkowania;
- kolejności relaksacja → stan zrelaksowany → tabela → dynamika;
- wspólnego skryptu i semantyki z lane’ami FDM;
- body-only free-tetrahedral P1 dla FK, bez airboxa.

Żaden test akceptacyjny nie może zastąpić benchmarku testem sferycznym ani
zmienić parametrów fizycznych w celu uzyskania zgodności.

## Architektura operatora

### Kontrakt neutralny

Wprowadzić wewnętrzny kontrakt `DemagBoundaryOperator` z następującymi
właściwościami:

- `build(surface, options)` — walidacja i jednorazowa kompilacja operatora;
- `apply(input, output)` — wielokrotne zastosowanie bez alokacji zależnej od
  liczby węzłów i bez zmiany geometrii;
- `mode()`, `boundary_nodes()`, `resident_bytes()`, `relative_error_bound()`;
- deterministyczny fingerprint zależny od geometrii, kolejności kanonicznej,
  parametrów kompresji i wersji kernela;
- jawne `failure_reason`, gdy budowa albo kontrola błędu nie powiedzie się.

`DenseDemagBemOperator` pozostaje kwalifikowanym domyślnym wariantem CPU.
Diagnostyczny ACA H-matrix nie zastępuje go bez osobnej bramy A/B i parity.

### Diagnostyczny operator ACA H-matrix CPU

`AcaHMatrixDemagBemOperator` buduje jedno deterministyczne drzewo klastrów
węzłów brzegowych. To samo drzewo jest współdzielone przez klastry docelowe
wierszy operatora i klastry źródłowe całek Lindholma.

Para klastrów jest admissible, gdy:

\[
\max(\operatorname{diam} T,\operatorname{diam} S)
\leq \eta\,\operatorname{dist}(T,S),
\]

gdzie `eta`, maksymalny liść i tolerancja są częścią resolved operator
options. Dla par nieadmissible używany jest dokładny kernel Lindholma, a dla
par admissible stosowana jest deterministyczna aproksymacja niskiego rzędu
(`U V^T`) uzyskana przez ACA z kontrolą pivotu i maksymalnego rzędu.

Wymagania implementacyjne:

- kanoniczny medianowy split po najdłuższej osi, z tie-breakiem po globalnym
  indeksie;
- brak pełnej macierzy `Nb x Nb` dla trybu production;
- osobne przechowywanie near blocks i far low-rank blocks;
- brak alokacji per apply i brak globalnego locka w hot path;
- OpenMP tylko na niezależnych blokach/wierszach, bez oversubscription z
  solverem MFEM;
- estymator błędu z niezależnych pivotów/residual probes; przekroczenie
  tolerancji kończy budowę błędem zamiast cichego obniżenia jakości;
- opcjonalny limit pamięci i limit liczby bloków sprawdzane przed alokacją;
- `O(N log N)` lub `O(N r)` storage/apply dla ustalonego rzędu, z raportem
  rzeczywistego near/far/rank i czasu budowy.

Wartości w blokach near muszą być tym samym signed Lindholm kernel’em co w
dense oracle. Aproksymacja far nie zmienia diagonalnego kąta bryłowego;
diagonalny wkład jest przechowywany jawnie.

### Diagnostyczny operator ACA H-matrix GPU

`GpuDemagFemBemWorkspace` jest osobnym właścicielem CUDA. Po setupie na host
pozostają wyłącznie metadane/provenance, a następujące bufory są device
resident:

- canonical boundary indices i geometria potrzebna do operatora;
- near block descriptors i wartości;
- far block descriptors oraz faktory `U` i `V`;
- boundary trace `u1`, correction `u2` i scratch reductions;
- gather/scatter dla FEM P1;
- bieżące wektory i redukcja energii.

Kernel apply przetwarza niezależne bloki wierszy. Dla bloku far najpierw liczy
`V^T x`, następnie `U(V^T x)`; blok near wykonuje dokładne sumowanie. Żaden
wektor magnetyzacji, trace, potencjał ani pole nie może być kopiowany
`D2H/H2D` w hot loop integratora. Dopuszczalne są wyłącznie jawnie opisane
transfery setupu, kontrolnego skalara i finalnego artefaktu obserwacyjnego.

GPU FK używa istniejących device-resident solverów u1/u2 tylko jako osobnych
solverów z tym samym mesh/potential contract. Inicjalizacja operatora,
upload, apply, recovery i energy reduction muszą mieć osobne liczniki i
telemetrię. Błąd CUDA, brak Hypre device albo przekroczenie budżetu kończy
cały forced-GPU run; nie wolno uruchomić `context_compute_demag_fem_bem` na
CPU jako obejścia.

## Warstwy integracji

1. `backends/fem/cpu/mfem/interactions/` — neutralny kontrakt, dense CPU default i diagnostyczny ACA H-matrix,
   workspace i telemetry.
2. `backends/fem/gpu/cuda/demag_fem_bem/` — CUDA storage, kernels, upload,
   apply, lifecycle i device energy.

Wspólny workspace FK składa geometrię granicy, przestrzeń P1, gauge oraz
operatory rzadkie. Nie buduje globalnej macierzy BEM. Dense operator jest
tworzony wyłącznie przy wyborze CPU, natomiast forced GPU buduje bezpośrednio
ACA H-matrix. Podpięty GPU workspace ma callback destruktora należący do modułu
CUDA; wspólny lifecycle wywołuje go przy reinicjalizacji i przed zniszczeniem
operatorów MFEM przez `context_destroy_mfem`.
3. `backends/fem/src/api.cpp` oraz `crates/fullmag-fem-sys` — tylko ABI
   capability/status/receipt; bez przenoszenia równań do ABI.
4. `crates/fullmag-plan` i `crates/fullmag-runner` — requested/resolved
   realization, device legality, fail-closed selection i provenance.
5. `tests/fem_fdm_mumax3_sinc_layer/` — wspólny producer benchmarku; różnice
   wyłącznie mesh/demag realization i device lane.
6. `scripts/analysis/compare_fdm_fem_mumax3_sinc_layer.py` — weryfikacja
   wszystkich kolumn, osi czasu i statusów artefaktów.
7. `live-results.html` — seria FK jest dostępna dopiero po świeżym, ważnym
   artefakcie; brak artefaktu pozostaje `pending`, nie `PASS`.

## Testy przed runtime

### CPU operator

- dense i ACA H-matrix dają tę samą wartość dla małej, kompletnej siatki TET4 w
  granicy ustalonej w options;
- testy near/far, zero input, stały input, permutacji numeracji i skalowania
  długości zachowują kontrakt znaków/jednostek;
- limit pamięci i limit bloków kończą się przed alokacją;
- budowa odrzuca niepełną granicę, non-manifold, PBC i nie-TET4;
- powtórny build daje ten sam fingerprint i te same bloki;
- zmniejszanie tolerancji nie może zwiększać błędu względem dense oracle;
- przypadki niefinityczne kończą się błędem, nigdy zerowym polem.

### GPU operator

- upload zachowuje fingerprint, liczbę bloków, rank i byte count;
- CUDA apply jest zgodny z CPU ACA H-matrix oraz dense oracle dla fixture’u
  testowego;
- test wymusza awarię operatora/Hypre i potwierdza brak CPU call/fallback;
- sanitizer/guard sprawdza zakresy bloków, brak write race i synchronizację;
- licznik hot-loop `D2H/H2D` pozostaje równy zero dla pełnej sekwencji RHS.

## Runtime i artefakty

Każdy lane zapisuje poza checkoutem:

- pełny source SHA i dirty/clean identity;
- canonical recipe oraz resolved plan;
- mesh/topology fingerprint, boundary nodes/faces;
- operator mode, `eta`, tolerance, leaf size, max rank, near/far counts,
  compression error i resident bytes;
- requested/resolved device, precision, CUDA/MFEM/Hypre identity;
- relaksację, powód zatrzymania, stan `relaxed_state`;
- dynamiczną tabelę z `mx,my,mz,e_ex,e_demag,e_ext,e_drive,e_ani,e_dmi,e_total`;
- transfer counters, solver iterations/residuals i brak fallback trail;
- SHA-256 artefaktów i status walidacji.

Publikacja artefaktu jest atomowa: tabela i manifest muszą być zamknięte,
zweryfikowane i zhashowane przed ustawieniem `ready`.

## Bramy akceptacji

1. Testy source/ABI/planner przechodzą z czystym i wymuszonym forced-GPU
   fail-closed.
2. Managed FEM CPU wykonuje dokładny benchmark 500 x 500 x 10 nm z relaksacją
   i dynamiką 4 ns bez airboxa FK.
3. Managed FEM GPU wykonuje ten sam benchmark z device-resident FK i zerowym
   hot-loop CPU fallbackiem/transferem wektorowym.
4. Oba lane’y publikują skończone `mx/my/mz` oraz wszystkie energie dla tych
   samych czasów próbkowania.
5. Porównanie z FDM CPU/GPU i MuMax3 ma jawne tolerancje, metadane osi czasu
   i rozdziela rozbieżność dyskretyzacji od błędu operatora.
6. `live-results` pokazuje FK jako dostępny wyłącznie wtedy, gdy validator
   potwierdzi manifest, tabelę, fingerprint i source identity.

Brak działającego managed GPU, niepełny artefakt, `NaN`, niezgodny czas,
niezerowy fallback lub nieudany residual gate oznacza `NOT VERIFIED` i
blokuje ukończenie zadania.
