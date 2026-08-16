# Produkcyjny racetrack ze skyrmionem i rozwiązanym transportem

**Status:** zatwierdzony projekt; bounded FDM/CUDA FP64 jest wykonywalny, a świeży common-limit FDM/CUDA FP64 ↔ MuMax3 przeszedł dla jawnie zbieżnego kroku `5e-14 s` (2026-08-14). Nie jest to jeszcze kwalifikacja produkcyjnego solved-current racetracku: nadal otwarte są bramki 2, 6, 8–12.

**Data:** 2026-08-11

**Aktywny zakres:** wyłącznie etap 1 roadmapy transportowej

**Pierwsza realizacja produkcyjna:** FDM / CUDA / FP64 / strict

## 1. Wynik końcowy

Użytkownik definiuje racetrack w Python DSL albo Control Room, dodaje transport
charge/spin tylko do wybranych obiektów, inicjalizuje albo relaksuje skyrmion i
uruchamia dynamikę. Fullmag rozwiązuje kolejno charge, direct SHE oraz steady
spin, przekazuje wynikowy transportowy SOT/STT do LLG i publikuje trajektorię,
prędkość oraz kąt Halla.

Etap jest ukończony dopiero wtedy, gdy cały przepływ działa publicznie,
fail-closed i bez ukrytego prescribed torque:

```text
Python/UI
  -> canonical ProblemIR
  -> FDM/CUDA capability plan
  -> accepted charge snapshot: V, J_c
  -> direct SHE + steady spin: mu_s, Q
  -> interfacial and volumetric angular-momentum transfer
  -> transport torque on the ferromagnet
  -> accepted LLG trajectory
  -> skyrmion center, velocity and Hall angle
  -> artifacts, checkpoint, provenance and qualification
```

Pole Oersteda i CPP-MTJ nie należą do tego przepływu i nie mogą opóźniać ani
pozornie rozszerzać kwalifikacji etapu 1.

## 2. Model fizyczny

Racetrack składa się z warstwy heavy-metal oraz sprzężonej z nią warstwy
ferromagnetycznej. Charge solver wyznacza podpisane, konserwatywne pole `J_c`.
Direct spin Hall effect w heavy-metalu wytwarza tensor prądu spinowego `Q`.
Steady drift-diffusion wyznacza wektorową akumulację spinową `mu_s`.

Poprzeczna absorpcja spinu na zorientowanym interfejsie HM/FM oraz
objętościowe reakcje wymiany i dephasing przekazują moment pędu do
ferromagnetyka. Torque transportowy jest wyznaczany z bilansu momentu pędu, a
nie z lokalnie podstawionej sprawności prescribed SOT.

LLG zachowuje kanoniczną konwencję Gilberta, znaki prądu, `theta_SH`, normalnej
interfejsu i momentu elektronu. Energia magnetyczna workloadu obejmuje co
najmniej exchange, demag, anisotropy oraz właściwy dla stabilnego skyrmionu
interfacial DMI. Pole Oersteda jest świadomie wyłączone w etapie 1 i jego brak
jest zapisany w `ProblemIR` oraz proweniencji.

## 3. Zamrożony zakres pierwszego workloadu

Pierwszy workload produkcyjny ma następujące granice:

- prostokątny racetrack HM/FM na pełnej strukturze FDM;
- jawne `backend=fdm`, `device=gpu`, `precision=double`, `mode=strict`;
- brak PBC, termicznego szumu, FP32, wielu urządzeń i adaptacyjnej geometrii;
- jedno źródło charge z kompletnymi elektrodami oraz jawnym gauge;
- jeden materiał HM z direct SHE i jeden materiał FM;
- jeden zorientowany interfejs HM/FM z jawnym mixing conductance;
- steady one-way M1 bez iSHE i bez transient spin M3;
- torque transportowy przekazywany device-to-device do RHS LLG;
- deterministyczna relaksacja i deterministyczny przebieg dynamiczny;
- brak pola Oersteda;
- jedna wersjonowana rodzina geometrii i parametrów materiałowych wybrana na
  podstawie literatury przed zakodowaniem fixture.

Wyjście poza ten zakres failuje w plannerze. W szczególności executor nie może
zastąpić GPU przez CPU, FP64 przez FP32, transportowego torque przez prescribed
SOT ani steady spin przez inną formułę.

## 4. Dwanaście bramek realizacji

### 4.1. Bramka 1 — workload, znaki i jednostki

Powstaje wersjonowany fixture zawierający geometrię HM/FM, parametry charge i
spin transportu, parametry magnetyczne, DMI, elektrody, orientację interfejsu,
stan początkowy i harmonogram prądu. Każdy parametr ma źródło, jednostkę SI,
zakres ważności oraz docelowe pole `ProblemIR`.

Bramka przechodzi, gdy Python i UI tworzą semantycznie identyczny znormalizowany
`ProblemIR`, a odwrócenie osi, normalnej lub prądu daje z góry określoną zmianę
znaków wszystkich wielkości pochodnych.

### 4.2. Bramka 2 — rozwiązany charge transport

Publiczny runtime materializuje descriptor FDM/CUDA i tworzy zaakceptowany,
niezmienny snapshot `V`, `J_x`, `J_y`, `J_z`, topologii oraz rewizji źródła.
Akceptacja wymaga lokalnego residual, bilansu elektrod, zgodności gauge i
kontroli numerycznej spójności przewodnika.

