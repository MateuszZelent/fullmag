# `racetrack_m1_v1`

`racetrack_m1_v1` to syntetyczny fixture walidacyjny dla pierwszego,
ściśle ograniczonego workloadu solved-current HM/FM. Wprost: nie reprezentuje jednego rzeczywistego materiału
ani zmierzonego stosu. Literatura uzasadnia fizyczny
model i skalę poszczególnych grup parametrów; każda liczba pozostaje jawnym
wyborem benchmarkowym zapisanym w `fixture.v1.json`.

## Zamrożona orientacja

- `+x`: oś toru i dodatni conventional current;
- `+y`: oś poprzeczna używana przez analizę Halla;
- `+z`: kierunek HM→FM i normalna zorientowanego interfejsu;
- tensor `Q_ia`: pierwszy indeks oznacza kierunek przepływu, drugi polaryzację
  spinu;
- dla `J_x>0` i `theta_SH>0` człon direct SHE daje `Q_zy>0`.

Odwrócenie samego zapisanego wektora normalnego bez zamiany stron interfejsu
jest błędnym deskryptorem. Spójna reorientacja zamienia HM/FM, normalną i skoki;
odwraca znaki wielkości zorientowanych, lecz nie zmienia fizycznego torque na FM.

## Zakres fixture

Fixture obejmuje siatkę `256 × 64 × 4`, osobne maski domeny transportowej,
magnetycznej i targetu torque, zeroprądową relaksację istniejącego modułu oraz
symetryczny sweep sześciu niezerowych prądów. Oersted, inverse SHE,
prescribed SOT/STT, MTJ, FP32, PBC, termika, M2/M3, multi-GPU i fallback CPU
są poza zakresem. Poza zakresem jest również `adaptive_geometry`: wszystkie
sześć drive używa niezmiennej siatki, geometrii, masek i indeksowania komórek.

HM zajmuje dokładnie warstwy komórek `z=[0,3)`, a FM `z=[3,4)`.
`transport_active` obejmuje wszystkie `65536` komórek, natomiast
`magnetic_active` i `torque_target` obejmują te same `16384` komórek FM.
Każda maska ma jawne `shape`, `cell_order`, `cell_bounds` i liczbę
aktywnych komórek; obowiązuje
`torque_target subset magnetic_active subset transport_active`.

Charge używa dwóch kompletnych terminali: `terminal_x_minus` obejmuje
`hm:x-` i `fm:x-`, a `terminal_x_plus` obejmuje `hm:x+` i `fm:x+`.
Pozostałe sześć zewnętrznych powierzchni ma BC insulating, a gauge jest
`zero_mean`. Interfejs `hm_fm` zapisuje obie powierzchnie `hm:z+` i
`fm:z-`, obie orientacje, strony materiałowe oraz normalną HM→FM `+z`.

Każdy drive wraca do checkpointu `relaxed_zero_current`, trwa `2e-9 s`,
używa kroku `1e-13 s` i próbkowania `5e-12 s`. JSON zapisuje konkretne
outward densities obu terminali dla każdej z sześciu amplitud, więc pełny
harmonogram i znaki nie zależą od późniejszych defaultów.

Spin solver jest zamrożony dokładnie jako `native_m1_v1`; `auto`, `gmres` i
każdy fallback są zabronione. Kanoniczny seed jest rzeczywistym publicznym
loweringiem `fm.texture.neel_skyrmion`, nie uniform `m`. Używa world-space
centrum `[256e-9,64e-9,3.5e-9]`, `R=30e-9`, `Delta=5e-9`,
`chirality=+1`, Néel `helicity=0` oraz parametru polaryzacji `+1`. Dla
rzeczywistej repozytoryjnej formuły oznacza to outward radial wall,
`core m_z<0` i `background m_z->+1`. Każda próbka jest normalizowana normą
euklidesową L2 do wektora jednostkowego; jedyny fallback dla zerowej normy to
`[0,0,1]`. Dokładny JSON seeda jest częścią
`magnets[0].initial_magnetization` i jest porównywany z aktualnym publicznym
`Problem.to_ir()`.

`normalized_problem_ir_contract.expected_lowering` jest kompletną, parsowalną
projekcją bieżącego `ProblemIR`, zbudowaną publicznymi konstruktorami
`Box`, `Translate`, `Material`, `Ferromagnet` i `Problem`. Zamraża rzeczywistą
kolejność `geometry.entries=[fm,hm]`, rozmiary obu przetłumaczonych warstw pod
`geometry.entries[*].base.size`, translacje do bounds fixture zaczynających się
w `[0,0,0]`, materiał pod `materials[0]`, moduły transportu,
energy terms, bazowy `TimeEvolution`, `BackendPolicyIR` i
`ValidationProfileIR`. Test Python porównuje całą projekcję i dereferencjonuje
każdy `problem_ir_path`. Test Rust parsuje cały `ProblemIR`, profil walidacji
oraz sprawdza selection dokładnie pod
`problem_meta.runtime_metadata.runtime_selection`. Konkretne mutacje drive
celują w istniejące indeksy terminali `current_modules[0].boundaries[0]` i
`[1]`; `boundaries[current_sweep]` nie jest polem ProblemIR.

Pełny sześcioprzebiegowy workload nie jest jeszcze lowerowalny jako jeden
niemutowalny `Problem`: neutralny obiekt HM typu `conductor`, jego region oraz
materiały charge/spin są już reprezentowalne, natomiast mutacje BC między
etapami i restart każdego drive z nazwanego checkpointu należą do jawnego
kontraktu workflow. Te dwie granice pozostają zapisane w
`public_lowering_boundary`; nie są ukrywane przez zmianę typu obiektu.

