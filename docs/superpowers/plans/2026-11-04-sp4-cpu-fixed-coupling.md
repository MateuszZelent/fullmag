# SP4: stałe sprzężenia FEM CPU i kwalifikacja artefaktów

> **Dla agentów wykonujących plan:** realizuj zadania krok po kroku zgodnie z workflow `executing-plans`. Checkboxy oznaczają sprawdzalne wyniki.

**Cel:** Zakwalifikować planowaną realizację stałych sprzężeń FEM CPU i domknąć przypięte porównanie SP4 dla FDM/FEM CPU/GPU oraz MuMax3 GPU, zachowując Zarr dla każdego biegu.

**Architektura:** Obecne kwadraturowe RHS i recovery CPU pozostają wykonywalnym oracle numerycznym oraz fallbackiem na tym samym CPU. Operatory sprzężenia należą do CPU workspace Poissona, powstają raz dla poprawnego workspace i są używane dla kolejnych stanów. Native contract uruchamia się opcjonalnie w przypiętym, stałym backendzie managed, a jego dowód pozostaje związany z tożsamością buildu i pakietu.

**Technologie:** C++20, MFEM, istniejący kontrakt FEM Poissona, Pythonowy launcher zarządzanego Docker Compose, stały backend Compose, oryginalne artefakty Zarr.

**Podstawa kontraktu:** `docs/physics/0431-fem-demag-mixed-order-potential.md` opisuje równania i realizację; niniejszy, wersjonowany plan opisuje wykonanie i bramki. Dodatkowy kontekst operacyjny stanowi `cpu-fixed-coupling-implementation-contract.md` w zachowanych raportach zadania SP4. Bazowy commit źródeł: `e3f38144cb63e5b76d90595df7d0d128e1345277`.

## Ograniczenia globalne

- Zachować równania P1 magnetyzacji/P2 potencjału, kwadratury, znaki, constraints, kolejność wyboru $M_s$, normalizację pól, finalizery energii i semantykę etapów/zapisu.
- Złożyć dokładnie trzy macierze RHS, trzy macierze recovery pola fizycznego i trzy macierze recovery pola wizualnego wraz z wymaganymi wagami i scratch. Nie przechowywać kopii COO dla każdego współczynnika.
- Cache trwały ze scratch nie może przekroczyć 640 MiB; dodatkowy peak RSS setupu R2 nie może przekroczyć 1,5 GiB. To limity eksperymentu, nie pomiary.
- Porównać cache z zachowanym oracle kwadraturowym: względny błąd L2 najwyżej $10^{-12}$ dla niezerowych fixture; bezwzględna skala pola bliskiego zeru $10^{-12}M_s$. Analizować przekroczenia bez poluzowania progów.
- W kontrolowanym porównaniu nie zmieniać Poisson `rtol=1e-12`, LLG `maxerr=1e-7`, siatki R2, integratora, kroku fizycznego ani cadence zapisu.
- Odmowa cache używa tej samej realizacji kwadraturowej CPU i zapisuje przyczynę. Nie może zmieniać GPU na CPU ani tolerancji.
- Tożsamość testu native obejmuje wymagane gate IDs, hash helpera, source snapshot i SHA rozwiązanych bibliotek. Bieżący pakiet, wspólny restore i promocja kandydata wymagają pasującego pozytywnego dowodu.
- Nowe grupy bez `--native-contract` zachowują legacy behavior; resume/recreate zachowuje już wybrany gate. Historyczne receipty bez gate nie są przepisywane i nie zaliczają dowodu gate. Bez nowego online controllera ani jednorazowego pliku request.
- Każdy bieg, także przerwany lub zakończony błędem, musi mieć własny artefakt Zarr. Fullmag zapisuje runtime Zarr; dopuszczalna jest zachowawcza kopia z potwierdzonymi hashami i pochodzeniem. MuMax3 zachowuje oryginalne table/OVF oraz wiernie przekonwertowany Zarr powiązany z hashami źródeł. Zarr częściowy pozostaje oznaczony jako niekompletny (dla StageAutosave manifest ma `complete=false`); nigdy nie kwalifikuje się go jako pełnego. Nie odtwarzać brakujących próbek ani nie nazywać rekonstrukcji z CSV oryginalnym zapisem runtime.
- Zachować oryginalne Zarr. Kopie zachowawcze i Zarr pochodne oznaczać osobno. Nie dopisywać brakujących próbek ani nie uznawać krótkich prób za pełne biegi 1 ns.
- Cache i jego wydajność pozostają `PLANNED / NOT VERIFIED` do czasu zaliczenia managed native tests i kontrolowanego A/B.

