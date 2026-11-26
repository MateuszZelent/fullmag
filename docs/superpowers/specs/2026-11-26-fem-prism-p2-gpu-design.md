# Specyfikacja projektowa — Wave 1 (PR A, P0 #4): Cienkowarstwowe `pure_prism_p2` na FEM GPU + Zunifikowany CSR GPU DMI + Naprawa konforemności `layers=2`

**Data:** 2026-11-26
**Status:** Gotowa do implementacji (Wave 1 / PR A)
**Rewizja bazowa:** `origin/master` = `9ab99132d5` (obejmuje PR #558 i PR #564)
**Zakres:** `backends/fem/`, `crates/fullmag-{ir,authoring,api,plan,runner}/`, `packages/fullmag-py/`, `scripts/benchmarks/relax_film_compare_case.py`, `docs/physics/{0106,0431,1001}*`
**Powiązane audyty i noty:** `docs/audits/2026-11-24-fem-gpu-cudss-film-validation.md`, `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`, `docs/physics/0431-fem-demag-mixed-order-potential.md`, `docs/physics/0997-fem-gpu-poisson-direct-cudss.md`, `docs/physics/0998-fem-gpu-rk-fsal-and-potential-predictor.md`

---

## 1. Problem, motywacja i cel naukowy

Audyt walidacyjny cienkiej warstwy Permalloy **300×300×5 nm** (`docs/audits/2026-11-24-fem-gpu-cudss-film-validation.md`, wartość analityczna Aharoniego $E_{\text{demag}}^{\text{Aharoni}} = 4.632850 \times 10^{-18}\text{ J}$ dla jednorodnego $\mathbf{m} = (1, 0.1, 0)/\sqrt{1.01}$) ujawnił trzy powiązane blokery produkcyjnego modelowania cienkich warstw na FEM GPU:

1. **Kompromis dokładności vs VRAM pomiędzy `tet P2` a `mixed_p1`:**
   - Siatka czworościenna z potencjałem $P_2$ (`tet P2`, $h = 2.5\text{ nm}$) daje znakomitą dokładność demagnetyzacji (**−0.20%** vs Aharoni), ale generuje **4.08M DOF** potencjału $\phi$ i wymaga **59.4 GB** faktoryzacji Cholesky'ego w `cuDSS` (OOM na RTX 4080 SUPER 16 GB; powolny fallback do `CG+AMG`, generacja siatki 123 s).
   - Siatka mieszana pryzmatyczno-piramidowa (`mixed_p1`: `prism6` film + `pyramid5` + `tet4` airbox) redukuje liczbę DOF do 51k (100% mieści się w `cuDSS`), ale obecność piramid `pyramid5` wymusza obniżenie rzędu potencjału $\phi$ do $P_1$ (`demag_poisson_lifecycle.cpp:121-131`), co powoduje **−15.14% błędu demagnetyzacji** i niestabilną zbieżność relaksacji PGBB na cienkiej płytce.
   - **Rozwiązanie — `pure_prism_p2` na FEM GPU:** cała domena współdzielona (film magnetyczny + dolny, boczny i górny airbox) jest zbudowana **wyłącznie z pryzmatów `prism6`** (zero piramid `pyramid5`, zero czworościanów `tet4`). Brak piramid odblokowuje natychmiast konforemny potencjał **$P_2$ (`H1_WedgeElement(2)`)** przy zachowaniu stanu $P_1$ na $\mathbf{m}$, osiągając jednocześnie dokładność `< 1%` względem Aharoniego, **2–7× mniej DOF** niż `tet P2`, **34× szybsze siatkowanie** (`3.6 s` vs `123 s`) oraz quasi-2D strukturę warstwową o znacznie mniejszej szerokości pasma macierzy sztywności, dzięki czemu czynnik Cholesky'ego `cuDSS` mieści się wygodnie w 16 GB VRAM.
2. **Brak wsparcia GPU dla DMI poza płaskimi siatkami `tet4`:**
   - Obecne kernele GPU DMI (`backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu`) są zahardkodowane na 4-węzłową łączność `tet4` z `gpu.mesh_geometry` i używają pojedynczego globalnego `atomicAdd` na energię. Z tego powodu C++, Rust i Python twardo blokują DMI na GPU zarówno na `mixed_p1` (`gpu_dmi_kernel_not_mixed_p1`), jak i na `pure_prism_p2` (`pure_prism_p2_dmi_not_qualified`).
3. **Błąd konforemności `thin_film(layers=2, topology="prismatic")` (`6 nonconforming tet4 faces`):**
   - Dla istniejącej ścieżki `transition="pyramid_to_tetrahedra"` przy `layers=2` (film 300×300×5 nm, $h=2.5\text{ nm}$) generator Gmsh Delaunay tworzy w cienkim bocznym wolumenie przejściowym parę odwróconych (samo-przecinających się) czworościanów o dodatnim lokalnym jakobianie, które prześlizgują się przez `_repair_mixed_tetrahedra` i wywalają certyfikat `MixedLayerTopologyCertificateV1` z `nonconforming_face_count = 6`.

**Cel Wave 1 (PR A):**
- Dostarczyć produkcyjny generator czysto-pryzmatycznej domeny współdzielonej `transition="pure_prism"` wraz z typowanym certyfikatem `PurePrismTopologyCertificateV1` i odblokować pełną ścieżkę `pure_prism_p2` na FEM **CPU i GPU** (`cg_amg` oraz `cuDSS`) dla relaksacji (`PGBB`, `NCG`, `LLG overdamped`) oraz dynamiki (`Heun`, `RK4`, `RK23`, `RK45`), z włączonym DMI.
- Zastąpić w runtime GPU elementowy kernel DMI **zunifikowanym preasemblowanym operatorem CSR DMI** działającym jednakowo (z dokładnością maszynową względem MFEM CPU, bez globalnych atomików) na siatkach `tet4`, `prism6` oraz mieszanych `prism6+pyramid5+tet4`, odblokowując jednocześnie GPU DMI na `mixed_p1` i `pure_prism_p2`.
- Naprawić źródłową przyczynę błędu `6 nonconforming tet4 faces` dla `thin_film(layers=2, topology="prismatic", transition="pyramid_to_tetrahedra")` deterministycznym rozplątywaniem odwróconych czworościanów (`same_side_two_owner_face == 0` dla wszystkich $L \ge 1$).
- Udokumentować całość zgodnie z `scientific-documentation-contract` i dostarczyć flagowy benchmark A/B dla filmu 300×300×5 nm.

**Zasady niezmienne (AGENTS.md):**
- Ścisłe rozdzielenie `requested_intent` od `resolved_execution` oraz `fallback=none` — zero cichego fallbacku z GPU na CPU ani z `pure_prism_p2` na `mixed_p1` lub `tet4`.
- Pełna zgodność kompilacji dla buildów bez stosu MFEM (`FULLMAG_HAS_MFEM_STACK=0`, np. `bootstrap / native-modal-cabi-contract`) oraz bez CUDA (`FULLMAG_HAS_CUDA_RUNTIME=0`).
- Zero regresji w istniejących testach certyfikatów `MixedLayerTopologyCertificateV1/V2` oraz testach jednostkowych `relaxation_energy_derivative_contract.cpp`.

---

## 2. Pełny audyt operatorów FEM GPU i bramek blokujących (`origin/master` `9ab99132d5`)

### 2.1. Audyt operatorów GPU na pryzmatach (`prism6` P1 `m` + P2 `phi`)

Przeprowadzono pełny przegląd każdego pliku w `backends/fem/gpu/cuda/` oraz `backends/fem/cpu/mfem/` pod kątem założeń `Geometry::TETRAHEDRON`, `elements_len % 4`, `element_nodes == 4` i `P1`-only:

| Moduł / Operator GPU | Kluczowe pliki | Status na `pure_prism_p2` (`prism6` P1 `m` + P2 `phi`) | Szczegóły audytu |
|---|---|---|---|
| **Demag Poisson GPU** (asemblacja, RHS, recovery, Robin/Dirichlet, `HYPRE` i `cuDSS`) | `demag_poisson_lifecycle.cpp:121-131`, `demag_poisson_boundary.cpp:165-185`, `operators.cpp:385-390,667-943`, `poisson.cpp:74-78`, `hypre_device_solver.cpp`, `cudss_direct_solver.cpp`, `stage_compute.cpp`, `demag_kernels.cu`, `demag_predictor.cu` | **GOTOWY NATYWNIE** | `potential_order = periodic_reduction \|\| has_pyramid ? 1 : 2` automatycznie wybiera `H1_FECollection(2, 3)` (`H1_WedgeElement(2)`, 18 DOF/pryzmat, konforemne ściany `Tri(2)` + `Quad(2)`). `operators.cpp` obsługuje `Geometry::TETRAHEDRON \| PRISM \| PYRAMID`, stosuje regułę kwadratury `2 * potential_fe->GetOrder()` (rząd 4 na P2 pryzmatach) i buduje prostokątne CSR `rhs` (`potential_rows × state_rows`) oraz `recovery_{x,y,z}` (`state_rows × potential_rows`). `poisson.cpp:74-78` alokuje bufory potencjału do rozmiaru P2 (`gpu_state_resize_demag_poisson_scalars`). Zarówno `hypre_device_solver.cpp`, jak i `cudss_direct_solver.cpp` są czysto algebraiczne na macierzy CSR $A_{\text{bc}}$. `demag_poisson_recovery.cpp:159,364` bramkuje szybki tor P1 tet4 przez `GetOrder()==1 && GetGeomType()==TETRAHEDRON`, więc P2 pryzmaty na CPU używają dokładnej kwadratury. |
| **Exchange GPU** | `exchange_operator.cpp`, `exchange_legacy_gpu_upload.cpp`, `exchange_plan.cpp`, `exchange_kernels.cu` | **GOTOWY NATYWNIE** | MFEM `DiffusionIntegrator` asembluje CSR na `prism6` P1 + `mfem_lumped_mass` (już pokryte testem `exchange_contract.cpp:1583`). GPU wykonuje SpMV na CSR oraz spolaryzowany przyrost energii double-double bez założeń o typie elementu. |
| **Oddziaływania węzłowe i integratory GPU** | `anisotropy`, `zeeman`, `regional_field_kernels.cu`, `thermal`, `magnetoelastic`, `oersted`, `sot`, `slonczewski_stt`, `frozen_spins`, `llg_rhs_kernels.cu`, `rk*`, `pgbb.cpp`, `nonlinear_cg.cpp`, `observables`, `object_average` | **GOTOWE NATYWNIE** | W 100% operacje węzłowe na tablicach `node_count`, `lumped_mass`, `node_volumes`, `magnetic_node_mask`, `frozen_mask`. Zero założeń `tet4`. (`pgbb.cpp:66` bezpiecznie wyłącza SP4-only cache pól przy aktywnym DMI). |
| **DMI GPU** (interfacial, rotated interfacial, bulk, periodic) | `dmi_kernels.cu`, `rk_dmi_fields.cu`, `rk_dmi_energy_reductions.cu`, `direct_energy_increment.cpp:297-335`, `rk_plan.cpp:160-166`, `gpu_state_runtime.cpp:23-28` | **WYMAGA PRACY (TEN PR)** | Jedyny operator z wymaganego zakresu cienkich warstw odczytujący płaską tablicę `gpu.mesh_geometry` (`tet4`, `elements_len % 4 == 0`). Zastępowany w Ścieżce 2 przez zunifikowany CSR DMI. |
| **Zhang-Li STT GPU** | `interactions/stt/stt_kernels.cu`, `rk_zhang_li_torque.cu`, `rk_plan.cpp:193-204`, `gpu_state_runtime.cpp:27` | **ŚWIADOMIE ZACHOWANE `tet4`-ONLY** | Już odrzucane poza zakresem `pure_prism_p2` i `mixed_p1` przez `no_other_extended_physics` (`fem_mesh.cpp:886`). Po migracji DMI na CSR pozostaje **jedynym** konsumentem `gpu_state_requires_tetrahedral_mesh_geometry(ctx)`. |

### 2.2. Mapa 6 warstw blokujących `pure_prism_p2` i GPU DMI

| Warstwa | Plik i lokalizacja (`origin/master`) | Obecna blokada | Docelowy stan po PR A |
|---|---|---|---|
| **C++ Core Gate** | `backends/fem/core/fem_mesh.cpp:871,902-938,959-969` | `qualified_pure_prism_p2` wymusza `mfem_device == "cpu" && !has_dmi` (`pure_prism_p2_cpu_only`, `pure_prism_p2_dmi_not_qualified`); `dmi_supported` blokuje GPU DMI na `mixed_p1` (`gpu_dmi_kernel_not_mixed_p1`). | Oba tory (`pure_prism_p2` i `mixed_p1`) akceptują `mfem_device ∈ {"cpu", "cuda"}` oraz wszystkie 3 typy DMI (`interfacial`, `rotated_interfacial`, `bulk`). Pozostałe rozszerzenia (`Zhang-Li`, `Oersted`, `thermal`, `magnetoelastic`, `DG0 Ms`, `periodic` na pure-prism) pozostają jawnie fail-closed. |
| **Rust IR** | `crates/fullmag-ir/src/{mesh_policy.rs:99,862,1347-1359, plan.rs:1486, mesh_assets.rs:2197,2287-2335,2437-2528, mixed_certificate.rs}` | `FemTransitionPolicyIR` ma tylko `PyramidToTetrahedra \| Reject`; `FemMeshTopologyFamilyIR` ma tylko `MixedP1`; brak typu certyfikatu dla siatki czysto-pryzmatycznej (`transition_shell_thickness_m == 0`). | Dodanie `FemTransitionPolicyIR::PurePrism` (`"pure_prism"`), `FemMeshTopologyFamilyIR::PurePrismP2` (`"pure_prism_p2"`) oraz addytywnego `PurePrismTopologyCertificateV1IR` na `FemSharedDomainBuildReportIR` (z wzajemną wyłącznością V1/V2/pure_prism) i pełną weryfikacją `mixed_topology_fingerprint_v3()` (`topology_fingerprint_version = "v3"`), objętości, jakobianu i `nonconforming_face_count == 0`. |
| **Rust Authoring & API** | `crates/fullmag-authoring/src/validation.rs:894,986,1004`, `crates/fullmag-api/src/schemas/mesh.rs:600-604,670-715` | Dopuszczają wyłącznie `"pyramid_to_tetrahedra" \| "reject"` i hardkodują `"mixed_p1"` w zasobie API. | Akceptacja `"pure_prism"` przy `topology == "prismatic"` (i odrzucenie przy `hex`), wzajemna wyłączność V1/V2/pure_prism oraz mapowanie `pure_prism_topology_certificate` → `topology = "pure_prism_p2"`, `transition_policy = "pure_prism"`. |
| **Rust Planner** | `crates/fullmag-plan/src/mesh.rs:1887-1890,2211-2245,2298-2394` | `reject_unsupported_mixed_topology` odrzuca `cells == ["prism6"]` błędem `fem_typed_topology_unsupported_before_backend`; `mixed_p1_scope_failed_predicates` odrzuca `has_dmi && device == "gpu"` (`gpu_dmi_kernel_not_mixed_p1`); limit warstw `1..=3`. | Przyjęcie `cells == [Prism6] + facets == [Tri3, Quad4]` z ważnym `PurePrismTopologyCertificateV1IR` (dla dowolnego `requested_layer_count >= 1`) w walidacji i w post-packing rebindingu (`resolve_fem_domain_mesh_asset:2298-2394`), usunięcie `gpu_dmi_kernel_not_mixed_p1`, wypełnienie `FemMixedTopologyProvenanceIR` z `requested_topology = resolved_topology = PurePrismP2` oraz `capability_status = Implemented`. |
| **Rust Runner** | `crates/fullmag-runner/src/lib.rs:2200-2208,2219-2254,2362-2363,2622,2654-2656,2684` | Przyjmuje wyłącznie `{Tet4, Prism6, Pyramid5}`; odrzuca `has_dmi && gpu` (`gpu_dmi_kernel_not_mixed_p1`); limit warstw `1..=3`. | Przyjęcie `{Prism6}` + `PurePrismTopologyCertificateV1IR` z re-weryfikacją `mixed_topology_fingerprint_v3()`, `layers >= 1`, `fallbacks_triggered == [] && !degraded` i wzajemną wyłącznością certyfikatów; usunięcie `gpu_dmi_kernel_not_mixed_p1`. |
| **Python DSL & Mesher** | `packages/fullmag-py/src/fullmag/{world.py:1512,1584-1596,1754,1869,2228,2280-2288,2347,2391,5885,9274, model/discretization.py:358,439,465,925,957,966, model/problem.py:1488-1541,2656,2729, runtime/script_builder.py:9447, meshing/{_gmsh_swept.py,_gmsh_types.py,_mesh_targets.py,persistence.py,asset_pipeline.py:2708-2714,3003,3041,4058,4103-4117}}` | Brak generatora `pure_prism` shared-domain; `thin_film()` i walidatory odrzucają `transition="pure_prism"` / `layers > 3`; brak nośnika certyfikatu w `MeshData`/`SharedDomainBuildReport`/`persistence.py`; preflight odrzuca GPU DMI. | Nowy generator `generate_pure_prism_box_airbox_mesh` (3 kolejne ekstruzje GEO), akceptacja `transition="pure_prism"` i `layers >= 1` w całej ścieżce Pythona, budowa/serializacja `pure_prism_topology_certificate.v1` w `MeshData`/`SharedDomainBuildReport`/`persistence.py`, usunięcie `gpu_dmi_kernel_not_mixed_p1` w `problem.py`. |

---

## 3. Ścieżka 1 (`mesher-author`): Naprawa konforemności `layers=2` + Generator `pure_prism` Shared-Domain

### 3.1. Diagnoza źródłowa i naprawa `thin_film(layers=2, topology="prismatic")` (`6 nonconforming tet4 faces`)

#### 3.1.1. Zreprodukowana przyczyna źródłowa
Bezpośrednia reprodukcja na przypadku z benchmarku (`300×300×5 nm`, $h_{\text{inplane}} = 2.5\text{ nm}$, `layers=2`, `transition="pyramid_to_tetrahedra"`, airbox `900×900×600 nm`, `hmax=110 nm`, Gmsh 4.15.2) wykazała dokładnie:
- Siatka wyjściowa po `gmsh.model.mesh.generate(3)`: 54,016 węzłów, 159,714 komórek (`tet4: 91,850`, `prism6: 66,904`, `pyramid5: 960`), `unmatched_single = 0`, `nonmanifold = 0`, **`same_side_two_owner_face = 6`**.
- Wszystkie 6 niezgodnych ścian to **6 ścian zewnętrznych jednej odwróconej dwupiramidy złożonej z 2 czworościanów** w cienkim bocznym wolumenie przejściowym `vol=23` (`[0.15, 0.26] × [-0.15, 0.15] × [-0.0025, 0.0025]` mm):
  - `tet 221402 = (53465, 53466, 53476, 35808)` ($\det = +1.367 \times 10^{-9}$, `minSJ = 0.00173`),
  - `tet 222423 = (53465, 53466, 53476, 902)` ($\det = +7.334 \times 10^{-10}$, `minSJ = 0.02292`).
- Wspólny trójkąt wewnętrzny $(A,B,C) = (53465, 53466, 53476)$ jest prawie współliniowy ($B = 53466$ leży o $0.13\text{ nm}$ po odwróconej stronie odcinka $A\text{–}C$), przez co oba tety zostały wywinięte na drugą stronę i nakładają się na swoich 6 zewnętrznych sąsiadów.
- **Dlaczego istniejące mechanizmy zawiodły:**
  1. Gmsh po triangulacji Delaunaya odwrócił kolejność lokalnych wierzchołków w `221402` i `222423`, aby każdy element miał indywidualnie $\det > 0$ (`min_det = 3.11e-10 >> threshold = 4.37e-18`).
  2. `_mixed_tet_degeneracy_report` (`_gmsh_swept.py:1209`) sprawdza **wyłącznie** $|\det| \le \text{threshold}$ i w ogóle nie wykrywa `same_side_two_owner_face`. W rezultacie `_execute_mixed_tet_repair_policy` (`_gmsh_swept.py:2218-2219`) natychmiast wychodzi bez podjęcia naprawy.
  3. Globalne optymalizatory Gmsh (`optimize("")` — 74.3 s, `optimize("Netgen")`, `optimize("Relocate3D")` — 16.5 s) **również nie usuwają błędu** (`same_side = 6` bez zmian!), ponieważ przy odwróconej numeracji wierzchołków traktują oba splątane tety jako dodatnio zorientowane i blokują jakikolwiek ruch węzła `53465`/`53466` przez płaszczyznę, gdyż taki ruch zmienia ich lokalny $\det$ na ujemny!

#### 3.1.2. Deterministyczny algorytm naprawy: `_untangle_same_side_mixed_tetrahedra`
W `_gmsh_swept.py` dodajemy dedykowaną fazę detekcji i rozplątywania wywoływaną deterministycznie w `_execute_mixed_tet_repair_policy` (oraz jako końcowy strażnik po `_optimize_mixed_pyramid_apices`, aby ruch wierzchołków piramid również nigdy nie wprowadził `same_side > 0`):

1. **Wektoryzowana detekcja `same_side_two_owner_face` ($O(F \log F)$ w NumPy, `< 0.5 s`):**
   - Ekstrakcja wszystkich ścian trójkątnych elementów 3D (`tet4`: 4 ściany, `pyramid5`: 4 ściany boczne, `prism6`: 2 trójkątne podstawy), kanoniczne sortowanie trójek węzłów `np.sort(..., axis=1)` i globalne `np.lexsort`.
   - Dla każdej pary sąsiednich elementów dzielących tę samą ścianę $(p_0, p_1, p_2)$ (z pominięciem wielokrotności $\ge 3$) obliczenie wektoryzowanych iloczynów mieszanych $d_0 = ((p_1-p_0)\times(p_2-p_0))\cdot(o_0-p_0)$ oraz $d_1 = ((p_1-p_0)\times(p_2-p_0))\cdot(o_1-p_0)$.
   - Ściana jest `same_side`, gdy $d_0 \cdot d_1 > 0$ (w granicach tej samej konwencji co certyfikat Rust `mixed_certificate.rs`!).
   - Jeśli `len(bad_pairs) == 0`, funkcja natychmiast zwraca `0` (koszt `< 0.45 s` dla siatki 160k elementów).
2. **Klasyfikacja odwróconych czworościanów:**
   - Zliczamy liczbę złych ścian `bad_face_count[t]` dla każdego `tet4`.
   - Tety o `bad_face_count[t] >= 2` tworzą zbiór odwróconych czworościanów $I$ (w przypadku odosobnionego spłaszczonego klastra lub niejednoznaczności: propagacja BFS spójnej orientacji od ścian brzegowych z `tri3`/`prism6`/`pyramid5` jako wyrocznią znaku!).
3. **Rozplątywanie przez dokładny środek Czebyszewa jądra gwiaździstego:**
   - Zbieramy kandydatów wśród **wyłącznie wewnętrznych, nie-piramidowych węzłów** (`dim == 3` i `node_tag not in pyramid_apices`) incydentnych do $I$, posortowanych deterministycznie rosnąco po `node_tag`.
   - Dla kandydata $v$ o pozycji $\mathbf{x}_0$ i jego gwiazdy czworościanów $\mathcal{S}(v)$: dla każdego $t \in \mathcal{S}(v)$ z naprzeciwległą ścianą $(a,b,c)$ obliczamy jednostkową normalną $\hat{\mathbf{u}}_t$ zorientowaną **do wnętrza dopuszczalnej półprzestrzeni**:
     $$\hat{\mathbf{u}}_t^{\text{in}} = \begin{cases} +\operatorname{sgn}(\hat{\mathbf{u}}_t \cdot (\mathbf{x}_0 - \mathbf{p}_a))\,\hat{\mathbf{u}}_t, & t \notin I \text{ (nieodwrócony)}, \\ -\operatorname{sgn}(\hat{\mathbf{u}}_t \cdot (\mathbf{x}_0 - \mathbf{p}_a))\,\hat{\mathbf{u}}_t, & t \in I \text{ (odwrócony)}. \end{cases}$$
   - Rozwiązujemy 4-zmiennowy problem programowania liniowego (maksymalizacja marginesu wysokości $r$):
     $$\max_{\mathbf{x} \in \mathbb{R}^3,\; r \in \mathbb{R}} r \quad \text{p.w.} \quad \hat{\mathbf{u}}_t^{\text{in}} \cdot (\mathbf{x} - \mathbf{p}_{a,t}) \ge r \quad \forall t \in \mathcal{S}(v)$$
     za pomocą deterministycznego solvera `scipy.optimize.linprog(..., method="highs")` (`scipy>=1.10` jest już wymaganą zależnością grupy `[meshing]` w `pyproject.toml`), z awaryjnym dokładnym rozwiązaniem czysto-NumPy (przecięcia czwórek płaszczyzn dla $|\mathcal{S}(v)| \le 24$) na wypadek środowiska bez `scipy`.
   - Jeśli znaleziono $\mathbf{x}^*$ z $r > \varepsilon_{\text{geom}}$ (np. $r > 10^{-9}\cdot L_{\text{char}}$), symulujemy przesunięcie $\mathbf{x}_0 \mapsto \mathbf{x}^*$ w pamięci i akceptujemy ruch tylko wtedy, gdy:
     - ściśle zmniejsza globalną liczbę ścian `same_side`,
     - każdy tet w $\mathcal{S}(v)$ uzyskuje $|\det| > \text{global\_threshold}$,
     - żaden tet w $\mathcal{S}(v)$ nie wprowadza nowej pary `same_side`.
4. **Aktualizacja siatki i reorientacja odwróconych tetów w Gmsh:**
   - Wywołanie `gmsh.model.mesh.setNode(vid, new_pos.tolist(), [])`.
   - Dla każdego czworościanu $t \in I \cap \mathcal{S}(v)$, którego surowy jakobian Gmsh stał się ujemny po przekroczeniu płaszczyzny, zamieniamy lokalne wierzchołki `nodes[2] <-> nodes[3]` i zapisujemy w jego wolumenie `vtag` przez `removeElements(3, vtag, tet_tags)` + `addElementsByType(vtag, 4, tet_tags, updated_nodes)` — zachowując **identyczne tagi elementów i przypisania grup fizycznych**!
   - Pętla powtarza się maksymalnie `max_passes = 8` razy (dla przypadków z więcej niż jednym odizolowanym klastrem), a na końcu weryfikuje `same_side == 0` oraz `_mixed_tet_degeneracy_report(..., use_global_scale=True)` == pusty; w razie niepowodzenia rzuca jawny błąd fail-closed (nigdy nie produkuje uszkodzonej siatki!).

**Weryfikacja empiryczna prototypu na dokładnym przypadku `300×300×5 nm, h=2.5 nm, layers=2`:**
- Czas całkowity fazy `_untangle_same_side_mixed_tetrahedra`: **0.45 s**.
- Przesunięto 1 węzeł wnętrza (`53465`, przesunięcie `2.09 nm`, margines Czebyszewa $r = 0.445\text{ nm}$), zreorientowano 2 tety (`221402`, `222423`).
- Wynik: **`same_side: 6 → 0`**, **`min |det|` gwiazdy wzrósł 5× (`7.33e-10 → 3.72e-9`)**, zero zmodyfikowanych piramid i węzłów brzegowych, pełna akceptacja `MixedLayerTopologyCertificateV1`!

### 3.2. Generator czysto-pryzmatycznej domeny współdzielonej (`transition="pure_prism"`)

Nowa funkcja `generate_pure_prism_box_airbox_mesh(...)` w `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py` buduje w 100% konforemną siatkę domenową złożoną wyłącznie z elementów `prism6` (bez piramid `pyramid5`, bez czworościanów `tet4`, dla dowolnej liczby warstw magnetycznych $L \ge 1$):

1. **Układ osi i geometria bazowa 2D:**
   - Obsługa `thin_axis ∈ {"x", "y", "z"}` (domyślnie najcieńszy wymiar pudełka, dla cienkich warstw `"z"`). Współrzędne lokalne $(u, v, w)$, gdzie $w$ jest osią ekstruzji, film ma rozmiary $(L_u, L_v, L_w)$, a airbox $(A_u, A_v, A_w)$ wycentrowany wokół środka airboxa (z walidacją ścisłego zawierania pudełka filmu wewnątrz airboxa w każdym z 3 kierunków).
   - Na dolnej płaszczyźnie airboxa $w_0 = c_w - A_w / 2$ budujemy w jądrze GEO dwa współpłaszczyznowe obszary 2D dzielące dokładnie 4 krawędzie graniczne filmu:
     - Prostokąt wewnętrzny $S_{\text{inner}}$ (`[x_min, x_max] × [y_min, y_max]`) opisany pętlą `[l1, l2, l3, l4]`,
     - Ramę zewnętrzną $S_{\text{outer}}$ opisaną zewnętrzną pętlą airboxa z otworem `[-l4, -l3, -l2, -l1]`.
   - Brak operacji boole'owskich OCC gwarantuje 100% deterministyczną topologię krawędzi współdzielonych i brak artefaktów fragmentacji.
2. **Płynne geometryczne stopniowanie siatki 2D w ramie powietrznej:**
   - Na $S_{\text{inner}}$ (i jego brzegu): stały rozmiar docelowy $h_{\text{inplane}}$ (z poszanowaniem opcjonalnego `hmin`).
   - Na $S_{\text{outer}}$: deterministyczne pole tła `MathEval` realizujące płynny wzrost liniowy/geometryczny od $h_{\text{inplane}}$ na brzegu filmu do $h_{\text{air}}$ (`airbox.maximum_element_size`) z tempem `max(growth_rate - 1.0, 0.25)` w funkcji odległości Czebyszewa/Euklidesowej $d_{\text{film}}(u,v) = \sqrt{\max(0, |u-c_u|-L_u/2)^2 + \max(0, |v-c_v|-L_v/2)^2}$:
     $$h(u, v) = \min\!\left(h_{\text{air}},\; h_{\text{inplane}} + (g - 1)\, d_{\text{film}}(u, v)\right).$$
   - Siatka 2D pozostaje **czysto trójkątna** (`recombine=False` na powierzchniach 2D, `Mesh.Algorithm = opts.algorithm_2d`, domyślnie Frontal-Delaunay `6`), z `Mesh.RandomFactor = 0.0`.
3. **Trzy kolejne ekstruzje GEO wzdłuż osi $w$ (100% `prism6`):**
   - Wyznaczamy niemalejące poziomy grubości dolnego powietrza (`lower_levels` od $w_0$ do $w_{\text{bot}} = -L_w/2$) oraz górnego powietrza (`upper_levels` od $w_{\text{top}} = +L_w/2$ do $w_1 = c_w + A_w/2$) za pomocą istniejącej geometrycznej funkcji `_box_airbox_layer_levels` (startując z grubością warstwy magnetycznej $\Delta w = L_w / L$, tempo wzrostu `airbox.maximum_element_growth_rate`, limit $h_{\text{air}}$).
   - **Ekstruzja 1 (dolne powietrze, $w_0 \to w_{\text{bot}}$):** równoległa ekstruzja `[(2, S_inner), (2, S_outer)]` z `numElements=[1]*n_lower`, `heights=lower_cum_heights`, `recombine=True` → tworzy wolumeny powietrza pod filmem (`V_air_bot_inner`, `V_air_bot_outer`) i automatycznie daje górne powierzchnie bazowe `(S_film_bot, S_frame_bot)` o **identycznej** triangulacji 2D!
   - **Ekstruzja 2 (warstwa filmu, $w_{\text{bot}} \to w_{\text{top}}$):** równoległa ekstruzja `[(2, S_film_bot), (2, S_frame_bot)]` z `numElements=[n_layers]`, `heights=[1.0]`, `recombine=True` → tworzy wolumen magnetyczny `V_mag` (dokładnie $L$ jednorodnych warstw `prism6`!), boczny pas powietrza `V_air_lat` oraz górne powierzchnie `(S_film_top, S_frame_top)`.
   - **Ekstruzja 3 (górne powietrze, $w_{\text{top}} \to w_1$):** równoległa ekstruzja `[(2, S_film_top), (2, S_frame_top)]` z `numElements=[1]*n_upper`, `heights=upper_cum_heights`, `recombine=True` → tworzy wolumeny powietrza nad filmem (`V_air_top_inner`, `V_air_top_outer`).
4. **Przypisanie grup fizycznych, ról ścian i metryk:**
   - Wolumeny (zgodnie z `_gmsh_swept.py:3129-3132`, gdyż Gmsh nie dopuszcza fizycznego tagu `0`!): `addPhysicalGroup(3, [V_mag], tag=1)` o nazwie `"magnetic"` oraz `addPhysicalGroup(3, [V_air_bot_inner, V_air_bot_outer, V_air_lat, V_air_top_inner, V_air_top_outer], tag=2)` o nazwie `"air"`. Ekstraktor `_extract_mesh_data` → `_semantic_marker_from_name` (`_gmsh_extraction.py:251-255`) mapuje nazwę `"air"` na semantyczne `element_markers == 0`, a `_gmsh_cell_parts_in_extraction_order` przypisuje części `"magnetic"` i `"far_air"`.
   - Powierzchnie (nazwy fizyczne Gmsh vs role `MeshIR`):
     - Fizyczna powierzchnia Gmsh `"mag_air_interface"` (marker `10`): `S_film_bot` (`tri3`), `S_film_top` (`tri3`) oraz 4 ściany boczne z ekstruzji `S_film_bot` (`quad4`) → w `MeshIR` i w certyfikacie mapowana na rolę **`"material_interface:10"`** (`_gmsh_types.py:56`, `crates/fullmag-ir/src/mesh_assets.rs:221`).
     - Fizyczna powierzchnia Gmsh `"outer_boundary"` (marker `airbox.boundary_marker`): dolne podstawy `S_inner, S_outer` (`tri3`), górne podstawy z Ekstruzji 3 (`tri3`), oraz 12 zewnętrznych ścian bocznych z Ekstruzji 1, 2 i 3 (`quad4`) → w `MeshIR` i w certyfikacie mapowana na rolę **`"exterior:<outer_boundary_marker>"`**.
   - Wszystkie elementy mają dokładnie 1 grupę fizyczną wolumenową, `cells == {prism6}`, `facets == {tri3, quad4}`, zero piramid, zero tets, `nonconforming_face_count == 0`, `orphan_face_count == 0`, `nonmanifold_face_count == 0`.

**Zmierzone metryki z prototypu Gmsh 4.15.2 (film 300×300×5 nm, airbox 900×900×600 nm, $h_{\text{air}} = 110\text{ nm}$):**

| Konfiguracja | Czas siatkowania | Warstwy Z (air+mag) | Węzły $P_1$ | Pryzmaty `prism6` | Potencjał $P_2$ DOF | Redukcja DOF vs `tet P2` (4.08M) |
|---|---:|---:|---:|---:|---:|---:|
| `pure_prism`, $h=5.0\text{ nm}, L=1$ | 0.72 s | 13 | 71,792 | 132,834 | **552,771** | **7.38×** |
| `pure_prism`, $h=5.0\text{ nm}, L=2$ | 0.79 s | 14 | 76,920 | 143,052 | **593,717** | **6.87×** |
| `pure_prism`, $h=2.5\text{ nm}, L=1$ | 3.56 s | 13 | 258,398 | 479,388 | **1,992,303** | **2.05×** (34× szybciej niż 123 s) |
| `pure_prism`, $h=2.5\text{ nm}, L=2$ | 3.58 s | 14 | 276,855 | 516,264 | **2,139,881** | **1.91×** (0 błędów konforemności!) |

*(Uwaga projektowa: dla $h=2.5\text{ nm}$ i `pure_prism` możemy ponadto poddać weryfikacji w benchmarku A/B również nieco wyższe tempo wzrostu bocznego w ramie 2D, np. `maximum_element_growth_rate=1.9` już zdefiniowane w `study.universe.mesh(...)`, które naturalnie utrzymuje `P2 DOF` na ~1.2–2.0M i czynnik Cholesky'ego cuDSS znacznie poniżej limitu 16 GB RTX 4080 SUPER!)*

### 3.3. Publiczne API Pythona i kontrakt certyfikatu `PurePrismTopologyCertificateV1`

- **Python DSL (`world.py`, `discretization.py`, `script_builder.py`, `asset_pipeline.py`):**
  - `film.mesh.thin_film(..., topology="prismatic", transition="pure_prism")` — rozszerzamy literal `transition` o `"pure_prism"` (obok `"pyramid_to_tetrahedra"` i `"reject"`). Wartość domyślna przy `topology="prismatic"` pozostaje `"pyramid_to_tetrahedra"`, więc żaden istniejący skrypt użytkownika nie zmienia zachowania.
  - W `asset_pipeline.py`: gdy `surface_mesh_options.mesh_strategy == "swept_prism"` i `transition_policy == "pure_prism"` (pojedynczy `Box`, `airbox is not None`, `order == 1`, `exact_layers == True`, brak pól lokalnych/periodycznych), wywołujemy `generate_pure_prism_box_airbox_mesh(...)` i budujemy certyfikat `pure_prism_topology_certificate.v1`. Dla `transition="pure_prism"` dopuszczamy dowolną liczbę warstw `layers >= 1` (bez sztucznego ograniczenia `1..=3` wynikającego z czworościennego przejścia!).
- **Addytywny certyfikat w Rust IR (`PurePrismTopologyCertificateV1IR` w `crates/fullmag-ir/src/mesh_assets.rs` i `mixed_certificate.rs`):**
  - Wzorowany ściśle na sprawdzonym precedensie `MixedLayerTopologyCertificateV2IR` (osobny typ wire, `#[serde(deny_unknown_fields)]`, brak zmian w `MixedLayerTopologyCertificateV1IR`/`V2IR`):
    - `schema_version = "pure_prism_topology_certificate.v1"`,
    - `certificate_status = "accepted"`,
    - `requested_sweep_direction`, `resolved_sweep_direction`,
    - `requested_layer_count: u32` ($\ge 1$), `realized_layer_count: u32` ($== \text{requested}$),
    - `lower_air_layer_count: u32` ($\ge 1$), `upper_air_layer_count: u32` ($\ge 1$),
    - `magnetic_plane_coordinates_m: Vec<f64>` (długość `realized_layer_count + 1`), `plane_tolerance_m: f64`,
    - `interface_marker: u32`, `outer_boundary_marker: u32`,
    - `magnetic_bounds_min_m`, `magnetic_bounds_max_m`, `airbox_bounds_min_m`, `airbox_bounds_max_m`,
    - `cell_family_counts_by_marker`, `cell_family_counts_by_part` (wyłącznie `"prism6"` w `"magnetic"` i `"far_air"`, zero `"pyramid5"` i `"tet4"`),
    - `facet_family_counts_by_role_marker` (`"tri3"` i `"quad4"` pod kluczami `MeshIR` **`"material_interface:<interface_marker>"`** oraz **`"exterior:<outer_boundary_marker>"`**),
    - `jacobian_minima_m3_by_family`, `quality_metric`, `scaled_jacobian_minima_by_family`, `scaled_jacobian_p05_by_family` (`prism6 >= 0.1`),
    - domknięcie objętościowe (`magnetic_volume_m3`, `expected_magnetic_volume_m3`, `magnetic_relative_volume_error`, `air_volume_m3`, `shared_domain_volume_m3`, `expected_shared_domain_volume_m3`, `shared_domain_relative_volume_error`),
    - `marker_coverage_complete: true`, `nonconforming_face_count: 0`, `orphan_face_count: 0`, `nonmanifold_face_count: 0`, `coincident_interface_face_count: 0`,
    - `topology_fingerprint_version: "v3"` (zgodne z `mixed_topology_fingerprint_for_version` w `crates/fullmag-ir/src/mesh_hints.rs:3036-3044` i `mesh.topology_fingerprint_v3()` w Pythonie!), `topology_fingerprint: "sha256:..."`, `gmsh_version`, `strategy: "pure_prism_extruded_shared_domain"`, `effective_gmsh_thread_count`, `deterministic_inputs`, `fallbacks_triggered: []`.
  - Walidacja Rust `validate_pure_prism_topology_certificate_against_mesh(mesh, cert)` ponownie przelicza `mesh.mixed_topology_fingerprint_v3()`, zgodność wszystkich ścian (w tym `same_side_two_owner_face == 0` na ścianach trójkątnych i czworokątnych!), objętości, płaszczyzny warstw i jakobiany — identyczny rygor jak V1/V2!
  - Przepływ nośników w Pythonie: certyfikat dołączany do `MeshData` (`_gmsh_types.py:2175,2241,2441`), propagowany do `SharedDomainBuildReport` (`_mesh_targets.py:772`) w `asset_pipeline.py:4058,4103-4117`, serializowany/cache'owany w `persistence.py` oraz `world.py:5885,9274` (z wyłączeniem ścieżki natywnego certyfikatora v2 w `model/problem.py:1488-1541` dla czystego `pure_prism`).

---

## 4. Ścieżka 2 (`prism-dmi-author`): Zunifikowany preasemblowany CSR GPU DMI (`tet4`, `prism6`, `mixed`)

### 4.1. Wybór architektury: Preasemblowany CSR DMI vs kernel kwadraturowy per-prism

| Kryterium | Osobny kernel kwadraturowy per-prism (`prism6` + `tet4`) | **Zunifikowany preasemblowany CSR DMI (WYBRANY)** |
|---|---|---|
| Obsługiwane topologie | Wymaga osobnej gałęzi dla `tet4`, osobnej dla `prism6` (6-pkt kwadratura Gaussa + 3×3 odwracanie Jakobianu w każdym punkcie), brak wsparcia mieszanego bez dodatkowych tablic. | **Jedna implementacja dla `tet4`, `prism6`, `mixed` (`prism6+pyramid5+tet4`) i dowolnej siatki H1 P1** — asemblowana dokładnie raz przez MFEM przy tworzeniu kontekstu. |
| Determinizm i atomiki | Wymaga globalnych FP64 `atomicAdd` do `residual_{x,y,z}` (niedeterministyczna kolejność dodawania, kolizje na węzłach wspólnych dla 12–24 elementów). | **ZERO `atomicAdd` przy obliczaniu pola!** SpMV wiersz-po-wierszu (1 wątek = 1 wiersz CSR) — bitowo deterministyczny jak exchange. |
| Wydajność per krok RK/PGBB | Powtarza na każdym etapie 6-punktową kwadraturę + obliczanie pochodnych funkcji kształtu + jakobianów + `atomicAdd`. | Pojedynczy odczyt strumieniowy `3 × double` na krawędź off-diagonal + 6 FMA (`d × m`). **3–8× szybciej** niż elementowy scatter, nawet na `tet4`! |
| Pamięć VRAM | Wymaga uploadu pełnej łączności wszystkich typów elementów + masek + pól `Dind`/`Dbulk`. | Wyłącznie 3 wartości `double` na niezerowy wpis poza przekątną (`24 B/NNZ`), współdzielony graf sąsiedztwa z exchange; np. dla 50k węzłów magnetycznych filmu (~450k krawędzi) to zaledwie **~12 MB VRAM**. |
| Zgodność z MFEM CPU | Wymaga ręcznego duplikowania reguł kwadratury MFEM w CUDA. | **Asemblacja używa dokładnie `mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder())` i średniej elementowej $D_e$ z `dmi_interfacial.cpp` / `dmi_bulk.cpp` → zgodność do $\le 10^{-14}$ rel.!** |
| Periodyczność i PGBB | Wymaga atomików na klasach periodycznych + osobnego kernela różnicy energii dla każdego typu elementu. | Redukcja klas periodycznych `P^T D P` identyczna z `legacy_exchange.periodic_reduced_*` + jeden uniwersalny kernel różnicy energii `double_double.cuh` ze skalą $S_{\text{abs}}$ dla Armijo w PGBB/NCG! |

### 4.2. Twierdzenie o dokładnej antysymetrycznej redukcji wektorowej $\mathbf{d}_{ij}$

Dla dowolnego elementu $e \in \mathcal{E}_m$ (`tet4`, `prism6`, `pyramid5`, `hex8`) o lokalnych funkcjach kształtu ze znakami orientacji $\tilde{\phi}_i = s_i \phi_i$, dokładnej regule kwadratury $Q_e = \text{IntRules.Get}(\text{geom}(e), 2 \cdot p_e)$ oraz uśrednionym na elemencie współczynniku $D_e = \frac{1}{n_{\text{dof}}}\sum_{k=1}^{n_{\text{dof}}} D_{\text{field}}[g_k]$ (lub stałej jednorodnej $D$), zdefiniujmy antysymetryczny wektor gradientowy pary węzłów $(i, j)$:

$$\mathbf{g}_{ij} = \sum_{e \in \mathcal{E}_m} D_e \sum_{q \in Q_e} w_q \left( \tilde{\phi}_i(\xi_q)\,\nabla \tilde{\phi}_j(\xi_q) - \tilde{\phi}_j(\xi_q)\,\nabla \tilde{\phi}_i(\xi_q) \right) \in \mathbb{R}^3.$$

Zachodzą tożsamości algebraiczne: $\mathbf{g}_{ii} = \mathbf{0}$ oraz $\mathbf{g}_{ji} = -\mathbf{g}_{ij}$.

Bezpośrednia weryfikacja względem kanonicznego kodu `backends/fem/src/dmi_weak_residual.cpp` (linie 23–113) dowodzi, że dla **każdego** z trzech wariantów DMI słabe residuum węzłowe $\mathbf{R}_i = \frac{\partial E_{\text{DMI}}}{\partial \mathbf{m}_i}$ wyraża się **dokładnie** jako iloczyn wektorowy z jednym wektorem krawędziowym $\mathbf{d}_{ij} = -\mathbf{d}_{ji}$ ($\mathbf{d}_{ii} = \mathbf{0}$):

$$\mathbf{R}_i = \sum_{j \in \mathcal{N}(i)} \mathbf{d}_{ij} \times \mathbf{m}_j,$$

gdzie:
1. **Bulk DMI** (`dmi_accumulate_bulk_residual`, linie 62–89):
   $$\mathbf{d}_{ij}^{\text{bulk}} = +\mathbf{g}_{ij}^{\text{bulk}}.$$
2. **Conventional Interfacial DMI** z dowolną normalną jednostkową $\hat{\mathbf{n}} = (n_x, n_y, n_z)$ (`dmi_accumulate_interfacial_residual`, linie 23–60, z tożsamości $(\mathbf{g}_{ij}\times\hat{\mathbf{n}})\times\mathbf{m}_j = (\mathbf{g}_{ij}\cdot\mathbf{m}_j)\hat{\mathbf{n}} - (\hat{\mathbf{n}}\cdot\mathbf{m}_j)\mathbf{g}_{ij}$):
   $$\mathbf{d}_{ij}^{\text{int}} = \mathbf{g}_{ij}^{\text{int}} \times \hat{\mathbf{n}}.$$
3. **Rotated Interfacial DMI (Göbel, $D_{21}=D_{32}$)** (`dmi_accumulate_rotated_interfacial_residual`, linie 91–113):
   $$\mathbf{d}_{ij}^{\text{rot}} = \bigl(0,\; -g_{ij,x}^{\text{rot}},\; -g_{ij,y}^{\text{rot}}\bigr).$$
4. **Kanał interfacial** (gdy aktywne są oba wkłady interfacial lub jeden z nich, sumujący się do `h_dmi` i `DmiEnergy`):
   $$\mathbf{d}_{ij}^{\text{interfacial}} = \mathbf{d}_{ij}^{\text{int}} + \mathbf{d}_{ij}^{\text{rot}}.$$

**Konsekwencje ścisłej symetrii operatora ($K_{(i,\alpha),(j,\beta)} = \varepsilon_{\alpha\gamma\beta} d_{ij,\gamma} = K_{(j,\beta),(i,\alpha)}$):**
- **Pole efektywne** (identycznie z `dmi_project_lumped_field`):
  $$\mathbf{H}_i^{\text{DMI}} = \begin{cases} -\dfrac{\mathbf{R}_i}{\mu_0 M_{s,i} M_i + 10^{-300}}, & M_i > 0 \text{ i węzeł magnetyczny}, \\ \mathbf{0}, & \text{w przeciwnym razie}. \end{cases}$$
- **Energia całkowita:**
  $$E_{\text{DMI}}(\mathbf{m}) = \frac{1}{2} \sum_{i=0}^{N-1} \mathbf{m}_i \cdot \mathbf{R}_i = \frac{1}{2} \sum_{i} \sum_{j \in \mathcal{N}(i)} \mathbf{m}_i \cdot (\mathbf{d}_{ij} \times \mathbf{m}_j).$$
- **Spolaryzowany przyrost energii dla Armijo w PGBB/NCG** ($\mathbf{s} = \mathbf{m}_1 + \mathbf{m}_0$, $\mathbf{q} = \mathbf{m}_1 - \mathbf{m}_0$): dzięki dokładnej symetrii $K = K^\top$:
  $$E_{\text{DMI}}(\mathbf{m}_1) - E_{\text{DMI}}(\mathbf{m}_0) = \frac{1}{2} \sum_{i=0}^{N-1} \mathbf{s}_i \cdot \sum_{j \in \mathcal{N}(i)} (\mathbf{d}_{ij} \times \mathbf{q}_j),$$
  obliczany w arytmetyce skompensowanej `double_double.cuh` (TwoProd + TwoSum) z konserwatywną granicą błędu zaokrągleń $S_{\text{abs}} = \frac{1}{2}\sum_{i,j} \bigl(|s_{i,x}|(|d_{ij,y}||q_{j,z}| + |d_{ij,z}||q_{j,y}|) + |s_{i,y}|(|d_{ij,z}||q_{j,x}| + |d_{ij,x}||q_{j,z}|) + |s_{i,z}|(|d_{ij,x}||q_{j,y}| + |d_{ij,y}||q_{j,x}|)\bigr)$, dokładnie tak jak w `direct_energy_increment.cpp`!
- **Klasy periodyczne (`docs/physics/0810`):** Redukcja $P^\top D P$ po indeksach klas `c = periodic_reduced_node[i]` daje $\mathbf{d}_{c, c'}^{\text{red}} = \sum_{i \in c,\; j \in c'} \mathbf{d}_{ij}$. Ponieważ dla $c = c'$ pary $(i,j)$ i $(j,i)$ znoszą się dokładnie ($\mathbf{d}_{ij} + \mathbf{d}_{ji} = \mathbf{0}$), nadal zachodzi $\mathbf{d}_{c,c}^{\text{red}} = \mathbf{0}$ oraz $\mathbf{d}_{c',c}^{\text{red}} = -\mathbf{d}_{c,c'}^{\text{red}}$! Na GPU obliczamy $\mathbf{R}_c^{\text{class}} = \sum_{c'} \mathbf{d}_{c,c'}^{\text{red}} \times \mathbf{m}_{\text{rep}(c')}$, energię $\frac{1}{2}\sum_c \mathbf{m}_{\text{rep}(c)} \cdot \mathbf{R}_c^{\text{class}}$, a następnie podnosimy pole na wszystkich członków klasy $i \in c$ dzieląc przez $\mu_0 M_{s,i} M_{c(i)}^{\text{class}}$ (identycznie z `dmi_interfacial.cpp` i `dmi_bulk.cpp`!).

