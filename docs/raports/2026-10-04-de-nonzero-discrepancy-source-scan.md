# Nonzero-k: wąski scan rozbieżności FEM–thickness oracle

**Nie wykazano błędu fizycznego.** Wyniki +10/−10 i +2 przekazane przez root są rozwiązaniami zaakceptowanymi przez obecne bramki dyskretnego operatora; residual ~1e−11/1e−13 nie mierzy błędu dyskretyzacji względem niezależnego continuum oracle. Hipoteza wymagająca kontrolowanej próby to błąd przestrzeni P1 dla sprzężonego pola magnetycznego/Poissona. Przyczyny nie da się przypisać z samego source.

## Fakty źródłowe i actual mesh

Odczytano metadata +10, związany cache oraz mode przez `scripts/compare_de_bv_mode_profiles.py::load_record:136`: loader weryfikuje hashe wejść, mode/full-residual receipt i wiąże cache z `source_mesh_topology_sha256` (:171–190). Interpretowany odczyt danych z `python -B` nie wykonywał solvera ani testów i nie zapisywał źródeł/cache.

- Actual metadata: build_mode=single_geometry_geo_layered_box, bez degraded/fallback; 6138 nodes, 30012 tet, w tym 1476 magnetic i 28536 air. Magnetyczna sygnatura: `189b0b4c33c9310afff3772f7d7e9152f00d50297524cf5f4d8c353021e5cec6`, 396 magnetic nodes. Z cache potwierdzono cztery magnetic z-planes [−5,−1.66666667,+1.66666667,+5] nm, czyli rzeczywiste trzy warstwy.
- Właściwy realizator to `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py::generate_swept_tetrahedral_box_airbox_mesh:1863`, nie ogólny transition-shell path. `_generate_coincident_ring_airbox_mesh:1915–1922` bierze h_inner z body hmax (lub mniejszego jawnego air minimum), h_outer z universe maximum. `_box_airbox_layer_levels:1842–1860` tworzy air z-planes od kroku h_inner rosnącego ×growth do h_outer, a film z-planes osobno z n_layers. Lateral source plane również używa body hmax (:1938–1946), a źródło sprawdza rzeczywisty film layer count (:2198–2203).
- **L2→L3 jest sprzężonym refinement:** zmienia film lateral target i air seed 5→3.75 nm mimo niezmiennego cap100 nm. **Layers3→6 przy L2 zmienia tylko film z-schedule względem air z-schedule w source.** Actual niezmienność reszty mesha nadal trzeba zmierzyć; nie wynika automatycznie z autorstwa jednej zmiennej.

Odczyt cache +10 potwierdza grading zamiast przypuszczenia „100 nm tuż przy filmie”. Poniżej długości wszystkich sześciu krawędzi air tet, binowane według odległości centroidu od z=±5 nm; w packed mesh air ma marker0. To deskryptywna statystyka, nie miara błędu FEM.

| Odległość centroidu [nm] | Air tet | Mediana / max krawędzi [nm] |
|---|---:|---:|
| 0–20 | 2952 | 5.986 / 10.236 |
| 20–50 | 2296 | 10.985 / 19.443 |
| 50–100 | 1968 | 18.743 / 31.902 |
| 100–200 | 2624 | 31.675 / 53.336 |
| 200–500 | 3280 | 68.978 / 100.167 |
| 500–2000 | 15416 | 100.000 / 100.167 |

## Fakty operatora

- `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp::assemble_native_magnetic_a_qq:2067–2220` używa native P1 weak exchange ∫2A(e_i·e_j)∇N_i·∇N_j. Public importer wymaga scalar Aex, zabrania graph endpoints; operator nie jest runnerowym graph Laplacian. Tet rule/order5 i prism/order4 są jawne (:2081–2090); nie ma reskalowania Aex.
- Dynamic/gyrotropic B jest **consistent bilinear mass**, z każdym test/trial shape product N_iN_j (:2835–2841), nie diagonalnym lumpingiem. K i B są projektowane tą samą complex magnetic constraint (:2879–2893). Istniejące `tangent_lumped_mass` (:3298–3359) jest nośnikiem artefaktu equilibrium/linearization; jego obecność nie oznacza lumped B w tym solve. Uniform projection² .999971156 jest również liczona consistent P1 mass przez `compare_de_bv_mode_profiles.py:71–89`, po zdjęciu exp(−ik·r) z nodal field (:184–185).
- Production Floquet scalar i tangent source deklarują **full_field_phase_constrained** (`floquet_airbox_operator.cpp:752–799`). Dlatego `floquet_bloch_scalar.cpp:61–71` używa zwykłej diffusion; k² mass i convection występują tylko dla alternatywnego shifted_envelope. K wchodzi przez exp(−ik·translation) i frame map (`operators/floquet_magnetic_operator.cpp:103–123`), scalar/tangent constraints i CᴴAC projection. Brak jawnego +k² w tej ścieżce nie jest dowodem brakującej exchange: pełne pole ma Bloch phase już w constraint.
- Weak source to elementowy ∫Ms N_trial (∇N_test·e), tylko na magnetic elements (`floquet_bloch_scalar.cpp:352–354,413–433`); ik term jest tylko shifted_envelope. Quadrature source jest order2P1 (:363–364). Źródło zachowuje interfejsowy wkład weak form, bez jawnego różniczkowania skoku Ms i bez zamiany source na nodal divergence.
- Feedback jest jawnie `A_qphi=−μ0 A_phiqᴴ` (`poisson_airbox_shared_domain.cpp:3689–3699`), a Schur to −A_qphi P⁻¹A_phiq. Dirichlet elimination dotyczy scalar/source (`floquet_airbox_operator.cpp:805–809`). W tym wąskim trace nie znaleziono dowodu niespójnej skali/source-sign/phase lub zamiany mass.