## Punkty do review

1. Signed local/true DOF i constrained FE spaces: cache musi odpowiadać istniejącej restrykcji oraz ścieżce `SetFromTrueDofs`.
2. Skalarne, nodalne i DG0/elementwise $M_s$ z maskami magnetic: zachować kolejność wyboru źródła i znaki interpolacji.
3. Zmiany geometrii bez zmiany liczby węzłów, curved `Mesh::GetNodes()`, FE-space order/constraints i periodic maps: unieważnić cache albo odmówić starego apply.
4. Historyczna gałąź P1 tetra center-gradient względem P2, mixed i curved quadrature; pola fizyczne i wizualne zachowują osobne zbiory elementów i normalizację.
5. Odmowa zasobów i przerwany native proof: nie publikować częściowych macierzy, nie zwalniać lease przy nieznanym wyniku i przechodzić wyłącznie na ten sam CPU oracle po potwierdzonej odmowie.

---

## Mapa plików i właścicieli

- **Root — managed gate i integracja:** `scripts/docker_dev.py`, `scripts/docker_dev_up.py`, `scripts/docker_volume_dev.py`, `scripts/docker_dev_codegen.py`, `scripts/docker_build_control.py`, `docker/all-in-one/backend_dev.py`, `docker/all-in-one/backend_candidate_retirement.py`, `docker/all-in-one/Dockerfile.backend`, `docker/all-in-one/Dockerfile.backend.dockerignore`, `justfile` i powiązane testy launchera/build-control. Root odpowiada też za managed execution, artefakty, porównanie końcowe, PR i cleanup.
- **Luna `sp4_cpu_thread_intent_fix` — helper kontraktu:** utworzyć lub rozszerzyć `docker/all-in-one/backend_native_contracts.py` i jego skupione testy Python. Helper pozostaje image-owned; wykonuje i waliduje wyłącznie allowlisted native contract.
- **Sol — implementacja FEM CPU:** `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp`, `demag_poisson_recovery.cpp`, `demag_poisson_dependency.cpp`, `demag_poisson_runtime.hpp`, `demag_poisson_lifecycle.cpp` tylko jeśli wymagają tego konstruktory workspace oraz `backends/fem/tests/demag_poisson_contract.cpp`.
- **Root — kwalifikacja i dowody:** receipty i wyniki porównania zapisywać tylko w przypisanych ścieżkach diagnostycznych/wyników SP4 R; zachować wszystkie istniejące oryginalne Zarr.

### Zadanie 1: dodać managed native-contract gate

**Wejścia:** Istniejący stały backend, przypięte development attempt/config, natywny target `fem_demag_poisson_contract`, helper-owned operation/build locking.

**Rezultat:** Opcjonalny, powtarzalny wybór `--native-contract fem-demag-poisson` przekazany w komendzie dla przypiętego stałego backendu oraz group inputs/config SHA; terminal receipt związany ze source snapshot, native contract/gate IDs, hashem helpera, binarium testu, rozwiązanymi bibliotekami i ich SHA, exit code oraz hashami ograniczonych logów.

