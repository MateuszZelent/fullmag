# E9c — granice publicznego Run i analizy odpowiedzi spinowej

## Checkpoint kandydata pionowego E9c — 12.10.2026

Historyczny audyt poniżej opisuje stan przed przygotowaniem poprawki. Kandydat
v2 obejmuje 14 plików: typed `FiniteKResponseAnalysis`, canonical eksport
Python, istniejący edytor i inspektory FFT/Run, kontrolę monitorów `m`/`H_drive`,
stage-local gate źródła oraz walidację błędnych typów/opcji requestu.
Znana analiza finite-k zachowuje tożsamość niezależnie od edytowalności;
nieznane payloady pozostają bezstratne i jawnie nierozpoznane, nie Gamma.

Zamrożony patch znajduje się w storage tego worktree, pod
`reviews/antenna-harmonic-cache-20261012/e9c-vertical-overlay/e9c-vertical-candidate-v2.patch`.
SHA256: `4ebf898a646e2d7c9a0397dddd4e297a7c867303e00dbe215296563447aa1eb5`.
Receipt `przekazanie-v2-pl.md` w tym samym katalogu. Wersja v1 zastąpiona.
Pakiet przekazano integratorowi, bez zapisu do jego checkoutu.

Dowody: rzeczywisty publiczny Python request/export/reimport PASS dla 15/16
sond i Gamma; rzeczywisty model UI parse/serialize oraz read-only PASS;
workflow jawnych zegarów PASS (auto-sinc dependency stubbed, niekwalifikowane);
lint czterech plików 0 błędów/ostrzeżeń; pełny graf własnego frontendu z
nakładkami TypeScript 0 diagnostyk, bez emit. Focused scientific validator
overlay PASS_DRAFT_OVERLAY_ONLY. Dwa przeglądy i końcowy delta review
rozstrzygnęły znalezione błędy prezentacji. `git apply --check -p2` w checkoutcie
integratora exit 0. To dowody źródeł, nie działania zmienionego workspace.

Rust regresje liczby sond, opcji/komponentów i stage/current/global companion
zapisane, NIE SKOMPILOWANE / NIE WYKONANE; parser rustfmt PASS. Gate źródła
nie certyfikuje zaakceptowania artefaktu bazy. Pozostają integracja,
zarządzany build, realny Run z m/H_drive, Zarr readback, cold API, browser i
naukowa FFT. Cały plan T00–T18 pozostaje otwarty; ten checkpoint go nie zawęża.

Data: 12.10.2026. Status: **audyt źródłowy częściowy; runtime NOT VERIFIED**.
Źródła: worktree integratora `antenna-transport-e2e-20261011`, HEAD
`93682dbbf7acbc4c028f5692ec4a164883b8a3fd` z WIP. Nie zmieniono jego
plików, nie uruchomiono buildu, solvera, HTTP ani przeglądarki.
Ten dokument nie zastępuje canonical physics note ani pełnej kwalifikacji E9c.

## Rzeczywista trasa i potwierdzone granice