### 4.3. Architektura plików i interfejsów C++/CUDA

Moduł `backends/fem/gpu/cuda/interactions/dmi/` wzorowany na `backends/fem/gpu/cuda/exchange/`:

1. **`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_state.hpp` (nowy — Phase 0 seam):**
   - `struct GpuDmiCsrChannelDeviceState`: `bool uploaded`, `uint64_t rows`, `uint64_t nnz`, `uint64_t device_bytes`, `uint32_t *csr_row_offsets`, `uint32_t *csr_col_indices`, `double *csr_dx`, `double *csr_dy`, `double *csr_dz`, oraz opcjonalna sekcja periodyczna (`bool periodic_reduced_ready`, `uint64_t periodic_reduced_rows`, `uint64_t periodic_reduced_nnz`, `uint64_t periodic_reduced_device_bytes`, `uint32_t *periodic_reduced_row_offsets`, `uint32_t *periodic_reduced_col_indices`, `double *periodic_reduced_dx/dy/dz`, `double *periodic_reduced_mass`, `double *periodic_reduced_rx/ry/rz`).
   - `struct FemGpuDmiCsrDeviceState`: `GpuDmiCsrChannelDeviceState interfacial{}`, `GpuDmiCsrChannelDeviceState bulk{}`.
   - Podłączony w `FemGpuState` (`backends/fem/gpu/cuda/state/gpu_state.hpp`) jako pole `FemGpuDmiCsrDeviceState dmi_csr{};` (z resetem w `reset_metadata` i zwolnieniem pamięci w `gpu_state_destroy` w `gpu_state.cpp`).
