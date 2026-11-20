# Audyt implementacji Spin Hall (SHE) i transportu spinowego w Fullmag

| Metadana | Wartość |
|---|---|
| Data | 2026-11-18 |
| Rewizja | `master`, `e8402f3f6c4859bc85b2c9fb441389e544e9fc63`. W trakcie audytu `master` przesunął się z `27484e8bc` na `e8402f3f6`. W audytowanym zakresie zmieniły się tylko `crates/fullmag-authoring/src/validation.rs` (przesunięcie linii ≤3) i `crates/fullmag-plan/src/fem.rs` (zmiany przed linią 5095; cytowane miejsce czytane na `e8402f3f6`). |
| Zakres | fizyka M1/M2/M3 (0970), FDM CPU (Rust i natywny C++), FDM GPU (CUDA), FEM CPU (MFEM), sprzężenie z LLG w runnerze, Python DSL → ProblemIR → walidacja → planner → authoring, Control Room |
| Charakter | audyt statyczny, tylko do odczytu; bez kompilacji (zakaz `cargo test` / `just test`), bez Dockera |
| Uruchomione | `pytest` dla 3 plików `packages/fullmag-py/tests/test_spin*` (systemowy `python3`, bo `.fullmag/local/python` nie istnieje); `node scripts/check_spin_authoring_forms.mjs` |
| Zmiany kodu | brak |

Poprzednie raporty, z którymi ten audyt jest porównywany:

- `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/README.md` (audyt STT/SOT/SHE/Oersted);
- `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/AUDYT_UI_EXPLORER_FIZYKI_PRADOWEJ_2026-08-09.md`;
- `docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/FDM_GPU_M1_SPIN_CLOSURE_2026-08-10.md`.

---

## 1. Werdykt wykonawczy

1. **Rdzeń fizyki jest poprawny we wszystkich czterech realizacjach**, które istnieją w kodzie (Rust FDM CPU, natywny C++ FDM CPU, CUDA FDM, MFEM FEM CPU). Kod zgadza się z notą `docs/physics/0970-spin-hall-drift-diffusion-transport.md` w tych punktach:
   - konwencja `G = −½∇μ_s` z czynnikiem ½ użytym dokładnie raz;
   - indeksy `Q_ia` i znak `θ_SH σ ε_ika E_k`;
   - partner Onsagera iSHE w M2;
   - reakcje `R_sf`, `R_J = …(μ×m)`, `R_φ = …m×(μ×m)`;
   - moment `−γ_e/M_s · ħ/2e · (R_J+R_φ)` bez spin-flipu;
   - prawo mixing conductance z czynnikiem ½ przy `m·Δμ`;
   - warunek Schura;
   - tableau ARS(2,3,2) i `C_s = e²N₀`.

   Nie znaleziono błędu znaku ani czynnika w samym operatorze transportu.
2. **Cicha zmiana dynamiki w FEM (P0).** FEM CPU M2+LLG dodaje źródło momentu w postaci Gilberta wprost do RHS w postaci LL, bez konwersji `(T + α m×T)/(1+α²)` (SHE-P0-1). FDM CPU i GPU robią tę konwersję poprawnie, a FEM SOT też. Maska targetu momentu w FEM nie jest stosowana (SHE-P1-12).
3. **Fałszywe provenance i diagnostyka (P0).**
   - Przebiegi FDM M2 i M3 nie mają wpisu provenance transportu.
   - GPU publikuje „bilanse” będące kopią residuum Kryłowa, a dla siatek powyżej 4096 komórek `torque_balance = 0`.
   - Bilans spinu FEM jest najpewniej tautologią.
   - Polityka `reject_unassigned` na FDM CPU jest po cichu zamieniana na `SpinInsulating`, bez wpisu w provenance.
4. **Aktywacja fizyki w FEM (P0).** Planner FEM nie filtruje modułów przez `physics_graph`. Moduł wyłączony w grafie zostanie zaplanowany i wykonany (SHE-P0-2).
5. **Dokładność interfejsu N|F (P1).** Mixing conductance w FDM używa `Δμ` z centrów komórek, bez półkomórkowego oporu objętościowego. M2 robi tak samo z `ΔV`. Błąd jest pierwszego rzędu w `h` i skaluje się jak `G·h/σ_s`.
   - Szacunek analityczny: dla `G_r ≈ 10¹⁵ S/m²`, `h = 1 nm` i `σ_s ≈ 10⁶ S/m` błąd jest rzędu 100% absorbowanego strumienia i momentu.
   - Wewnętrzne bramki residuum tego nie wykryją, bo sprawdzają samozgodność dyskretyzacji.
   - Wykonana wcześniej bramka BORIS N/F przy `Gmix = 1,5·10¹⁵ S/m²` (`BORIS_FULLMAG_SHE_COMPARISON.md` §7.8) ma status `incomparable`, z maksymalnym względnym błędem absorbowanego strumienia ≈ 1,0 i `μ_s` ≈ 1,9. Jest to spójne z tym oszacowaniem, ale nie dowodzi, że to jedyna przyczyna, bo otwarte pozostają też mapowanie `Gi/Gmix` i normalizacja momentu.
6. **Wydajność nie nadaje się do produkcyjnego sprzężenia z LLG w żadnym lane.**
   - FDM CPU: solvery spinu i ładunku M1 są bez prekondycjonera i matrix-free. Każdy matvec od nowa liczy stałe źródła i przeszukuje interfejsy liniowo. Ładunek i Oersted O(N²) są liczone od nowa w każdym etapie RK, mimo że w M1 nie zależą od `m`.
   - FDM GPU: kernele przeszukują deskryptory liniowo, workspace jest realokowany przy każdym solve, a hierarchia AMG jest przebudowywana co etap. Raport zamknięcia podaje 18,7 s na solve dla siatki 1024×128×8, przy 1,4 ms samego GMRES.
   - FEM: każde wywołanie od nowa importuje siatkę i składa formy. GMRES jest bez prekondycjonera, także dla monolitycznego bloku 4N M2.
7. **Python/IR są kompletne parametrycznie, ale walidacja jest powielona 3–4 razy i już się rozjeżdża.**
   - IR nie waliduje `λ_J`, `λ_φ` ani `default_external_boundary`.
   - SceneDocument nie potrafi wyrazić jedynej wykonywalnej ścieżki FEM M2.
   - Publiczny przykład FEM M2 używa silnika odrzucanego przez planner FEM.
8. **Control Room.** Projekcje tensora `Q_ia` są zgodne z kontraktem, ale:
   - legenda viewportu nie ma jednostki ani tokenu projekcji;
   - poprawne zasoby z interfejsem związanym z powierzchniami albo z operatorem FEM są pokazywane jako „Unknown variant, read-only”;
   - momentu `drift_diffusion_spin_torque` nie da się autorować;
   - bramka parytetu formularzy jest czerwona i niepodpięta do CI.

### 1.1. Stan według realizacji

| Lane | Capability (matryca) | Fizyka operatora | Sprzężenie LLG | Provenance / diagnostyka | Wydajność | Werdykt audytu |
|---|---|---|---|---|---|---|
| FDM CPU Rust (M1/M2/M3) | `reference_executable` (M1 SHE, M2 iSHE bounded, M3) | zgodna; interfejs N\|F pierwszego rzędu (P1) | M1/M2 Heun co etap, ARS M3 poprawne; δT M2 niespójne z §2.6 | **brak wpisu M2/M3** (P0), telemetria M2 na sztywno 0 (P1) | referencyjna, nieskalowalna | wykonywalny referencyjnie; nie produkcyjny |
| FDM CPU natywny C++ (M1) | `semantic_only`, executable | zgodna, parytet z Rust | M1 co etap | poprawne bramki fail-closed | lin. search interfejsów, brak prekondycjonera | zgodny; opt-in |
| FDM GPU CUDA (M1) | `semantic_only` | zgodna (tożsamości \|m\|=1) | Heun/RK4 transakcyjnie | **bilanse fałszywe** (P0), brak 3 bramek CPU (P1) | ~18 s/solve poza GMRES | nie spełnia własnego kontraktu §3.1.1 |
| FEM CPU MFEM (M1/M2) | `reference_executable` | słaba postać zgodna | **brak konwersji Gilberta** (P0), maska ignorowana | bilans spinu tautologiczny (P0, warunkowo) | brak reuse i prekondycjonera | operator OK; sprzężenie z LLG błędne |
| FEM GPU | `semantic_only` | brak realizacji | — | fail-closed w 5 warstwach | — | zgodny z deklaracją |

---

## 2. Metoda, poziomy dowodu i ograniczenia

Pracę podzielono na sześć obszarów czytanych równolegle. Każde znalezisko P0 i każde twierdzenie o znaku lub czynniku zostało potem ponownie otwarte w kodzie przez autora raportu. Weryfikację własną oznaczono „(zweryfikowane)”.

| Tag | Znaczenie |
|---|---|
| **CODE** | potwierdzone bezpośrednio w kodzie (`plik:linia`) |
| **CONTRACT** | wynika tylko z noty, specyfikacji lub nazwy testu |
| **RUN** | faktycznie uruchomione w tym audycie |
| **NOT VERIFIED** | brak dowodu |

| Poziom | Definicja |
|---|---|
| **P0** | cichy błąd fizyki, utrata danych kanonicznych albo fałszywe provenance/diagnostyka; blokuje użycie danej ścieżki |
| **P1** | poważna niespójność cross-backend, z normą lub błąd numeryczny pierwszego rzędu, bez cichego złamania kontraktu |
| **P2** | dług, martwy kod, dryf dokumentacji, brak testu |

Ograniczenia:

- Nic nie zostało skompilowane ani uruchomione poza testami Pythona i skryptem Node.
- Wszystkie liczby wydajności to analiza kodu albo wartości z raportów zamknięcia (CONTRACT), a nie pomiar.
- Pokrycie: ścieżki produkcyjne z listy ~130 plików wskazanych przez grep (`spin hall`, `spin_hall`, `theta_sh`) przeczytano w zakresie fizyki, sprzężenia i wydajności. Nie analizowano w głąb:
  - skryptów weryfikacyjnych i porównawczych (`scripts/verify_*`, `scripts/run_*boris*`, `scripts/boris_*`);
  - fixture `tests/standard_problems/transport/racetrack_m1_v1` (poza testem golden);
  - diagramów `public_docs/site/_static/diagrams/*`;
  - `crates/fullmag-api/src/router_v2/tests.rs`;
  - dokumentów `docs/superpowers/*`, `docs/plans/active/SHE.md` i not 0800/0820 (użyte tylko jako kontekst);
  - treści testów kontraktowych C++/CUDA (oceniono tylko to, co sprawdzają).