Testy obejmują rozwiązanie analityczne jednorodnego przewodnika, odwrócenie
prądu, skalowanie amplitudy, niezależny CPU oracle oraz CUDA FP64 parity.

### 4.3. Bramka 3 — direct SHE i steady spin

Spin solver konsumuje wyłącznie zaakceptowany uchwyt snapshotu charge oraz
jego generację. Wyznacza `mu_s` i jeden globalnie zorientowany tensor fluxu
`Q`. Nie może otrzymywać równoległych, możliwych do podrobienia tablic `J_c`.

Testy obejmują analityczny profil `she_1d_film_v1`, residual lokalny, bilans
spinu, zbieżność przestrzenną, odwrócenie `J_c` i `theta_SH` oraz porównanie
CPU-reference z CUDA FP64.

### 4.4. Bramka 4 — interfejs HM/FM

Zorientowany interfejs publikuje longitudinal injection/backflow, transverse
absorption i odpowiadające im dwa ślady spinowe. Mixing conductance zachowuje
część rzeczywistą i urojoną bez zamiany normalnej interfejsu.

Testy obejmują granicę transparentną, zerowy mixing, czysto rzeczywisty i
czysto urojony mixing, odwrócenie orientacji oraz niezależny bilans momentu
pędu po obu stronach interfejsu.

### 4.5. Bramka 5 — transportowy SOT/STT

Torque jest liczony z objętościowej reakcji spinu i poprzecznej absorpcji
powierzchniowej, następnie mapowany wyłącznie na wskazany ferromagnetyczny
target. Prescribed SOT/STT nie uczestniczy w tym workloadzie.

Testy sprawdzają jednostki RHS LLG, prefaktor, kierunek damping-like i
field-like, odwrócenie prądu, odwrócenie `theta_SH`, target mask oraz zgodność
z niezależnym oraclem algebraicznym i CPU-reference.

### 4.6. Bramka 6 — sprzężenie transportu z LLG

Charge snapshot, spin solve, torque i LLG należą do jednego lifecycle etapu.
Odrzucony krok integratora przywraca magnetyzację, snapshoty pochodne,
telemetrię i liczniki generacji. Zaakceptowany krok publikuje tylko spójny stan.

Testy obejmują stały krok, próbę adaptacyjną, rollback, restart, wszystkie
wspierane integratory jawne oraz zakaz host round-trip w gorącej pętli CUDA.

### 4.7. Bramka 7 — przygotowanie skyrmionu

Racetrack inicjalizuje kanoniczny skyrmion Néela, a następnie relaksuje go bez
prądu i bez transportowego torque. Artefakt stanu równowagi zapisuje pełne `m`,
energię, ładunek topologiczny, środek, promień oraz kryterium stopu.

Stabilność wymaga zachowania znaku i wartości ładunku topologicznego w
zadeklarowanej tolerancji, braku dryfu środka oraz zbieżności energii i promienia
na co najmniej trzech siatkach.

### 4.8. Bramka 8 — dynamika racetracku

Zaakceptowany stan równowagi jest pobudzany rozwiązanym prądem. Publikowana jest
pełna trajektoria `m(t)`, `J_c(t)`, `mu_s(t)`, `Q(t)`, torque oraz pozycja
skyrmionu dla dodatniego i ujemnego prądu oraz co najmniej trzech amplitud.

Test odrzuca anihilację skyrmionu, niekontrolowaną interakcję z krawędzią,
utratę bilansu transportu i nieciągłość stanu na granicach kroków.

### 4.9. Bramka 9 — pomiar kąta Halla

Środek skyrmionu jest wyznaczany z wersjonowanego momentu gęstości ładunku
topologicznego, z jawną obsługą krawędzi. Odcinek transientu jest odrzucany
według kryterium stabilizacji prędkości, a nie ręcznie wybranej liczby ramek.

Na zaakceptowanym oknie wykonywana jest ważona regresja pozycji. Kąt ma
definicję

```math
\Theta_H=\operatorname{atan2}(v_\perp,v_\parallel).
```

Artefakt publikuje `v_parallel`, `v_perp`, `Theta_H`, przedział regresji,
niepewność, residua dopasowania, znak średniego prądu oraz wersję algorytmu.
Testy obejmują syntetyczne trajektorie, odwrócenie osi i prądu, szum pomiarowy,
brak ruchu oraz zbliżenie do krawędzi.

### 4.10. Bramka 10 — porównanie z MuMax3

MuMax3 nie jest oraclem solved-current ani spin accumulation. Porównanie jest
podzielone na dwie jawne części:

1. Fullmag transport jest walidowany przez rozwiązania analityczne,
   CPU-reference, bilanse i zbieżność dla `V`, `J_c`, `mu_s`, `Q` i torque.
2. Zaakceptowany Gilbert-source torque `T_tr_G` Fullmag w `s^-1` jest
   eksportowany jako wersjonowane pole wejściowe `B_eq` w `T`. Dla kanonicznego
   jawnego równania Gilberta obowiązuje dokładnie
   `B_eq = (m × T_tr_G) / gamma_e`; exporter odrzuca nietangentne `T_tr_G`, a
   nie wykonuje ukrytej projekcji. Manifest rozdziela digest źródłowego
   `T_tr_G` od digestu wstrzykniętego `B_eq`, zapisuje `alpha`,
   `gamma_rad_s_T`, konwencję Gilberta oraz zasadę
   `frozen_from_accepted_fullmag_snapshot`. Fullmag i MuMax3 otrzymują
   identyczną geometrię magnetyczną, siatkę, stan początkowy, exchange,
   anisotropy, DMI, demag policy, integrator, krok czasu oraz to samo,
   zamrożone pole `B_eq`.