| Warstwa | Źródło + symbol | Odczytany kontrakt |
|---|---|---|
| Python | `packages/fullmag-py/src/fullmag/world.py` + `StudyStagesBuilder.fft_response` | konfiguruje wyłącznie Γ przez `GammaResponseAnalysis.to_runtime_metadata`; nie jest autorem finite-k |
| Alternatywny autor | `apps/control-room/src/modules/start/model/templateScripts.ts` + `spin-wave-dispersion` w katalogu szablonów | używa publicznego `study.runtime_metadata` z `analysis=finite_k`, probe count, zakresem x i absorberami; brak typed finite-k builder nie oznacza braku możliwości zapisania requestu |
| UI FFT | `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts` + gałęzie `fft_response` | edytowalny request jest Γ; nieobsługiwany raw request zachowywany przez read-only/rawRequest, nie wolno go milcząco zamienić na Γ |
| Zapis pola | `crates/fullmag-plan/src/validate.rs` + `validate_executable_outputs`; `crates/fullmag-plan/src/fem.rs` + wywołanie tej funkcji | `H_drive` dopuszczone przy `!problem.field_drives.is_empty()`; solved antenna drive nie jest uwzględniony w tym booleanie |
| Native źródło | `crates/fullmag-runner/src/native_fem.rs` + `pack_native_regional_field_drives` | baza anteny mnożona przez peak current i pakowana wraz z regional drives; to obecność implementacji, nie dowód zapisania snapshotu |
| Postprocessing | `crates/fullmag-runner/src/spin_wave_sampling.rs` + `requested_finite_k_artifacts` | tylko `BackendPlanIR::Fem`, aktywny regional lub solved antenna drive; tet4, co najmniej cztery saved snapshots, full nodal float64 `m` i `H_drive` z tym samym czasem |
| Sampling | ten sam plik + `build_p1_x_cross_section_operator`, `read_native_fem_zarr_component` | średnia przekroju P1 wzdłuż x, dodatnia masa magnetyczna; SoA chunk, planowana liczba węzłów, samples.csv o 8 kolumnach |
| Γ odmowa | `crates/fullmag-runner/src/spin_wave_response.rs` + `append_requested_spin_wave_artifacts` | root WIP odrzuca Γ dla aktywnej solved antenna; nie utożsamiać tego z brakiem finite-k ani z wynikami anteny |
| FFT | `crates/fullmag-runner/src/spin_wave_sampling.rs` + `dynamic_structure_factor_1d_with_axes` | osobne transformacje odpowiedzi i źródła; odjęcie pierwszego snapshotu, Hann w czasie i przestrzeni, jawna konwencja fazy i normalizacja |
| HTTP | `crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs` + `get_dynamic_structure_factor` | istniejący `/v2/sessions/current/analysis/spin-wave/dynamic-structure-factor.v1`, bound do 4096 komórek; pozostaje artifact_ref |
| Klient/UI | `apps/control-room/src/kernel/api/ControlRoomApi.ts` + `analysis.spinWave.dynamicStructureFactor`; `AnalysisPlotsView` + `DynamicStructureFactorView` | istnieje klient i widok `dynamics.s-k-f`; nie trzeba tworzyć nowego endpointu ani modala dla podstawowego wyniku |

## Problemy wymagające rozwiązania przed realnym E9c

1. **Antenna-only H_drive output.** Publiczny planner odrzuca wymagany
   snapshot bez regional field drive. Naprawić canonical availability i
   walidację zgodnie z rzeczywistym źródłem. Fikcyjny regional drive nie jest
   poprawnym obejściem. Weryfikacja: authored antenna-only Run z `m` oraz
   `H_drive` przechodzi planowanie, a nieaktywne/niezgodne źródło ma jawną odmowę.
2. **Szablon dyspersji nie odpowiada możliwości analizatora.** Wybiera
   `study.engine("fdm")`, zapisuje `m`, ustawia finite-k metadata i nie zapisuje
   `H_drive`. Analizator wymaga FEM i obu snapshotów. Nie znaleziono dopięcia
   monitorów przez samo finite-k metadata w odczytanych planner/runner sources.
   Dalszy przegląd monitor pipeline jest wymagany przed pełnym wnioskiem.
   Docelowo zgodny publiczny workflow albo jawna capability odmowa przed Run;
   nie cichy backend fallback ani tylko zmiana etykiety szablonu.
3. **Konfiguracja nie jest wykonywalnym dowodem.** Sprawdzić właściwy
   stage-local/absolute czas, wspólną regularną cadence, float64, topology i
   zakres magnetyczny w rzeczywistym zapisie. Postprocessing jest wykonywany
   po finish pipeline, więc brak snapshotów może ujawnić się dopiero po Run.
4. **Źródło i odpowiedź to odrębne obserwable.** Reader używa tego samego
   `response_component` dla `m` i `H_drive`. To ograniczenie projekcji, nie
   automatycznie pełna podatność wektorowa. Potrzebny naukowy kontrakt źródła
   i test przypadku z różnymi osiami wzbudzenia/odpowiedzi; nie dopisywać
   interpretacji susceptibility na podstawie samej macierzy power.
5. **Absorbery i okna.** `excluded_absorber_ranges_m` jest kopiowane do
   artefaktu po FFT; samo pole nie wycina próbek. Wyłączenie wymaga poprawnego
   `analysis_x_min_m/max_m`. Obecny FFT używa Hann na sztywno; metadata
   `window_space/window_time` nie dowodzi wyboru innego okna. UI musi pokazywać
   rzeczywiste resolved sampling, nie tylko requested metadata.
6. **Cold archive/API/UI i niezależna analiza.** Potwierdzić trwały artefakt
   z prawdziwego Run, źródło snapshotów i tożsamość run/stage/meshu, wykonać
   niezależną FFT tych samych danych, następnie cold HTTP i browser. Obecność
   klienta, zapisane fixture oraz testy źródeł nie zamykają tych bramek.