2. **`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_operator.{hpp,cpp}` (nowy):**
   - Host-side struktura `GpuDmiCsrHostData` (`rows`, `row_offsets`, `col_indices`, `dx`, `dy`, `dz`, plus opcjonalny `periodic_reduced`).
   - `build_gpu_dmi_csr_from_mfem(const Context &ctx, bool bulk_mode, GpuDmiCsrHostData &out, std::string &error)` — kompilowane pod `#if FULLMAG_HAS_MFEM_STACK` (w gałęzi `#else` czysty fail-closed stub zwracający `false`, chroniący build non-MFEM!). Iteruje po `mesh->GetNE()` (pomija niemagnetyczne elementy jak `dmi_interfacial.cpp`), używa dokładnie `mfem::IntRules.Get(fe->GetGeomType(), 2 * fe->GetOrder())`, akumuluje trójki `(row, col, dx, dy, dz)` w deterministycznej posortowanej strukturze CSR (z odrzuceniem `row == col` oraz zerowych wektorów `dx==0 && dy==0 && dz==0`, zachowując 100% ścisłą antysymetrię $\mathbf{d}_{ji} = -\mathbf{d}_{ij}$). Dla siatek periodycznych redukuje graf po `periodic_reduced_node` i wylicza `periodic_reduced_mass[c] = sum_{i in c} lumped_mass[i]`.
   - `gpu_dmi_csr_upload_channel(...)`, `gpu_dmi_csr_free(FemGpuLifecycleDeviceState &, FemGpuDmiCsrDeviceState &)`, oraz `context_upload_mfem_dmi_to_gpu_state(Context &ctx, std::string &error)` wywoływane w `gpu_state_runtime.cpp` zaraz po `context_upload_mfem_exchange_to_gpu_state(ctx, error)`.
   - Zero kosztu przy braku DMI: gdy `!interfacial_enabled && !rotated_interfacial_enabled && !bulk_enabled`, `context_upload_mfem_dmi_to_gpu_state` wraca natychmiast z `true`.
