# T17 — granica podłączenia anteny do odpowiedzi harmonicznej

Data: 12.10.2026. Odczyt źródeł: `ca59ab9bca0b1962ba20a302f8738ce56e12af4c`.
Status: **przegląd source-only; T17 OTWARTE**. Nie jest to publikacyjna
nota fizyczna ani kwalifikacja wykonania. Nie uruchomiono solvera, przeglądarki
ani testów jednostkowych. Nie zmieniono produkcji ani odmów wykonania.

## Uzgodnienie prac

Integrator w wątku `01a12a56-002e-7660-8424-c7e07fb0907a` zachowuje własność
produkcji backend/UI i czterech plików przekazanych z poprawką M04. Ten przegląd
jest niezależnym odczytem T17, uzgodnionym z integratorem; nie upoważnia do
równoległej modyfikacji tych plików. Dowody browser FFT nie kwalifikują T17.

## Potwierdzone granice

| Warstwa | Stan odczytany z kodu | Konsekwencja |
|---|---|---|
| CLI | `prepare_solved_antenna_drive_activation` odrzuca aktywne solved antenna drives dla `FemEigen` i `FemFrequencyResponse` | Nie wystarczy usunąć odmowy: brak dalszego kontraktu |
| IR | `FrequencyExcitationIR` zawiera jeden `field_au_per_m: [f64; 3]` i `phase_rad` | Nie reprezentuje przestrzennej bazy A/m/A ani jej tożsamości/projekcji |
| Plan | `FemFrequencyResponsePlanIR` nie ma pola `solved_antenna_drive_bases` | Plan czasowy i częstotliwościowy nie mają obecnie równoważnego nośnika anteny |
| Runner | `build_native_production_payload` rzutuje wspólny wektor excitation na lokalne bazy styczne i tworzy real/imag z cos/sin fazy | Istnieje nośnik zespolonego wymuszenia, ale nie binder przestrzennej anteny |
| Native | `LinearizedDynamicPencil::apply_Aomega` realizuje znak zależny od konwencji; CPU solver zachowuje oba składniki RHS | Podstawy operatora istnieją; nie dowodzi to poprawności antenowego RHS |
| Pomocniczy plan demag | `frequency_response_demag_backend_plan` tworzy `FemPlanIR` z pustymi bazami anteny | To plan dostawcy demag, nie dowód, że należy do niego wkleić dynamiczną antenę |

Komunikat odmowy CLI mówi tylko o FEM time-evolution, chociaż wcześniejsza gałąź
dopuszcza również `Fdm`. Jest to niespójność diagnostyki, **nie dowód obsługi
FDM frequency response**. Naprawa komunikatu pozostaje po stronie integratora.

## Konwencja fazy i zakres wniosku

Źródło nadrzędne: `docs/physics/frequency_domain_solver_physics.md`, sekcje
„Physical Goal” i „Magnetic-Only Frequency Response”. Runner przekazuje
`FrequencyDomainPhaseConvention::ExpIOmegaT` do natywnego żądania.

Dla tej konwencji rekonstrukcja rzeczywistego sygnału ma postać
$H(t)=\operatorname{Re}[\widehat H\exp(i\omega t)]$.
Obecny evaluator czasowy stosuje $\sin(2\pi f t+\phi)+c$.
Zatem dla skalarnego prądu $I(t)=I_a[\sin(\omega t+\phi)+c]$ kandydatem
na **sam składnik AC** jest $\widehat I=I_a\exp[i(\phi-\pi/2)]$,
a składowa DC wynosi $I_a c$. Dla realnej bazy Tier 1 zachodzi
$\widehat{\mathbf H}(\mathbf r)=\widehat I\mathbf h(\mathbf r)$.
To tożsamość algebraiczna, nie wdrożony adapter ani dowód runtime.

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $t$ | czas | $\mathrm{s}$ |
| $f$, $\omega=2\pi f$ | częstotliwość i pulsacja | $\mathrm{Hz}$, $\mathrm{rad\,s^{-1}}$ |
| $i$, $c$ | jednostka urojona i offset waveform | $1$, $1$ |
| $\phi$ | faza sinusoidy | $\mathrm{rad}$ |
| $I_a$, $\widehat I$ | skala prądu i amplituda zespolona AC | $\mathrm{A}$ |
| $\mathbf r$ | pozycja | $\mathrm{m}$ |
| $\mathbf h$ | realna baza pola na jednostkę prądu | $\mathrm{A\,m^{-1}\,A^{-1}}$ |
| $H$, $\widehat H$, $\widehat{\mathbf H}$ | pole rzeczywiste i amplitudy zespolone | $\mathrm{A\,m^{-1}}$ |