FDM CPU/GPU: obecny analizator finite-k jawnie nie obsługuje tych planów.
FEM CPU/GPU: ścieżka źródłowa jest FEM, ale nie wykonano kwalifikacji żadnego
device; nie wywodzić parytetu z jednego wspólnego postprocessora. Mixed-cell
FEM nie spełnia obecnego wymagania tet4 tego readera.

## Piny odczytanych plików WIP (SHA-256)

| Ścieżka | SHA-256 |
|---|---|
| `crates/fullmag-plan/src/fem.rs` | `4e4c25a7d1069049a39d4113efaf33e57914cef9b7dd820fc87d67227674ac0f` |
| `crates/fullmag-plan/src/validate.rs` | `2a207b340950607801355243cd7708eed183fff43eac565ce14a3190990e4ad0` |
| `crates/fullmag-runner/src/spin_wave_sampling.rs` | `aee4e4a7e2d89bc17472e2a97a39b025e1d532c38293923313af67ccd0f3d4a5` |
| `crates/fullmag-runner/src/spin_wave_response.rs` | `cb529673dfc5407c2317a7d7d25f954da69d876adeb9a3d29fb549259e5b04b4` |
| `apps/control-room/src/modules/start/model/templateScripts.ts` | `5dec7345a4106a8a1a19af3168614b45fc885da3ad28c64dd2109ea769fd20c2` |
| `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts` | `68da44d05c2ddf883ab06b4791ec0bd0a14c654e96654003d02763792ba241dc` |
| `packages/fullmag-py/src/fullmag/world.py` | `bcda4ff26eaba77a7db8d31852417bca87878c1c0dc78ce80be0c4d26d36407a` |

Integrator otrzymał problemy 1–2. Uzupełnienie pełnego monitor wiring,
eksportu, resource hooks i naukowej association pozostaje otwarte.

## Uzupełnienie: wykonywalna reprodukcja granicy eksportu

Wykonano bez solvera rzeczywistą funkcję
`packages/fullmag-py/src/fullmag/runtime/script_builder.py` + `_render_stages`.
Wejściem był minimalny obiekt etapu z `action.kind=fft_response`,
`enabled=true`, `stage_id=response` i requestem
`analysis=finite_k`, `response_component=my`, `probe_count=32`,
zakresem x od 0 do 1 µm oraz schematem `spin_wave_response.request.v1`.
Wywołanie `surface=study`, `overrides={}` zwróciło:

```python
# Stages
study.stages.fft_response("my", stage_id="response")
```

Assert potwierdził obecność wywołania i brak `finite_k`/`probe_count`.
Exit code 0, status `REPRODUCED_EXPORT_BOUNDARY`, `solver_executed=false`.
Renderer w gałęzi `fft_response` nie sprawdza `request.analysis` i nie zachowuje
parametrów finite-k; publiczny `StudyStagesBuilder.fft_response` konfiguruje Γ.
To potwierdzony problem **tej granicy renderera**, nie dowód wykonania całej
ścieżki UI export ani tego, że każde wejście UI dochodzi do tej gałęzi.
Potrzebna jest walidacja end-to-end z rzeczywistym authored pipeline.

Najmniejsza bezpieczna naprawa musi jawnie zachować request w kanonicznym
publicznym eksporcie lub odrzucić nieobsługiwany rodzaj z diagnozą; nie może
generować innej analizy bez ostrzeżenia. Docelowy typed finite-k authoring
nadal pozostaje wymaganiem pełnego workflow, nie należy zastąpić go samą odmową.

Dodatkowy odczyt monitorów: `crates/fullmag-runner/src/schedules.rs` +
`collect_field_schedules` tworzy zegary wyłącznie z przekazanych `OutputIR`
i waliduje quantity przez canonical catalog. Nie tworzy `H_drive` na podstawie
requestu finite-k. `crates/fullmag-runner/src/native_fem.rs` +
`fem_preview_observable` mapuje `HDrive` na native `H_DRIVE`; to nie jest
automatyczna deklaracja zapisu ani dowód pełnego monitor pipeline.
Nie zmieniono writera ani polityki output. Reprodukcję i ograniczenia
przekazano integratorowi; runtime, cold HTTP i browser nadal NOT VERIFIED.

## Uzupełnienie: osie FFT i semantyka maski sond

W `crates/fullmag-runner/src/spin_wave_sampling.rs` +
`dynamic_structure_factor_1d_with_axes` etykieta signed bin wynosi
`index - floor(N/2)`, lecz payload wybierany jest przez
`(index + floor(N/2)) % N`. Dla nieparzystego N te permutacje nie odpowiadają
sobie. Publiczny reader dopuszcza probe_count w 4..=2048 bez wymagania parzystości.