3. **`backends/fem/gpu/cuda/interactions/dmi/dmi_csr_kernels.{hpp,cu}` (nowy):**
   - `fullmag_cuda_dmi_csr_field_energy(...)`:
     - Wspiera `template <bool ComputeEnergy>` — gdy `energy_block_sums == nullptr` (pośrednie etapy RK w `rk_dmi_fields.cu`), **nie oblicza ani nie redukuje energii** (zero zbędnych redukcji i pełna kompatybilność warstwowa z optymalizacją Wave 3!).
     - Gdy `energy_block_sums != nullptr` (`rk_dmi_energy_reductions.cu`), każdy blok redukuje $\frac{1}{2}\mathbf{m}_i \cdot \mathbf{R}_i$ przez `cub::BlockReduce<double, 256>` i zapisuje 1 sumę na blok do `energy_block_sums[blockIdx.x]`, po czym `fullmag_cuda_device_sum(..., block_count, ...)` daje końcową energię bez pojedynczego globalnego `atomicAdd`!
     - Obsługuje zarówno nieperiodyczny CSR (`node_count` wierszy), jak i periodyczny CSR (`periodic_reduced_rows` klas + 1-przebiegowy kernel `dmi_csr_lift_periodic_field_kernel`).
   - `fullmag_cuda_dmi_csr_energy_difference(...)`:
     - Służy bezpośrednio w `direct_energy_increment.cpp:297-335` dla Armijo w PGBB i NCG.
     - Używa skompensowanej arytmetyki `double_double.cuh` na poziomie iloczynów krawędziowych i sumy blokowej `cub::BlockReduce`, zapisując `(delta_out, abs_out)` (poprzez 2-etapową redukcję lub pojedynczy blok redukujący `scalar_workspace`), dla obu wariantów (zwykły i periodyczny).