Porównywane są pełne pola `m(t)`, energia, `Q(t)`, położenie, `v_parallel`,
`v_perp` i `Theta_H`. Osobno raportuje się literalną konfigurację MuMax3 oraz
zbieżniejszą konfigurację demag, aby błąd kernela referencyjnego nie był
przypisany transportowi Fullmag. Kadencja jest częścią tożsamości: fixed-step
Heun, `dt`, czas trwania, zapis początkowego stanu i digest rzeczywistej tabeli
MuMax3 muszą być zgodne z manifestem. Czasowy `TableAutoSave`/`AutoSave(m)` jest
akceptowalny tylko wtedy, gdy zapisane czasy przechodzą dokładny gate kadencji;
checkout `external_solvers/3` może przekroczyć alarm o jeden krok, dlatego
fixture produkcyjny używa jawnego `Steps(n)` + `TableSave()` + `Save(m)`.
Zgodność tej bramki nie promuje
MuMax3 do orakla transportu i nie pozwala zastąpić solved-current prescribed
torque.

#### Świeży wynik wspólnego limitu — aktualny (2026-08-14)

Wykonano rzeczywiste, zarządzane przebiegi Fullmag FDM/CUDA FP64 oraz MuMax3
3.12 dla tego samego zamrożonego artefaktu `B_eq`, z identyczną siatką
`256×64×1`, literalną polityką demag, solverem Heun i początkowym OVF.
Wersja zbieżna używa `dt=5e-14 s`, próbkowania co `5e-12 s` i horyzontu
`10 ps`, czyli trzech wspólnych ramek (`t=0,5,10 ps`).

Ścieżka CUDA rozróżnia zamrożony profil pola od czasowo skalowanego profilu
Oersteda. Operator DMI ma naturalne warunki brzegowe zgodne ze stencilami
MuMax oraz odpowiadającą korektę wymiany na brakujących sąsiadach. Są to
korekty wspólnego limitu; nie implementują dynamicznego solved-current.

Comparator v2 zakończył się `pass` przy niezmienionych, ścisłych progach:

| metryka | wynik | próg |
|---|---:|---:|
| `m_rms` | `7.8449561e-5` | `< 2e-3` |
| względna energia | `4.8360286e-4` | `< 5e-3` |
| różnica `Q` | `2.4518281e-2` | `< 5e-2` |
| różnica środka | `3.1422347e-13 m` | `< 2e-9 m` |
| różnica prędkości | `1.7389425e-2 m/s` | `< 5 m/s` |
| różnica `Theta_H` | `3.1715904e-3 rad` | `< 5e-2 rad` |

Wspólny-limit używa środka skyrmionu zgodnego z `ext_bubblepos` MuMax3:
wagowania `(m_z+1)/2` oraz transformacji z układu mesh-centered do układu
Fullmag z początkiem siatki. Jest to jawnie zapisane w manifeście. Produkcyjny
obserwabl kąta Halla pozostaje oparty na podpisanym centroidzie gęstości
topologicznej i oknie ruchu ustalonego. Prędkość oraz `Theta_H` z trzech ramek
są więc dowodem parytety common-limit, a nie jeszcze artefaktem produkcyjnego
Hall-angle.

Artefakty wersji przechodzącej znajdują się w
`/zfn2/mateuszz/git/fullmag/reports/racetrack-current-cli-111e265-20260813-2336/common_limit/corrected_gamma_20260814/`:
`fullmag-input-dt5e-14.json`, `mumax-input-dt5e-14-actual.json`,
`common_limit_dt5e-14_runtime.mx3` oraz
`racetrack_mumax_common_limit_10ps_dt5e-14_actual.json`. Manifest MuMax ma
digest `3ee32bc9b79d053260c000d67b0a350cf94829eb8f117ac17698f4a6b9cf6c2c`,
czyli digest rzeczywistego skryptu użytego w przebiegu, a nie starszego fixture.
Niezależny recheck comparatora po ujednoliceniu fixture pozostawił ten sam
wynik `pass` w
`.../corrected_gamma_20260814/recheck/comparison.json`; jest to wyłącznie
potwierdzenie wspólnego limitu z zamrożonym `B_eq`.
Przebieg `dt=1e-13 s` pozostaje diagnostycznie wrażliwy i nie jest referencją
kwalifikacyjną.

Ten wynik zamyka wyłącznie bramkę wspólnego limitu dla krótkiego, zamrożonego
źródła pola. Nadal nie zamyka etapu 1: brakuje runtime'owego sześciu-drive
solved-current, długiej trajektorii (co najmniej 21 ramek i okna ruchu
ustalonego), producenta artefaktu Hall z rzeczywistego `m(t)`, CPU/FEM
common-limit, checkpoint/restart i pełnego manifestu bramek 2, 6, 8–12.
Pełny status pozostaje `bounded executable + common-limit pass`, a nie
`production-qualified`.

#### Świeży smoke solved-current — wykonywalność ścieżki (2026-08-14)