Offset musi wejść do jawnie zweryfikowanego pola równowagi albo zostać odrzucony;
nie wolno dopisać go do harmonicznego RHS. Pulse/sinc/piecewise nie są jednym
phasorem bez osobnego kontraktu transformacji. Konwencji przestrzennej Floqueta
nie wolno utożsamiać z konwencją czasową. Dla `exp(-iωt)` amplituda tego samego
rzeczywistego sygnału byłaby sprzężona; obecny odczyt potwierdza plus w runnerze.

Odczyt projekcji pola **nie zamyka** dowodu znaku momentu, współczynnika
żyromagnetycznego, masy FEM ani jednostek natywnego RHS. Przed podłączeniem
anteny trzeba prześledzić cały adapter field→torque/operator; nie mnożyć przez
$\mu_0$ lub gamma na podstawie samej nazwy `drive_real`.

## Kolejność wdrożenia przekazana integratorowi

### Dodatkowy przegląd: pole nie jest automatycznie RHS momentu

Prześledzony wycinek to FEM CPU, nie wszystkie warianty demag/Floquet/GPU.
Pięć plików tej ścieżki (`frequency_response.rs`, `api.cpp`,
`driven_response_solver.cpp`, `operator_terms.cpp`, `mfem_linearized_operator.cpp`)
miało identyczne SHA w checkoutcie integratora w chwili tego odczytu.

| Krok | Ścieżka + symbol | Rzeczywista operacja |
|---|---|---|
| Pole → tangent | `crates/fullmag-runner/src/frequency_response.rs` + `build_native_production_payload` | dot z e1/e2, faza cos/sin; brak mnożenia przez gamma i obrotu precesyjnego w budowie drive |
| ABI → request | `backends/fem/src/api.cpp` + `fullmag_fem_frequency_domain_solve_driven_response_from_c_abi` | przypisanie `mfem_drive_real/imag` do `mfem_validation_problem.drive_real/imag` |
| Request → solver | `backends/fem/src/frequency_domain/driven_response_solver.cpp` + `solve_mfem_production_cpu_problem` | przekazanie drive po ewentualnej projekcji ograniczeń okresowych |
| Solver → RHS | `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp` + `solve_production_cpu_driven_response` | `rhs[row]=drive_real`, `rhs[row+n]=drive_imag` |
| Pole operatora → precesja | `backends/fem/cpu/frequency_domain/mfem_linearized_operator.cpp` + `apply_mfem_linearized_cpu_operator`; `backends/fem/src/frequency_domain/operator_terms.cpp` + `apply_tangent_precession_operator` | $(h_1,h_2)\mapsto(\gamma_0 h_2,-\gamma_0 h_1)$ |
| Masa i adapter | `backends/fem/src/frequency_domain/operator_terms.cpp` + `apply_tangent_frequency_mass_operator`; `driven_response_solver.cpp` + `apply_mfem_production_cpu_canonical_pencil` | masa $(q_1+\alpha q_2,q_2-\alpha q_1)$; adapter ma $L=-S$, $B_\alpha=-M$ |

To wskazuje **potencjalny błąd jednostek/obrotu wymuszenia w istniejącej ścieżce
uniform excitation**, niezależny od brakującego bindera anteny. Natywny solver
traktuje drive jak gotowy algebraiczny RHS, a publiczny runner buduje go jak pole.
Nie jest to jeszcze potwierdzony błąd runtime; nie wykonano niezależnego oracle.
Nie poprawiać przez bezwarunkowe skopiowanie helpera precesji: trzeba najpierw
uzgodnić znak całego operatora, w tym adaptera legacy, i rekonstrukcję odpowiedzi.