4. **Podpięcie runtime i zachowanie kompatybilności testów:**
   - `gpu_state_runtime.cpp:23-28`: `gpu_state_requires_tetrahedral_mesh_geometry(const Context &ctx)` zwraca **`return ctx.stt.zhang_li_enabled;`**! Dzięki temu na `pure_prism_p2` i `mixed_p1` z włączonym DMI bootstrap GPU **nie próbuje** uploadować płaskiej tablicy `tet4` `mesh_geometry`!
   - `rk_plan.cpp:160-166`: zamiast sprawdzać `mesh_geometry.uploaded`, sprawdza `dmi_csr.interfacial.uploaded` (gdy `interfacial || rotated`) oraz `dmi_csr.bulk.uploaded` (gdy `bulk`).
   - `rk_dmi_fields.cu`: wywołuje `fullmag_cuda_dmi_csr_field_energy(..., /*energy_block_sums=*/nullptr, ...)`.
   - `rk_dmi_energy_reductions.cu`: wywołuje `fullmag_cuda_dmi_csr_field_energy(..., gpu.reductions.scalar_workspace, ...)` + `fullmag_cuda_device_sum(..., block_count, ...)`.
   - `direct_energy_increment.cpp:297-335`: przełącza `add_dmi_difference` na `fullmag_cuda_dmi_csr_energy_difference`.
   - **Legacy `dmi_kernels.{hpp,cu}`:** pozostawione nienaruszone (zachowane symbole `fullmag_cuda_dmi_field_energy` i `fullmag_cuda_dmi_energy_difference`), dzięki czemu istniejące testy wyroczni jednostkowej `relaxation_energy_derivative_contract.cpp:2620-2888` pozostają w 100% zielone.
   - **Aktualizacja testów kontraktowych fasady źródłowej:** `gpu_state_runtime_contract.cpp:74-89`, `source_facade_gpu_state_contract.cpp:106-143,983-992`, `source_facade_cuda_kernels_contract.cpp:1581-1588`, `source_facade_gpu_rk_contract.cpp:989-1015`, `gpu_rk_plan.cpp:123-125,268-303`, oraz `relaxation_source_contract.cpp:2770-2798`.
  - **Bezpieczeństwo kerneli CUDA (obowiązkowe niezmienniki):** (a) zero wczesnych `return;` przed `cub::BlockReduce` (predykat `if (row < rows)` w każdym z 3 kerneli, eliminujący deadlock na częściowych blokach!); (b) bezpieczna obsługa `nnz == 0` (np. `D == 0.0`) i `magnetic_node_mask == nullptr` (traktowane jako wszystkie węzły magnetyczne); (c) w `fullmag_cuda_dmi_csr_energy_difference` pełne użycie `gpu/cuda/relaxation/double_double.cuh` (`fullmag::fem::gpu_relax_dd`) wraz z konserwatywną podłogą błędu `DBL_EPSILON` na skali operandów (jak `exchange_kernels.cu:338-349`), aby `S_abs` pozostało bezpieczne również przy $\mathbf{m}_1 \approx -\mathbf{m}_0$.