Po zamknięciu common-limit uruchomiono również krótki stage-first workload na
zarządzanym kontenerze `fem-gpu`, z natywnym FDM/CUDA FP64 i bez fallbacku. Smoke
ustawiał `RELAX_MAX_STEPS=5`, trzy niezależne napędy
`J_x\in\{-0.5,+0.5,+1.0\}\times10^{12}\,\mathrm{A/m^2}` oraz
`DRIVE_DURATION=1\,\mathrm{ps}`. Wszystkie 13 etapów (wyłączenie momentu,
relaksacja, checkpoint, trzy `load_state`, trzy zmiany prądu i trzy przebiegi)
zakończyło się poprawnie; łącznie zaakceptowano 35 kroków LLG.

To jest pierwszy świeży dowód, że produkcyjna ścieżka stage-first wykonuje
rzeczywisty solved charge → direct SHE → steady spin → transport torque → LLG.
W artefaktach etapów `stage_06_flat_run` i `stage_09_flat_run` zapisano przeciwne
znaki prądu i momentu: średni `J_c` wynosił odpowiednio
`-1.6666667e11` oraz `+1.6666667e11\,\mathrm{A/m^2}`, a średni `T_tr,G`
odpowiednio `+1.2137389e8` oraz `-1.2166183e8\,\mathrm{s^{-1}}`.
Świadczy to o zmianie rozwiązania transportowego, a nie o samym przełączeniu
etykiety etapu. Artefakt grafu fizyki ma moduły `charge`, `spin`, `hm_fm` i
`transport_torque` jako aktywne/wykonane; runtime identyfikuje się jako
`cuda_fdm` / `fdm_cuda_transport_m1_v1`.

Artefakty smoke są w
`/zfn2/mateuszz/git/fullmag/reports/racetrack-smoke-20260814-0438/`, a
artefakty pośrednich etapów w
`/zfn2/mateuszz/git/fullmag/.worktrees/fdm-gpu-public-m1-spin/.fullmag/local-live/history/session-1786675079773-28/stages/`.
Producent Halla uruchomiony na tej trajektorii zwrócił poprawnie
`reason_code=insufficient_samples` (3 próbki, wymagane co najmniej 21), więc
nie wygenerował fałszywego kąta. Ten smoke zamyka bramkę „wykonywalność
krótkiego solved-current”, ale nie bramkę dynamiki racetracku ani kwalifikację
produkcyjną: potrzebny jest długi przebieg sześciu prądów, stabilne okno ruchu,
checkpoint/restart oraz pełny manifest 12 bramek.

#### Rozdzielenie roli `StaticFieldMap` od Oersteda — korekta wykonawcza (2026-08-14)

Profil zamrożonego pola `H_ext` ma teraz neutralną ścieżkę wykonawczą. Runner nie
przekazuje go przez legacy `oersted_field_xyz`; po utworzeniu backendu wywołuje
wersjonowany setter profilu statycznego, który alokuje bufor urządzenia na żądanie
i ustawia osobną rolę `has_static_external_field_profile`. Dzięki temu zwykła
symulacja bez modułu Oersteda nie tworzy ani nie aktywuje węzła Oersteda,
`H_OE` pozostaje zerowe, a `H_EXT`/`H_EFF` zawierają właściwy profil.

Świeży zarządzany build CUDA oraz kontrakty `fdm_bulk_dmi_sign_contract` i
`fdm_oersted_cuda_runtime` przeszły 2/2. Test Rust z realną biblioteką CUDA
potwierdził `H_ext=H_eff`, zerowe `H_OE` i maskowanie nieaktywnych komórek
(`1 passed`, 917 odfiltrowanych). Zestaw testów Python racetracku pozostał
zielony (`25 passed`). Korekta usuwa błąd lifecycle/semantyki profilu, ale nie
zamyka bramek solved-current, Hall ani produkcyjnej kwalifikacji etapu 1.

#### Historyczny wynik przed korektą operatora (2026-08-14)

Wykonano rzeczywisty przebieg Fullmag FDM/CUDA FP64 oraz niezależny przebieg
MuMax3 3.12 dla tego samego zamrożonego artefaktu `B_eq`. W czasie tego testu
wykryto i skorygowano błąd jednostek: Fullmagowy parametr
`gamma_0=221100\,\mathrm{m\,A^{-1}\,s^{-1}}` nie może być zapisany jako
MuMaxowe `gamma_e`. Eksporter używa teraz
`gamma_e=1.76085963023\times10^{11}\,\mathrm{rad\,s^{-1}\,T^{-1}}`, zgodnie z
`B_eq=(m\times T_{tr,G})/gamma_e`. Po korekcie zakres pola `B_eq` wynosił
około `2.28--16.535\,\mathrm{mT}`; wcześniejszy artefakt z wartością `221100`
był fizycznie nieważny i nie jest dowodem.

Ścieżka CUDA ma jawne rozróżnienie zamrożonego profilu pola od skalowanego
profilu Oersteda w obliczaniu pola efektywnego i energii. Ta zmiana chroni
wspólny limit przed błędnym przeskalowaniem, ale nie jest implementacją
dynamicznego solved-current i nie stanowi sama w sobie dowodu zgodności.

