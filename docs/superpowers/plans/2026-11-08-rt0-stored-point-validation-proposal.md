# RT0 — walidacja J w zapisanym punkcie próbkowania

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Usunąć potwierdzoną fałszywą odmowę próbki środka bez zmiany J, zasilania lub tolerancji.
**Architecture:** Odtwarzać kanoniczne RT0 dokładnie w zapisanej współrzędnej środka. Jeden prywatny kontekst komórki współdzieli wyznacznik i orientację momentów między kontrolą środka i wierzchołków.
**Tech Stack:** istniejące Rust BigInt i dyadyczne binary64, FEM CPU/double, managed just Docker/WSL, GitHub CI.
**Spec:** [rzeczywista odmowa](2026-11-08-rt0-actual-center-failure-result.md), właściciel fizyki [0950](../../physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md), kontekst publikacji [0951](../../physics/0951-sushruth-2020-forward-volume-reference.md).

Status: projekt do decyzji; produkcyjna bramka pozostaje bez zmian. Poprzednia zgoda
została wykorzystana: jeden build i jedna próba zakończona Failed. Poniższy zakres
nie jest automatycznym retry ani dowodem reprodukcji publikacji.

## Baza i dane wejściowe

HEAD b4a424f72bbd0ce0dfe884baa3c4ea4f45e682b8.
Pobrany origin/master: 1b01d44c63a42135a0243c0b36a9d324505f9e9c; nie jest scalony.
Jego 201 nowych commitów nie zawiera zmian dotychczasowego pliku walidatora.
Plan nie obejmuje scalenia tych commitów ani przebudowy innych worktree.

Working validator SHA256: 784347cd66144e3266610d06b592dfe1554d28a2aac2d0c277315a23fcdf3609.
Working tree zawiera wcześniejszą optymalizację affinity/moments na BigInt oraz profiler;
HEAD ma w tych miejscach BigRational. Nie commitować całego dirty pliku.
Nowa kontrola musi kompilować się również na HEAD bez dołączania zmian affinity.
Wydzielenie arytmetyki momentów potrzebnej nowej kontroli podlega regresji równoważności
z dotychczasową metodą; nie jest zgodą na ogólną przebudowę walidatora.

Świadek: element 28881, oś y, 40728 Tet4/14194 węzły/20 targetów H.
Fixture SHA256: 3337bf6858ecebfd9ee63eecb799a74353ae5ec5b45de8faf27a83b6e9c1d1db.
Istniejący request SHA256: d2c8add5027af0fa253643578fe82415c9ed1b1ee33d6f8866217b2c3050d656.
Prepare: 9440b363eda74047ba4d768dac1baaa1.
Wynik poprzedniej próby pozostaje Failed, bez accepted artifacts.

## Wybór rozwiązania i jego granica

| Wariant | Ocena |
|---|---|
| Zmiana native J na średnią wierzchołków | Odrzucony: zmienia próbkę i jej tożsamość zamiast naprawić walidację |
| Interpolacja zaokrąglonych nodalnych J | Odrzucony jako źródło referencji: ślady prezentacyjne nie są kanonicznymi DOF |
| RT0 z kanonicznych momentów w zapisanym punkcie | Rekomendowany: odpowiada istniejącemu native retained_current_at(center) |
| Większy epsilon lub absolutny próg | Odrzucony: nie usuwa pomylenia punktów |

Planowane porównanie dokładnych liczb dyadycznych:

~~~{math}
:label: planned-rt0-stored-point-reference
D_K=\det[\mathbf x_1-\mathbf x_0,\mathbf x_2-\mathbf x_0,\mathbf x_3-\mathbf x_0],
\qquad
J^\star_a(c_a)=\frac{2\sum_{i=0}^3\Phi_i^{\mathrm{out}}(c_a-x_{i,a})}{D_K}.
~~~

~~~{math}
:label: planned-rt0-stored-point-gate
s_a=\max_i|\widehat J_{i,a}|,\qquad
\tau_a=128\,\varepsilon_{64}s_a,\qquad
|\widehat J_{c,a}-J^\star_a(c_a)|\leq\tau_a,\qquad
\varepsilon_{64}=2^{-52}.
~~~

| Token | Znaczenie | SI |
|---|---|---|
| $\mathbf x_i,x_{i,a}$ | cztery zapisane pozycje i składowe wierzchołków | $\mathrm m$ |
| $c_a$ | składowa rzeczywiście zapisanego środka | $\mathrm m$ |
| $D_K$ | dodatni dokładny wyznacznik komórki | $\mathrm{m^3}$ |
| $\Phi_i^{\mathrm{out}}$ | moment ściany naprzeciw wierzchołka i, po istniejącej orientacji sorted stable IDs | $\mathrm A$ |
| $J^\star_a$ | kanoniczne pole RT0 ocenione w zadanym punkcie | $\mathrm{A\,m^{-2}}$ |
| $\widehat J_{i,a},\widehat J_{c,a}$ | zachowane próbki binary64 w wierzchołku i środku | $\mathrm{A\,m^{-2}}$ |
| $s_a,\tau_a$ | dotychczasowa skala osiowa i jej budżet | $\mathrm{A\,m^{-2}}$ |
| $i,a,\varepsilon_{64}$ | indeksy i epsilon binary64 | $1$ |