Uzupełniające symbole: $h_1,h_2$ to składowe pola w bazie stycznej
[$\mathrm{A\,m^{-1}}$], $q_1,q_2$ to składowe perturbacji jednostkowej
magnetyzacji [$1$], $\gamma_0$ to dodatni współczynnik precesji dla pola H
[$\mathrm{m\,A^{-1}\,s^{-1}}$], $\alpha$ to tłumienie Gilberta [$1$],
$S,M$ to wyjścia legacy operatora precesji i masy, $L,B_\alpha$ to ich
adaptery w pencil. Ich działania na $q$ mają jednostki odpowiednio
$\mathrm{s^{-1}},1,\mathrm{s^{-1}},1$. Obrót pola przez gamma daje
$\mathrm{s^{-1}}$, nie $\mathrm{A\,m^{-1}}$.

**Bramka przed T17:** niezależny macrospin bez exchange/demag/anisotropii,
pole równowagi dodatnie wzdłuż z, niewielkie wymuszenie poprzeczne x; sprawdzić
granicę małej częstotliwości (tilt w kierunku x, skala H_AC/H_DC), fazę obu
komponentów i skończoną częstotliwość przy kilku alpha. Oracle musi wynikać z
LLG, nie z tej samej macierzy, którą testujemy. Porównać również z time-domain
po transjencie. Sam mały residual algebraiczny nie sprawdza fizycznego RHS.

1. Uzupełnić kanoniczną notę 0950 i właściciela frequency-domain o kontrakt
   harmonicznej anteny, pełne mapowanie Python→IR oraz normalizację per-current.
   Nie tworzyć drugiej fizyki w UI ani równoległego solvera anten RF.
2. Zaprojektować nośnik spatial source w IR/planie: przyjęte rozwiązanie, signed
   current normalization, projekcja target/mesh, scalar AC, faza, provenance.
   Wyraźnie oddzielić pole równowagi od dynamicznego RHS i od operatora eigen.
3. Dodać binder przyjętej bazy do RHS, zachowujący lokalne indeksy magnetycznych
   węzłów, orientację baz stycznych i ograniczenia okresowe. Odrzucać stale/missing
   projection, mismatch częstotliwości i nieobsługiwany waveform, bez fallbacku.
4. Prześledzić i zweryfikować natywną normalizację field→RHS. Dopiero wtedy
   zintegrować z istniejącym solverem; nie zastępować tego uniform excitation
   ani dense-reference wynikiem produkcyjnym.
5. Dodać Python/UI/eksport na tym samym kontrakcie: źródło antenowe, AC amplitude
   w A, faza i jej konwencja, sweep Hz, target, równowaga, normalizacja wyników,
   jawne unsupported capability. FFT źródła pozostaje osobnym podwęzłem.
6. Zapisać i następnie wykonać dopuszczone bramki: algebra faz 0/π/2/π i offset;
   przestrzennie niejednorodna baza; odrzucenia; macrospin z niezależnym oracle;
   zgodność amplitudy i fazy z time-domain po zaniku transjentu; bilans jednostek
   i residual; round-trip; backend provenance; browser regresje Inspectorów.
7. Usunąć odmowę `FemFrequencyResponse` wyłącznie dla kwalifikowanego wycinka
   po rzeczywistym wykonaniu. Nie usuwać odmowy dynamicznego drive w eigen.

FEM CPU i FEM GPU wymagają odrębnych dowodów wykonania tej integracji.
FDM CPU/GPU nie uzyskują obsługi frequency response przez analogię do LLG.
Żaden z tych czterech torów nie został tutaj zakwalifikowany dla T17.
Nie deklarować S21 bez modelu detektora/portów; source FFT nie jest odpowiedzią
magnetyzacji ani gwarancją wzbudzenia modu.

## Mapa źródeł i zamrożenie odczytu

SHA-256 odnoszą się do bajtów plików worktree (nie do Git blob IDs).
Każda pozycja ma status **odczyt source-only**, bez wykonanego testu numerycznego.