Wynik porównania 10 ps jest negatywny. Przy normalnych progach comparatora
`m_rms=0.0753331` przekracza `0.002`; zmierzono również względną różnicę
energii `0.558983`, różnicę ładunku topologicznego `0.215505` oraz różne
prędkości i kąty Halla (`Fullmag: v=(-6.30e-10,-4.42e-10)\,\mathrm{m/s}`,
`MuMax3: v=(1.01517,-0.39207)\,\mathrm{m/s}`). Plik diagnostyczny ma status
`pass` wyłącznie dlatego, że użyto progów `1e9` do zebrania metryk; nie jest to
przejście bramki 10. Początkowe pola magnetyzacji były zgodne do około
`1.5e-8` RMS, więc rozbieżność nie może być zakwalifikowana jako zwykły błąd
inicjalizacji.

Artefakty i pełne hashe tego przebiegu znajdują się w
`/zfn2/mateuszz/git/fullmag/reports/racetrack-current-cli-111e265-20260813-2336/common_limit/corrected_gamma_20260814/`.
Pełny przebieg Fullmag zakończył `20000` kroków i zapisał `401` ramek, a
MuMax3 zapisał `401` ramek; oba runtime'y zakończyły się, lecz kwalifikacja
Fullmag pozostaje `not_evaluated`, a porównanie wspólnego limitu `fail`.
Należy najpierw wyjaśnić rozbieżność dynamiki (w szczególności sprzężenie
zamrożonego źródła z LLG, konwencję demag oraz równoważność stanu relaksacji),
zanim bramka 10 może zostać uznana za spełnioną.

Wykonany dodatkowo test diagnostyczny bez DMI zawęża problem, ale go nie
usuwa: po `5\,\mathrm{ps}` RMS pola `m` wyniósł `0.00548197`, a po
`10\,\mathrm{ps}` `0.0419713` (przy tym samym zamrożonym `B_eq`). Nie wolno
więc przypisać całej rozbieżności wyłącznie operatorowi DMI. Jest to test
diagnostyczny poza manifestem kwalifikacyjnym; jego artefakty są w
`.../corrected_gamma_20260814/fullmag_no_dmi_20260814_0107/` oraz
`.../mumax_no_dmi_20260814_0131/`.

Implementacja wspólnego limitu posiada obecnie jawny `StaticFieldMap` w Python
DSL/ProblemIR/plannerze FDM oraz osobne role CPU/CUDA. Jest to wyłącznie
zamrożony artefakt `B_eq` do porównania numerycznego; nie jest to implementacja
dynamicznego transportu ani dowód zgodności solved-current. Aktualny wynik,
świeże bramki i blokery są zapisane w
`docs/raports/2026-07-15_audyt-stt-sot-she-fem-fdm/RACETRACK_ETAP_1_STATUS_2026-08-13.md`.

#### Stage-first probe z runtime evidence — 2026-08-14

Na zarządzanym `fem-gpu` wykonano probe `dt=1e-13 s`, `DRIVE_DURATION=100 ps`,
`OUTPUT_PERIOD=5 ps`, `RELAX_MAX_STEPS=5` dla
$J_x=-0.5,+0.5,+1.0\times10^{12}\,\mathrm{A/m^2}$. Runtime zakończył 13/13
etapów, 3005 kroków, z `execution_engine=cuda_fdm`, FP64, strict i bez
fallbacku. Artefakt Halla z każdego ukończonego przebiegu ma 21 próbek i
stabilne $Q\approx-1$, ale przesunięcia środka `1.52 nm`, `1.52 nm` i
`3.04 nm` pozostają poniżej bramki `4 nm`; wszystkie trzy wyniki mają
`reason_code=no_motion`. Nie jest to jeszcze kąt Halla ani dowód dynamiki
racetracku.

Dodany kolektor `scripts/collect_fdm_gpu_racetrack_evidence.py` rozdziela
`session_root` (live history/checkpoint) od `artifact_root` (finalny flat-run),
materializuje analizę z `fields/m.zarr` i pozostaje słabszy od 12-gate
validatora. Trwałe, fail-closed evidence znajduje się w
`/mnt/fullmag-zfn2-native-2/racetrack-build-111e265-static-field-map-v4/probe-100ps-3drive-20260814/evidence/`;
status to `blocked` z brakującymi trzema amplitudami, niewystarczającym ruchem
i niepełnym save/load dla sześciu napędów. Ten zapis powstał przed poprawką
mapowania ścieżek checkpointów; nowszy snapshot 300-ps ma osobno potwierdzony
istniejący payload save/load.

Producent Halla interpretuje znak zgodnie z kontraktem fizycznym
`terminal_x_plus=+J_x`; test regresyjny odrzuca wcześniejsze sztuczne
odwrócenie znaku. Pełny skupiony zestaw testów implementacji, walidatora,
porównania MuMax i scenariusza publicznego przechodzi `49 passed, 6 subtests
passed`. Zmiana nie awansuje capability i nie zamyka etapu 1.

#### Przedłużony probe jednego napędu — 300 ps

Probe z `DRIVE_DURATION=300 ps` i 21 próbkami co `15 ps` ukończył napęd
`J_x=-0.5\times10^{12}\,\mathrm{A/m^2}` (`3005` kroków). Otrzymano
$Q\in[-0.999999996,-0.999999371]$, `dx=-0.912 nm`, `dy=-2.478 nm` i
przemieszczenie netto `2.64 nm`. Producent Halla zwrócił
`reason_code=no_motion`, ponieważ bramka wymaga `4 nm`; nie powstał liczbowy
kąt Halla. Pozostałe napędy przerwano po zapisaniu tego pierwszego artefaktu,
więc probe jest diagnostyczny i nie zastępuje sześciu przebiegów produkcyjnych.