---

## 5. Ścieżka 3 (`prism-gpu-unlock-author`): Odblokowanie `pure_prism_p2` end-to-end, dokumentacja i benchmark A/B

### 5.1. Precyzyjne zmiany w bramkach kwalifikacyjnych (C++ / Rust / Python)

1. **C++ `backends/fem/core/fem_mesh.cpp:855-973`:**
   - `dmi_supported` staje się `true` dla `explicit_cpu_or_cuda_device` (zarówno `cpu`, jak i `cuda` obsługują wszystkie 3 typy DMI na `prism6` i `mixed_p1` przez MFEM CPU i GPU CSR DMI!).
   - `qualified_pure_prism_p2`:
     ```cpp
     const bool qualified_pure_prism_p2 =
         pure_prism_cell_family && pure_prism_facet_families &&
         pure_prism_markers_cover_magnetic_and_air &&
         explicit_cpu_or_cuda_device;
     ```
   - Usunięcie nieaktualnych predykatów `pure_prism_p2_cpu_only`, `pure_prism_p2_dmi_not_qualified` oraz `gpu_dmi_kernel_not_mixed_p1` (w przypadku nieprawidłowego urządzenia nadal raportowane jest `explicit_cpu_or_cuda_device`).
   - **Uczciwie zachowane strażniki fail-closed:** `plan_topology_matches_import_no_periodic` (brak periodyczności na P2 pryzmatach), `p1_magnetization_state`, `double_precision`, `exchange`, `poisson_robin_or_dirichlet`, oraz `no_other_extended_physics` (odrzucające `Zhang-Li STT`, `Oersted`, `thermal`, `magnetoelastic`, `DG0 Ms` — wszystko z `fallback=none`).