- Semantyki MFEM (`BilinearForm::Mult` po `FormLinearSystem`, `ProjectCoefficient` w węzłach wspólnych, `mfem_error`) nie dało się sprawdzić, bo źródeł MFEM nie ma w repozytorium.
- Testów Rust, C++ i CUDA nie wykonywano. Status „przechodzi” pochodzi wyłącznie z dokumentów.

---

## 3. Fizyka krok po kroku

### 3.1. Model normatywny (0970 §2)

Zmienne: `V` [V], pełne rozszczepienie spinowe `μ_s` [V] (kanały `V ± μ_s/2`), `E = −∇V`, `G_ia = −½ ∂_i μ_s,a`. Tensor `Q_ia` [A/m²] ma pierwszy indeks przepływu `i` i drugi indeks spinu `a`.

| Krok | Równanie | Uwagi |
|---|---|---|
| M1 ładunek | `J_c = σE`, `div J_c = 0` | bez sprzężenia zwrotnego ze spinu |
| M1 spin | `Q_ia = σ_s G_ia + Pσ E_i m_a + θ_SH σ ε_ika E_k` | direct SHE i polaryzowany przepływ |
| M2 ładunek | `J_c,i = J_mr,i + Pσ m_a G_ia + θ_SH σ ε_ija G_ja`, gdzie `J_mr = σ⊥E + (σ∥−σ⊥)(m·E)m + σ_AHE m×E` | iSHE jest partnerem Onsagera, a nie osobnym znakiem |
| Dodatniość | `min(σ∥,σ⊥)σ_s − P²σ² > 0`; w przypadku izotropowym `σ_s − P²σ > 0` | warunek Schura |
| Bilans spinu | `C_s ∂_t μ + ∂_i Q_ia = −R_sf − R_J − R_φ` | M1/M2 quasi-statyczne; M3 z `C_s = e²N₀` |
| Reakcje | `R_sf = σ_s/(2λ_sf²) μ`, `R_J = σ_s/(2λ_J²)(μ×m)`, `R_φ = σ_s/(2λ_φ²) m×(μ×m)` | `λ = ∞` to jawne `disabled` |
| Moment | `T_G = −γ_e/M_s · ħ/2e · (R_J + R_φ)` | spin-flip trafia do sieci, nie do magnesu |
| Interfejs N→F | `j_c,n = (G↑+G↓)ΔV_Γ [+ ½(G↑−G↓) m·Δμ tylko w M2]`, `q_∥ = [(G↑−G↓)ΔV_Γ + ½(G↑+G↓) m·Δμ] m`, `q_⊥ = G_r m×(Δμ×m) + G_i (Δμ×m)` | `ΔV_Γ` z trace'ów ładunku |
| SML v2 | `μ_R = (G_N μ_N + G_F μ_F)/(G_N+G_F+G_R)` | rezerwuar, moc ≥ 0 |
| Czas | M1/M2: solve w każdym etapie RK; M3: ARS(2,3,2) z podwajaniem kroku `1/(2²−1)` | wspólny czas etapów, rollback |
| LLG | `T_RHS = (T_G + α m×T_G)/(1+α²)` (0970 §2.6.2) | dokładnie jedna konwersja |

### 3.2. Weryfikacja równań w kodzie

| Równanie | Rust FDM CPU | C++ FDM CPU | CUDA FDM | MFEM FEM CPU |
|---|---|---|---|---|
| ½ w `G` dokładnie raz | OK `spin_drift_diffusion.rs:1298-1302,1347-1352,1648`; M2 `coupled_charge_spin.rs:726-727,912-915` (zweryfikowane) | OK `spin_transport_v1.cpp:678-682,716-718,750` | OK `device_solver.cu:535-538,804-805,1337-1340` | OK `steady_transport.cpp:896` (M1), `:442-453` (M2) |
| SHE `θσ ε_ika E_k` | OK: `cross(normal, E)·θσ`, bo `(n×E)_a = ε_aik n_i E_k = ε_ika E_k` (`:1337,1687`, zweryfikowane) | OK `spin_transport_validation_v1.cpp:17-19` | OK `device_solver.cu:279-280` | OK `steady_transport.cpp:330-342` |
| Rekonstrukcja `E` na ścianie | dokładna z prądu ścian (`:1694-1714`); fallback z różnic `V` bez provenance (`:1716-1729`) | z prądu ścian (`:583-590,693-694`) | z prądu ścian (`:307-309,365-375`) | `∇V` w elemencie |
| Człon `Pσ E_n m_f` | upwind wg znaku `P·J` (`:1308-1315`) | upwind | upwind | centralnie w kwadraturze |
| M2 `J_mr`, iSHE, Onsager | OK `reciprocal_constitutive.rs:134-166` | n/d | n/d | OK `steady_transport.cpp:427-476`; test `steady_transport_contract.cpp:791-819` |
| Warunek Schura | M1 `spin_drift_diffusion.rs:348-355`; M2 `reciprocal_constitutive.rs:59-75` | — | — | `steady_transport.cpp:603-614`, C API `:1986-1994` |
| `R_sf`, `R_J`, `R_φ` | OK `:865-879` (zweryfikowane) | OK `:886-898` | OK, ale `R_φ` jako `μ − m(m·μ)` (wymaga \|m\|=1) `:478,706,1437` | OK `:266-291` |
| Moment `−γ/M_s ħ/2e (R_J+R_φ)` | OK `:1044-1047`; interfejs `A/V` na `to_cell` `:1058-1074` (zweryfikowane) | OK `:1140-1163` | OK `:1439-1447`, ale cichy 0 poza targetem (P1) | OK `:1476-1496` |
| Znak γ_e | dodatni moduł (0970:698); planner `γ0/μ0 > 0` (`plan/spin_transport.rs:1579,2896`), więc znak `−` w momencie pochodzi wyłącznie z wzoru (zweryfikowane) | jak Rust (`gamma_e` z deskryptora) | jak Rust (`formula->gamma_e`) | jak Rust (planner `:1579`) |
| Konwersja Gilberta w RHS | OK, raz: `direct_torques.rs:183-210` | (przez runner) | OK `transport_rhs_fp64.cu:39-45` ze skalarnym α; niejednorodne α/Ms odrzucone `c_api.cpp:2845-2852` | **BRAK** `transport_stage.cpp:182-192` (zweryfikowane) |
| Mixing (½ przy `m·Δμ`) | OK `:1534-1547` (zweryfikowane) | OK `:629-642` | OK `:433-444`; `m` z `m_stage`, a nie z deskryptora | fail-closed |
| `ΔV_Γ` z trace'ów | M1 tak (`:1514-1524`) z latentnym fallbackiem (`:1525-1528`); **M2 z centrów komórek** (`coupled_charge_spin.rs:881,1920`) | tak (`:627`) | tak, dopasowanie po indeksie tablicy (`:403-409`) | n/d |
| `Δμ` przy interfejsie | **z centrów komórek** (`:1529-1532`; M2 `:882,1921`) | z centrów komórek | z centrów komórek | n/d |
| SML v2 | wykonywany w M2 Rust (`:1548-1599`); legacy `g_sml` odrzucony (`:2217-2221`) | fail-closed (`:412-414`) | fail-closed (`context.cu:1288-1289`) | fail-closed |
| M3: `C_s = e²N₀` | `fullmag-ir/src/lib.rs:129`; zgodność 1e-12 `validation.rs:3859-3868` | n/d | n/d | n/d |
| ARS(2,3,2) | tableau `types.rs:128-137`, `integrators.rs:1376-1458`; część niejawna `transient_spin.rs:311-378`; `1/3` `spin_transport.rs:1714` | n/d | n/d | n/d |
| BDF2 (wyrocznia) | masy poprawne; przy zmianie `dt` błąd zamiast restartu BE (`transient_spin.rs:507-520`) | n/d | n/d | n/d |

Wniosek: **równania konstytutywne, reakcje, moment i prawo interfejsu są poprawne we wszystkich realizacjach.** Problemy dotyczą czterech rzeczy:

- granicy z LLG w FEM;
- dyskretyzacji interfejsu (rząd zbieżności);
- spójności diagnostyki i provenance;
- semantyki planowania.

### 3.3. Uwaga o schemacie upwind (decyzja kontraktowa)

`fv_spin_upwind_v1` wybiera `m_f` ze strony „pod prąd” według znaku `P·J_c` (`spin_drift_diffusion.rs:1308-1315`, norma 0970:1202-1210).

- Człon `Pσ E_n m_f` jest afinicznym źródłem: `E` i `m` są dane, a niewiadomą jest wyłącznie `μ`. Upwind nie zmienia więc macierzy i nie daje żadnej stabilizacji.
- W ścianach domenowych obniża dokładność do O(h).
- Dla `P < 0` wybór strony się odwraca, choć kierunek przepływu elektronów się nie zmienia.
- M2 używa średniej centralnej (`coupled_charge_spin.rs:729-748`), więc M1 i M2 nie są spójne.

Rekomendacja: po badaniu zbieżności na ścianie domenowej przyjąć `fv_spin_central_reference_v1` jako domyślny operator M1, a upwind zostawić jako jawnie nazwany wariant. Wymaga to wcześniejszej zmiany noty 0970 §3.1.

---

## 4. Znaleziska fizyczne, semantyczne i provenance

### 4.1. P0

**SHE-P0-1. FEM: moment transportowy w postaci Gilberta jest dodawany do RHS w postaci LL bez konwersji** (CODE, zweryfikowane).

