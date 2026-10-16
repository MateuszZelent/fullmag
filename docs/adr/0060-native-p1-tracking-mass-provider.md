(native-p1-tracking-mass-provider)=
# ADR 0060 — natywny geometryczny provider P1 dla metryki trackingu

Status: accepted dla dwóch pierwszych wewnętrznych atomów; wykorzystanie snapshotu przez tracking/sweep, managed FEM, GPU i kwalifikacja naukowa **NOT VERIFIED**.

Data: 16.10.2026. Punkt odniesienia źródeł: `MateuszZelent/fullmag@40fd62ae39f6e68ac7dcc602c614e12f610cbc46`. Ta decyzja dodaje wyłącznie prywatny, wersjonowany kontrakt C ABI dla `fullmag-fem-sys` i runnera; nie rozszerza wspieranego publicznego SDK ani legalności planner'a.

## Kontekst

Ścieżka trackingu używa geometrycznej, consistent metryki P1 do porównywania
nodalnych wektorów. Nie jest to operator dynamiki ani macierz uogólnionego
pencil. Obecny adapter Rustowy buduje metrykę Tet4 z kanonicznej topologii.
Pierwszy atom dostarcza natywny MFEM assembly, a drugi prywatne C ABI i
bezpieczny, niemutowalny snapshot Rust do późniejszego połączenia ze sweepem.
Macierz wymiany ważona przez
$M_s$, masa lumped i tangent mass Floqueta mają odrębne znaczenie i pozostają
bez zmian.

## Decyzja

Pierwszy atom dodaje wewnętrzny C++ builder, który dla scalar conforming H1
P1 assemble'uje geometryczną macierz consistent na elementach wybranych
jawnymi atrybutami objętości magnetycznej. Wynik to niemutowalny CSR pełnej
fizycznej przestrzeni wierzchołkowej z mapami native scalar DOF ↔ kanoniczny
vertex ID dla każdego węzła. Węzeł na granicy magnetyczne/powietrzne
otrzymuje magnetyczny wkład; wiersz węzła wyłącznie powietrznego pozostaje
pusty i ma dokładnie zerową masę. Dalszy konsument rozpoznaje aktywne węzły
przez sumy wierszy, bez usuwania fizycznych wierszy snapshotu.

Provider przyjmuje wyłącznie `FiniteElementSpace` i listę atrybutów domeny.
Nie dostaje `M_s` ani innych pól materiałowych, nie dzieli komórek, nie
lumpuje macierzy, nie dodaje diagonalnej regularizacji i nie ma fallbacku do
identity. Wymagania obejmują trzywymiarową siatkę, scalar continuous P1,
zgodny rozmiar lokalny i true-space oraz dokładne `GetVertexDofs` dla każdego
kanonicznego wierzchołka. Nieobsługiwana przestrzeń, brak/duplikat atrybutu,
pusta domena, błędny CSR lub niezgodne mapowanie kończą się jawnym statusem
błędu, bez częściowego snapshotu. Wybrane elementy magnetyczne są ograniczone
do liniowych Tet4/Prism6, a siatka MFEM nie może mieć zakrzywionych węzłów.
Provider odtwarza istniejący sanity check mesh-buildera: kontrolę orientacji
oraz dodatnie, skończone Jacobiany w punktach reguły rzędu 2. Nie jest to
pełna certyfikacja Jacobianu w każdym punkcie nieafinicznego Prism6.

Drugim atomem jest prywatny kontrakt `fullmag_fem_tracking_mass_snapshot_*_v1`.
`fullmag_fem_tracking_mass_snapshot_create_v1` przyjmuje istniejący typowany
`fullmag_fem_mesh_desc` oraz maskę 0/1 z jednym wpisem na kanoniczną komórkę.
Implementacja ponownie używa `import_mesh_descriptor` i
`build_mfem_mesh`; porównuje maskę po indeksie komórki z rzeczywistym
atrybutem MFEM po translacji markerów IR. Nie zakłada, że marker IR równy zero
jest atrybutem MFEM zero. Maska dzieląca komórki o jednym atrybucie MFEM jest
jawnie odrzucana, tak aby assembly nie rozszerzyło domeny po cichu.