Wykonana niezależna kontrola indeksów w Pythonie (exit 0, bez native) dała:

| N | Permutacja źródłowa | Permutacja zgodna z etykietami | Zgodność |
|---|---|---|---|
| 4 | 2,3,0,1 | 2,3,0,1 | tak |
| 5 | 2,3,4,0,1 | 3,4,0,1,2 | nie |
| 7 | 3,4,5,6,0,1,2 | 4,5,6,0,1,2,3 | nie |
| 8 | 4,5,6,7,0,1,2,3 | 4,5,6,7,0,1,2,3 | tak |

To potwierdza błąd mapowania źródłowego. Przed zamknięciem wymagany jest
wykonywalny regression na rzeczywistej funkcji FFT, z dodatnim/ujemnym k,
DC i nieparzystym N; nie wolno zamknąć problemu przez ograniczenie publicznego
probe_count do parzystych wartości. Poprawka permutacji musi zachować istniejącą
konwencję fazy, normalizację i poprawne parzyste przypadki.

Osobna obserwacja semantyczna: `requested_finite_k_artifacts` tworzy
`invalid_probe_mask` z przestrzennych wierszy operatora, a API
`crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs` +
`bound_dynamic_structure_factor` ogranicza maskę indeksami osi k.
Frontend `apps/control-room/src/modules/analysis-plots/dynamicStructureFactorModel.ts`
+ `hasConsistentGrid`, `dynamicStructureFactorPointSelection` interpretuje ją jako
maskę koszyków k. Sonda x i koszyk Fouriera nie mają relacji jeden-do-jednego.
Obecny reader odrzuca każdą invalid row przed FFT, więc dla aktualnie generowanego
wyniku maska zawiera tylko false: nie jest to dowód występującego dziś błędnego
ukrywania wyników. Jest to niespójność kontraktu, którą należy rozstrzygnąć
przed obsługą częściowo nieprawidłowych sond, bez arbitralnego maskowania k.

Hook `apps/control-room/src/kernel/resources/spinWaveResources.ts` +
`useDynamicStructureFactorResource` używa session-scoped resource key,
typed API i `schema_version` jako resolveRevision. To dowód istniejącej
trasy klienta, nie tożsamości bytes wyniku lub poprawnej invalidacji między runami;
pełna kontrola resource lifecycle pozostaje otwarta.

Dodatkowe SHA odczytu: API `spin_wave_response.rs`
`485a529be45099efdb8fa07b9613ed6fdf7f695f6cb6bc748a6076684261f4e6`;
frontend `dynamicStructureFactorModel.ts`
`1e2e7e10315030dbf7481dad876dd9131845bcaacde569b05b06a11881b93e53`.
SHA sampling pozostaje zgodne z tabelą powyżej.

### Izolowany kandydat poprawki odd-N

Na przydział integratora zapisano zmianę produkcyjną wyłącznie offsetu:
`space_count / 2` → `space_count.div_ceil(2)`. Regresja rzeczywistego helpera
`finite_k_shift_matches_direct_dft_for_odd_even_signed_and_zero_k` obejmuje
N=15/16 i signed k=-3/0/+3: direct complex DFT, power, peak, axis,
phase_convention i normalization. Testy Rust zapisano, lecz nie kompilowano.

Doc-first kontrakt i mapa źródeł w canonical 0950; focused validator PASS.
`rustfmt --edition 2021 --emit stdout` parser PASS (bez zapisu formatowania).
Niezależna kontrola NumPy sześciu przypadków PASS; maksymalna różnica zespolona
`7.815970093361102e-14`, wszystkie signed peaks zgodne. Nie jest to wykonanie
helpera Rust ani kwalifikacja runtime.

Patch storage `reviews/antenna-harmonic-cache-20261012/finite-k-odd-shift.patch`
w resolverowym build root tego worktree, SHA-256
`a3228943665690620515a8550548da12fc3b1df2a0f570c84087e8b8cd36bb06`.
Own preimage `fb0d5264c89104e22e46adc627ea98a0a0215afc95981086762338ffb0d41d27`;
own after `c380f0dfaffe8f86373bbb799e336d191d51134a3647fa8054a5304a523c76db`.
Root preimage pozostaje `aee4e4a7e2d89bc17472e2a97a39b025e1d532c38293923313af67ccd0f3d4a5`;
`git apply --check` na nim PASS. Own after nie jest expected root after,
ponieważ root zawiera niezależny WIP aktywacji anteny. Root nie zmieniono.
Pakiet przekazano integratorowi do review; zastosowanie i integracja z jego
canonical doc WIP pozostają otwarte.