- `backends/fem/cpu/mfem/interactions/transport_stage.cpp:182-192`: `rhs_xyz[index] += ctx.stage_transport.torque_xyz_per_s[index];`.
- Źródło to surowe `T_G` (`steady_transport.cpp:1492-1496`). Adapter Rust nazywa je „direct Gilbert torque” (`crates/fullmag-runner/src/native_fem/stage_transport.rs:1-6`) i nie przekazuje `α`.
- RHS LLG ma postać LL z `gamma_bar = γ/(1+α_i²)` (`integrators/llg_rhs.cpp:70`).
- Dla porównania FEM SOT konwertuje (`interactions/sot.cpp:395-397`) i FDM też (`direct_torques.rs:183-210`).
- Skutek: amplituda jest zawyżona o `(1+α²)` i brakuje składowej `α m×T`. Dynamika M2+LLG w FEM (`fem_stage_transport_callback.v1`, `..._oersted_callback.v1`) zmienia się po cichu.
- Stan norm (sprawdzony):
  - 0980 §4.6.5 (`0980:2268+`) mówi, że `torque_xyz_per_s` jest „kopiowany do ABI i dodawany do RHS LLG”, a §4.6.3 (`0980:2213`) nazywa go „bezpośrednim składnikiem RHS LLG”. Żadne z tych miejsc nie wspomina o konwersji Gilberta.
  - 0970 §2.6.2 wymaga `T_RHS = (T_G + α m×T_G)/(1+α²)`, ale jego nagłówek ogranicza zakres do „FDM CPU”. Ten paragraf dokumentuje identyczny błąd przekazania źródła w FDM CPU (`SOURCE_BUG_CONFIRMED`), poprawiony w październiku 2026.
  - FEM odziedziczył więc niedookreśloną normę 0980 i nie dostał analogicznej poprawki. Fizycznie poprawna jest postać z 0970 §2.6.2 (ta sama co w FEM SOT), więc kod FEM jest błędny niezależnie od brzmienia 0980.
- Wpływ ilościowy na trajektorię: NOT VERIFIED.

**SHE-P0-2. Planner FEM ignoruje aktywację z `physics_graph`** (CODE, zweryfikowane).

- `crates/fullmag-plan/src/fem.rs:5095` wywołuje `resolve_m1_fem_spin_transport` z surowym `problem`.
- Funkcja iteruje po wszystkich modułach (`crates/fullmag-plan/src/spin_transport.rs:1101`), a konsumenta momentu bierze przez `find_map` bez sprawdzenia aktywacji (`:1478-1490`).
- FDM filtruje przez `ActiveFdmTransportGraph` (`spin_transport.rs:188-190,2780`).
- Skutek: moduł spin transport lub `DriftDiffusionSpinTorque` wyłączony w grafie jest w FEM planowany i wykonywany.
- Poza plannerem nikt nie przycina `spin_transport_modules`. `git grep` w `fullmag-api`, `fullmag-runner` i `fullmag-cli` znajduje tylko odczyty i fixture. Filtrowanie w FDM odbywa się właśnie w plannerze, co potwierdza, że to jego obowiązek.

**SHE-P0-3. FDM CPU: `default_external_boundary = "reject_unassigned"` jest po cichu zamieniane na SpinInsulating** (CODE, zweryfikowane).

- Przy braku claimów `resolve_spin_boundaries` wstawia `default:spin_insulating` na wszystkich ścianach (`plan/spin_transport.rs:4005-4014`).
- `inserted_default_boundaries` wypełnia się tylko dla polityki `"spin_insulating"` (`:523-529`), więc provenance mówi, że nic nie wstawiono.
- FEM (`:1511-1517`) i runner CUDA (`fdm/gpu/cuda/spin_transport.rs:781`) odrzucają ten przypadek.
- IR nie waliduje wartości enumu (`fullmag-ir/src/spin_transport.rs:1182`).
- Narusza to normę 0970:197-199.

**SHE-P0-4. Przebiegi FDM M2 i M3 nie mają wpisu provenance transportu** (CODE, zweryfikowane).

- `fdm_transport_execution_provenance_for_lane` (`crates/fullmag-runner/src/fdm/cpu/spin_transport.rs:276-287`) robi `filter_map` po `resolved.fdm_cpu_double.as_ref()?`.
- Planner ustawia `fdm_cpu_double = None` dla planów reciprocal i transient (`plan/spin_transport.rs:456,466`).
- Brakuje więc rekordu requested vs resolved wymaganego przez 0970 §4.1.1.

**SHE-P0-5. FDM GPU: publikowane bilanse fizyczne nie są niezależne i nie są bramkami** (CODE, zweryfikowane).

- `device_solver.cu:1654-1655`: `local_balance = residual; global_balance = residual;`. Komentarz przyznaje, że to decyzja.
- `:1672-1673`: dla `cells > 4096` ustawiane jest `torque_balance = 0.0`.
- `interface_balance` jest liczone z tego samego `mixing_flux`, więc wynosi 0 z konstrukcji (`:1656-1671`, `:440-444`).
- W `context.cu` żadna z tych wartości nie jest porównywana z tolerancją.
- Narusza to normę 0970:1721-1723 („the Krylov residual cannot substitute for them”). Asercje kontraktowe `gpu_m1_spin_operator_parity_v1_contract.cpp:1456-1467` są przez to puste.

**SHE-P0-6. FEM: bilans spinu jest najpewniej tautologią** (CODE; semantyka MFEM NOT VERIFIED).

- Obliczony konstytutywny strumień brzegowy (`steady_transport.cpp:1391-1397`) jest nadpisywany przez `last_spin_weak_balance` (`:1443-1444`).
- `last_spin_weak_balance` pochodzi z `form.Mult(...) − rhs` wywołanego po `FormLinearSystem` (`:937-946`; M2 `:1080-1089`).
- Po eliminacji Dirichleta daje to resztę algebraiczną ≈ tol, a „strumień brzegowy” staje się z definicji `−∫R`.
- Ścieżka ładunku świadomie używa `FullMult` (`:680-681`).
- Test `steady_transport_contract.cpp:584-598` (tolerancja 8%) nie może tego wykryć. Jednostka w nazwie `_apm2` jest błędna, bo całka ma jednostkę A.
- Nota 0970 §7.1 twierdzi „independently reassembled weak residuals”.

### 4.2. P1

| ID | Lane | Znalezisko | Dowód |
|---|---|---|---|
| SHE-P1-1 | FDM CPU/GPU | Interfejs mixing używa `Δμ` z centrów komórek, a M2 dodatkowo `ΔV` z centrów, bez eliminacji trace'ów. Błąd O(`G h/σ_s`). Ładunek M1 ma eliminację szeregową (`charge.rs:634-637,753-767`), spin już nie. | CODE `spin_drift_diffusion.rs:1529-1532`; `coupled_charge_spin.rs:881-884,1920-1921` (zweryfikowane) |
| SHE-P1-2 | FDM CPU M1 | Transparentna ściana międzyregionowa: SHE jest ważone oporami, ale człon P używa `½(P_L+P_R)` i upwindu `m`, co narusza §3.1 („never arithmetic averaging”). Dla N\|F daje `P_face = P/2`. | CODE `spin_drift_diffusion.rs:1305-1324` (zweryfikowane) |
| SHE-P1-3 | FDM CPU M2 | δT w budżecie błędu to różnica momentów korektor−predyktor, a nie iteratów nieliniowych. Iloraz ≈ `dt‖∂T/∂m‖/η` działa więc jak limit sztywności. Bramka działa tylko w etapie korektora. Sama nota jest sprzeczna: §2.6 (0970:296-304) mówi o iteratach, §2.6.1 (0970:403,422-429) o kandydatach Heun/Euler. | CODE `reference.rs:1524`, `spin_transport.rs:2050-2061`, `coupled_charge_spin.rs:532` |
| SHE-P1-4 | FDM CPU | Każde odrzucenie lub błąd solve kończy cały przebieg (M1/M2 stały krok, M3 adaptacyjny), zamiast ponowić krok z mniejszym `dt` (spec §7). Telemetria wycofanych prób ginie. | CODE `reference.rs:2661-2671,2555,2570,2591` |
| SHE-P1-5 | FDM CPU M3 | Legacy checkpoint M3 v1 jest zwolniony z odmowy resume (§2.6.3). | CODE `reference.rs:1659-1667` |
| SHE-P1-6 | FDM CPU | `resolved_execution_mode: "strict"` jest wpisane na sztywno, a planner zapisuje wartość z profilu i dla M1 Rust nie wymaga strict. Osiągalność trybu non-strict: NOT VERIFIED. | CODE runner `spin_transport.rs:322`; plan `:491,1282` (zweryfikowane) |
| SHE-P1-7 | FDM CPU M2 | Telemetria `charge_net_boundary_current_a = 0.0`, `charge_max_abs_divergence_a_per_m3 = 0.0` i `charge_iterations = 0` to literały publikowane jako pomiar. Należy do tej samej klasy co SHE-P0-5, ale ma niższy poziom: M2 ma osobne, egzekwowane bramki residuum i bilansu elektrod (`coupled_charge_spin.rs:487-526`), więc fałszywe są tylko pola raportowe, a nie akceptacja rozwiązania. | CODE runner `spin_transport.rs:2122-2125` (zweryfikowane) |
| SHE-P1-8 | FDM CPU | Rzutowanie RHS ładunku ZeroMean bez sprawdzenia kompatybilności Neumanna, globalnie, a nie per składowa spójna. `physical_residual` nie jest bramką. Planner sprawdza to tylko dla GPU. | CODE `charge.rs:391-394,445-456`; `current_transport.rs:420-450` |
| SHE-P1-9 | M3 (Py/IR/plan/silnik) | Transient z `dos_isotropic_nonmagnetic` jest akceptowany w ferromagnetyku (P≠0, λ_J/λ_φ), a 0970:149-152 wymaga fail-closed. | CODE `transient_spin.rs:160-168`; `plan/spin_transport.rs:665-724`; `validation.rs:3875-3882` |
| SHE-P1-10 (obniżone do P2, 2026-11-20) | FDM CPU/GPU SOT | Wybór formuły SOT `_ => LegacyFullmagV0` obejmuje też `None`. Legacy v0 nadal liczy amplitudę w A/m, bez γ i znaku prądu; poprzednie P0 (2026-07-15) jest naprawione tylko w v1. Korekta przy implementacji: planner zawsze ustawia wersję formuły (`plan/spin_torque.rs:538,588`), bramka runtime `fdm/mod.rs:330-351` odrzuca nieznane wersje przed wykonaniem, a `None` jest celowym kodowaniem planów historycznych (test CUDA `prescribed_sot_formula_mapping_preserves_legacy_and_selects_v1_explicitly`). Pozostaje dług obronny w samym `match`. | CODE `reference.rs:296-299`, `reference/interactions.rs:31-34`, `direct_torques.rs:134-141`; CUDA `native.rs:666` (zweryfikowane) |
| SHE-P1-11 | FDM GPU | Brakuje trzech bramek CPU: ściana międzyregionowa bez interfejsu jest liczona jako transparent; komponenty bez kotwicy nie są sprawdzane; endpointy interfejsu nie są sprawdzane pod kątem `spin_active`. Do tego cichy zerowy moment poza targetem, gdy CPU zwraca błąd. | CODE `device_solver.cu:376-388,1311-1312,1442-1447`; `context.cu:1328-1331`; CPU `spin_transport_v1.cpp:465-528,1136-1154` |
| SHE-P1-12 | FEM | `torque_target.element_mask` nie jest stosowany, a provenance publikuje target. Mitygacja: FEM wymaga jednorodnej domeny magnetycznej. | CODE `stage_transport.rs:31,82`; `descriptor.rs:807-810`; `rk_stage_rhs.cpp:71-72`; `provenance.rs:54` |
| SHE-P1-13 | FEM | M2: jedna monolityczna reszta publikowana jako reszta ładunku i spinu. Względna reszta ma dolny próg `max(‖b‖, 1)` w SI. | CODE `steady_transport.cpp:1094-1099,72` |
| SHE-P1-14 | FEM | Zero-mean M1 bez napędu (RHS ładunku = 0, NormalCurrent odrzucany) daje `V ≡ 0`, `μ ≡ 0`, `τ ≡ 0`. Spin w widoku RT0 liczy się z legacy H1. Osiągalność: NOT VERIFIED. | CODE `steady_transport.cpp:650-652,699-707`; `steady_transport.rs:361-370,1327-1332` |
| SHE-P1-15 | FEM | `J_c` i `Q` są rzutowane na węzły przez `ProjectCoefficient` bez uśredniania. Wynik zasila artefakt i Oersted. | CODE `steady_transport.cpp:1236,1268`; `steady_transport.rs:454-458` |
| SHE-P1-16 | FEM | Przy `m = 0` `mfem_error` (abort bez wyjątków MFEM); C ABI sprawdza tylko skończoność. | CODE `steady_transport.cpp:262-264`; `steady_transport_c_api.cpp:620-624` |
| SHE-P1-17 | FDM CPU vs GPU | Magnetyzacja interfejsu: CPU bierze ją z deskryptora, GPU z `m_stage[to_cell]`, a pole deskryptora jest martwe. Brak kontroli \|m_to\|=1. | CODE `spin_transport_v1.cpp:629-640`; `device_solver.cu:419-422,810-813` |