Deklaracje i symbole tego ABI są obecne także w konfiguracji z
`FULLMAG_USE_MFEM_STACK=OFF`. W tej konfiguracji mały stub zwraca
`FULLMAG_FEM_ERR_UNAVAILABLE` i zeruje wyjściowy uchwyt; nie tworzy danych ani
nie dołącza typów MFEM. Zapytanie lub kopiowanie z nieistniejącym uchwytem
kończy się jawnym błędem. Oddzielny profil `tracking-mass-stub` sprawdza tę
granicę bez linkowania MFEM.

Uchwyt zawiera wyłącznie własne tablice CSR/mapowania i metadane; nie zachowuje
wskaźników do siatki, FES, formy MFEM, kontekstu ani urządzenia. Metadata
wiąże wersję i rozmiar ABI, generation, pełne wymiary, hash komórkowej maski,
topologii/markerów, canonical map, CSR oraz SHA-256 źródłowego snapshotu
osadzonego w DSO. Kopiowanie wymaga oczekiwanej generation i digestu, sprawdza
wszystkie wskaźniki oraz pojemności przed pierwszym zapisem i nie wykonuje
częściowego copy. Wrapper Rust sprawdza rozmiary/overflow przed alokacją,
waliduje cały CSR i mapowanie oraz zwalnia uchwyt przez `Drop`, także gdy
walidacja albo copy kończą się błędem.

To nadal nie podłącza snapshotu do iloczynu trackingu, solvera, direct/path,
adaptive ani bias. Następny atom zachowa istniejący Tet4 artifact/parser v1
i doda odrębny immutable sidecar v2 raz na sweep, z digestem sidecara w
rekordzie każdego modu; nie będzie tworzyć assembly ani macierzy per punkt
`k`. Export snapshotu Stage 2 pozostaje surową geometryczną macierzą bez fazy,
redukcji PBC ani wyboru CPU/GPU. Postprocessing metryki może jawnie wykonać
się na CPU także po GPU solverze; nie oznacza to solver fallbacku. Planner,
żądane urządzenie, provenance i wynik GPU pozostają bez zmian.

## Kontrakt numeryczny

Dla liniowych nodalnych funkcji bazowych $N_i$ provider składa

```{math}
:label: eq-adr-native-p1-tracking-mass
(M_T^{\mathrm{track}})_{ij}
=\sum_{e\in\Omega_m}\int_e N_iN_j\,\mathrm dV.
```

Gdy geometria wejściowa wyraża się w SI, wartości mają jednostkę $\mathrm{m^3}$.
Macierz jest symetryczna i positive semidefinite w pełnym węzłowym scalar P1
space domeny magnetycznej. Nie jest to dodatnia masa dołożona do dynamicznego
pencil i nie zastępuje dowolnej macierzy już używanej przez solver.

### Granica fazy Floqueta w przyszłym konsumencie

Dla niezerowego `k` tracker porównuje nodalny envelope, zgodnie ze znakiem
`exp(+i k·r)` używanym przez istniejący adapter wektorów. Nie wolno
przestawić diagonalnej transformacji fazy przez consistent masę, która ma
wyrazy pozadiagonalne. Niech `P(k)` oznacza dokładne mapowanie solvera z
zredukowanego wektora `q` na pełny nodalny Cartesian phasor `m=P(k)q`,
`D+(k)=diag_i exp(+i k·r_i)`, a `M_full=M_T^track ⊗ I_3`. Wówczas
metryka nodalnego envelope wynosi

```{math}
:label: eq-adr-nodal-envelope-tracking-metric
u=D_+(\mathbf k)\,\mathcal P(\mathbf k)q,\qquad
u^\mathsf H M_\mathrm{full}u
=q^\mathsf H\mathcal P(\mathbf k)^\mathsf H
D_+(\mathbf k)^\mathsf H M_\mathrm{full}
D_+(\mathbf k)\mathcal P(\mathbf k)q.
```