- [ ] **Krok 1: przypiąć admission i zgodność testami.** Rozszerzyć testy launchera/build-control dla allowlisted contract, dokładnych pinów backend/mount/source/config, zachowania wyboru gate przez resume/recreate, zgodności dowodu dla pakietu bieżącego/wspólnego/kandydata, konfliktu aktywności/lease, utraty obserwatora oraz legacy path bez flagi. Odrzucać dowolny shell lub CMake target.
- [ ] **Krok 2: dodać ścieżkę launchera owned przez root.** Skompilować wybrany target native contract wewnątrz kanonicznego Make, przed końcowym kopiowaniem biblioteki FEM do pakietu. Po Make zweryfikować dowód kompilacji i wykonać test przed publikacją API w istniejącym stałym backendzie pod autorytatywnymi admission/build locks. Nie dodawać usługi ani online controllera. Zachować wybór gate przez resume/recreate; nowe grupy bez flagi pozostawić na legacy path.
- [ ] **Krok 3: dodać executor helpera i receipt.** W `backend_native_contracts.py` zweryfikować jedyny allowlisted target i piny, uruchomić go w managed backendzie i zwrócić terminalny dowód. Nieznane zakończenie utrzymuje lease/artefakty i nie może automatycznie ponawiać testu.
- [ ] **Krok 4: związać cache i promocję z dowodem.** Dodać wymagane gate IDs i SHA helpera do cache identity. Wymagać pozytywnego receipt zgodnego ze snapshotem i hashami rozwiązanych bibliotek przed użyciem pakietu z current/shared restore lub candidate promotion. Gdy helper jest wbudowany w image, wykonać drain i managed rebuild/recreate; sam `docker restart` nie wystarcza.
- [ ] **Krok 5: przejść skupione testy managed gate.** Uruchomić skupione testy Python launchera/helpera. Oczekiwane: da się uruchomić tylko allowlisted contract; pasujący dowód jest przyjmowany; brakujący/stary/niedopasowany dowód blokuje gated reuse/promotion; przerwane wykonanie pozostaje unknown; grupy bez flagi zachowują dotychczasową ścieżkę.
- [ ] **Krok 6: zapisać odrębny commit gate.** Commitować wyłącznie pliki Zadania 1 po osobnym sprawdzeniu staged names.

**Doprecyzowanie kolejności (06.11.2026):** Kompilacja targetu testowego po skopiowaniu biblioteki może ponownie ją podlinkować. Nazwy tymczasowe NVCC w `.strtab` mogą wtedy zmienić pełny SHA mimo identycznego kodu wykonywalnego. Nie pomijać tej różnicy ani nie osłabiać kontroli SHA. Helper zapisuje rzeczywiste argv, exit code, czas i log kompilacji oraz hashe biblioteki i testu w osobnym dowodzie `compiled`. Ten stan nie zalicza testu. Po Make bramka sprawdza snapshot CMake, zachowany log, hashe artefaktów oraz zgodność aliasu SONAME `.so.0`, po czym uruchamia samo poświadczone binarium. Zmiana helpera wymaga zgodnego obrazu grupy; testy interpretowane nie zastępują natywnego wykonania.

### Zadanie 2: cache stałych transferów RHS i recovery CPU

**Wejścia:** Kwalifikowana ścieżka managed native contract z Zadania 1 oraz bieżące implementacje `assemble_demag_poisson_rhs` i `recover_demag_poisson_field`.

**Rezultat:** Wielokrotnie używane macierze transferu należące do CPU context; pierwotna kwadraturowa ścieżka pozostaje oracle testowym i fallbackiem tego samego CPU.