### 4.3. P2 (fizyka i numeryka)

- Upwind `m_f` (§3.3). Kontraktowe `structured_cross_gradient_v1` (9/27 punktów) nie występuje w crates. Fallback `E` z różnic `V` nie ma provenance (`spin_drift_diffusion.rs:1716-1729`).
- Latentny fallback `ΔV` z centrów komórek w publicznym API silnika (`spin_drift_diffusion.rs:1525-1528`). Runner M1 zawsze dołącza snapshot (`runner spin_transport.rs:3075`), zweryfikowane.
- M2: na brzegu SpinSink/SpecifiedPotential przy izolującym ładunku `E_n` pochodzi z jednostronnego gradientu (`coupled_charge_spin.rs:777-790,843`); M1 robi to dokładnie.
- Wymiarowy floor tolerancji `max(rhs, 1)` w M3 (`transient_spin.rs:562-563`), czyli wzorzec zakazany w §3.1 dla M2.
- Arbitralny próg bilansu spinu `10·rtol` (`coupled_charge_spin.rs:521`, `spin_drift_diffusion.rs:973`).
- „Picard” M2 przy stałym `m` to defect correction (`coupled_charge_spin.rs:438-494,579`).
- BDF2 zwraca błąd przy zmianie `dt` zamiast restartu BE (`transient_spin.rs:507-512`).
- GPU:
  - tożsamości \|m\|=1 (`device_solver.cu:429-431,478,706,819`);
  - dopasowanie trace'ów po indeksie (`:403-409`);
  - niedeterministyczny `atomicAdd` momentu powierzchniowego (`:1326-1327,1556-1557`);
  - martwy kod gęstego solvera i `mode==3`;
  - skalarna α w konwersji Gilberta (fail-closed dla niejednorodnych, `c_api.cpp:2845-2852`).
- FEM:
  - wymóg jednego jednorodnego materiału spinowego, więc układu HM\|FM nie da się wyrazić;
  - globalne zero-mean dla rozłącznych komponentów;
  - `formula_version` wyroczni na sztywno one-way (`steady_transport.hpp:84-87`);
  - diagnostyka fixture w kodzie produkcyjnym (`steady_transport.cpp:1401-1415`).
- Brak testu zbieżności analitycznego N\|F z mixingiem (FDM). `fdm_spin_oracle_v1` jest fixture parytetu, a nie fizyki.
- Martwy `canonicalize_fixed_step_time` (`runner spin_transport.rs:1239-1266`) jest sprzeczny z 0970:446-448.

---

## 5. Efektywność obliczeń

### 5.1. Liczba rozwiązań liniowych na krok LLG

| Lane | Ładunek | Spin | Dodatkowo |
|---|---|---|---|
| FDM CPU M1, Heun (jedyny dopuszczony) | 3× CG bez prekondycjonera, start od zera (`charge.rs:399-436`) | 3× GMRES bez prekondycjonera, od zera, tolerancja 0,01·tol (`spin_drift_diffusion.rs:901-934`) | 3× Biot–Savart O(N²), gdy Oersted aktywny (`oersted.rs:43-60`, docstring: „not a production large-grid realization”) |
| FDM CPU M2, Heun | — | 3× sprzężony solve Picard+GMRES z prekondycjonerem liniowym | warm start trafia tylko w etap 0 (hash FNV `m`, `runner spin_transport.rs:2029-2033`) |
| FDM CPU M3, stały krok | 4 | 2 niejawne | 4× materializacja problemu, `affine` liczone za każdym razem (`transient_spin.rs:554`) |
| FDM CPU M3, adaptacyjny (na próbę) | 12 | 6 | odrzucenie powtarza całość |
| FDM GPU M1 | 1 (raz) | Heun 2, RK4 4, DP45 do 6–7 (szacunek z miejsc wywołań, NOT VERIFIED) | — |
| FEM CPU M2 | — | 1 monolityczny GMRES 4N bez prekondycjonera na etap; RK4 = 4 | Biot–Savart O(N_e·N_n) na etap (`steady_transport.rs:732-810`) |

### 5.2. FDM CPU (Rust): hot-spoty

1. **Ładunek i Oersted liczone od nowa w każdym etapie**, choć w M1 i M3 `V`, `J` i `H_oe` nie zależą od `m` i są liniowe w mnożniku obwiedni (`runner spin_transport.rs:2928-2983,2091-2102`). Spec §6.1 (`spin-transport-runtime-contract-v1.md:1152-1153`) pozwala cache'ować `J₀`, `H₀` i skalować je obwiednią. Zysk: z 3–4 (do 12) CG i 3 sum O(N²) na krok do zera. Klucz cache: `(descriptor revision, multiplier)`. Trzeba pilnować offsetów afinicznych BC.
2. **Matvec spinu M1** (`spin_drift_diffusion.rs:604-640,887-934`):
   - w każdym wywołaniu od nowa `cell_electric_field()` (`:614`), stałe źródła P i SHE oraz `validate_spin_values`;
   - liniowe `interfaces.iter().find` i `internal_contacts.iter().find` na każdą ścianę (`:1236-1240,1278-1286`) oraz O(N_if²) kontrola duplikatów (`:793-802`); dla płaszczyzny N\|F 256×256 to ~4·10⁹ porównań na matvec;
   - alokacje: flatten/unflatten, 4 tablice reakcji, tablice ścian, Hessenberg `Vec<Vec>`;
   - poprawka: indeks ściana→interfejs budowany raz, prekomputacja źródeł afinicznych i `E`, bufory robocze.
3. **Brak prekondycjonera i warm startu.** Spin M1 to GMRES(40) bez prekondycjonera (telemetria `preconditioner: "none"`, `:994`), a ładunek to CG bez prekondycjonera, choć nota mówi „CG/AMG” (0970:1248). M2 buduje zawsze także prekondycjoner blokowo-Jacobiego (`coupled_charge_spin.rs:406-410`), a każde zastosowanie prekondycjonera liniowego to (1+n_osi) przejść operatora (`:161-171`). Propozycja:
   - prekondycjoner blokowo-Jacobiego 3×3 dla M1;
   - warm start z poprzedniego etapu zawsze, bo bramka prawdziwego residuum gwarantuje wynik;
   - dla stałej geometrii: złożenie CSR raz na `operator_revision` i AMG/IC na części dyfuzyjnej `L_diff ⊗ I₃`; bloki zależne od `m` są lokalne 3×3.
4. **FSAL dla etapu 0.** Etap 0 kroku n+1 ma bitowo ten sam stan co odświeżenie zaakceptowanego stanu kroku n (`integrators.rs:1469,1654`). Ponowne użycie z dokładnym kluczem daje −1/3 solve'ów w Heunie.
5. **Pełny checkpoint M3 w każdym zaakceptowanym kroku**: klony, JSON, SHA-256, `to_value` (`runner spin_transport.rs:1268-1319`, `reference.rs:2845-2865,3047-3050`). `descriptor_revision` serializuje deskryptor M2 do JSON w każdym etapie (`:1970,2389-2393`). Poprawka: budowa leniwa przy pauzie lub publikacji, a rewizję liczyć raz.
6. **Klony workflow** ~5× na próbę adaptacyjną (`reference.rs:1449,2525,2547,2562`) i pełny snapshot (~368 B/komórkę) w każdym etapie. Poprawka: `Arc` i lekki snapshot etapowy.
7. **Brak równoległości.** `rayon` / `par_iter` nie występuje w `fdm/cpu/transport/`.

### 5.3. FDM CPU natywny C++

- `find_interface` liniowo na ścianę i matvec (`spin_transport_v1.cpp:197-204,673`).
- `E` przeliczane w każdym `apply` (`:764`).
- GMRES bez prekondycjonera.
- Jako referencja akceptowalne; poprawki jak w §5.2 pkt 2.