Po poprawce mapowania ścieżek checkpointów kolektor potwierdził dla tego
samego artefaktu `save_count=1` i `load_count=2`, z istniejącym plikiem
`states/relaxed_zero_current.json`. Zaktualizowana kopia dowodu znajduje się
w `/mnt/fullmag-zfn2-native-2/racetrack-build-111e265-static-field-map-v4/
probe-300ps-3drive-20260814/evidence-stage06-v2/`; status nadal pozostaje
`blocked` z powodu brakujących napędów i `no_motion`.

#### Stabilność i koszt profilu czasowego

Dodatkowe próby nie zmieniły kontraktu produkcyjnego. Referencyjny RK4 z
`dt=1e-13 s` pozostawał stabilny przez co najmniej `40.5 ps`, ale pełny
sześcioprądowy przebieg ma obecnie wielogodzinny koszt. Próby przyspieszenia
integratorem Heuna odrzucono: `dt=5e-13 s` rozbiegał się już w relaksacji
(`max_torque≈33.65 T`), `dt=2e-13 s` osiągał około `53 T` podczas napędu, a
`dt=1e-13 s` około `18.7 T` po około 105 krokach. Są to profile diagnostyczne,
nie alternatywne ustawienia kwalifikacyjne.

Diagnostyczny przebieg RK4 na `1 ns` dla sześciu napędów przerwano po około
`30.5 ps`, gdy oszacowany czas wykonania wynosił wiele godzin. Zatrzymanie było
kontrolą kosztu, nie dowodem niestabilności GPU. Nie wolno używać częściowego
przebiegu do wyznaczania kąta Halla.

Solver musi nadal rozwiązywać sprzężony transport dla aktualnego `m` przy
każdym stadium RHS LLG; cache'owanie torque między stadiami zmieniłoby fizykę.
Aktualna blokada wynika więc jednocześnie z braku wystarczającego okna ruchu w
dotychczasowych probe'ach i z kosztu jedynego stabilnego profilu referencyjnego.
Nie obniża to progów ani nie awansuje capability.

#### Probe wysokich prądów

W managed CUDA FP64 uruchomiono trzy diagnostyczne przebiegi RK4 o długości
`100 ps` dla `+1.5`, `+1.6` i `+1.7e12 A/m²`. Wszystkie zakończyły się bez
fallbacku, z 1000 kroków napędu i 21 próbkami. Otrzymano odpowiednio
przemieszczenia netto `4.574 nm`, `4.881 nm` i `5.190 nm`, przy stabilnym
$Q$ około `-1`. Producent Halla zwrócił jednak dla wszystkich
`reason_code=no_stationary_window`: długość ruchu przekroczyła próg, lecz w
100-ps oknie nie ma jeszcze ustalonego przedziału szybkości i kierunku.

Nie jest to kąt Halla równy zero i nie wolno go zastępować liczbą. Jest to
poprawne odrzucenie fail-closed. Amplitudy `+1.6` i `+1.7e12 A/m²` są wyłącznie
diagnostyczne; nie zastępują normatywnego zestawu `±0.5`, `±1.0`, `±1.5e12`.
Trwałe evidence zapisano pod
`/mnt/fullmag-zfn2-native-2/racetrack-build-111e265-static-field-map-v4/
probe-100ps-rk4-high3-20260814/evidence/`.
Kolektor umieszcza te przebiegi w `diagnostic_drives` i oznacza je reason codes
`unexpected_drive_plus_1_6` oraz `unexpected_drive_plus_1_7`; nie są one
zaliczane do normatywnego sześcioprądowego workloadu.

#### Kontrola kierunku torque

Po wyrównaniu próbek `m(t)` i `torque_stt` w układzie cell-major względne
`max |m·T_tr,G|/max(|T_tr,G|,1)` wyniosło `2.99e-15`, `3.03e-15` i `3.66e-15`
odpowiednio dla `+1.5`, `+1.6` i `+1.7e12 A/m²`. Zapisany torque jest zatem
numerycznie styczny i ma jednostkę `s^-1`; pozorne wartości równoległe wynikają
z błędnego odczytu component-major, a nie z solvera. Kontrola nie awansuje
kwalifikacji, ale wyklucza błędną interpretację artefaktu torque jako przyczyny
braku ustalonego okna Halla.

### 4.11. Bramka 11 — pełny kontrakt produktu

Python DSL i Control Room round-tripują każdy parametr fixture bez raw-JSON
obejścia. Brak modułu transportu oznacza brak węzłów charge/spin/torque w
`ProblemIR` i Explorer; zerowy prąd nie decyduje o obecności modułu.

Planner, runtime, OpenAPI, zasoby v2, Inspector, viewport, quantity catalog i
eksport skryptu używają jednego słownika capability. Użytkownik może utworzyć,
uruchomić, obserwować i odtworzyć workload w obu powierzchniach authoringu.

### 4.12. Bramka 12 — kwalifikacja produkcyjna

Końcowy gate uruchamia wersjonowany publiczny scenariusz na zarządzanym
runtime CUDA z zapisaną tożsamością GPU, sterownika, runtime, build digest i
source commit. Obejmuje pełny restart/checkpoint, deterministyczne powtórzenie,
budżet pamięci wyliczony z deskryptora i wolnej pamięci, pomiar wydajności oraz
kontrolę braku niejawnego fallbacku i transferów host-device w gorącej pętli.