| Ścieżka | Symbol / sekcja | SHA-256 |
|---|---|---|
| `crates/fullmag-cli/src/orchestrator.rs` | `prepare_solved_antenna_drive_activation` | `4e0bb1e13ba94427263e54c7dbd49645902f11dd3e641b35302ac3704e80abf2` |
| `crates/fullmag-ir/src/frequency_response_contract.rs` | `FrequencyExcitationIR` | `d5f119b1b63eaa78a985e107c1c97fc11d7cf5779475283635246171811bb232` |
| `crates/fullmag-ir/src/plan.rs` | `FemFrequencyResponsePlanIR` | `d76f62224c238b16f9616c60075b40d9159533506376aa06a0828c81eac11658` |
| `crates/fullmag-runner/src/time_dependence.rs` | `evaluate_time_dependence` | `4c18efa6caf790c0399ffc0353e77b978059a755775b86ef051406d944194360` |
| `crates/fullmag-runner/src/frequency_response.rs` | `build_native_production_payload`, `frequency_response_demag_backend_plan`, `try_execute_fem_frequency_response_native_production_cpu` | `7757d437e4f226563634191ab38661892419959e149e45549c737df9e4317364` |
| `backends/fem/src/frequency_domain/linearized_dynamic_pencil.cpp` | `LinearizedDynamicPencil::apply_Aomega`, `apply_Aomega_real_split` | `df5e1ad4563af7dfd4783251a107534df359a6326352dd12e30d8e694c18e523` |
| `backends/fem/cpu/frequency_domain/production_cpu_driven_response.cpp` | `drive_real`/`drive_imag` RHS i wybór `angular_frequency_sign` | `6da912799e8f0d5d409ccaeef26e821c4cf11e1f965f7aec77d6eb987f5dc736` |
| `docs/physics/frequency_domain_solver_physics.md` | Physical Goal; Magnetic-Only Frequency Response | `f480033e5935ce8edd3a5cda10d39e5d09654d72f779091e871802b28d635f5a` |
| `backends/fem/src/api.cpp` | `fullmag_fem_frequency_domain_solve_driven_response_from_c_abi`, mapowanie `mfem_drive_*` | `007aa017426f85f23bdf172499c2f43f67e1fa1ec39c0112c3268d502021c609` |
| `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `solve_mfem_production_cpu_problem`, `apply_mfem_production_cpu_canonical_pencil` | `f1f58c88efff81b1d89d3d21e0eae310ae28adfeafe23232cb231b98c4da8c84` |
| `backends/fem/src/frequency_domain/operator_terms.cpp` | `apply_tangent_precession_operator`, `apply_tangent_frequency_mass_operator` | `2a339c974eb87c046d2ef6faa89eb57945312e71558c721895f734b40fdfef4f` |
| `backends/fem/cpu/frequency_domain/mfem_linearized_operator.cpp` | `apply_mfem_linearized_cpu_operator` | `7924421eb7203592cdecbfc984928dc8542373d54d8bbe9deb976e99d8459713` |

Przegląd nie publikuje nowego API, nie daje wykonalnego przykładu i nie zastępuje
pełnej noty z `.source-map.json` wymaganej przez scientific-documentation-contract.
T17 i naukowe bramki całego modułu pozostają otwarte.

## Uzupełnienie: wykonany niezależny oracle, nie backend

Dodano `scripts/antenna_harmonic_macrospin_oracle.py` + `harmonic_response`
oraz `diagnostic`. Odczyt produkcji powyżej nadal jest source-only; późniejsze
wykonanie dotyczy **wyłącznie niezależnego narzędzia referencyjnego**.
Istniejący `scripts/antenna_macrospin_oracle.py` opisuje pole współliniowe,
dlatego nie zastępuje nowego oracle poprzecznej odpowiedzi harmonicznej.

Wzór wyprowadzono bez macierzy Fullmaga z Gilbert LLG wokół +z. Niezależny
przegląd matematyczny potwierdził wzór, znak precesji, granicę statycznego
przechylenia i konwersję sinusa. Numeryczna kontrola używa pełnego 3D LLG
z iloczynami wektorowymi, nie tej samej macierzy 2×2; wyniki są w granicy
małego sygnału, nie w nieliniowym reżimie dużych wymuszeń.

Parametry zadano w kodzie przed wykonaniem, bez dopasowywania do danych native:
bias 10000 A/m, gamma0 221100 m/(A s), alpha 0.05/0.2,
omega/(gamma0 H0) 0.5/1/1.4, względne pola rzędu 1e-6,
20 czasów zaniku przed pomiarem i 8 pełnych okresów pomiaru. RK4 wykonuje
128 i 256 kroków na okres; wymagany spadek błędu po zagęszczeniu,
błąd względny wektora zespolonego ≤2e-6 i defekt normy ≤1e-10.
Te tolerancje kontrolują tylko oracle. Przyszła bramka Fullmaga musi osobno
ustalić kryteria przestrzenne i czasowe odpowiednie dla konkretnego backendu.

Wykonanie `python -B scripts/antenna_harmonic_macrospin_oracle.py`: exit 0,
`PASS_ORACLE_ONLY`. Pięć kontroli obejmuje DC tilt, znak bez tłumienia,
sinusoidalną fazę dla obu znaków amplitudy, fazę kołową w rezonansie
i odmowę osobliwego rezonansu bez tłumienia. Trzy porównania z 3D LLG dały:

| alpha; omega/(gamma0 H0) | Błąd względny, 128 kroków | Błąd względny, 256 kroków |
|---|---|---|
| 0.05; 0.5 | 4.03886483723612e-7 | 2.5161049684600134e-8 |
| 0.05; 1.0 | 9.653026703594529e-7 | 5.964799756288254e-8 |
| 0.2; 1.4 | 4.169118665674755e-8 | 2.5480382275333263e-9 |

Pełne wyniki i parametry zapisano pod resolverowym storage tego worktree:
`reviews/antenna-harmonic-oracle-20261012/receipt.json`. SHA-256 źródła oracle:
`3f4fdd97d4cd65720c138337a4b5e5304b8b19e3a7d7aece164a62b227416098`.
Nie uruchomiono native, browser ani kompilacji testów jednostkowych.
Nie porównano jeszcze żadnego wyniku Fullmaga z tym oracle.
Narzędzie nie obsługuje wymiany, demag, anizotropii, meshu ani portów anteny
i nie kwalifikuje żadnego z czterech backendów. T17 pozostaje otwarte.

## Mapa istniejących artefaktów → publiczne API

Odczyt przy `a193ccc7bd49886b6bf6fd2fa9d1dce0f5e6dfcd`. Zgodnie z ustaleniem
integratora nie dodano comparatora ani wymyślonego manifestu. Nie ma jeszcze
potwierdzonego kompletnego artefaktu harmonicznej odpowiedzi anteny do porównania.
Poniżej jest rzeczywisty kontrakt istniejącego writera, nie deklaracja T17 PASS.

| Warstwa / tożsamość | Źródło + symbol | Semantyka odczytana |
|---|---|---|
| Trwały manifest `frequency_domain/manifest.v1.json` | native `driven_response_solver.cpp` + `write_mfem_validation_artifacts` | `physics.llg_gamma0_si`, `llg_alpha`, `phase_convention`, `frequency_units=Hz`, `field_units=A_per_m`, `normalization=linear_response_tangent`; artifact paths |
| Sweep `response/magnetic_response_sweep.v2.json` | ten sam writer | `complete`, completed count, `points[]`, ścieżki point/payload; direct harmonic response |
| Point `response/frequency_points/frequency_NNNN.json` | ten sam writer + `build_response_point_series_json` | `m_complex` jest listą par real/imag surowych DOFs odpowiedzi; nie automatycznie XYZ. `phase_rad` w wierszu to faza odpowiedzi, a faza źródła jest w `excitation_provenance.phase_rad` |
| XYZ i tangent | ten sam writer | XYZ powstaje tylko przy dostępnym frame/nodes i layout 2 tangent DOFs na node / 3 pełne DOFs. XYZ Zarr `<f8`, shape `[N,3,2]`, interleaved real/imag; tangent to osobny payload i osobna baza |
| Aktualny katalog artefaktów | `crates/fullmag-api/src/session.rs` + `current_artifact_dir`; `artifacts.rs` + `require_current_live_artifact_dir` | najpierw artifact_dir aktualnego run, potem session; brak workspace/directory jest odmową. Ten odczyt nie kwalifikuje ścieżki historycznych runów |
| Sweep HTTP | `analysis/frequency_domain.rs` + `get_frequency_domain_response_magnetic_sweep` | `/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep`; preferuje v2, potem v1 |
| Point HTTP | ten sam moduł + `get_frequency_domain_response_frequency_point` | `/v2/sessions/current/analysis/frequency-domain/response/frequency-points/{index}`; ścieżka z sweep lub convention fallback |
| Field meta HTTP | ten sam moduł + `get_frequency_domain_response_field_meta` | `/v2/sessions/current/analysis/frequency-domain/response/field/{index}/meta`; field ID `analysis:frequency-response:frequency-NNNN`, quantity `delta_m`, basis/encoding/views i resource_key |
| Binary HTTP | `data/fields.rs` + `analysis_frequency_response_vector_response` | `/v2/sessions/current/data/fields/{field_id}/samples/vector`; manifest→sweep→point→fallback wybiera payload; decoder finite LE f64 complex pairs, kontrola zadeklarowanej liczby wartości |
| Widoki binary | `data/fields.rs` + `analysis_complex_component_view_values` | `complex/full` zachowuje pary i 2×component_count; real/imag/abs/phase zwracają projekcję. `phase_rotated_real` to Re(z exp(i phase)), a nie pełny phasor do comparatora |

`FrequencyDomainFieldResource` nie ma osobnych pól units, normalization ani
phasor convention. Nie wolno wywodzić ich z nazwy `delta_m`: przyszły comparator
musi powiązać manifest.physics z point, payload i prerejestrowanym wejściem.
Nie wolno zastąpić tego zaufaniem do diagnostyki residual lub scalara amplitude.
W szczególności komponentowe abs usuwa informację o znaku/fazie; `m_complex`
w JSON wymaga jawnej rekonstrukcji frame, podczas gdy globalny XYZ payload
ma tę rekonstrukcję już wykonaną. Brak frame nie uprawnia do traktowania tangent
e1/e2 jako osi x/y.

### Ryzyko tożsamości meta/binary przed kwalifikacją

`frequency_domain_field_content_digest` hashuje kolejno długość serialized
metadata (LE u64), metadata, długość payload (LE u64) i rzeczywiste payloadbytes.
Meta revision/content_digest jest więc digestem **metadata + payload**, nie
samego pliku, mimo węższego komentarza w typie.

Binary `analysis_payload_revision` używa natomiast domain_generation XOR
byte_len i rolling hash ścieżki. ETag budowany jest z field ID, tego revision,
view/component i fazy. W tym algorytmie zmiana bajtów przy tej samej
generacji, ścieżce i długości **nie zmienia revision/ETag**. Jest to źródłowo
potwierdzona luka association/cache; nie wykonano HTTP reprodukcji.
Nie narzucać identycznego ETag dla raw complex i transformowanych widoków:
potrzebne są wspólna tożsamość źródła oraz osobna tożsamość reprezentacji.
Integrator otrzymał ustalenie; produkcja nie została zmieniona.

### Zamrożenie odczytu dodatkowej mapy

| Ścieżka | Symbol | SHA-256 |
|---|---|---|
| `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` | `get_frequency_domain_response_field_meta`, `frequency_domain_field_content_digest` | `3f463bacf550afce46f857a91e04d65a244bbbddfa4037e736a4d19ef73f67b9` |
| `crates/fullmag-api/src/router_v2/handlers/data/fields.rs` | `analysis_frequency_response_vector_response`, `analysis_payload_revision`, `analysis_complex_component_view_values` | `335935aadafab915d2ae13588fb29637ee6244578c9ad9f6697bd346566f54bd` |
| `crates/fullmag-api/src/artifacts.rs` | `require_current_live_artifact_dir`, `try_resolve_artifact_path` | `5b0e899d7a8c289402959818adfd4d787be39a4bf2e76e5763fdcc37e99a7796` |
| `crates/fullmag-api/src/session.rs` | `current_artifact_dir` | `44a46462e9707a070723435fadee558ec69c1f4171923126289b39fcc1298f0a` |
| `crates/fullmag-api/src/router_v2/mod.rs` | routes response magnetic-sweep/frequency-points/field-meta | `8910ac4c6c9274d737531bd518b8eec51d98cd63b4c1442c4e42f936c11865fa` |
| `docs/specs/frequency-domain-artifacts-v2.md` | native FEM response metadata contract | `a1bd9d6319e198d5b959c0aeaa60ab9c27d929c77d2a0353a9ec1a21c72f3bfc` |

SHA native writera podano w poprzedniej mapie; źródło nie zmieniło się.
API odczytano, ale endpointów tutaj nie wywołano, OpenAPI nie regenerowano,
browser/native/unit build nie wykonano. Mapowanie nie jest dowodem zgodności
archiwum konkretnego run ani ukończenia API/UI anteny.

## Uzupełnienie: publiczna trasa harmoniczna i brak integracji anteny

Odczyt 12.10.2026 z worktree integratora
`D:/git/fullmag/worktrees/antenna-transport-e2e-20261011`, HEAD
`93682dbbf7acbc4c028f5692ec4a164883b8a3fd`. Checkout zawiera WIP;
poniższe SHA-256 opisują odczytane pliki, nie sam commit.
To audyt źródeł i propozycja integracji, nie nowa nota fizyczna ani
kwalifikacja runtime. Zakres uzgodniony z integratorem: bez zmian w jego
checkoutcie, comparatora, zmian znaków/gamma oraz kolejki/builda.

| Granica | Ścieżka + symbol | Potwierdzony stan |
|---|---|---|
| Publiczny Python | `packages/fullmag-py/src/fullmag/model/study.py` + `FrequencyResponse.to_ir` | `excitation` zawiera jednorodny `field_au_per_m` i `phase_rad`, bez referencji do przestrzennej bazy anteny |
| IR | `crates/fullmag-ir/src/frequency_response_contract.rs` + `FrequencyExcitationIR` | ten sam wektor i faza; brak harmonicznego źródła antenowego |
| Plan | `crates/fullmag-ir/src/plan.rs` + `FemFrequencyResponsePlanIR` | brak carrier'a rozwiązanej bazy anteny; istniejącego `ResolvedSolvedAntennaDriveBasisIR` nie należy zastępować fikcyjnym planem czasowym |
| Aktywacja CLI | `crates/fullmag-cli/src/orchestrator.rs` + `prepare_solved_antenna_drive_activation`, `attach_solved_antenna_drive_bases` | aktywna baza odrzucana dla `FemFrequencyResponse`; materializacja obejmuje plany czasowe FEM/FDM |
| Wymuszenie runnera | `crates/fullmag-runner/src/frequency_response.rs` + `build_native_production_payload` | projekcja jednorodnego wektora na lokalne tangent frames, z fazą; nie ładowanie przestrzennego pola anteny |
| ABI | `crates/fullmag-runner/src/native_fem/frequency_domain.rs` + `solve_native_driven_frequency_response_impl` | request ustawia `DRIVE_UNSPECIFIED`, `require_nonzero_rhs=0`; ta obserwacja nie dowodzi poprawności lub błędu fizycznego RHS |
| Natywny writer | `backends/fem/src/frequency_domain/driven_response_solver.cpp` + `write_owned_response_manifest`, `write_mfem_validation_artifacts` | ownership session/run/stage/runtime; point wskazuje payload ścieżką, deklaruje layout i `excitation_provenance.kind=field`. Nazwa funkcji zawierająca validation nie oznacza wyłącznie reference lane |

Wykonano izolowany probe publicznego autora: `fm.FrequencyResponse` z jednym
punktem 1 GHz, wektorem `(1,2,3)` i fazą `0.375`, z `fm.SaveResponse('m_complex')`.
Assert sprawdził dokładnie dwie właściwości serializowanego `excitation`:
`field_au_per_m=[1.0,2.0,3.0]` i `phase_rad=0.375`.
Wynik `PASS_AUTHORING_ONLY`, exit code 0; `solver_executed=false`.
Nie jest to dowód kompletnego authoring→plan→runtime ani odpowiedzi anteny.

### Kolejność minimalnej kompletnej integracji

1. **Jawne źródło harmoniczne Python→IR→plan→UI.** Zachować istniejące
   wymuszenie jednorodne; dodać jawny wybór rozwiązanej anteny i projekcji.
   Kryterium: publiczny autor oraz eksport UI odtwarzają identyczne źródło,
   a nie tylko opis tekstowy. Dokładne nazwy nowych parametrów wymagają
   projektu kontraktu — nie są istniejącym API.
2. **Walidacja semantyki częstotliwości i aktywacji.** `all_time_evolution`
   nie aktywuje automatycznie FMR. Rozstrzygnąć relację częstotliwości
   sinusoidy do punktów sweepu; nie nadpisywać jej milcząco ani nie traktować
   DC, pulse/sinc/samples jako równoważnego phasora. Kryterium: jawne zasady
   i odmowy dla niezgodnych kombinacji, zachowanie requested intent.
3. **Materializacja przestrzennego źródła.** Reużyć walidowany
   `crates/fullmag-ir/src/antenna_field_solution.rs` +
   `load_solved_antenna_drive_basis_projected`; zapewnić zgodny target,
   maskę, mapping i topology identity. Obecne
   `materialize_fem_solved_antenna_drives_v03` przyjmuje plan czasowy,
   więc nie podłączać go przez sztuczny `FemPlanIR`. Kryterium: prawdziwa
   baza z artefaktu, jawny prąd peak i faza oraz poprawna kolejność compact
   magnetic nodes; odrzucenie niezgodnego/starego assetu.
4. **Kontrakt operatora/RHS.** Podłączyć przestrzenne wymuszenie zgodnie
   z jednostkami i konwencją istniejącego operatora. Pole tangent nie jest
   automatycznie dowodem poprawnego torque RHS. Kryterium: niezależny
   oracle i rzeczywiste native wykonanie; żadnego dobierania znaków/gamma
   do oczekiwanej krzywej. Dotychczasowy oracle nie kwalifikuje tego kroku.
5. **Input→manifest→point→payload.** Ustanowić kanoniczną tożsamość
   rzeczywistych real/imag drive bytes wraz ze źródłem, port mode,
   projekcją, targetem, indeksami/frame, częstotliwością, fazą i normalizacją.
   Powiązać ją z digestem faktycznych bytes odpowiedzi i publikacją spójnego
   zestawu. Kryterium: walidator wykrywa podmianę wejścia, punktu lub payloadu;
   session/run/stage ownership ani ścieżka pliku nie zastępują tego dowodu.
6. **Publiczne wykonanie i frontend.** Dodać wybór źródła w istniejącym
   authoring/Inspector, capability i round-trip; dopiero prawdziwy artefakt
   sprawdzić przez istniejące v2 meta/binary i widoki complex/real/imag.
   Kryterium: udokumentowane żądania i runtime/browser receipts, w tym
   faza/komponenty oraz invalidation. Fixture-only ani parser PASS nie zamykają T17.

Usunięcie wyłącznie odmowy CLI, dodanie pola provenance po wykonaniu lub
podstawienie artefaktu reference nie realizuje tej ścieżki. Propozycja nie
redukuje T17 do jednego punktu: pojedynczy zgodny punkt może być pierwszym
testem integracyjnym, lecz nie zastępuje kwalifikacji sweepu i całego planu.

### Zamrożone źródła tego uzupełnienia

| Ścieżka z tabeli powyżej | SHA-256 |
|---|---|
| `packages/fullmag-py/src/fullmag/model/study.py` | `d52d2d2ffe33d2e7eda7f527afbe9765632bc780fb2c8d1830a7626a9e61fea9` |
| `crates/fullmag-ir/src/frequency_response_contract.rs` | `d5f119b1b63eaa78a985e107c1c97fc11d7cf5779475283635246171811bb232` |
| `crates/fullmag-ir/src/plan.rs` | `1137094e9facb154396de5fdd6e35767159b0e8add657bdb8907a659953ade6d` |
| `crates/fullmag-cli/src/orchestrator.rs` | `2af1b66f082fe61f4169f7e4364453a6fc14eda2e98a9a475c0c9b0a8a8cfa7d` |
| `crates/fullmag-runner/src/frequency_response.rs` | `7757d437e4f226563634191ab38661892419959e149e45549c737df9e4317364` |
| `crates/fullmag-runner/src/native_fem/frequency_domain.rs` | `a641452851b13f0929658907fa3eae220488096f16d5847bf4bcb09be6fd8717` |
| `backends/fem/src/frequency_domain/driven_response_solver.cpp` | `f1f58c88efff81b1d89d3d21e0eae310ae28adfeafe23232cb231b98c4da8c84` |

Historyczna sekcja cache powyżej opisuje stan przed poprawką. Aktualny
checkpoint integracji cache znajduje się w
`2026-10-12-fmr-cache-integration-checkpoint.md`: patch zastosowany przez
integratora i zweryfikowany hashami; regresja HTTP jeszcze bez wykonania.
Nie utożsamiać tego z zamknięciem naukowego input/output association.