To nie jest na ogół `qᴴ Pᴴ M_full P q`. Operacja działa na nodalnych
wartościach phasora; interpolacja P1 tych odfazowanych węzłów nie jest
dokładną ciągłą transformacją `exp(+i k·r)` interpolowanego pola FE.
Nowa faza nie należy do Stage 2 CSR ani do solvera i nie zmienia v1.

## Rozważone alternatywy

- **Użyć masy wymiany:** odrzucono, bo wprowadza $M_s$ i zmienia
  geometryczną metrykę trackingu.
- **Zlumpować do wag nodalnych:** odrzucono, bo usuwa off-diagonal terms i
  zmienia iloczyn consistent P1.
- **Dzielić pryzmy na tetraedry:** odrzucono, bo zmienia oryginalną bazę
  finite-element i lokalną macierz; integracja musi zachować native MFEM
  elementy.
- **Dopasować węzły przez współrzędne:** odrzucono, bo nie zapewnia
  tożsamości; wymagany jest dokładny DOF-to-canonical-vertex map.
- **Dodać publiczne SDK/API albo planner capability:** odrzucono w tym ADR.
  Prywatne, wersjonowane C ABI jest wyłącznie adapterem między natywnym FEM,
  sys crate i runnerem; publiczna legalność i fallback/fail-closed GPU
  pozostają osobnym etapem.

## Weryfikacja i granice

Real-MFEM CTest sprawdza niezależne współczynniki analityczne Tet4
i affine Wedge6 przy skalach 1 m i 1 nm, sumy wierszy równe objętości,
symetrię i mapowanie kanonicznych węzłów. Mieszany fixture z atrybutem
magnetycznym i powietrznym ma potwierdzać, że powietrzne komórki nie dodają
wkładu, a wiersz węzła wyłącznie powietrznego pozostaje w snapshotcie pusty
i zerowy; osobny przypadek odrzuca zdegenerowany Tet4. Osobne cases odrzucają
vector/P2 spaces i nieprawidłowe maski. CTest Stage 2 ma przez rzeczywiste
DSO sprawdzić query, wszystkie bounded-copy buffers, brak częściowego zapisu,
stale generation/identity i teardown. Rust test używa typed `MeshIR` oraz
`PackedNativeMesh`, sprawdza pełny canonical map/CSR i porównuje digest
źródłowy zwrócony przez DSO z tożsamością buildu. GHA uruchamia oba testy oraz
przed/po testach attests SHA biblioteki i loader resolution. Są one podpięte do
istniejącej bramki `positive-mass`; dotychczasowy ważony/operatorowy test
pozostaje bez zmian. Oddzielny no-stack CTest sprawdza symbole stub ABI,
jawny status `UNAVAILABLE` i brak uchwytu. Weryfikacja Stage 2 pozostaje
**NOT VERIFIED** do
wykonania tej bramki. Nawet zielone CTest/Rust testy nie dowodzą użycia
providera przez tracking, runtime FEM/GPU ani kwalifikacji fizycznej.

Pliki dwóch atomów: natywny provider w
`backends/fem/cpu/frequency_domain/modal/tracking_mass_provider.hpp/.cpp`;
prywatny ABI w `native/include/fullmag_fem.h` i
`backends/fem/src/frequency_domain/tracking_mass_snapshot.cpp`; bezpieczny
wrapper w `crates/fullmag-fem-sys/src/lib.rs` oraz
`crates/fullmag-runner/src/native_fem/tracking_mass.rs` /
`crates/fullmag-runner/src/native_fem.rs`; rzeczywiste CTest/Rust testy,
ich profile CMake i wiring GHA pozostają w odpowiadających ścieżkach
`backends/fem/tests`, `backends/fem/CMakeLists.txt`,
`scripts/ci/run_fem_positive_mass_contract.py` i
`.github/workflows/fem-positive-mass-contract.yml`. Naukowy opis i
mapowanie źródeł są w `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`.