Nie zaokrąglać oczekiwanej wartości do f64 przed porównaniem. Dokładna dyadyczna
nierówność unika przepełnienia i underflow samego budżetu; nie dodaje absolutnego
floor. Skala pozostaje osiowa, a nie normą całego wektora. Weryfikacja geometrii
środka, 64epsilon nodalnych momentów, affinity, bilansu i certyfikatu pozostaje.

Komponent RT0 zależy tylko od odpowiadającej współrzędnej punktu, dlatego ocena
osi a nie musi czytać jeszcze niesprawdzonego center_xyz[a+1]. Zachować kolejność
geometry(a) → current(a), następnie dotychczasowe affinity/moments/bilanse.
Pierwsze użycie momentów wymaga ich dostępności: brak lub niefinitywny moment
może teraz dać odmowę wcześniej niż późniejsza odmowa środka. To jawna zmiana
pierwszej przyczyny dla uszkodzonego źródła, bez dopuszczenia brakujących danych.
NaN w center J ma pozostać odmową tej osi; nie naprawiać go rekonstrukcją.

## Global Constraints

- Nie zmieniać C++ próbkowania, geometrii, zasilania, prądu, normalizacji lub H.
- Nie zastępować zapisanych danych obliczoną referencją. Referencja służy tylko walidacji.
- Zachować accepted source v2 i sampling_policy cell_center_and_cell_local_vertices.v1.
- To zmiana predykatu walidacji, nie jedynie logowania. Starszy runtime może nadal odrzucić prawidłową próbkę; nie obiecywać zgodnego rollback.
- Prywatny świadek odmowy otrzyma v2 z jawną polityką; v1 pozostaje czytelne offline bez reinterpretacji jego mean/difference/budget.
- Bez zmian Python/ProblemIR/OpenAPI, .env, limitów, mountów, profili lub recovery.
- Zachować dirty worktree i 63 wpisy indeksu SHA256 f8c8d727f21451b25db1d2050015b469ad6bdb00b07fdba84136095367eb6fd3.
- Bez lokalnej kompilacji unit testów Rust; regresje wykonywać przez dozwolone CI.
- Jeden nowy managed build 3203; jedno nowe zgłoszenie i jedna materializacja V/J/H na zachowanej siatce. Odmowa kończy sekwencję.
- Bez nowego Gmsh/meshowania, H-only, LLG, usuwania danych lub automatycznego retry.

## Review Focus

1. Skrajne wykładniki, subnormal i zero: dokładne porównanie nie wprowadza floor ani przepełnienia.
2. Błędny znak/porządek momentu lub zmieniony wierzchołek: źródło nadal odrzucane.
3. NaN i zmieszane błędy XYZ/J: pierwsza oś i przeplatanie pozostają jawne.
4. v1/v2 świadka i limit stderr: cały odczyt zachowuje raw bits bez fałszywej interpretacji starej bramki.
5. Koszt: jeden wyznacznik i orientacja na komórkę, bez ich powtarzania na każdej osi oraz bez alokacji świadka na sukcesie.

### Task 1: Kontrola zapisanego punktu, dokumentacja i regresje

**Files:**
- Modify: docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md i sąsiedni source-map.json — tylko właściciel walidacji RT0, mapa źródeł i status kwalifikacji.
- Modify: crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs — prywatny dokładny kontekst komórki i kontrola środka.
- Modify: crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2_affinity_tests.rs — regresje i jawne poprawne momenty dotychczasowych fixture.
- Modify: crates/fullmag-api/src/accepted_study_supervisor.rs — tylko dodatkowa regresja transportu świadka v2.
- Verify: .github/workflows/bootstrap.yml — istniejący filtr całego modułu affinity_tests i worker_failure_reason_ obejmuje nowe testy; bez zbędnej zmiany workflow.
- Modify: examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/offline-analysis/verify_rt0_center_witness.py oraz test_verify_rt0_center_witness.py — osobna obsługa v2, v1 bez zmian.