### Potwierdzenie integracji i ostrożny wniosek o cache

Ponowny niezależny odczyt worktree integratora potwierdził zastosowanie
pakietu: sampling SHA `cc43009db876f5ec9e3a74dd9f4705204a5cc963693f60a027826d1c2d46a355`,
canonical0950 SHA `a3f7ff27d6f6ed00335357502dc51d0c13ef13d7903b56de8d05079c19c125c1`,
map SHA `79a07737d5cafffce4875645b013bc02e9de3ba76ebe9bbaaea59eb74576ea99`.
Wszystkie odpowiadają kandydatom root overlay. Jest to dowód integracji
źródeł, nie wykonania regresji Rust lub naukowego runtime.

Kontrola `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts` +
`ResourceRuntimeStore.ensureLoad` (ścieżka zakończenia load) i
`resourceState.ts` + `markResourceReady` pokazuje, że udany load przypisuje
nowe data również przy niezmienionym resolveRevision. Dodatkowo przechowuje
`settledExternalRevision` niezależnie od revision danych. Sam hook
`resolveRevision=data.schema_version` nie dowodzi więc, że wykres ignoruje
odświeżenie. Wymagane jest osobne sprawdzenie zewnętrznej invalidacji i
tożsamości wybranego punktu między runami; nie zgłaszać zamrożonego UI
bez takiego dowodu.

Piny tego odczytu: `ResourceRuntimeStore.ts`
`b8a5f347db8c0ee7e314cbbc14b477b33d248782a4364fc50795a73c15cd3254`;
`resourceState.ts` `ae18588321dd5c9e4be2b1c16e9f2ab910fa1ca4b653221df2541edfd398a6a5`.

### Kolejny checkpoint: invalidacja, tożsamość i kwalifikacja konsumenta

Poprawka invalidacji Gamma/DSF została zintegrowana przez właściciela
checkoutu w commicie `6125df565c6afaacc8663279e884f28c793dce12`.
Autor tego raportu potwierdził zgodność mostka i zapisanego testu z pakietem;
interpretowana kontrola rzeczywistych klas nie zastępuje Vitest ani browser.

`ResourceRuntimeStore.ensureLoad`: dwa syntetyczne payloady z tą samą
schema_version przy external revision 17 → 18 przyjęły nowe dane;
powtórzenie 18 nie uruchomiło kolejnego load. Legacy wybór DSF dla dwóch
artefaktów i tych samych indeksów ma identyczne node/item/sample identity,
lecz kopiuje różne f/k. Legacy Inspector jawnie nie udostępnia pola:
nie wykazano zamiany pól ani stale browser. Kanoniczna funkcja
`useAnalysisResultProjectionController.ts` +
`analysisResultProjectionMatchesSelection` zaakceptowała zgodny zestaw
i odrzuciła dziewięć mismatch/missing przypadków; uruchomiono dokładnie
wyciętą czystą funkcję, nie hook ani endpoint.

Kontrola `antennaFieldOverlayModel.ts` + `antennaDisplayShape` na syntetycznych
deskryptorach: 6 poprawnych konfiguracji i 18 odmów unit/byte-count/hash.
Pełny `antennaClosedLoopInspectionModel.ts` parser/owner: 3 akceptacje
i 16 odmów. Są to kontrole metadanych, nie realnych bajtów bundle ani solvera.

Zidentyfikowano niejednoznaczność diagnostyki: istniejące
`closed_loop_v2::require_qualified` nie ma callsite; konsumenci nadal
odrzucają v2 przez dalszy schemat v1/ready. Nie potwierdzono bypassu.
Przekazano storage-only propozycję jawnej odmowy, cztery niewykonane testy
Rust oraz minimalną notę 0950/source-map. Kod patch v3 SHA256:
`27e2eac6d74daf43c16e0ce466ab426196d75b84b4e320066da590d61fe46a1b`;
dokumentacja patch v2 SHA256:
`c91933fb4416b7e2d0247718d6e5848db173c5030c53dbd9defa619b136a174f`.
Obie kontrole zastosowania PASS; focused validator overlay PASS;
suite kontraktu dokumentacji: 33 interpretowane testy OK.

Pakiet pozostaje propozycją do review, nie zintegrowaną kwalifikacją.
Pełne valid-v1/v2 public-loader runtime, cold HTTP, UI, LLG i naukowe
bramki T00–T18 pozostają otwarte. E9c14 nadal czeka na integrację po B02;
ponownie potwierdzono 14/14 zgodnych preimages, nie wykonanie funkcjonalności.