- [ ] **Krok 1: dodać regresje oracle w `demag_poisson_contract.cpp`.** Porównać cache RHS i oba wyjścia recovery z dotychczasową kwadraturą na tych samych wejściach; po jednym setupie użyć dwóch stanów `m` i dwóch potencjałów oraz sprawdzić jeden build. Pola fizyczne i wizualne asertować osobno.
- [ ] **Krok 2: zbudować etapowane operatory transferu.** Dodać po trzy macierze $C^d$ dla RHS, trzy macierze $G$ dla recovery pola fizycznego i trzy $G$ dla recovery pola wizualnego, dwa wektory wag recovery i persistent component scratch do istniejących CPU workspace. Zacząć od MFEM `SparseMatrix::Add/Finalize`; jeśli zmierzony peak buildera naruszy budżet R2, zastosować deterministyczne dwupassowe CSR ze scalaniem wierszy bez zachowywania dodatkowych map/COO per wpis.
- [ ] **Krok 3: zachować kontrakty RHS i recovery.** Użyć dokładnej istniejącej kwadratury dla wybranego potential order. Zachować signed state/potential DOF, `GetRestrictionMatrix()->Mult`, essential-DOF treatment, priorytet `M_s` (elementwise/DG0, nodalne interpolowane bazą stanu, potem scalar) oraz bieżące znaki interpolacji nodalnej. Przed lokalnym recovery potencjału zastosować `GridFunction::SetFromTrueDofs`; zachować osobne zbiory elementów pola fizycznego/wizualnego, aktualną normalizację/periodic/mask i `finalize_demag_poisson_recovered_field`.
- [ ] **Krok 4: zachować każdą gałąź kwadratury.** Zachować historyczną gałąź center gradient dla `potential_order == 1 && geometry == TETRAHEDRON`, z `T.Weight()/6` i równym rozłożeniem na state DOF. P2 i inne geometrie używają dotychczasowej kwadratury. Nie zastępować trzech transferów jedną bezwarunkową parą transpozycji.
- [ ] **Krok 5: uczynić setup atomowym, a zależności pełnymi.** Staged setup przez RAII, walidować indeksy/skończoność współczynników/dodatnie wymagane wagi, publikować wyłącznie kompletne operatory, niszczyć je przed FE spaces/mesh i wykluczyć immutable maps z RK snapshots. Invalidation obejmuje wierzchołki oraz geometrię `Mesh::GetNodes()`, oba FE spaces/order/DOF maps/constraints/restrictions, signed DOF, magnetic masks, efektywne `M_s` i periodic maps. Zmiany stanu lub potencjału same nie powodują rebuild; `M_s` może unieważniać całe workspace.
- [ ] **Krok 6: testować invalidation, gałęzie i odmowę w budżecie.** Objąć P1/P2, tetra center, mixed/curved geometrię, dostępne signed/constrained fixtures, scalar/nodal/DG0 material, masks i periodic classes. Zmienić geometrię bez zmiany liczby węzłów i wymagać rebuild/refusal. Wstrzyknąć błąd staged setup i sprawdzić brak częściowej publikacji lub wiszących FE references. Gdy cache jest opcjonalnie nieobsługiwany albo przekracza budżet, sprawdzić raport przyczyny i ten sam CPU oracle.
- [ ] **Krok 7: zaliczyć managed native contract.** Wywołać allowlisted gate `fem-demag-poisson` w wybranym stałym backendzie. Oczekiwane: progi oracle przechodzą, build count dla powtarzanych stanów wynosi jeden, a receipt wiąże testowany snapshot i rozwiązane biblioteki. Niedostępne fixtures zapisać jako lukę; nie rozszerzać CPU admission.
- [ ] **Krok 8: zapisać odrębny commit cache CPU i regresji.** Commitować wyłącznie pliki Zadania 2 po osobnym sprawdzeniu staged names.

### Zadanie 3: kontrolowane krótkie A/B CPU1/2/6 przed merge i zachowanie Zarr

**Pliki:** Nowe managed run identities oraz oryginalne Zarr w diagnostycznej części R SP4; raport porównania w tej samej części diagnostycznej.

**Wejścia:** Source snapshot i receipt Zadania 2; przypięta siatka R2, stan początkowy, materiał/pole, solver i stage inputs.

**Rezultat:** Trzy osobno zidentyfikowane biegi CPU po 500 fs i pomiar względem dotychczasowego baseline, przed merge. Ten krótki A/B jest bramką poprawki, nie pełną kwalifikacją SP4.