**Interfaces — planowane prywatne symbole:**
ExactRt0MomentCell::from_cell(points:&[[f64;3];4],vertex_ids:&[u64;4],faces:&BTreeMap<[u64;3],f64>)->Result<Self,RunError>.
ExactRt0MomentCell::matches_center_axis(&self,coordinate:f64,sample:f64,axis:usize,nodal_scale:f64)->Result<bool,RunError>.
ExactRt0MomentCell::verify_vertex_samples(&self,currents:&[f64;12])->Result<(),RunError>.
verify_owned_geometry tworzy kontekst leniwie po geometrii pierwszej osi i używa go
dla środka oraz obecnego miejsca sprawdzania nodalnych momentów. Nie dodawać
stanu do runtime Context ani zależności nowych bibliotek.

- [ ] Step 1: Uzupełnić wspólną notę 0950 i source map przed zmianą numerics; brak zmiany publicznych parametrów, Python→IR i wsparcia GPU. Focused scientific validator i testy kontraktu mają przejść.
- [ ] Step 2: Dodać Rust test stored_point_center_accepts_actual_28881, wczytujący bity istniejącego małego fixture przez CARGO_MANIFEST_DIR/../../examples; przed poprawką musi odtworzyć dotychczasową odmowę. Użyć istniejącego filtra modułu CI, potwierdzić wykonanie nowego testu z jego nazwą i odebrać rzeczywisty RED.
- [ ] Step 3: Dodać stored_point_center_preserves_boundary_and_zero: stałe Jx=8 na unit Tet4, kanoniczne momenty [4,4,0,0] A, środek [0.25;3] m; 8+128epsilon*8 PASS, następne binary64 FAIL, zero PASS, najmniejsze subnormal przy zerowej referencji i skali FAIL.
- [ ] Step 4: Dodać stored_point_center_rejects_wrong_samples_and_moments: w rzeczywistym fixture stara mean Jy jako próbka w zapisanym punkcie FAIL; zmiana znaku niezerowego face_flux[0], brak flux, NaN/Infinity i zdegenerowany Tet4 dają FAIL. Zmiana vertex payload przy niezmienionych preimages musi być odrzucona przez pełną ścieżkę binding, nie wyłącznie helper środka. Dodać skalowania prądu 2^-500/2^500 oraz dokładną translację dyadycznego unit Tet4 wraz ze środkiem.
- [ ] Step 5: Dodać stored_point_center_preserves_failure_order: poprawne pełne momenty w fixture; błędne J osi0 i geometria osi1 dają odmowę J0; błędna geometria osi0 ma pierwszeństwo. Osobno przypiąć wcześniejszą odmowę brakującego momentu i niefinitywnego vertex J.
- [ ] Step 6: Wdrożyć prywatny kontekst i dokładną nierówność. Potwierdzić równoważność wydzielonych 12 nodalnych porównań z dotychczasową referencją BigRational na unit Tet4, cancellation witness, skalowaniach wykładników i rzeczywistej komórce.
- [ ] Step 7: Zachować oryginalny prefix odmowy; świadek fullmag.rt0_center_failure.v2 zawiera schema, comparison_policy=canonical_rt0_at_stored_point.v1, element/axis, wyłącznie klucze schema/comparison_policy/element/axis/vertex_ids/vertex_xyz_bits/vertex_j_bits/center_xyz_bits/center_j_bits/axis_scale_bits/face_flux_bits. Tablice mają dokładnie długości 4/12/12/3/3/4 jak v1; scale jest raw hex16. Null dla brakującej ściany jest wyłącznie dowodem niekompletności, nie zgodą na jej pominięcie. Nie serializować wielkich liczników/mianowników, zaokrąglonej referencji ani starego mean jako nowej wartości oczekiwanej. Nie reinterpretować formatu v1.
- [ ] Step 8: worker_failure_reason_keeps_rt0_center_witness_v2 sprawdza pełny wrapper, stdout640B, JSON i receipt round-trip; RunError<=2048B, raport<=2816B, failure_reason<=4096B. Offline testy obejmują oba schema, odmowę pomieszanych pól i pełny replay dokładnej nierówności.
- [ ] Step 9: Pełne CI, bez skip nowych filtrów; final review zmiany względem zatwierdzonego zakresu. Bez zielonego CI nie uruchamiać buildu. Commitować tylko fragment zadania, z osobnym sprawdzeniem indeksu przed każdym commitem.

**Dokładne komendy weryfikacyjne po zgodzie:**

Poniższe Cargo wyłącznie w istniejącym GitHub CI, nie lokalnie:
- cargo test --locked -p fullmag-runner --lib antenna_field_solution::closed_loop_identity_v2::affinity_tests
- cargo test --locked -p fullmag-api --bin fullmag-api-accepted-scheduler worker_failure_reason_

Oczekiwane: RED nowego stored_point_center_accepts_actual_28881 przed poprawką;
po niej wszystkie stare i nowe testy modułu oraz oba formaty transportu PASS,
zero pominiętych nowych przypadków. Odebrać także końcowy sukces całego workflow.