`she_1d_film_v1` jest analitycznym oraklem direct-SHE/steady-spin, natomiast
`skyrmion_hall_angle_v1` jest wersją algorytmu trajektorii, okna ruchu ustalonego
i ważonej regresji. Żaden z tych identyfikatorów nie oznacza jeszcze
produkcyjnej kwalifikacji FDM GPU.

Przy produkcyjnym `P=0.4` odwrócenie `theta_SH` zmienia
`T_P+T_SHE` na `T_P-T_SHE`; nie odwraca ogólnie całej odpowiedzi.
Dokładny oracle czystego SHE ustawia wyłącznie `fm.P=0`, zachowuje ten sam
charge snapshot i wymaga odd `mu_s`, `Q_spin` oraz `T_tr_G`.

## Kolejne bramki

Task 1 zamraża dane wejściowe, równania, znaki i wymagane nazwy właścicieli.
Implementacja, wykonywalność, walidacja CPU↔CUDA i kwalifikacja produkcyjna są
oddzielnymi bramkami Tasks 2–12. Dopiero świeży zarządzany manifest Task 12 może
promować dokładny tuple `fdm/gpu/double/strict/racetrack_m1_v1`.

## MuMax3: wyłącznie wspólny limit dynamiki

`mumax/common_limit.mx3` nie implementuje solved-current transportu w MuMax3.
Wymaga początkowego stanu po relaksacji oraz pola równoważnego torque
wyeksportowanego z Fullmag. Nie wolno zastępować go terminem Slonczewskiego,
Zhang–Li ani innym prescribed-current torque. Receptura
`just verify-fdm-gpu-racetrack-mumax-common-limit` wymaga manifestu wejściowego
Fullmag oraz stanu po relaksacji i pola torque. Po zakończeniu MuMax3 parser
`scripts/parse_mumax_common_limit.py` buduje manifest MuMax3 bezpośrednio z
rzeczywistych OVF/table, binarium, skryptu i kadencji; opcjonalny
`MUMAX_RACETRACK_COMMON_LIMIT_INPUT` jest tylko oczekiwaniem tożsamości i nie
zastępuje świeżego wyniku. Porównywarka odrzuca brak digestu binarium MuMax3,
niezgodną siatkę, różny krok/integrator common limit albo brak identycznego
digestu pola torque.

Źródłem eksportu jest zaakceptowane `T_tr_G` Fullmag w `s^-1`, nie
prescribed field. Dla kanonicznego jawnego równania Gilberta z
`docs/physics/0970-spin-hall-drift-diffusion-transport.md`,

```text
(1 + alpha^2) dm/dt = -gamma_e [m x B + alpha m x (m x B)]
                         + T_tr_G + alpha m x T_tr_G,
```

oraz tangentnego `T_tr_G`, exporter
`scripts/export_fullmag_transport_torque_for_mumax.py` zapisuje pole
`B_eq = (m x T_tr_G) / gamma_e` w teslach. Pole jest zamrożone na
zaakceptowanym snapshocie: nie jest aktualizowane podczas ewolucji MuMax3 i
nie wolno go po cichu projekować, jeśli `m · T_tr_G != 0`. Manifest v1
eksportu oddziela digest źródłowego `T_tr_G` (`s^-1`) od digestu wstrzykniętego
`B_eq` (`T`), zapisuje `alpha`, `gamma_rad_s_T`, konwencję Gilberta i digest
OVF. `common_limit.mx3` ustawia identyczne `GammaLL`, używa fixed-step Heuna
`FixDt=5e-14 s` oraz jawnych par `Steps(100)` + `TableSave()` + `Save(m)` dla
próbek co `5e-12 s`; nie używa czasowego autosave jako dowodu kadencji.
Comparator v2 odrzuca dynamiczną rekalkulację torque,
brak jednego z digestów, różne jednostki, niecałkowitą relację
`dt`/próbkowanie/czas przebiegu oraz inną literalną politykę demag. Receptura
wiąże ponadto digest rzeczywiście wygenerowanego `table.txt` z manifestem
MuMax3; sam deklarowany interwał nie wystarcza jako dowód kadencji runtime.

Jednostkowe testy `scripts/test_compare_fdm_racetrack_mumax.py` używają tylko
syntetycznych manifestów do weryfikacji parsera i bramek fail-closed. Nie są
dowodem uruchomienia MuMax3 ani kwalifikacją dynamiki. Prawdziwy wynik jest
manifestem `racetrack_mumax_common_limit_v2.json` pod trwałym katalogiem
raportów i zawiera osobno metryki `m_rms`, energii, $Q$, środka, prędkości oraz
$\Theta_H$, wraz z literalną polityką demag.

## Źródła skali

1. J. Sampaio et al., *Nature Nanotechnology* 8, 839–844 (2013),
   DOI `10.1038/nnano.2013.210`.
2. T. Valet and A. Fert, *Physical Review B* 48, 7099–7113 (1993),
   DOI `10.1103/PhysRevB.48.7099`.
3. A. Brataas, Yu. V. Nazarov, and G. E. W. Bauer,
   *Physical Review Letters* 84, 2481–2484 (2000),
   DOI `10.1103/PhysRevLett.84.2481`.
4. C. Abert et al., *Scientific Reports* 5, 14855 (2015),
   DOI `10.1038/srep14855`.