- [ ] **Krok 1: zamrozić krotkę wejściową.** Użyć identycznego R2 mesh/hash, bitwise `m_0`, `M_s`, pola, FEM/P2 solver route, CG/AMG `rtol=1e-12`, LLG `maxerr=1e-7`, integratora, horyzontu 500 fs oraz niezmienionego timestep/output cadence. Jawnie ustawić CPU count na 1, potem 2, potem 6; w każdym receipcie sprawdzić authored/requested/resolved/effective count.
- [ ] **Krok 2: uruchomić przez managed run path.** Użyć unikalnych request/run/output identities i zachować oryginalny Zarr każdego biegu. Nie uznawać kopii lub konwersji za runtime original i nie dopisywać brakujących próbek cadence.
- [ ] **Krok 3: porównać zmierzoną pracę i naukę.** Osobno raportować setup i warmup; per-step wall, assembly, recovery, apply, solve, build/reuse, NNZ/bytes/RSS, RHS/solve count, CG iterations/residual, accepted/rejected attempts i fizyczny czas końcowy. Między liczbą wątków porównać initial/terminal fields, wszystkie osiem składowych energii, torque i terminal `m`.
- [ ] **Krok 4: zapisać zakres i niepewność.** Podawać run IDs, build/library pins, faktyczny effective thread count, okno/liczbę pomiarów i zmienność. Krótki bieg po 500 fs nie jest pełnym wynikiem SP4 1 ns. Nie deklarować przyspieszenia, jeśli pomiary tego nie wykazują.

### Zadanie 4: zakończyć SP4, porównanie MuMax3 i integrację

**Pliki:** Istniejące manifesty/porównania SP4 i oryginalne Zarr w przypisanym R; artefakty PR i CI dla brancha worktree.

**Wejścia:** Pozytywny native proof Zadania 2, krótkie A/B Zadania 3, istniejące FDM i relaxation artefacts, przypięte MuMax3 GPU accuracy 6/48.

**Rezultat:** Dowody dla wszystkich czterech par Fullmag CPU/GPU × FDM/FEM, porównanie MuMax3 GPU i artefakt Zarr dla każdego biegu. Pełne FEM A/B wykonuje się dopiero po merge i wdrożeniu przypiętego mastera.

- [ ] **Krok 1: przed merge zaliczyć bramki poprawki.** Wymagać zielonego managed native oracle i krótkiego A/B. Sprawdzić kompletny diff, notę, plan, kod, testy, receipty i dowody; uruchomić wymagane CI. Commitować i pushować branch, utworzyć PR i merge po wymaganych kontrolach.
- [ ] **Krok 2: zaktualizować i wdrożyć przypięty `master`.** Fast-forward lokalnego `master` do dokładnego merge SHA; przez właściwy managed route zbudować/wdrożyć przypięte źródła mastera. Zweryfikować, że runtime receipt wskazuje ten source snapshot i wymagane biblioteki.
- [ ] **Krok 3: uruchomić pełne FEM A/B CPU/GPU na wdrożonym masterze.** Użyć siatki R2 i pełnego horyzontu 1 ns. Każdy bieg zachowuje swój oryginalny Zarr. Bieg niekompletny lub błędny raportować ze swoim terminal status; krótka próba nigdy nie spełnia tej bramki.
- [ ] **Krok 4: wykonać końcowe porównania FDM i MuMax3.** Dla FDM CPU/GPU A/B porównać dopasowane stany końcowe, wszystkie składowe energii, torque i zapisane pola przy zgodnych czasach. Dla MuMax3 GPU accuracy 6/48, przypadków A/B, porównać wszystkie składowe energii, torque i stan końcowy przy zgodnych czasach. Zachować raw table/OVF, rozróżnić pochodne sibling Zarr i nie mylić ich z natywnymi artefaktami procesu.
- [ ] **Krok 5: uzgodnić Zarr i niepewność dla każdego run ID.** Sprawdzić zarówno zakończone, przerwane, jak i błędne biegi. Każdy ma wskazany własny oryginalny Zarr; niekompletny Zarr pozostaje oznaczony jako partial, nigdy jako completed. Brak Zarr pozostaje jawnym niespełnieniem bramki i wymaga naprawy/kwalifikowanego powtórzenia, bez fabrykowania danych. Wskazać kopie preservation i konwersje MuMax3 oddzielnie od oryginałów.
- [ ] **Krok 6: zakończyć wyłącznie cleanup tego celu.** Po końcowych receipts wykonać drain grupy zadania i kwalifikowaną retencję worktree. Zachować wszystkie oryginalne Zarr R, receipty i bezpośredni rollback; usuwać tylko zweryfikowane zasoby tego zadania po sprawdzeniu właścicieli i konsumentów.