Lekkie kontrole:
- python3 -B -m unittest discover -s examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/offline-analysis -p test_verify_rt0_center_witness.py
- python3 -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.source-map.json --repo-root .
- python3 -B -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p test_*.py

Oczekiwane: exit0, zachowane siedem starych regresji offline i nowe v2,
walidator noty oraz kontrakty naukowe bez błędów. Nie zastępuje to runtime Task2.

### Task 2: Jeden odbiór rzeczywisty i trwały wynik

**Interfaces:** istniejące just docker-dev-restart-saved-authoring,
docker-dev-submit-accepted i docker-dev-materialize-accepted. Aktualne
piny checkpointu/pakietu odczytać przed wykonaniem; nie kopiować starego owner.

- [ ] Step 1: Potwierdzić profil exec:default@1, pustą kolejkę, brak aktywnych zadań/rezerwacji; zachować scenę, generated Python i FMS. Utworzyć aktualny checkpoint v2 i odebrać pełny native preflight.
- [ ] Step 2: Jedna managed aktualizacja w istniejącej grupie 3203, bez zmiany kontenerów/mountów lub ręcznej retencji; odebrać receipt, hashe API/CLI/workera, snapshot i restore identycznej sceny. Okno czasowo wyłączy API.
- [ ] Step 3: Z istniejącego requestu wygenerować raz nowy run_id/idempotency_key; zapisać bajty/SHA i diff dokładnie dwóch pól. 40728 Tet4/14194 węzły/20H pozostają. Requested minima 1CPU/4GiB; istniejąca polityka auto grant bez zmian, raportować rzeczywisty przydział.
- [ ] Step 4: Run404 i brak fence, jeden Submit. Po niepewnym transporcie tylko GET tego runu; ten sam fingerprint w pending_materialization pozwala na jedną materializację. Brak ponowienia POST.
- [ ] Step 5: Succeeded: odebrać spójne V/J/H, canonical moments i provenance przez publiczne API oraz trwały zapis/cold-read. Failed: zachować pełny receipt i v2 świadek na ext4, wyjaśnić pierwszą odmowę. Nie publikować częściowych danych, nie zmieniać Failed i nie uruchamiać drugiej próby.
- [ ] Step 6: Potwierdzić zwolnienie lokalnych i hostowych rezerwacji. Raport po polsku; niezależnie od wyniku brak automatycznej kwalifikacji E3, LLG lub zgodności z publikacją.

## Dowody przygotowania i self-review

Read-only skrypt stored_point_policy_audit.py w examples/sushruth_2020_closed_gsg/stored_point_validation_20261108/:
SHA256 1b486fb30ecef04e5721bc754c0bfd8f695457ee62231bbc5639dae889a24d6f.
Wynik stored_point_policy_audit.json SHA256:
13c1db69af09adb81a3b7a5232be0e52ef13811d95bfa59c4de1cce647b086b3.
15/15 kontroli PASS. Błąd rzeczywistego Jy względem dokładnej referencji w zapisanym
punkcie: 2.127993927816495e-25 A/m², budżet pozostaje 5.881850519618007e-22 A/m².
Nie wykonywano C++, nowego Solve, buildu ani produkcyjnej bramki.

Niezależny odczyt źródeł potwierdził wybór kanonicznego RT0 w zapisanym punkcie
i konieczność współdzielenia dokładnej geometrii. Nie jest review gotowego patcha.
Self-review planu: kryteria błędu, stałej granicy, negatywnych próbek, kolejności odmów,
zgodności diagnostyki i kosztu mają kroki w Task1; runtime i atomowa publikacja mają Task2.
Kontrolę jednokrotnego utworzenia kontekstu odebrać w final review wywołań verify_owned_geometry; nie dodawać produkcyjnego licznika lub osobnej polityki wydajności. Implementacja i jej pomiar kosztu pozostają niewykonane.

| Realizacja | Status tego projektu |
|---|---|
| FDM CPU | bez zmian i bez nowej kwalifikacji |
| FDM GPU | bez zmian i bez nowej kwalifikacji |
| FEM CPU | projekt naprawy walidacji; dowód arytmetyczny jednej komórki |
| FEM GPU | poza zakresem; brak wniosku o wykonaniu |

Źródła path+symbol:
- backends/fem/cpu/mfem/transport/closed_loop_source_snapshot.hpp::export_closed_loop_source_snapshot.
- backends/fem/cpu/mfem/transport/affine_rt0_element.cpp::AffineRt0Element::retained_current_at.
- crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs::verify_owned_geometry / verify_center_current / verify_rt0_sample_moments.
- crates/fullmag-api/src/accepted_study_supervisor.rs::worker_failure_reason.

Nowy publiczny kontrakt fizyki nie jest publikowany tym planem. Przed implementacją
wymagana jest decyzja zgodnie z AGENTS.md §8 i handoff writing-plans.