2. **Rust (`crates/fullmag-{ir,authoring,api,plan,runner}`):**
   - `FemTransitionPolicyIR`: dodanie `PurePrism` (`"pure_prism"`), obsługa w `mesh_policy.rs:862` (`(Triangular, Prism6, ...)`) i `:1347-1359` (`Some("pure_prism")`).
   - `FemMeshTopologyFamilyIR`: dodanie `PurePrismP2` (`"pure_prism_p2"`).
   - `FemSharedDomainBuildReportIR`: dodanie opcjonalnego pola `pure_prism_topology_certificate: Option<PurePrismTopologyCertificateV1IR>` + obsługa odczytu z poziomu `mesh` w `FemDomainMeshAssetIR::deserialize` (`mesh_assets.rs:2287-2335`), wzajemna wyłączność V1/V2/pure_prism oraz walidacja provenance dla `PurePrismP2` w `validate()` (`mesh_assets.rs:2437-2528`).
   - `crates/fullmag-authoring/src/validation.rs`: zezwolenie na `"pure_prism"` przy `topology == "prismatic"` (`:894,986`) oraz odrzucenie przy `hex` (`:1004`).
   - `crates/fullmag-api/src/schemas/mesh.rs`: wzajemna wyłączność V1/V2/pure_prism (`:600-604`) oraz propagacja zasobów `requested_layered_policy` / `resolved_layered_policy` z `topology = "pure_prism_p2"` i `transition_policy = "pure_prism"` (`:670-715`).
   - `crates/fullmag-plan/src/mesh.rs`:
     - rozpoznanie `cells == [Prism6]` + `facets ⊆ {Tri3, Quad4}` z `Quad4` jako toru `pure_prism_p2` wymagającego ważnego `pure_prism_topology_certificate` (`fem_pure_prism_p2_certificate_required` przy braku), w tym post-packing rebinding i emisja provenance w `resolve_fem_domain_mesh_asset` (`:2298-2394`);
     - usunięcie `gpu_dmi_kernel_not_mixed_p1` ze `scope_failed_predicates`;
     - dla `pure_prism_p2`: dopuszczenie `requested_layer_count >= 1`, `device ∈ {cpu, gpu}`, `precision == double`, `P1`, `exchange`, `poisson_robin | poisson_dirichlet`, relaksacja (`PGBB`, `NCG`, `LLG overdamped`) oraz dynamika (`Heun`, `RK4`, `RK23`, `RK45`), z opcjonalnymi lokalną anizotropią, Zeemanem, napędami regionalnymi i wszystkimi 3 typami DMI;
     - emisja `FemMixedTopologyProvenanceIR { requested_topology: PurePrismP2, resolved_topology: PurePrismP2, accepted_certificate_fingerprint, requested_device, precision, capability_status: Implemented }` (zgodnie z ograniczeniem `Implemented` w `mesh_assets.rs:2519-2528` i `runner/src/lib.rs:2310-2316,2386-2390`!).
   - `crates/fullmag-runner/src/lib.rs`:
     - przyjęcie `{Prism6}` + `{Tri3, Quad4}` z weryfikacją `pure_prism_topology_certificate` (`mixed_topology_fingerprint_v3()`, `layers >= 1` na `:2622`, `fallbacks_triggered == [] && !degraded`, wzajemna wyłączność i brak metadanych V1/V2/pure_prism na siatce `tet4` w `:2200-2208` i `require_tetrahedral_fem_plan_mesh:2684`, akceptacja `PurePrismP2` na `:2362-2363`);
     - usunięcie `gpu_dmi_kernel_not_mixed_p1` z `lib.rs:2654-2656`.
3. **Python preflight (`packages/fullmag-py/src/fullmag/model/problem.py`):**
   - Usunięcie blokady `gpu_dmi_kernel_not_mixed_p1` (`:2729-2730`), obsługa `transition_policy == "pure_prism"` (`:2656`, `layers >= 1`), oraz strażnik pomijający natywny certyfikator V2 dla czystego `pure_prism` na `:1488-1541`.

### 5.2. Kontrakt dokumentacji naukowej (`docs/physics/`)

Aby uniknąć kolizji numeracji ze ścieżkami równoległymi (`0997`/`0998` już na `origin/master`, `0999`/`1000` zarezerwowane przez Wave 3, `1005` przez Wave 2), używamy wolnego numeru **`1001`**:

1. **Aktualizacja `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.{md,source-map.json}`:**
   - Udokumentowanie odblokowania GPU DMI (poprzez zunifikowany operator CSR DMI) dla `mixed_p1` oraz deterministycznej naprawy odwróconych czworościanów `same_side_two_owner_face` w wolumenach przejściowych dla `layers >= 2`.
2. **Aktualizacja `docs/physics/0431-fem-demag-mixed-order-potential.{md,source-map.json}`:**
   - Aktualizacja statusu `pure_prism_p2`: z CPU-only na pełną kwalifikację **FEM CPU + GPU (`cg_amg` i `cuDSS`)** z potencjałem $P_2$ (`H1_WedgeElement(2)`) oraz zaktualizowaną mapą źródeł i tabelą macierzy backendów.
3. **Nowa nota `docs/physics/1001-fem-gpu-pure-prism-p2-and-csr-dmi.{md,source-map.json}` (+ wpis w `docs/physics/README.md`):**
   - Kompletny model matematyczny: (a) dyskretyzacja `pure_prism_p2` (ekstruzja 3-etapowa, przestrzeń $P_1$ na $\mathbf{m}$ i konforemne $P_2$ na $\phi$ bez piramid), (b) twierdzenie o antysymetrycznej redukcji wektorowej $\mathbf{d}_{ij}$ dla wszystkich 3 wariantów DMI (interfacial, rotated interfacial, bulk), energia, spolaryzowana różnica energii `double_double.cuh` oraz redukcja periodyczna $P^\top D P$, (c) algorytm rozplątywania odwróconych czworościanów metodą środka Czebyszewa, (d) publiczne API (`transition="pure_prism"`) oraz tabela wyników walidacyjnych A/B na filmie 300×300×5 nm.
   - Pełna walidacja skryptami: `python3 scripts/validate_scientific_docs.py`, `python3 scripts/validate_changed_scientific_docs.py`, `python3 scripts/check_repo_consistency.py`.

### 5.3. Flagowy benchmark walidacyjny A/B (300×300×5 nm Permalloy, RTX 4080 SUPER)

Rozszerzamy `scripts/benchmarks/relax_film_compare_case.py` o opcjonalne zmienne środowiskowe:
- `FILM_FEM_MESH`: `prism | pure_prism | tet` (gdy `pure_prism`, wywołuje `film.mesh.thin_film(..., topology="prismatic", transition="pure_prism")`),
- `FILM_FEM_GPU_STRATEGY`: `auto | cudss | cg_amg` (przekazywane do `study.fem_demag_solver(..., gpu_strategy=...)`).

**Macierz walidacyjna do wykonania w Fazie 2 w Docker DEV na RTX 4080 SUPER (16 GB VRAM):**

| Przypadek | Topologia / Solver | Kryterium sukcesu |
|---|---|---|
| **A1** (baseline) | `tet P2` ($h=2.5\text{ nm}$), GPU `cg_amg` | Referencja z audytu `2026-11-24`: $E_{\text{demag}}(t=0) \approx 4.623 \times 10^{-18}\text{ J}$ (−0.20% vs Aharoni), 4.08M DOF, cuDSS OOM (59.4 GB). |
| **A2** (baseline) | `mixed_p1` (`layers=1`, $h=2.5\text{ nm}$), GPU `cuDSS` | Referencja z audytu `2026-11-24`: 51k DOF, błąd −15.14% vs Aharoni. |
| **A3** (conformity fix) | `mixed_p1` (`layers=2`, $h=2.5\text{ nm}$), `transition="pyramid_to_tetrahedra"` | `build_domain_mesh()` przechodzi 100% bez błędu, `nonconforming_face_count == 0`, `certificate_status == "accepted"`, `tet4 p05 >= 0.1`. |
| **B1** (flagship L=1) | **`pure_prism_p2` (`layers=1`, $h=2.5\text{ nm}$), GPU `cuDSS`** | Błąd $E_{\text{demag}}(t=0)$ vs Aharoni **`< 1.0%`**, `resolved_linear_solver == "cudss_direct"` (mieści się w 16 GB VRAM bez fallbacku!), zrelaksowana $E_{\text{total}}$ zgodna z `tet P2` / CPU / FDM w granicach tolerancji dyskretyzacji (`< 1%`), przyspieszenie czasu ściany vs `tet P2 CG+AMG`! |
| **B2** (flagship L=2) | **`pure_prism_p2` (`layers=2`, $h=2.5\text{ nm}$), GPU `cuDSS`** | `nonconforming_face_count == 0`, `PurePrismTopologyCertificateV1` zaakceptowany, spójność $E_{\text{demag}}$ i $E_{\text{total}}$ z B1 oraz CPU MFEM ($\le 10^{-11}$ rel. na tej samej siatce!). |
| **C1** (prism6 DMI parity) | `pure_prism_p2` + `mixed_p1`, interfacial ($D=3\text{ mJ/m}^2$) + rotated ($D_{\text{rot}}=1.5\text{ mJ/m}^2$) + bulk ($D_b=2\text{ mJ/m}^2$), GPU vs CPU | Parytet pola $\mathbf{H}_{\text{DMI}}$, energii $E_{\text{DMI}}$, przyrostu $\Delta E_{\text{DMI}}$ w PGBB oraz kroku RK4 pomiędzy GPU CSR DMI a MFEM CPU: **`<= 1e-12` rel.**! |

---

## 6. Podział wieloautorski z zerowym nakładaniem plików

Aby 3 autorów mogło pracować w 100% równolegle w osobnych worktree (`workspace:"share"`) bez ani jednego konfliktu scalania, rozdzielamy pracę w 3 fazach:

### Faza 0 (Koordynator — pojedynczy commit interfejsowy przed rozgałęzieniem)
Zamraża wyłącznie minimalne nagłówki C++ i kanoniczny kontrakt JSON/Rust IR, tak aby wszystkie 3 ścieżki kompilowały się niezależnie:
- **Nowe nagłówki C++:** `backends/fem/gpu/cuda/interactions/dmi/dmi_csr_state.hpp`, `dmi_csr_operator.hpp`, `dmi_csr_kernels.hpp`.
- **Rozszerzenie `FemGpuState`:** `backends/fem/gpu/cuda/state/gpu_state.hpp` (dodanie `#include "gpu/cuda/interactions/dmi/dmi_csr_state.hpp"` i pola `FemGpuDmiCsrDeviceState dmi_csr{};`).
- **Jednorazowy kontrakt nazewnictwa JSON/IR (w dokumentacji specyfikacji — współdzielone stałe stringowe):**
  - `transition_policy = "pure_prism"` (`FemTransitionPolicyIR::PurePrism`),
  - `topology = "pure_prism_p2"` (`FemMeshTopologyFamilyIR::PurePrismP2`),
  - `schema_version = "pure_prism_topology_certificate.v1"`, pole w `build_report`: `"pure_prism_topology_certificate"`.

### Faza 1 (3 równoległych autorów — ścisła rozłączność plików!)