### 5.4. FDM GPU (CUDA)

Stan: GMRES(50) z dwuprzebiegowym MGS w jednym kernelu kooperacyjnym oraz geometryczny V-cycle z block-Jacobi 3×3 i Chebyshevem stopnia 128 (`sparse_solver.cu:683-938,1071-1236`). Między GPU a hostem nie ma transferów `m` ani `T` na etap.

Według raportu zamknięcia (CONTRACT): grid 1024×128×8 potrzebuje 17,2 s na zimno i 18,7 s na ciepło, a izolowany GMRES ma medianę 1,4 ms. Ponad 99% czasu jest poza Kryłowem.

1. **Liniowe skany deskryptorów w kernelach** (zweryfikowane): `boundary()` (`device_solver.cu:238-248`), `interface_at()` (`:250-261`), `spin_material()` (`:221-229`). Dla 1024×128×8 to ~4·10¹⁰ porównań na wywołanie kernela assembly lub materializacji. Najpewniej główna przyczyna 18 s. Poprawka: indeks arytmetyczny ścian, jak dla ładunku w `context.cu:1583-1605`, oraz mapa face→interface (CSR już istnieje: `:1909-1937`).
2. **Realokacja workspace po każdym solve.** `sparse::release(&state.workspace)` (`device_solver.cu:2035`, zweryfikowane) zwalnia bazę Kryłowa ~51·3N·8 B (1,2 GB dla 1M komórek). Do tego 13 alokacji kandydata, `cudaGetDeviceProperties` (`sparse_solver.cu:1565`) i `cudaMemGetInfo` (`context.cu:2425`) przy każdym solve. Poprawka: trwały workspace i `cudaMallocAsync` z pulą.
3. **Przebudowa hierarchii AMG w każdym etapie RK.** Digest `m_stage` wchodzi do klucza cache (`:1991-1996`, `sparse_solver.cu:1357-1359`), a przebudowa synchronizuje hosta na każdym poziomie. Poprawka: prekondycjoner opóźniony (lagged), przebudowywany przy wzroście liczby iteracji. Wymaga zmiany kontraktu 0970:1749-1751.
4. **Brak warm startu.** `solution_soa` jest zerowane (`:1964`).
5. **Synchronizacje:**
   - co najmniej 5 `cudaStreamSynchronize` na solve (`:1975,2110,2116,2149,2161`);
   - `cudaEventSynchronize` na etap RHS (`context.cu:5015`);
   - w MGS ~4(j+1) `grid.sync` na kolumnę;
   - Chebyshev 128 oznacza ≥256 synchronizacji na V-cycle, a granice Gershgorina liczy jeden wątek (`:693-728`).

   Poprawka: CGS2 z fuzją iloczynów skalarnych, granice liczone przy setupie, zdarzenia strumieni zamiast blokady hosta.
6. **Jednowątkowe kernele:** `materialize_kernel<<<1,1>>>` (`:2107`). Ładunek ma PCG w jednym bloku, etykietowanie komponentów i SHA na jednym wątku (`charge/device_solver.cu:1569,1621,1753`). Kontrakt to przyznaje, ale dla 1M komórek to sekundy setupu.

### 5.5. FEM CPU (MFEM)

1. **Solvery.** Ładunek: CG + `GSSmoother` (`steady_transport.cpp:668-676`). Spin M1: GMRES KDim=100 bez prekondycjonera (`:925-932`). M2: monolityczny GMRES 4N bez prekondycjonera (`:1051-1058`). Blok ładunku jest dyfuzyjny, κ ~ (L/h)², więc przy tol 1e-10…1e-12 stagnacja na realnych siatkach jest bardzo prawdopodobna (analiza, NOT VERIFIED). Rekomendacja: FGMRES z blokowo-diagonalnym BoomerAMG (V oraz system-AMG 3×3 dla μ), a dla rozmiarów referencyjnych direct (UMFPACK/KLU).
2. **Zero reuse.** Każde wywołanie od nowa robi:
   - `import_mesh` (`steady_transport_c_api.cpp:1625,1996`);
   - pięć przestrzeni FE (`:571-576`);
   - złożenie form;
   - macierz masy i CG dla projekcji momentu (`:1505-1531`);
   - start od zera (`:1005`).

   Przy N terminalach jest N pełnych składań (`:810-850`). Potrzebny jest trwały obiekt solvera po stronie C++ (siatka, przestrzenie, wzorzec, prekondycjoner) żyjący przez cały run.
3. **Granica Rust↔C na każdy etap:**
   - `request_template.clone()` klonuje całe `MeshIR` (`stage_transport.rs:198`, `stage_coupled.rs:151`);
   - flatten i pakowanie siatki (`steady_transport.rs:964-985`);
   - wyjścia 18N;
   - kopie AoS↔byNODES;
   - SHA-256 z `m`, momentu i pola (`stage_coupled.rs:131,181-182`).
4. Własny integrator M2 z pętlami 4×4×3×3 na parę DOF i punkt kwadratury (`steady_transport.cpp:458-476`), post-processing gradientów na węzeł (`:1239-1269`), podwójny solve ładunku w ścieżce RT0 (`steady_transport.rs:361-370`), brak MPI i OpenMP.

Wniosek: w obecnej postaci sprzężenie FEM z LLG co etap RK jest praktyczne tylko na siatkach rzędu ≤10⁴ węzłów.

---

## 6. Python DSL → ProblemIR → walidacja → planner

### 6.1. Parametry

Wszystkie parametry noty 0970 §2.7 mają reprezentację w Pythonie (`packages/fullmag-py/src/fullmag/model/spin_transport.py`, `current_transport.py`) i IR (`crates/fullmag-ir/src/spin_transport.rs`), z jednostkami SI zgodnymi z notą:

- σ, σ∥, σ⊥, σ_AHE;
- σ_s, P, θ_SH;
- λ_sf, λ_J, λ_φ (z jawnym `disabled`);
- C_s [A·s·V⁻¹·m⁻³], N₀ [J⁻¹·m⁻³];
- G↑, G↓, G_r, G_i [S/m²];
- G_N, G_F, G_R;
- BC ładunku i spinu.

| Reguła | Python | IR | Authoring | Planner |
|---|---|---|---|---|
| σ_s, θ_SH, λ_sf > 0 | ✓ | ✓ `validation.rs:3822-3836` | ✓ | — |
| P ∈ [−1, 1] | ✓ | ✓ | ✓ | — |
| **λ_J, λ_φ > 0** | ✓ `spin_transport.py:92-95` | **brak** (zweryfikowane: `validation.rs:3832-3836` sprawdza tylko λ_sf) | ✓ `authoring/validation.rs:1780-1788` | bez sprawdzenia `plan/spin_transport.rs:3289-3293` |
| C_s = e²N₀ (1e-12) | ✓ `abs_tol=1e-300` | ✓ | ✓ | ✓ (M3) |
| Schur (MR) | brak | ✓ `validation.rs:3895-3929` | **brak** | FEM M2 ✓ |
| `default_external_boundary` | ✓ enum | **wolny String** | — | FDM CPU ignoruje (SHE-P0-3) |
| unikalność konsumenta momentu na solve | — | **brak** | — | FDM ✓ odrzuca, FEM bierze pierwszego |

### 6.2. Znaleziska

| ID | Poziom | Znalezisko | Dowód |
|---|---|---|---|
| SHE-PY-1 | P1 | FEM po cichu bierze pierwszego `DriftDiffusionSpinTorque` na solve; FDM odrzuca więcej niż jednego. | CODE `plan/spin_transport.rs:1478-1490` vs `:2784-2789` |
| SHE-PY-2 | P1 | IR nie waliduje λ_J, λ_φ > 0 i skończoności. Do `σ_s/(2λ²)` może trafić `Enabled(0.0)`. | CODE (zweryfikowane) |
| SHE-PY-3 | P1 | SceneDocument nie potrafi wyrazić FEM M2. Authoring wymaga operatora FDM i `reciprocal_nonlinear`, a Python, IR i planner FEM wymagają operatora FEM i zakazują `reciprocal_nonlinear`. | CODE `authoring/validation.rs:1506-1519`; `problem.py:3044-3069`; `validation.rs:4108-4116`; `plan/spin_transport.rs:1225-1229` |
| SHE-PY-4 | P1 | `examples/fem_reciprocal_m2_public.py:106` używa `engine="block_gmres"`, a planner FEM akceptuje tylko `auto\|gmres`. Test sprawdza tylko eksport IR. Runtime: NOT VERIFIED. | CODE `plan/spin_transport.rs:1137-1141` |
| SHE-PY-5 | P1 | Wymuszenie `P = λ_J = λ_φ = 0` poza ferromagnetykiem istnieje tylko dla M2. | CODE `plan/spin_transport.rs:838-855` |
| SHE-PY-6 | P1 | Na `SpinTransportModuleIR`, materiałach, interfejsach, BC i wariancie Known sceny brakuje `deny_unknown_fields`. ADR 0019 §4 wymaga fail-closed dla konfliktowego legacy `coupling`. | CODE `fullmag-ir/src/spin_transport.rs:1019-1167`; `authoring/spin_transport.rs:438` |
| SHE-PY-7 | P1 | Capabilities w planie są nadmiarowe lub niepełne. `transport.spin.mixing_conductance` jest zawsze dla M2, a nigdy dla M1 z mixingiem. Identyfikatory `transport.coupling.*` nie istnieją w matrycy (`coupling.transport_llg.*`). | CODE `plan/spin_transport.rs:503-521` |
| SHE-PY-8 | P1 | Capability matrix jest rozjechana z plannerem i runtime: MD `:407-415` mówi semantic_only GPU, a JSON `features[36-39]` ma `implemented`; MD `:439,:443` mówi „no LLG stage coupling”, a planner i dispatch je instalują; JSON `features[40-58]` nie ma `implementation_state` ani `validation_state`. | CONTRACT/CODE `plan/spin_transport.rs:1530-1534`, `dispatch.rs:3588-3667` |
| SHE-PY-9 | P1 | Specyfikacja parity: jednostka C_s `A/(V m^3)` jest błędna (brakuje s), a statusy `declared_unsupported` są nieaktualne. | CONTRACT `docs/specs/spin-transport-authoring-parameter-parity-v1.json` |
| SHE-PY-10 | P2 | Walidacja C_s/N₀ istnieje w 4 kopiach (py, IR, authoring, planner), a tolerancje różnią się minimalnie. Kontrola Schura istnieje w dwóch kopiach. | CODE |
| SHE-PY-11 | P2 | `TransportExecution` ma domyślnie FDM/CPU także w studium FEM. Dokumentacja podaje `None` i „self-consistent”, choć domyślne M1 jest one-way. Sekcja jednostek jest niepełna, a dokument cytuje nieistniejące testy. | CODE `spin_transport.py:48-49`; `public_docs/site/python-api/interactions/drift-diffusion-spin-torque.md:24,29,52-53,113` |
| SHE-PY-12 | P2 | Placeholder `DriftDiffusionSpinTorque` w `spin_torque.py:781-806` koliduje nazwą z kanonicznym (`model/__init__.py:302,445`). `absorption` nie jest walidowane (`full` vs `full_absorption`). Planner ma martwy kod (`:237-254,1541-1547`). | CODE |
| SHE-PY-13 | P2 | Test golden się nie zgadza: zob. niżej. | RUN |