Macierz capability otrzymuje awans wyłącznie dla dokładnego tuple i workloadu,
które przeszły wszystkie bramki. Inne siatki, materiały, FP32, PBC, transient
spin, Oersted, FEM i MTJ pozostają niekwalifikowane.

### 4.13. Launcher i assembler dowodów (2026-08-14)

Receptura produkcyjna ma teraz rozdzielone dwie odpowiedzialności:

- `scripts/run_fdm_gpu_racetrack_qualification.py` uruchamia publiczny scenariusz
  w zarządzanym kontenerze i zamraża dokładnie sześć prądów
  `-1.5,-1.0,-0.5,+0.5,+1.0,+1.5e12 A/m²`, czas `2 ns`, krok `1e-13 s`,
  próbkowanie `5 ps` oraz relaksację z fixture. Konflikt odziedziczonej zmiennej
  środowiskowej kończy wykonanie, zamiast ją nadpisywać. Launcher zapisuje log,
  identyfikację GPU/CUDA/build oraz wynik kolektora; nie tworzy twierdzeń o
  kwalifikacji.
- `scripts/assemble_fdm_gpu_racetrack_qualification.py` sprawdza 12 osobnych
  artefaktów `gates/*.json`, zgodność ich `source_identity` i `runtime_identity`,
  audyt fallbacków/transferów oraz niezmienność hashy wejściowych. Niepełny lub
  niespójny zestaw zapisuje wyłącznie
  `fdm_gpu_solved_current_racetrack_qualification_summary.v1.json` ze statusem
  `blocked`; manifest `...qualification_v1.json` jest publikowany atomowo tylko
  przy pełnym `pass`.

Receptura nie zakłada już nieistniejącego mountu jako jedynej ścieżki: honoruje
`FULLMAG_MANAGED_NATIVE_ROOT`, a bez niego wybiera zapisywalny
`/mnt/fullmag-zfn2-native-2` przed starszym aliasem `/mnt/fullmag-zfn2-native`.

Launcher zamraża również `FULLMAG_ARTIFACT_FIELD_STORAGE=zarr`. Dotyczy to
wyłącznie tego workloadu i jest zapisane w `workload-run.v1.json`; zwykłe
uruchomienia zachowują kompatybilny domyślny JSON. Zarr v2 zapisuje regularne
transportowe snapshoty jako niekompresowane `f64`, w układzie
`[component, cell]`, z `samples.csv`, `.zarray`, `.zattrs` i jednoznacznym
`field-storage.v1.json`. Nie zmienia to wartości, kolejności próbek, jednostek
ani proweniencji; usuwa jedynie koszt formatowania wielkich tablic JSON.
Kolektor akceptuje binarny Zarr oraz starszy katalog JSON, przy czym Zarr jest
preferowany dla świeżej kwalifikacji.

Ta infrastruktura usuwa wcześniejszą lukę „build + validator bez workloadu”, ale
nie dostarcza brakujących niezależnych bramek fizycznych. Do czasu pełnego,
świeżego przebiegu sześciu napędów oraz zasilenia wszystkich 12 artefaktów etap
pozostaje `blocked` i capability nie jest promowane.

#### Adapter dowodów bramek — 2026-08-14

Recipe wywołuje teraz również
`scripts/produce_fdm_gpu_racetrack_gate_evidence.py`. Jest to wyłącznie adapter
dowodów, a nie generator twierdzeń fizycznych. Dla każdej z 12 bramek oczekuje
wersjonowanego `proofs/<gate>.json` o schemacie
`fdm_gpu_racetrack_gate_proof.v1`, poprawnych `claims` przechodzących ten sam
walidator co manifest oraz co najmniej jednej istniejącej ścieżki artefaktu
wewnątrz wspólnego evidence root. Producent stempluje dowód aktualnymi
`source_identity` i `runtime_identity`; obce tożsamości, ścieżki wychodzące poza
root, brak pliku lub niepoprawne twierdzenie kończą się artefaktem bramki
`status=blocked` z reason code, nigdy syntetycznym `pass`.

Podsumowanie producenta jest zapisywane jako
`fdm_gpu_racetrack_gate_evidence_summary.v1.json`, a assembler zachowuje
reason codes z zablokowanych artefaktów w
`fdm_gpu_solved_current_racetrack_qualification_summary.v1.json`. Dzięki temu
brak niezależnego orakla (charge, SHE, interfejs, torque, lifecycle, stabilność,
MuMax lub runtime) jest widoczny jako konkretny blocker, zamiast wyglądać jak
brakujący plik infrastruktury. Sam adapter nie awansuje żadnej capability i nie
zmienia definicji 12 bramek.

Fixture `tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json` jest
również przekazywany do `capture_source_snapshot_identity.py` jako jawny
`qualification_input`. Jego stabilny hash trafia do source snapshotu i musi
zgadzać się z hashem użytym przez assembler. Zmiana fixture pomiędzy startem
workloadu a publikacją summary kończy się
`source_snapshot_qualification_input_mismatch`, zamiast mieszać artefakty dwóch
wersji kontraktu.