## Interpretacja: fakty a hipotezy

Dane root: +10≈11.205285324 GHz, −10≈11.205285254 GHz; finite-Dirichlet n0≈11.235414179 GHz; open thickness basis16≈11.228265980 GHz i zmiana basis8→16≈27 Hz. +2≈9.723285911825 GHz. Te wartości są dowodem obecnej rozbieżności, nie jej przyczyny.

**n0 kontra thickness basis16 nie izoluje outer boundary.** n0 jest uniform-thickness continuum przybliżeniem (`scripts/finite_dirichlet_thin_film_oracle.py:1–4,98`), a thickness oracle ma cosine basis, pełne off-diagonal demag i exchange zależne od n (`scripts/thin_film_thickness_oracle.py:33–68`). Różnica ~7.148 MHz między tymi dwoma odniesieniami obejmuje zmianę modelu profilu. Trzeba zachować to rozróżnienie, nawet gdy FEM mode jest niemal uniform w mass metric.

**Hipoteza H1 (air/Poisson Galerkin):** przestrzeń scalar P1 na graded air może zaniżać efektywną energię demag dla danego magnetic source. Wniosek warunkowy z postaci Schura: cᴴP⁻¹c=maxφ(2Re(cᴴφ)−φᴴPφ); ograniczenie φ do przestrzeni FE może obniżać maksimum. To argument kierunku dla fixed-source energy przy zgodnych formach/BC, nie dowód znaku błędu częstotliwości całej sprzężonej modalnej pary. Przy |k|=10/µm decay length=100 nm, więc actual grading 20–200 nm ma znaczenie dla tej hipotezy.
**Hipoteza H2 (magnetic P1/phase/thickness):** trzy warstwy oraz interpolacja pełnego phased field na lateral P1 nie są dokładnym continuum plane wave/cosine basis. Niemal uniform nodal envelope nie wyklucza błędu source/exchange i coupling wewnątrz tet. Nie przypisano rozbieżności ani „brakującemu k²”, ani mass lumpingowi; źródło temu nie odpowiada.

## Jeden eksperyment izolujący H1

Najmniejszy **versioned input-only** wariant +10: zachować body L2/3, geometry/period/padding/material/bias/nearest albo window scope oraz wszystkie zaakceptowane EPS/KSP settings i progi; zmienić tylko `study.universe.mesh(maximum_element_growth_rate=1.3)` na 1.15. Cap100 nm i seed5 nm pozostają. Realizator zmienia exterior z-planes, nie formułę film planes. Nowy immutable model input, fresh output i rzeczywisty mesh receipt są konieczne.

Warunek izolacji: zmierzyć actual magnetic_submesh_signature, lateral coordinates/connectivity, trzy film planes oraz equilibrium magnetic state; potwierdzić niezmienność tych danych i real zmianę air schedule. Nie obiecywać tego z samego source, raw whole-mesh fingerprint oczywiście zmieni się. Jeśli magnetic submesh też się zmieni, to nie jest eksperyment air-only. Porównać częstotliwość, original full residual, profile overlap i demag probe. Istotny ruch w stronę oracle przy zachowanym body wspiera H1; brak ruchu ogranicza H1 tylko dla tej jednej zmiany, nie dowodzi błędu operatora.

Dostępna bez zmiany modelu kontrola drivera **L2/6 przy +10** sprawdza H2/thickness i zachowuje źródłowy air z-schedule. L3/3 jest użytecznym, ale sprzężonym refinement i nie rozstrzyga body vs air. Nie uruchomiono żadnej z tych prób ani nie ingerowano w aktywny controller.

## Tożsamość i granice dowodów

Actual run: `.../scientific-batches/nonzero-k-validation/8df582e52a54410bae0387d2eaecd6a9/de-k10-fgmres-window-canonical-mu0-job228-v1`; root receipt: `signed10-fgmres-window-postsolve-inspection.json`. Metadata SHA256 `3404D49C0F90B58F90177616669077B82D5D0CA379468AF6083CD9DC0B04E2CB`; bound cache `6c278fbbe0fd04dce9bf13053ee0576adedcd59a4b952c8427e67c15d209f42f`; mode binary `8f71e4e08b9840b562a58ef23cdec54cf4b8cbf203e4a8c3b9b6a5e132f15b6a`.

Run-request wskazuje rzeczywistą capsule `.../fa3320d978544cf29b93c4653c0d6ebb/source/tree`, commit57182911c6e8e721b8ee9705aa7f70491c70fe94. Cztery trace sources poniżej są byte-identical z nią **po CRLF/LF normalizacji**; raw hashe różnią się wyłącznie newline representation w tym porównaniu.

| Bieżący source | Raw SHA256 |
|---|---|
| packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py | `25D82FBC82177EE31B0EC083CFD08935DD6FD56185592F8D4237A9B8817D3DCB` |
| backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp | `7169DDFC1ACDE4648311E9AEFC17F9B8491C84A2B1C16F6BD593390C78ACDCE2` |
| backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp | `B286EE5BBB41675CF6267019F5D9653C02BA5A34C30BB0C189354A2151ACB0ED` |
| backends/fem/cpu/frequency_domain/floquet_bloch_scalar.cpp | `0CD7C9287400C1CB7042AFC2467DEF76FA1B84D9A37F05E5AA53D7A4F4CF94D9` |

To source/data inspection, nie ponowna kwalifikacja runtime. Brak nowych buildów, solver runs, testów jednostkowych lub edycji source/index/runtime artifacts. Przyczyna rozbieżności i mesh/air convergence pozostają **NOT VERIFIED**.