Wynik testów (RUN): `pytest` na `test_spin_drift_diffusion.py`, `test_spin_transport_authoring_parameter_parity.py` i `test_spin_transport_runtime_roundtrip.py` daje **38 passed, 1 failed, 45 subtests passed**.

- Porażka: `test_spin_drift_diffusion.py:601`. Golden `tests/standard_problems/transport/racetrack_m1_v1/python_problem_ir.v1.json` nie ma nowych pustych kolekcji IR (`antenna_*`, `selections`, `magnetization_constraints`, `solved_antenna_drives`), `object_id: null` ani metadanych `parallel_execution`.
- Żadne pole spin/charge się nie różni, więc to dryf golden, a nie błąd fizyki.

Round-trip (CODE): znaleziska AUTH-001/002 z audytu 2026-07-15 są dla spin transport zamknięte.

- Scena ma typowane `spin_transports`, `spin_torques` i `oersted_fields` (`authoring/src/scene.rs:44-50`).
- `script_builder.py` renderuje je (`:5426-5694`, `:7169+`, `:7811-7851`).
- Wyjątki: FEM M2 (SHE-PY-3) oraz `absorption`/`g_sml`.

Rozdzielenie name/type od fizyki jest zachowane (CODE `plan/spin_transport.rs:84-169`), z wyjątkiem braku filtra aktywacji w FEM (SHE-P0-2).

---

## 7. Control Room

Przepływ danych jest zgodny z architekturą (CODE):

- panele używają typowanego `api.model.*` i resource hooks, bez własnych `fetch(`;
- pola idą przez binary data plane (`kernel/api/codecs/*`);
- projekcje tensora `Q_ia` działają po stronie klienta (`tensorFieldProjection.ts:67-133`): `c = 3i+a`, `spin_flow_a = (Q_0a, Q_1a, Q_2a)`, Frobenius z interpolacją przed normą, odmowa bez deskryptora;
- rozpoznawanie fizyki nie korzysta z nazwy ani typu obiektu (`transportRecognition.ts:12-21`).

| ID | Poziom | Znalezisko | Dowód | Wymaga modern-web-guidance |
|---|---|---|---|---|
| SHE-UI-1 | P1 | Legenda viewportu 3D dla `spin_current_tensor`, `spin_potential` i `torque_*` nie ma jednostki (tabela statyczna zwraca `""`) ani tokenu projekcji (np. „Q_yx [A/m²]”). Narusza to kontrakt projekcji 0970:2160-2170. Inspector bierze jednostkę z katalogu poprawnie. | CODE `Viewport3DModule.tsx:589-603,704`; `quantityIds.ts:247-289`; `viewport3DColorbarPlan.ts:27-41` | tak |
| SHE-UI-2 | P1 | Bramka parytetu formularzy jest czerwona: `check_spin_authoring_forms.mjs:27` oczekuje 5 rodzajów BC spinu, a jest 6 (`homogeneous_spin_potential_gradient`). Skrypt nie jest podpięty do `justfile` ani CI. | RUN, CODE (zweryfikowane) | nie |
| SHE-UI-3 | P1 | `transportRecognition.ts:321-334` nie dopuszcza `normal_surface`, `ferromagnet_surface` ani `g_sml_Spm2`. Po „bind traces” z własnego Inspectora interfejsu cały transport staje się „Unknown variant, read-only”. | CODE (zweryfikowane); Rust `authoring/spin_transport.rs:319-331` | nie |
| SHE-UI-4 | P1 | `transportRecognition.ts:380-396` nie dopuszcza `external_lead_preparation` ani `conservative_current_source`, choć sam builder emituje pierwsze z nich. Zasób znika z listy źródeł prądu dla momentu. | CODE | nie |
| SHE-UI-5 | P1 | Operator one-way jest przypięty do `fv_spin_upwind_v1` (`:180-181`), więc zasoby FEM M1 (`reference_executable`) są read-only. UI powiela regułę wersji z backendu. | CODE | nie |
| SHE-UI-6 | P1 | Rozwiązywanego `drift_diffusion_spin_torque` nie da się autorować (formularz ma tylko ZL, Slonczewski i prescribed SOT). Trasa nazywa się „Transport torque”. Brak ostrzeżenia o podwójnym liczeniu prescribed SOT z θ_SH na tym samym targecie (czy backend to blokuje: NOT VERIFIED). Są martwe opcje legacy w `interactions.ts:247-254`. | CODE `SpinAuthoringInspector.tsx:553`; `spinAuthoringRecognition.ts:57-60`; `inspectorRouteCatalog.tsx:1102-1105` | tak |
| SHE-UI-7 | P1 | Overview ma na sztywno `status: "active"`. Backend ustawia `qualification = status` i `resolved_lane: None`, więc użytkownik nie widzi `reference_executable` vs `semantic_only`. Pola lane są wyświetlane przez `JSON.stringify`. | CODE `TransportAuthoringInspector.tsx:518-522,564-566,610-612`; `transport_authoring_policy.rs:43-49` | tak |
| SHE-UI-8 | P2 | Duplikacja walidacji (C_s, tensor M2, lustro capability, które już różni się wartością `hybrid`). Martwe edytowalne pole „Legacy SML conductance”. Reciprocal nonlinear policy to textarea JSON, choć nota 0970:2186 mówi „typowana”. Enumy są polami tekstowymi. `key={index}` w wierszach kolekcji. Pola σ∥/σ⊥/σ_AHE są widoczne w one-way. Nie ma residuów ani bilansów (0970 §4.4). Wyniki zapisane obsługują tylko `V`, `J` i `H_ant`. | CODE (szczegóły w notatkach agenta; m.in. `SpinInterfaceInspector.tsx:389`, `TransportCollectionFields.tsx:30`, `savedFieldViewportResources.ts:134-135`) | częściowo |

Status audytu UI z 2026-08-09:

- **Naprawione:** fallback legacy roots, presentation metadata, `solve_region` → scope, Zhang–Li w Inspectorze, ribbon, `results.field_quantity`, layout ≤420 px, typ `conservative_current_view`.
- **Częściowo:** mapowanie `semantic_only` (Explorer tak, Inspector nadal „Active”).
- **Otwarte:** scenariusze MTJ/racetrack, browser smoke, pełny round-trip przez UI.

---

## 8. Status znalezisk z audytu 2026-07-15

| Znalezisko 2026-07-15 | Stan 2026-11-18 |
|---|---|
| P0 SOT FDM CPU: A/m wprost do `dm/dt` | **naprawione w `prescribed_sot.fullmag.v1`** (`direct_torques.rs:122-133`). Legacy v0 nadal błędne i osiągalne przez fallback `_ =>` (SHE-P1-10). |
| P0 CUDA SOT bez maski materiału | **naprawione** (`llg_fp64.cu:282-295`); gałąź fp32 v1 NOT VERIFIED |
| „Fullmag nie posiada solvera SHE” | **nieaktualne**: M1/M2/M3 są wykonywalne w FDM CPU, M1/M2 w FEM CPU, M1 w CUDA (`semantic_only`) |
| AUTH-001/002: SceneDocument gubi torque i Oersted | **zamknięte** dla spin transport, poza FEM M2 (SHE-PY-3) |
| Wymuszone FEM GPU wykonuje CPU | dla transportu fail-closed w 5 warstwach (CODE); poza zakresem tego audytu dla innych modułów |

---

## 9. Sprzeczności dokumentów do rozstrzygnięcia

1. Konwersja Gilberta: 0970 §2.6.2 wymaga jej, ale tylko dla FDM CPU. 0980 §4.6.3/§4.6.5 opisuje moment FEM M2 jako „bezpośredni składnik RHS LLG” i nie wspomina o konwersji. Kod FEM idzie za 0980 (SHE-P0-1). Konwersję trzeba zapisać jako regułę wspólną dla wszystkich lane (najlepiej w 0960 lub 0970 §2.6), a 0980 poprawić.
2. δT: 0970 §2.6 definiuje różnicę iteratów nieliniowych, a §2.6.1 różnicę kandydatów etapów (SHE-P1-3).
3. SML v2: 0970 §2.5 mówi „FDM/FEM production weak-form fail-closed”, a FDM M2 Rust go wykonuje (zgodnie z matrycą `features[49]`).
4. FEM M2: capability-matrix `:443` i 0970 §7.2 (`:2577-2578`) mówią „no LLG stage coupling”, a planner i dispatch je instalują.
5. 0970 §3.1 deklaruje „CG/AMG” i `structured_cross_gradient_v1`. W kodzie Rust CG jest bez prekondycjonera, a operatora `structured_cross_gradient_v1` nie ma.
6. 0970 §7.1 twierdzi „independently reassembled weak residuals” dla FEM (SHE-P0-6).
7. 0970 §2.6: BDF2 ma restartować BE przy zmianie `dt`, a kod zwraca błąd.
8. Specyfikacja parity jest nieaktualna (statusy, jednostka C_s).

---

## 10. Plan wdrożenia poprawek

Zasady, zgodnie z `AGENTS.md`:

- każda zmiana numeryki lub fizyki zaczyna się od aktualizacji noty w `docs/physics/` (skill `scientific-documentation-contract`);
- implementacja odbywa się w worktree `worktrees/<task-id>` na branchu `codex/<task-id>`, z pełnym cyklem PR;
- buildy i testy Rust/C++/CUDA tylko w grupie Docker DEV danego worktree, po zdjęciu zakazu kompilacji testów przez użytkownika;
- zmiany UI wymagają skilla `modern-web-guidance` i dowodu z przeglądarki.

Każdy etap ma lane, bramkę dowodu i status.

### Etap A: fail-closed i provenance (bez zmiany równań; najwyższy priorytet, niskie ryzyko)

Stan na 2026-11-20 (branch `codex/she-audit-stage-a-20261120`): A1–A4 i część A6 są zaimplementowane. Kod aplikacji skompilował się w grupie Docker DEV tego worktree (backend package bez cache-hit). Nowe testy są wyłącznie źródłowe, bo kompilacja testów jest zakazana; ich wykonanie potwierdza job CI `rust-contracts`. A7 i część C ABI z A8 wymagają natywnego buildu C++/CUDA i trafiają do osobnego zadania.

| # | Zadanie | Lane | Bramka | Status |
|---|---|---|---|---|
| A1 | Filtr aktywacji `physics_graph` w `resolve_m1_fem_spin_transport` (wspólny helper z FDM) oraz unikalność konsumenta momentu w IR (SHE-P0-2, SHE-PY-1) | FEM plan, IR | test plannera: wyłączony moduł nie trafia do planu; dwa konsumenty dają błąd | **zaimplementowane** (`b1752feb5`) |
| A2 | Walidacja enumu `default_external_boundary` w IR; `reject_unassigned` przy pustych BC daje błąd w FDM; `inserted_default_boundaries` liczone z faktycznie wstawionych ścian (SHE-P0-3) | IR, plan FDM | testy plannera FDM CPU/native | **zaimplementowane** (`72cce9949`) |
| A3 | Provenance M2/M3: gałęzie dla `fdm_cpu_double_reciprocal` i `_transient` z właściwym `stage_coupling`; `resolved_execution_mode` z planu (SHE-P0-4, SHE-P1-6) | runner FDM CPU | test provenance M2 i M3 (requested/resolved) | **zaimplementowane** (`6a063f15e`) |
| A4 | Telemetria M2: `Option<f64>` albo wartości z `balance_metrics`, zamiast literałów 0 (SHE-P1-7) | runner FDM CPU | test serializacji telemetrii | **zaimplementowane** (`4e7130fb6`): pola wypełniane rzeczywistymi wartościami z solvera, bez zmiany schematu |
| A5 | SOT: jawne dopasowanie `"prescribed_sot.legacy_fullmag.v0"`, a pozostałe wartości (także `None`) odrzucać; rozważyć odrzucenie legacy w nowym planowaniu (SHE-P1-10) | FDM CPU/GPU | test runnera dla `None`/literówki | **odstąpione**: nieznane wersje są już odrzucane przez bramkę runtime, a `None` koduje plany historyczne (zob. SHE-P1-10) |
| A6 | IR: λ_J, λ_φ > 0 i skończone; `deny_unknown_fields` na modułach transportu; M3 `dos_isotropic_nonmagnetic` odrzuca komórki z P≠0 lub reakcjami magnetycznymi; walidacja `absorption` (SHE-PY-2, SHE-PY-6, SHE-P1-9) | IR, plan, silnik | testy walidacji IR i plannera | **częściowo**: λ_J/λ_φ zrobione. Wstrzymane: (1) reguła M3 dla ferromagnetyka koliduje z zakwalifikowanym workloadem `scripts/verify_fdm_transient_spin_m3_public_e2e.py:55-59` (P=0,4 w `Ferromagnet` z `dos_isotropic_nonmagnetic`) i wymaga decyzji właściciela fizyki; (2) `deny_unknown_fields` może zepsuć deserializację zapisanych sesji i golden IR, więc wymaga osobnego zadania ze skanem danych; (3) `absorption` nie jest czytane przez żadną fizykę, a walidacja zepsułaby fixture `full` |
| A7 | GPU: przenieść do uploadu deskryptora bramki CPU (ściana międzyregionowa bez interfejsu, kotwica komponentu, `spin_active` endpointów, reakcje magnetyczne wyłącznie w targetach, \|m_to\|=1) (SHE-P1-11, SHE-P1-17) | FDM GPU | kontrakt CUDA w grupie DEV (actual device) | do zrobienia |
| A8 | FEM: walidacja \|m\| > 0 w C ABI; planner odrzuca M1 zero-mean bez napędu i spin w widoku RT0 (SHE-P1-16, SHE-P1-14) | FEM CPU | test ABI i plannera | do zrobienia |
| A9 | Silnik Rust: `solve()` odrzuca mixing bez snapshotu ładunku (latentny fallback ΔV) oraz fallback `E` z różnic V bez provenance | FDM CPU | test silnika | **przeniesione do B4**: trzy testy silnika (`spin_drift_diffusion_tests.rs:741,824,935`) celowo budują mixing bez snapshotu; B4 i tak przebuduje tę ścieżkę |

### Etap B: poprawność fizyki i diagnostyki (najpierw nota, potem kod)

| # | Zadanie | Lane | Najpierw nota | Bramka | Status |
|---|---|---|---|---|---|
| B1 | Konwersja Gilberta w `add_transport_stage_rhs` z lokalnym α (jak w `sot.cpp`) oraz maska węzłowa targetu momentu (SHE-P0-1, SHE-P1-12) | FEM CPU | ujednolicić 0980 §4.6.5 z 0970 §2.6.2 | test jednego kroku: nieosiowe `m`, α≠0, porównanie z wyrocznią SI i z FDM CPU dla jednorodnego macrospinu; test maski | do zrobienia |
| B2 | Niezależne bilanse FEM: reakcja na wierszach Dirichleta z `FullMult` na oryginalnym RHS, osobno konstytutywny strumień brzegowy, raport różnicy; poprawka jednostki `_apm2`; osobne skalowane reszty ładunku i spinu w M2; usunięcie floor `max(‖b‖,1)` (SHE-P0-6, SHE-P1-13) | FEM CPU | 0970 §7.1 | test celowo zaburzonego rozwiązania: bilans musi zawieść | do zrobienia |
| B3 | Niezależne residuum FV, bilans globalny, interfejsowy i torque closure dla każdego N na GPU, z deterministyczną redukcją i bramkami odrzucającymi przed commitem (SHE-P0-5) | FDM GPU | 0970 §3.1.1 (bez zmian) | kontrakt actual-device z negatywnym przypadkiem | do zrobienia |
| B4 | Eliminacja trace'ów `μ_Γ` (i `V_Γ` w M2) na ścianach mixing: lokalny układ 3×3 (M1) lub 4×4 (M2) na ścianę, liniowy w μ; transparent cross-region z ważeniem członu P oporami (SHE-P1-1, SHE-P1-2) | FDM CPU Rust, C++, CUDA | 0970 §2.5/§3.1: nowa wersja operatora, np. `fv_spin_mixing_series_trace.v1` | analityczny benchmark N\|F 1D z mixingiem: zbieżność O(h²) w 3+ rozdzielczościach, parytet CPU↔C++↔CUDA, porównanie z BORIS | do zrobienia |
| B5 | ZeroMean ładunku: test kompatybilności per składowa spójna przed rzutowaniem, rzutowanie per składowa, `physical_residual` jako bramka (SHE-P1-8) | FDM CPU | 0970 §2.4 | test niekompatybilnego Neumanna daje błąd | do zrobienia |
| B6 | Rozstrzygnąć definicję δT (iteraty vs etapy). Jeśli iteraty: liczyć w pętli Picarda w każdym etapie. Jeśli etapy: przemianować kryterium na limit sprzężenia (SHE-P1-3) | FDM CPU M2 | 0970 §2.6 i §2.6.1 | test: zmiana η wpływa zgodnie z definicją | decyzja użytkownika / właściciela fizyki |
| B7 | Odrzucenie lub błąd solve → `Retry(dt·shrink)` z rekordem odrzuconej próby; usunięcie zwolnienia legacy M3 v1 z odmowy resume (SHE-P1-4, SHE-P1-5) | FDM CPU | spec §7, 0970 §2.6.3 | test wymuszonego niepowodzenia: krok ponowiony, stan niezmieniony | do zrobienia |
| B8 | Domyślny operator M1 `m_f`: badanie zbieżności upwind vs central na ścianie domenowej, potem decyzja o domyślnym (§3.3) | FDM CPU/GPU | 0970 §3.1 | tabela zbieżności | do decyzji |
| B9 | M2 brzeg SpinSink/SpecifiedPotential przy izolującym ładunku: `E_n` z `J/σ = 0`; BDF2 z restartem BE; tolerancja M3 bez floor | FDM CPU | 0970 §2.6, §3.1 | testy jednostkowe | do zrobienia |

### Etap C: wydajność (bez zmiany wyników ponad tolerancję solvera)

Każda pozycja wymaga bramki „wynik bez zmian”: porównania artefaktów przed i po w ramach tolerancji solvera oraz liczników solve'ów i iteracji w telemetrii.