Receptura zapisuje także surowe wyniki zarządzanych kontraktów w
`contracts/` przez `scripts/collect_fdm_gpu_racetrack_contract_artifacts.py`.
Kolektor kopiuje pliki atomowo, zapisuje ich SHA-256 i jawnie oznacza brakujące
źródła jako `blocked`. Nie tworzy `proofs/*.json`, nie interpretuje markerów
logu i nie może samodzielnie awansować żadnej bramki. Dzięki temu diagnostyczne
wyniki charge/SHE/sparse i runtime są dostępne w tym samym evidence-root, ale
assembler nadal wymaga niezależnych, merytorycznych dowodów każdej z 12 bramek.
Każdy proof musi dodatkowo zawierać pełne `source_identity` i
`runtime_identity` zgodne z bieżącym snapshotem; brak tych pól jest blokadą,
aby nie dało się ponownie użyć proofu z innego przebiegu przez samo
przestemplowanie go aktualnym runtime.
Ścieżki dowodów proofu muszą wskazywać na surowe artefakty poza katalogami
`proofs/` i `gates/`; sam proof albo wcześniejszy gate nie może być własnym
dowodem. Assembler i końcowy validator wymuszają dodatkowo obecność tego
proof-of-record,
zgodność jego claims oraz obu tożsamości z artefaktem `gates/<gate>.json` i
istnienie wskazanych surowych plików; bez tego manifest nie może przejść.

## 5. Warunki fail-closed

Wykonanie kończy się przed publikacją zaakceptowanego stanu, gdy:

- graf transportu, BC, gauge, target albo orientacja interfejsu są niepełne;
- snapshot charge jest obcy, niezaakceptowany, nieaktualny lub ma inną rewizję;
- wymagane pole, operator albo capability nie istnieją dla wymuszonego tuple;
- solver próbuje użyć CPU, FP32 albo prescribed torque jako fallbacku;
- residual, bilans elektrod, bilans spinu lub bilans momentu pędu przekracza
  normatywną tolerancję;
- krok LLG jest odrzucony, a pełny wspólny stan nie został przywrócony;
- skyrmion zanika, opuszcza ważne okno pomiarowe albo algorytm kąta Halla nie
  ma wystarczającego odcinka ruchu ustalonego;
- requested intent, resolved execution i artefakty mają niespójne rewizje.

Nie publikuje się częściowych pól jako zaakceptowanego wyniku naukowego.

## 6. Definicja produkcyjnego ukończenia

Etap 1 jest zamknięty tylko wtedy, gdy:

- wszystkie dwanaście bramek mają świeże, wersjonowane artefakty `pass`;
- publiczny workload działa od Python/UI do zarządzanego CUDA FP64 runtime;
- solved-current, SHE, spin accumulation i torque mają niezależne orakle oraz
  badania zbieżności;
- LLG, trajektoria i kąt Halla przechodzą wspólny-limit comparison z MuMax3;
- CPU-reference i CUDA FP64 są zgodne w zadeklarowanych tolerancjach;
- nie ma ukrytego fallbacku, prescribed torque ani utraty round-trip;
- checkpoint/restart zachowuje tożsamość źródła i wynik w deklarowanym trybie;
- capability matrix promuje wyłącznie dokładnie zakwalifikowany workload;
- plan główny i dokumentacja fizyki zawierają źródła, jednostki, ograniczenia,
  dowody oraz uczciwy zakres kwalifikacji.

Dopiero po spełnieniu tej definicji wolno rozpocząć projekt etapu 2 — pola
Oersteda.

#### Rerun managed workloadu — korekta dynamicznego loadera (2026-08-14)

Pierwszy start exact workloadu zakończył się przed solverem kodem `127`,
ponieważ CLI nie miało `libfullmag_fdm.so.0` w ścieżce dynamicznego loadera.
Launcher wymaga teraz katalogu `native/backends/fdm` z przekazanego
`--build-root` i prependsuje go do `LD_LIBRARY_PATH`; brak katalogu jest
odrzucany jawnie. Test regresyjny obejmuje zarówno brak biblioteki, jak i
zachowanie istniejącej ścieżki. Managed rerun ponownie przeszedł wszystkie
wcześniejsze kontrakty GPU i uruchomił rzeczywisty publiczny CLI w tuple
`fdm/gpu/double/strict`. W chwili tego zapisu pierwszy z sześciu napędów nadal
liczy się na GPU i zapisuje chunki Zarr; nie powstał jeszcze wynik końcowy,
12-gate manifest ani liczbowy kąt Halla. Ten snapshot jest obserwacją
wykonania, a nie awansem kwalifikacji.

#### Telemetria transferów GPU

W tym kontrakcie „brak transferów host-device w gorącej pętli” oznacza brak
transferu pełnego stanu magnetycznego lub nieznanego bufora. Solver może
jawnie raportować dwa ograniczone wyjątki: `CONTROL_STATE_H2D` (sterowanie
iteracją, maksymalnie 4096 B na rekord) oraz `SCALAR_REDUCTION_D2H` (redukcja
skalarna, maksymalnie 4096 B na rekord). Oba wyjątki muszą mieć dodatni
`count`, status sukcesu i są agregowane jako
`allowed_control_h2d_*`/`allowed_scalar_d2h_*`; nie zerują ani nie ukrywają
licznika transferów zabronionych. Każdy inny H2D/D2H, rekord niepoprawny lub
przekroczenie limitu blokuje dowód.

#### Bieżący stan starego workloadu

Managed proces rozpoczęty przed zmianą telemetryki ukończył pierwszy napęd
(`stage_06_flat_run`, 401 próbek) i rozpoczął drugi (`stage_09_flat_run`). Jest
to wyłącznie obserwacja postępu; nie może zasilić manifestu aktualnego buildu.
