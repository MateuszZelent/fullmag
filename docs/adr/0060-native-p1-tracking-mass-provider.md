(native-p1-tracking-mass-provider)=
# ADR 0060 — natywny geometryczny provider P1 dla metryki trackingu

Status: accepted dla pierwszego wewnętrznego atomu; integracja runtime, managed FEM, GPU i kwalifikacja naukowa **NOT VERIFIED**.

Data: 16.10.2026. Punkt odniesienia źródeł: `MateuszZelent/fullmag@aa7e20a2924507ac91004f04eea3facbc81e3f91`. Ta decyzja nie rozszerza publicznego ABI ani legalności planner'a.

## Kontekst

Ścieżka trackingu używa geometrycznej, consistent metryki P1 do porównywania
nodalnych wektorów. Nie jest to operator dynamiki ani macierz uogólnionego
pencil. Obecny adapter Rustowy buduje metrykę Tet4 z kanonicznej topologii,
ale dalszy natywny provider ma udostępnić jeden dokładny, niezależny snapshot
MFEM do późniejszego połączenia ze sweepem. Macierz wymiany ważona przez
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

Snapshot nie zachowuje wskaźników do siatki, FES ani formy MFEM. Budowa
pozostaje pojedynczą jawnie żądaną operacją. Późniejszy integrator sweepu
będzie właścicielem czasu życia i cache jednego snapshotu na niezmienny
geometric domain; nie składa macierzy osobno dla każdego modu ani punktu.
Ten ADR nie dodaje jeszcze integratora, publicznego C ABI, Rust FFI,
wyboru CPU/GPU, planner capability ani fallbacku GPU.

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
- **Dodać nową publiczną funkcję ABI albo planner capability od razu:**
  odroczono do osobnego etapu obejmującego lifetime, C ABI/FFI,
  capability matrix i fallback/fail-closed GPU.

## Weryfikacja i granice

Nowy real-MFEM CTest ma sprawdzić niezależne współczynniki analityczne Tet4
i affine Wedge6 przy skalach 1 m i 1 nm, sumy wierszy równe objętości,
symetrię i mapowanie kanonicznych węzłów. Mieszany fixture z atrybutem
magnetycznym i powietrznym ma potwierdzać, że powietrzne komórki nie dodają
wkładu, a wiersz węzła wyłącznie powietrznego pozostaje w snapshotcie pusty
i zerowy; osobny przypadek odrzuca zdegenerowany Tet4. Osobne cases odrzucają
vector/P2 spaces i nieprawidłowe maski. Nowy CTest jest dołączony do
istniejącej bramki `positive-mass`; jej wcześniejszy ważony/operatorowy test
pozostaje bez zmian. Sam kod źródłowy lub zielony CTest nie dowodzi jeszcze
użycia providera przez tracking, runtime FEM/GPU ani kwalifikacji fizycznej.

Pliki tego atomu: `backends/fem/cpu/frequency_domain/modal/tracking_mass_provider.hpp/.cpp`,
`backends/fem/tests/frequency_domain/tracking_mass_provider_test.cpp` i
`backends/fem/CMakeLists.txt`. Naukowy opis i mapowanie źródeł są w
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`.