| Autor | Zakres odpowiedzialności | Wyłączna własność plików (ZERO nakładania!) |
|---|---|---|
| **Author 1 (`mesher-author`)** | Naprawa `layers=2` (`_untangle_same_side_mixed_tetrahedra`) + generator `generate_pure_prism_box_airbox_mesh` + `PurePrismTopologyCertificateV1` w Pythonie + publiczne API `thin_film(transition="pure_prism")` | `packages/fullmag-py/src/fullmag/meshing/{_gmsh_swept.py,_gmsh_types.py,_mesh_targets.py,persistence.py,asset_pipeline.py}`, `packages/fullmag-py/src/fullmag/{world.py,model/discretization.py,runtime/script_builder.py}`, `packages/fullmag-py/tests/{test_mixed_element_meshing.py,test_script_builder_roundtrip.py}` (+ nowy `test_pure_prism_shared_domain_meshing.py`) |
| **Author 2 (`prism-dmi-author`)** | Zunifikowany CSR GPU DMI (asemblacja MFEM, kernele CUDA + `gpu_relax_dd` + periodyczność + `energy_block_sums == nullptr` fast path), podpięcie `gpu_state`, `gpu_state_runtime`, `rk_plan`, `rk_dmi_*`, `direct_energy_increment`, spięcie `dmi_csr_*` i `fem_cuda_csr_dmi_prism_contract` w `CMakeLists.txt` (natychmiastowa kompilowalność w Fazie 1!), testy C++/CUDA DMI | `backends/fem/CMakeLists.txt` (sekcja `dmi_csr_*` + `fem_cuda_csr_dmi_prism_contract`), `backends/fem/gpu/cuda/interactions/dmi/{dmi_csr_operator.cpp,dmi_csr_kernels.cu}`, `backends/fem/gpu/cuda/state/gpu_state.cpp`, `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`, `backends/fem/gpu/cuda/integrators/rk/{rk_plan.cpp,rk_dmi_fields.cu,rk_dmi_energy_reductions.cu}`, `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp`, `backends/fem/tests/{gpu_state_runtime_contract.cpp,source_facade_gpu_state_contract.cpp,source_facade_cuda_kernels_contract.cpp,source_facade_gpu_rk_contract.cpp,gpu_rk_plan.cpp,relaxation_source_contract.cpp}` + nowy `backends/fem/tests/cuda_csr_dmi_prism_contract.cpp` |
| **Author 3 (`prism-gpu-unlock-author`)** | Odblokowanie `pure_prism_p2` GPU + DMI w C++ `fem_mesh.cpp`, całej warstwie Rust (`ir`, `authoring`, `api`, `plan`, `runner`) oraz Python preflight `problem.py` + testy bramek + aktualizacja benchmarku `relax_film_compare_case.py` | `backends/fem/core/fem_mesh.cpp`, `backends/fem/tests/fem_mesh_contract.cpp`, `crates/fullmag-ir/src/{mesh_policy.rs,plan.rs,mesh_assets.rs,mixed_certificate.rs}`, `crates/fullmag-authoring/src/validation.rs`, `crates/fullmag-api/src/schemas/mesh.rs`, `crates/fullmag-plan/src/{mesh.rs,tests.rs}`, `crates/fullmag-runner/src/lib.rs`, `packages/fullmag-py/src/fullmag/model/problem.py`, `packages/fullmag-py/tests/test_mixed_p1_preflight.py`, `scripts/benchmarks/relax_film_compare_case.py` |

*(Wyłącznie Author 2 edytuje `backends/fem/CMakeLists.txt` w Fazie 1 — ani Author 1, ani Author 3 go nie dotykają, więc wszystkie 3 ścieżki kompilują się i testują niezależnie przy zerowym ryzyku konfliktu scalania!)*

### Faza 2 (Integrator / Weryfikator — po scaleniu Fazy 1)
1. Dodanie nowego testu end-to-end `fem_pure_prism_p2_gpu_contract` do `backends/fem/CMakeLists.txt` (sprawdzającego GPU `cuDSS` + `cg_amg` + PGBB + RK + DMI na siatce `pure_prism_p2`).
2. Dokumentacja naukowa: aktualizacja `docs/physics/0106*`, `docs/physics/0431*`, utworzenie `docs/physics/1001-fem-gpu-pure-prism-p2-and-csr-dmi.{md,source-map.json}`, wpis w `docs/physics/README.md`.
3. Pełna macierz weryfikacji w Docker DEV (`just docker-dev`):
   - build non-MFEM (`FULLMAG_HAS_MFEM_STACK=0` / `native-modal-cabi-contract`),
   - build FEM CPU + CUDA GPU CTest (wszystkie testy kontraktowe DMI, exchange, demag, RK, PGBB, `fem_mesh_contract`, `fem_mixed_p1_contract`, `fem_cuda_csr_dmi_prism_contract`, `fem_pure_prism_p2_gpu_contract`),
   - `cargo test` dla `fullmag-{ir,authoring,api,plan,runner}`,
   - `pytest` dla `test_mixed_element_meshing.py`, `test_pure_prism_shared_domain_meshing.py`, `test_mixed_p1_preflight.py`,
   - walidatory `validate_scientific_docs.py`, `validate_changed_scientific_docs.py`, `check_repo_consistency.py`,
   - wykonanie flagowego benchmarku A/B (A1/A2/A3/B1/B2/C1) na RTX 4080 SUPER i zapisanie wyników w `docs/physics/1001*` / audycie.

---

## 7. Review Focus — 5 krytycznych przypadków brzegowych (przypiętych do testów)

1. **Znak i konwencja 3 wariantów DMI + orientacja `dofs[i] < 0` + periodyczność `P^T D P` w CSR DMI:**
   - *Ryzyko:* Pomyłka znaku w `d_rot = (0, -g_x, -g_y)` lub `d_int = g × n_hat`, albo brak znaku orientacji `sign = dofs[i] >= 0 ? 1.0 : -1.0` przy asemblacji $\mathbf{g}_{ij}$, albo niezachowanie $\mathbf{d}^{\text{red}}_{c,c} = \mathbf{0}$ przy redukcji klas periodycznych (co psuje dokładność przyrostu Armijo w PGBB!).
   - *Przypięty test:* `backends/fem/tests/cuda_csr_dmi_prism_contract.cpp` (Faza 1 / Author 2) — weryfikuje z dokładnością $\le 10^{-12}$ rel. względem MFEM CPU **wszystkie 3 warianty** (`interfacial` z ukośną normalną $\hat{\mathbf{n}}$, `rotated_interfacial`, `bulk`, oraz jednoczesne `interfacial + rotated_interfacial + spatial D_field`) na siatkach `tet4`, `prism6` i `mixed` (`prism6+pyramid5+tet4`), plus przypadek periodyczny i różnicę energii `E(m1) - E(m0)` w `double_double`.
2. **Alokacja buforów potencjału $P_2$ (`scalar_dof_count > node_count`) i brak `tet4` `mesh_geometry` na `pure_prism_p2` GPU:**
   - *Ryzyko:* Ukryte założenie `scalar_dof_count == node_count` w którymś buforze GPU (`poisson_rhs`, `poisson_solution`, `demag_predictor`, `cudss_direct_solver`, `hypre_device_solver`) lub przypadkowe wywołanie `gpu_state_upload_mesh_geometry` przy aktywnym DMI na `pure_prism_p2` (wybuch `elements_len % 4 != 0`).
   - *Przypięty test:* `backends/fem/tests/fem_pure_prism_p2_gpu_contract.cpp` (Faza 2) + `gpu_state_runtime_contract.cpp` (Author 2) — uruchamia pełną relaksację PGBB i kroki RK4 na wielowarstwowej siatce `pure_prism_p2` z włączonym DMI (zarówno pod `cuDSS`, jak i `cg_amg`), weryfikując `potential_order == 2`, `scalar_dof_count > node_count`, `mesh_geometry.uploaded == false` oraz parytet energii i pola z CPU MFEM ($\le 10^{-11}$ rel.).
3. **Reorientacja odwróconych tetów po rozplątaniu `layers=2` + odporność na `layers=1, 2, 3, 4` i różne geometrie:**
   - *Ryzyko:* Samo przesunięcie węzła `setNode()` bez zamiany wierzchołków `nodes[2] <-> nodes[3]` w odwróconych tetach sprawi, że ich jakobian w Gmsh i w certyfikacie Rust stanie się **ujemny** (`jacobian_min < 0`), albo ruch węzła zepsuje sąsiednią piramidę lub spowoduje `same_side` w innym miejscu.
   - *Przypięty test:* `packages/fullmag-py/tests/test_mixed_element_meshing.py` (Author 1) — testuje bezpośrednio pełne `build_domain_mesh()` + pełną walidację certyfikatu V1 (`certificate_status == "accepted"`, `nonconforming_face_count == 0`, wszystkie `jacobian_minima > 0`, `tet4 p05 >= 0.1`, `pyramid5 p05 >= 0.1`, `prism6 p05 >= 0.1`) dla `300×300×5 nm` ($h=2.5\text{ nm}$, `layers=1, 2, 3`) oraz SP4 `500×125×3 nm` (`layers=1, 2, 3`), plus syntetyczny test jednostkowy z ręcznie splątaną dwupiramidą sprawdzający zarówno ścieżkę `scipy.linprog`, jak i fallback NumPy.
4. **Kompilacja bez MFEM (`FULLMAG_HAS_MFEM_STACK=0`) i bez CUDA (`FULLMAG_HAS_CUDA_RUNTIME=0`) oraz zachowanie testu `relaxation_energy_derivative_contract.cpp`:**
   - *Ryzyko:* Bezpośrednie włączenie `<mfem.hpp>` w `dmi_csr_operator.cpp` lub wywołanie symboli CUDA poza `#if FULLMAG_HAS_CUDA_RUNTIME` złamie cel CI `bootstrap / native-modal-cabi-contract`, a usunięcie legacy `fullmag_cuda_dmi_energy_difference` złamie `relaxation_energy_derivative_contract.cpp:2620-2888`.
   - *Przypięty test:* Krok weryfikacyjny w Fazie 2 budujący jawnie konfigurację `-DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_ENABLE_CUDA=OFF` (`native-modal-cabi-contract`) oraz uruchamiający `fem_relaxation_energy_derivative_contract` bez modyfikacji wyroczni `tet4`.
5. **Ścisły fail-closed dla niezakwalifikowanych kombinacji (zero cichego fallbacku + ochrona V1/V2 certyfikatów):**
   - *Ryzyko:* Poluzowanie bramek w `fem_mesh.cpp`, `fullmag-plan` lub `fullmag-runner` mogłoby przepuścić `pure_prism_p2` z `Zhang-Li STT`, `periodic`, `Hex8`, brakującym certyfikatem lub sfałszowanym `mixed_topology_fingerprint_v3()` (`topology_fingerprint_version = "v3"`), albo zregresować istniejące testy certyfikatów V1/V2.
   - *Przypięty test:* `backends/fem/tests/fem_mesh_contract.cpp`, `crates/fullmag-ir/src/mesh_assets.rs`, `crates/fullmag-plan/src/tests.rs`, `crates/fullmag-runner/src/lib.rs`, `packages/fullmag-py/tests/test_mixed_p1_preflight.py` (Author 3) — negatywne testy fail-closed dla `pure_prism_p2 + Zhang-Li STT`, `pure_prism_p2 + periodic`, `pure_prism_p2` bez certyfikatu, sfałszowany `mixed_topology_fingerprint_v3()`, `Hex8`, oraz zachowanie 100% istniejących fixture'ów V1/V2 bez zmian.