| # | Zadanie | Lane | Oczekiwany zysk (szacunek) | Ryzyko |
|---|---|---|---|---|
| C1 | Cache rozwiązania ładunku i pola Oersteda dla M1/M3, skalowanego mnożnikiem obwiedni (spec §6.1); klucz `(descriptor revision, multiplier)` | FDM CPU Rust/native | z 3–12 CG i 3 sum O(N²) na krok do 0; przy Oerstedzie rzędy wielkości | offsety afiniczne BC, gauge |
| C2 | FSAL etapu 0 z dokładnym kluczem `(hash m, bity t, rewizja)` | FDM CPU | −1/3 solve'ów w Heunie, −1/4 w ARS | minimalne |
| C3 | Indeks ściana→interfejs/kontakt, prekomputacja `E` i źródeł afinicznych, bufory robocze bez alokacji w matvec, jedna implementacja `restarted_gmres` | FDM CPU Rust, C++ | kilka–kilkadziesiąt razy na matvec przy płaszczyznach N\|F | niskie |
| C4 | Prekondycjoner blokowo-Jacobiego 3×3 dla spinu M1, prekondycjonowany CG (IC/AMG) dla ładunku, warm start zawsze, leniwy block-Jacobi w M2 | FDM CPU | 2–10× mniej iteracji | brak dla wyniku (bramka prawdziwego residuum) |
| C5 | Leniwy checkpoint M3, rewizja deskryptora liczona raz, `Arc` dla planów i stanu accepted, lekki snapshot etapowy, `rayon` w pętlach po komórkach i ścianach | FDM CPU | znaczący narzut O(N) na krok | niskie |
| C6 | GPU: indeks arytmetyczny `boundary()`/`interface_at()`/`spin_material()` | FDM GPU | assembly i materializacja z sekund do ms (prawdopodobnie główna część 18 s) | niskie |
| C7 | GPU: trwały workspace i pula `cudaMallocAsync`, cache atrybutów urządzenia, warm start μ, redukcja `cudaStreamSynchronize`, zdarzenia zamiast `cudaEventSynchronize` | FDM GPU | dziesiątki ms na etap | obsługa błędów późnego etapu |
| C8 | GPU: opóźniony prekondycjoner AMG, CGS2 z fuzją iloczynów, granice Chebysheva przy setupie, równoległe kernele materializacji i ładunku | FDM GPU | 3–10× na iterację | wymaga zmiany 0970:1749-1751 |
| C9 | FEM: trwały obiekt solvera C++ na cały run (siatka, przestrzenie, wzorzec, prekondycjonery, macierz masy), zero-copy `m`, bez klonu `MeshIR` na etap, SHA tylko dla zaakceptowanych stanów | FEM CPU | rzędy wielkości dla sprzężenia per etap | zarządzanie stanem przy rollbacku |
| C10 | FEM: FGMRES z blokowo-diagonalnym BoomerAMG (V, system-AMG 3×3 μ), direct dla rozmiarów referencyjnych; Oersted z element-wise `σ∇V` i ewentualnie FFT/FMM | FEM CPU | zbieżność na realnych siatkach (dziś ryzyko stagnacji) | nowa zależność hypre w ścieżce transportu |

### Etap D: Python, IR, dokumentacja i matryca

| # | Zadanie | Bramka |
|---|---|---|
| D1 | SceneDocument wyraża FEM M2 (operator FEM, bez `reciprocal_nonlinear`); przykład `fem_reciprocal_m2_public.py` z `engine="gmres"` i test, który go planuje (SHE-PY-3, SHE-PY-4) | test planowania przykładu |
| D2 | Jedno źródło reguł walidacji (tabela reguł w IR, eksportowana do Pythona i UI); Python liczy co najmniej Schura i C_s/N₀ z tej samej definicji | test parytetu reguł |
| D3 | Synchronizacja `capability-matrix-v0.json/.md` z plannerem: stany, FEM M2 stage coupling, GPU M1, identyfikatory capability w planie (SHE-PY-7, SHE-PY-8) | skrypt spójności matryca↔planner |
| D4 | Aktualizacja specyfikacji parity (jednostka C_s, statusy, osobne pozycje G↑/G↓/G_r/G_i/SML, `drift_diffusion_spin_torque`) | test parity |
| D5 | Dokumentacja publiczna: domyślne lane i operator, M1 one-way vs M2, pełna tabela jednostek, odsyłacz SOT ↔ solved SHE, usunięcie nieistniejących testów; usunięcie kolizji placeholdera `DriftDiffusionSpinTorque` | build Sphinx/MyST |
| D6 | Odświeżenie golden `racetrack_m1_v1/python_problem_ir.v1.json` po potwierdzeniu, że różnice dotyczą tylko nowych pustych kolekcji | `pytest` zielony |
| D7 | Rozstrzygnięcie sprzeczności z §9 w notach 0970 i 0980 | review naukowy |

### Etap E: Control Room (z `modern-web-guidance` i dowodem z przeglądarki)

| # | Zadanie | Bramka |
|---|---|---|
| E1 | Naprawa `check_spin_authoring_forms.mjs` (liczniki wyprowadzone z listy IR) i podpięcie pod `just lint-control-room-source` / CI (SHE-UI-2) | zielony skrypt w CI |
| E2 | Rozpoznawanie: dopuścić powierzchnie interfejsu, `external_lead_preparation`, `conservative_current_source`; walidację wersji operatora zostawić backendowi (SHE-UI-3…5) | testy modelu z przypadkami regresyjnymi |
| E3 | Legenda viewportu: jednostka z `QuantityCatalogEntry.unit`, token projekcji w planie colorbaru (SHE-UI-1) | test modelu oraz browser smoke (widoczny canvas, kontekst WebGL, niezerowy drawing buffer) |
| E4 | Autoring `drift_diffusion_spin_torque` (select istniejącego spin transportu, target, wersja), opis „prescribed vs solved”, ostrzeżenie o podwójnym liczeniu, usunięcie martwych opcji legacy (SHE-UI-6) | test round-trip UI → skrypt → IR |
| E5 | Rozdzielenie „authoring allowed” od „lane qualification”, resolved lane z planera, status overview liczony z capability (SHE-UI-7) | test modelu i zrzut przeglądarki |
| E6 | Residua, bilanse i świeżość transportu w UI (0970 §4.4); wyniki zapisane dla μ_s, Q i momentu; formularze z enumami, wektorami i stabilnymi kluczami (SHE-UI-8) | browser smoke 320–420 px |

### Etap F: walidacja naukowa (po A–C)

1. Analityczne N\|F 1D z mixingiem i SML, z h-refinement (po B4).
2. Wspólna granica FDM↔FEM dla direct SHE w filmie i M2 iSHE.
3. Sweep Onsagera i dyssypacji dla M2.
4. Parytet z BORIS dla przypadków N\|F (istniejące skrypty `scripts/verify_boris_fullmag_she_1d.py`, `scripts/run_fullmag_m2_nf_common_case_v3.py`).
5. Trajektoria FEM M2+LLG vs FDM M2+LLG dla jednorodnego macrospinu (po B1).
6. Kwalifikacja wydajności z licznikami solve'ów, iteracji i czasu dla siatek 10⁴…10⁶.

Kolejność zalecana: **A → B1, B2, B3 → B4 → C1–C4 → D1, E1, E2 → reszta C, D, E → F**.

- A i E1/E2 są niezależne i mogą iść równolegle.
- B4 jest największą zmianą numeryczną i potrzebuje nowej wersji operatora oraz benchmarku N\|F, zanim jakikolwiek wynik z interfejsem mixing zostanie użyty do porównań ilościowych.

---

## 11. Czego nie zweryfikowano

- Wykonania jakiegokolwiek testu Rust, C++ i CUDA ani przebiegu runtime (zakaz kompilacji).
- Semantyki MFEM w dołączonej wersji (SHE-P0-6, SHE-P1-15, SHE-P1-16).
- Ilościowego wpływu SHE-P0-1 na trajektorie. Istnienia bramki E2E FEM M2+LLG vs FDM.
- Osiągalności:
  - non-strict dla M1 Rust (SHE-P1-6);
  - FEM zero-mean bez napędu (SHE-P1-14);
  - legacy SOT v0 z publicznego DSL.
- Kadencji solve'ów na etap w natywnych integratorach CUDA (RK23, DP45, ABM3) i normalizacji `m_stage` poza RK4.
- Wartości liczbowych wydajności. Są to szacunki z kodu i wartości z raportu zamknięcia GPU (CONTRACT).
- Zachowania Control Room w przeglądarce. Czy żywy katalog publikuje `spin_potential`, `spin_current_tensor` i `torque_*` z projekcjami.
- Czy backend blokuje jednoczesny prescribed SOT i solved SHE torque na tym samym targecie.
- Asercji `check_spin_authoring_forms.mjs` po linii 27 (przerwane na pierwszej porażce).

---

## 12. Mapa głównych plików

| Warstwa | Pliki |
|---|---|
| Nota i kontrakty | `docs/physics/0970-spin-hall-drift-diffusion-transport.md` (+ `.source-map.json`), `docs/physics/0960-…`, `docs/physics/0980-…`, `docs/specs/spin-transport-runtime-contract-v1.md`, `docs/adr/0019-…`, `docs/specs/capability-matrix-v0.{md,json}`, `docs/specs/spin-transport-authoring-parameter-parity-v1.json` |
| Python | `packages/fullmag-py/src/fullmag/model/spin_transport.py`, `current_transport.py`, `spin_torque.py`, `runtime/script_builder.py` |
| IR i walidacja | `crates/fullmag-ir/src/spin_transport.rs`, `validation.rs`, `plan.rs` |
| Planner | `crates/fullmag-plan/src/spin_transport.rs`, `fem.rs`, `fdm.rs`, `current_transport.rs`, `validate.rs`, `physics_graph.rs` |
| Authoring | `crates/fullmag-authoring/src/spin_transport.rs`, `validation.rs`, `scene.rs` |
| Silnik FDM CPU | `crates/fullmag-engine/src/fdm/cpu/transport/{charge,spin_drift_diffusion,coupled_charge_spin,coupled_block_linear,reciprocal_constitutive,transient_spin,oersted}.rs`, `fdm/cpu/fields/direct_torques.rs`, `fdm/cpu/integrators.rs` |
| Runner FDM | `crates/fullmag-runner/src/fdm/cpu/{spin_transport,native_transport,reference}.rs`, `fdm/gpu/cuda/spin_transport.rs` |
| Natywny FDM | `backends/fdm/cpu/transport/spin_transport_v1.cpp`, `backends/fdm/api/{cpu_transport_v1,c_api}.cpp`, `backends/fdm/gpu/cuda/transport/{context.cu,spin/*,charge/*}`, `backends/fdm/gpu/cuda/integrators/transport_rhs_fp64.cu` |
| FEM | `backends/fem/cpu/mfem/transport/steady_transport*.{cpp,hpp}`, `backends/fem/cpu/mfem/interactions/{transport_stage,sot}.cpp`, `crates/fullmag-runner/src/native_fem/{steady_transport,stage_transport,stage_coupled,charge_transport}.rs` |
| Control Room | `apps/control-room/src/shared/domain/physics/transportRecognition.ts`, `modules/inspector/panels/Transport*`, `SpinInterfaceInspector*`, `SpinAuthoringInspector*`, `modules/viewport-3d/Viewport3DModule.tsx`, `kernel/api/quantityIds.ts`, `tensorFieldProjection.ts`, `scripts/check_spin_authoring_forms.mjs` |
