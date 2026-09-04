# ALL IN GPU FEM runtime contract

Data: 2026-05-15; korekta statusu direct minimizers: 2026-09-04

Ten dokument definiuje kontrakt wykonawczy dla migracji time-domain FEM na
GPU. Jest uzupelnieniem dokumentow fizyki FEM/MFEM GPU i planu
`docs/plans/active/all-in-gpu-fem-rollout-plan-2026-05-15.md`.

(all-in-gpu-fem-problem-statement)=
## Znaczenie ALL IN GPU

`ALL IN GPU FEM` oznacza, ze device jest zrodlem prawdy dla hot loopu
integratora. W szczegolnosci na device musza pozostac:

- `m`, `H_ex`, `H_demag`, `H_eff` i lokalne skladowe pola,
- bufory stage/RHS/error dla RK,
- redukcje skalarnych metryk, energii i norm,
- workspace Poissona i odzysku gradientu demag,
- maski, wspolczynniki materialowe i projekcje periodyczne wymagane w RHS.

CPU pozostaje odpowiedzialny za orchestration, kontrolny event loop,
meshing, I/O, snapshot scheduling i male pakiety telemetryczne. CPU nie moze
byc elementem obliczeniowym w kazdym RHS/stage.

(all-in-gpu-fem-governing-equations)=
## Kontrakt hot-loop

Dla zaakceptowanego strict GPU hot-loop obowiazuje budzet

```{math}
:label: all-in-gpu-fem-hot-loop-budget
N_{\mathrm{H2D}}^{\mathrm{hot}}
=N_{\mathrm{D2H}}^{\mathrm{hot}}
=N_{\mathrm{sync}}^{\mathrm{hot}}=0.
```

(all-in-gpu-fem-symbols-and-si-units)=

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $N_{\mathrm{H2D}}^{\mathrm{hot}}$ | liczba transferow H2D w hot-loop | $1$ |
| $N_{\mathrm{D2H}}^{\mathrm{hot}}$ | liczba transferow D2H w hot-loop | $1$ |
| $N_{\mathrm{sync}}^{\mathrm{hot}}$ | liczba synchronizacji hosta w hot-loop | $1$ |

Pola `hot_loop_*_bytes` maja jednostke bajtow, a czasy profilera jednostke
nanosekund.

## Dozwolone transfery

Host/device transfer jest dozwolony tylko w jawnych miejscach:

- inicjalizacja kontekstu,
- zmiana parametrow kontrolnych,
- zaplanowany snapshot lub artefakt,
- maly odczyt skalarny telemetryczny.

Nieplanowany `HostRead`, `HostWrite`, D2H albo H2D w hot loopie jest
regresja. Transfer pola po kazdym kroku nie jest snapshotem, tylko ukrytym
hostowym stepperem.

(all-in-gpu-fem-assumptions-and-validity)=
## Jawne tryby runtime

GPU FEM musi raportowac prawde o tym, czy Poisson demag jest wykonywany na
device, czy przez jawny tryb kompatybilnosci. Od 2026-05-23 publiczne
`study.engine("fem")` + `study.device("gpu", precision="double")` oznacza
strict full-in-GPU dla Poisson demag. Dla takiego runu obowiazuje:

- `fem_execution_mode = all_in_gpu_legacy_sparse`,
- `fem_data_residency = device_source_of_truth` po inicjalizacji device,
- `fem_assembly_mode = legacy_sparse`,
- `uses_cuda_kernels = true`,
- `uses_gpu_poisson = true`,
- `fem_demag_operator_mode = device_hypre_poisson`,
- `hypre_execution_policy = device`,
- `demag_residency = device`.

`hybrid_legacy_sparse` / `hybrid_cpu_poisson` pozostaje dopuszczalne tylko jako
jawnie wybrany compatibility/debug mode, np. przez backendowy hint albo zmienna
`FULLMAG_FEM_GPU_DEMAG_MODE=hybrid_cpu_poisson`. Taki tryb nie jest strict GPU
i musi raportowac `uses_gpu_poisson=false`,
`hypre_execution_policy=host` oraz `demag_residency=host_device_roundtrip`.

Te pola nie sa kosmetyka. Sa bramka anty-regresyjna dla runnera, artefaktow i
benchmarkow. Dopiero gdy `TransferAudit` oraz profiler potwierdza brak
hot-loop host sync, runtime moze przejsc na:

- `all_in_gpu_legacy_sparse`, albo
- `all_in_gpu_partial_assembly`.

(all-in-gpu-fem-python-api)=
## Python API

Publiczny skrypt wyraza fizyczny problem i jawne zadanie FEM GPU, a nie
wewnetrzne liczniki residency:

```python
# %%
import fullmag as fm

study = fm.study("all_in_gpu_fem")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")

# %%
film = study.geometry(
    fm.Box(size=(80e-9, 40e-9, 8e-9), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange(enabled=True)
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    max_steps=1,
)
```

(all-in-gpu-fem-problem-ir)=
## ProblemIR i planner

ProblemIR zachowuje engine, device, precision, mode, fizyke i stage. Pola
residency, transfer audit oraz resolved operator modes sa wynikiem planowania i
wykonania, nie dodatkowymi parametrami fizycznymi.

(all-in-gpu-fem-round-trip-and-failure-semantics)=
## Round-trip i failure semantics

Requested intent zachowuje jawne zadanie strict FEM GPU. Resolved execution
publikuje faktyczny tryb operatorow i residency. Validation errors oraz
unsupported combinations koncza run przed lub przy pierwszym naruszeniu;
brak GPU, nieobslugiwany operator i transfer hot-loop nie moga uruchomic
ukrytego CPU fallbacku.

(all-in-gpu-fem-discrete-realization)=
## Kolejnosc Fullmag/HYPRE bez globalnej bariery

Strict GPU Poisson uzywa dwoch jawnych strumieni. Fullmag zapisuje zdarzenie
gotowosci na swoim compute streamie, a
`hypre_HandleComputeStream(hypre_handle())` czeka na to zdarzenie. Po `Mult`
zdarzenie HYPRE-done jest zapisywane na dokladnie tym strumieniu HYPRE, po czym
compute stream Fullmag czeka przed recovery i redukcja energii. A
device-wide compatibility barrier is not strict GPU. `cudaDeviceSynchronize` moze istniec
jedynie w jawnym trybie compatibility/debug i musi obnizyc provenance z trybu
strict; nie jest dopuszczalnym ukrytym fallbackiem.

(all-in-gpu-fem-implementation-mapping)=
## TransferAudit

Natywny backend publikuje `fullmag_fem_transfer_audit` w C ABI. Liczniki
rozrozniaja calkowite transfery oraz transfery w hot loopie:

- `hot_loop_h2d_bytes`,
- `hot_loop_d2h_bytes`,
- `hot_loop_host_read_count`,
- `hot_loop_host_write_count`,
- `hot_loop_host_sync_count`,
- `hot_loop_exchange_h2d_bytes`,
- `hot_loop_exchange_d2h_bytes`,
- `hot_loop_exchange_host_sync_count`,
- `hot_loop_compute_h2d_bytes`,
- `hot_loop_compute_d2h_bytes`,
- `hot_loop_compute_host_sync_count`.

Tryb:

```bash
FULLMAG_FEM_ASSERT_NO_HOT_LOOP_HOST_SYNC=1
```

ma przerwac krok, jezeli w sekcji hot loop pojawi sie instrumentowany
`HostRead`, `HostWrite` albo `HostReadWrite`.

W Fazie 2, gdy exchange moze jeszcze uzywac tymczasowego interop przez host,
stosujemy wezszego straznika:

```bash
FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1
```

Ten tryb dopuszcza zdarzenia oznaczone `TransferAuditScope::ExchangeInterop`,
ale przerywa krok dla host sync w RK, LLG, normalize, redukcjach i innych
czesciach compute hot loopu. Benchmark zapisuje odpowiadajaca bramke jako
`phase2_compute_assertion_enabled`, `phase2_compute_hot_loop_sync_clean` oraz
`phase2_gate_reason`. Dla `fem_gpu + exchange_only` benchmark ma uruchamiac
proces z wlaczonym `FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1`, nawet gdy
shell dziedziczy wartosc wylaczajaca ten gate.
`phase2_compute_hot_loop_sync_clean=true` wymaga jednoczesnie
`hot_loop_compute_host_sync_count == 0` oraz
`fem_gpu_rk_stage_exchange_device_resident == true`; samo zero w compute
counterze nie wystarcza, jezeli stage exchange nadal przechodzi przez host.
Jezeli provenance raportuje `fem_gpu_rk_exchange_only_enabled=true` przy
`fem_gpu_rk_stage_exchange_device_resident != true`, benchmark ma oznaczyc to
jako runtime-contract violation, a nie jako czysty lub czesciowo czysty gate.
Gdy `stage_exchange_device_resident=false`, gdy brakuje licznika
`hot_loop_compute_host_sync_count`, albo gdy benchmark wykrywa
`runtime_contract_violation`, `phase2_gate_reason` ma przenosic
`gpu_rk_block_reason`, jezeli provenance go dostarcza, zeby CSV zachowal
konkretny powod blokady bez laczenia z dodatkowymi artefaktami.
Jezeli sam run konczy sie `status=failed` zanim powstanie phase2 provenance,
CSV ma raportowac `phase2_gate_reason=run_failed_before_phase2_provenance`
zamiast mylic ten przypadek z niekompletnym, ale udanym runem. Kolumna `error`
ma zachowywac poczatek i koniec dlugiego stderr/stdout, zeby koncowy
`fallback_reason` albo natywny powod awarii nie zostal obciety.

Powierzchnia `gpu_rk_device_resident_step` nie moze uzywac
`cudaStreamSynchronize` w hot loopie. Dopuszczalne sa tylko asynchroniczne
walidacje launchy bez odczytu wyniku redukcji na hosta; wartosc redukcji moze
zostac skonsumowana dopiero przez jawnie oznaczona sciezke diagnostyczna albo
output lane poza hot loopem.
Po zaakceptowanym kroku C ABI moze wykonac pojedynczy skalarny D2H dla
`max_dm_dt` poza `TransferAuditScope::HotLoop`. Taki odczyt ma byc
instrumentowany jako zwykly D2H telemetryczny, ale nie moze podbijac
`hot_loop_compute_host_sync_count`.
Pelny readback magnetyzacji jest dozwolony tylko dla jawnego snapshotu albo
kopiowania pola. `context_snapshot_stats_mfem(...)` i
`context_refresh_exchange_field_mfem(...)` musza najpierw zsynchronizowac
device-source `m` do hostowego `ctx.m_xyz`, bo nastepnie uruchamiaja CPU/MFEM
rekalkulacje pol i energii poza hot loopem.
Po zaakceptowaniu kroku GPU RK musi tez odswiezyc device `H_ex/H_eff` dla
zaakceptowanego `m`; pola z predictor stage nie moga zostac opublikowane jako
aktualne pola finalnego stanu.
Metryka `max_dm_dt` musi byc liczona po tym finalnym odswiezeniu, z
zaakceptowanego `m` i finalnego `H_eff`, a nie z ostatniego RHS stage.
W waskim `legacy_sparse_gpu` C ABI ma uzupelniac krokowe metryki na device:
`E_ex`, opcjonalne `E_ext` dla uniform Zeeman, opcjonalne `E_ani` dla
uniaxial/cubic anisotropy, opcjonalne `E_mel` dla uniform prescribed strain,
`E_total`, `max |H_eff|`, `max |m x H_eff|` oraz srednia magnetyzacje
`mx/my/mz`. Odczyty do hosta sa pojedynczymi skalarami po hot loopie; nie
wolno zastepowac tej telemetryki pelnym readbackiem pola. Dopoki inny lokalny
term nie ma odpowiedniej sciezki device-side, musi blokowac GPU RK
exchange-only zamiast produkowac niepelne `StepStats`.
Kazdy nieobslugiwany lokalny term albo torque ma raportowac konkretny powod
blokady, np. DMI, thermal bez jawnego seedu albo brak wymaganych danych device
dla STT, zamiast zbiorczego komunikatu o "local terms".
Po uzupelnieniu tych metryk GPU RK musi uruchamiac te same kryteria
`stage_completion`, ktore CPU stepper uruchamia po kroku, inaczej relax/stop
criteria bylyby omijane przez device-resident sciezke.

Workspace CUB dla redukcji (`scalar_reduce_temp_storage`) jest query'owany i
alokowany podczas inicjalizacji `FemGpuState`. Hot loop RK ma uzywac tego
prealokowanego bufora; nie moze w kroku wywolywac wariantu
`fullmag_cuda_device_max(..., temp_storage=nullptr, ...)`, bo taki call tylko
pyta o rozmiar workspace i nie wykonuje redukcji.

Jezeli inicjalny upload zostawil stan jako `host_source_of_truth`, ale host i
device sa jednoczesnie clean, GPU RK moze promowac taki stan do
`device_source_of_truth` bez transferu. Nie wolno w tym miejscu wywolywac
uploadu AOS ani odtwarzac danych przez CPU.

Plan GPU RK raportuje `fem_gpu_rk_stage_exchange_device_resident`. Pole musi
pozostac `false`, dopoki stage `H_ex` przechodzi przez hostowy fallback
`compute_exchange_for_magnetization(...)`, czyli przez
`copy_host_vector_to_mfem(...)` / `pack_components_to_aos(...)`. Samo istnienie
tej hostowej sciezki nie blokuje waskiego `legacy_sparse_gpu`; warunkiem jest,
zeby plan `gpu_exchange_plan_stage_exchange(...)` potwierdzil device-resident
operator stage exchange, a GPU RK nie wywolywal hostowego fallbacku w stage RHS.
Ten sam kontrakt raportuje `fem_exchange_operator_mode`; plan ma zwracac
`unsupported` dla wariantu runtime, ktory nie spelnia warunkow
`legacy_sparse_gpu` albo przyszlego `partial_assembly_gpu`.
Benchmark nie moze oznaczyc `phase2_compute_hot_loop_sync_clean=true`, jezeli
`fem_exchange_operator_mode` jest `unsupported` albo nieobecny.
Po inicjalizacji MFEM runtime przechwytuje metadane zlozonego legacy sparse
exchange oraz lumped mass i moze przeslac CSR/mass do `FemGpuState`. Waske
`legacy_sparse_gpu` jest prawdziwe tylko wtedy, gdy runtime wykonuje stage
`H_ex` przez device SpMV/scaling na tych danych, bez
`copy_host_vector_to_mfem(...)` ani `pack_components_to_aos(...)`. Obecny
zakres tego trybu to `exchange_only + Heun/RK4/RK23/RK45`, legacy sparse,
lumped mass,
device-resident runtime coefficients (`Ms`, maski, material fields), uniform
albo per-node damping, bez periodic exchange i bez consistent-mass projection;
pozostale warianty musza nadal raportowac `unsupported`.

Aktualizacja implementacyjna 2026-05-15: waski tryb
`legacy_sparse_gpu` ma teraz zrodla dla stage `H_ex` oraz waski
Heun/RK4/RK23/RK45 path na device:
`FemGpuState` przechowuje CSR exchange, mass, odwrotny lumped mass,
wspolczynniki runtime, SoA magnetyzacji oraz device backup `m_backup` wymagany
do przyszlego adaptive reject/retry, a GPU RK uzywa tych buforow do stage RHS.
`gpu/cuda/integrators/rk/rk_step.cu` ma rowniez device-side restore `m_backup -> m`, ktory uniewaznia
FSAL i nie wymaga hostowego readbacku odrzuconej proby.
Kernele CUDA udostepniaja tez `fullmag_cuda_adaptive_error_norm_blocks(...)`
jako prerekwizyt device-side embedded error norm dla RK23/RK45. `gpu/cuda/integrators/rk/rk_step.cu`
ma helper, ktory uruchamia ten kernel, redukuje max scaled error przez
prealokowany workspace CUB i odczytuje pojedynczy skalar telemetryczny. GPU RK
ma tez helper decyzji PI zgodny z CPU semantics dla accept/reject i propozycji
`dt_next`, a `gpu_rk_device_resident_step(...)` ma juz wewnetrzny scaffold petli
retry, ktory liczy blad, podejmuje decyzje PI, przy reject odtwarza
`m_backup -> m` i raportuje `rejected_attempts`. Plan wykonania nie blokuje juz
adaptive RK23/RK45 osobnym powodem, ale ta sciezka nadal wymaga kompilacji `.cu`,
device-resident exchange i realnej walidacji CUDA/MFEM przed uznaniem jej za
zaakceptowana.
Po kroku device pozostaje zrodlem prawdy. Hostowy snapshot magnetyzacji jest
odswiezany tylko przez jawny readback poza `TransferAuditScope::HotLoop` w
sciezce kopii pola `M`. Ten milestone nadal nie obejmuje PBC demag,
Fredkin-Koehler GPU, high-order FEM, zaakceptowanej na CUDA/MFEM adaptive
RK23/RK45 parity/profiler, adaptive FSAL/error reuse, consistent mass ani
partial assembly/libCEED.

Wymuszenie pelnego trybu odbywa sie przez `FULLMAG_FEM_ALL_IN_GPU=1` albo
`FULLMAG_FEM_EXECUTION=all_in_gpu`. Taki request jest fail-fast: runtime nie
moze fallbackowac do CPU ani akceptowac `hybrid_legacy_sparse`. Dopoki
`fem_gpu_rk_exchange_only_enabled` i
`fem_gpu_rk_stage_exchange_device_resident` nie sa jednoczesnie `true`, albo
`fem_exchange_operator_mode` nie jest realnym trybem
`legacy_sparse_gpu` / `partial_assembly_gpu`, albo Poisson demag nie raportuje
`device_hypre_poisson` + `hypre_execution_policy=device`, runner ma zwracac
blad `all_in_gpu_contract_unmet` z `gpu_rk_block_reason`, zeby diagnostyka
pokazywala konkretny brak planu GPU RK.

Strict GPU demag obejmuje na razie P1, double precision, nieperiodyczny
shared-domain airbox Poisson z Dirichlet/Robin. `fe_order > 1`, periodic
demag oraz Fredkin-Koehler FEM/BEM na GPU maja failowac z diagnostyka zamiast
przechodzic w ukryty CPU fallback.

## Status preconditionera direct minimizers

Audyt z 2026-09-04 potwierdza, ze obecna klasa
`GpuExchangeMassPreconditioner` nie realizuje pelnego sparse
$(M+wK)^{-1}M$. Otrzymuje tylko przekatne mass/exchange i stosuje punktowy
czynnik $M_i/(M_i+wK_{ii})$, czyli diagonalna aproksymacje Jacobiego. Setup tej
klasy nie jest wywolywany przez produkcyjny NCG ani PG-BB, a ich warunkowe
call-site'y nie propagują bledu apply. Benchmark nadal odrzuca
`exchange_mass`, poniewaz mapuje go na brak realizacji C++.

Nota 0581 zachowuje osobno historyczny wynik no-go z 2026-07-26 i zatwierdzony
projekt nowej realizacji `diagonal` oraz pelnego sparse
`exchange_mass_cg4|cg8`. Sam projekt nie jest dowodem ALL IN GPU. Dla nowej
realizacji capability, runtime, physics validation, CPU/GPU parity i
performance pozostaja `NOT VERIFIED`; produkcyjny default pozostaje `none`.
Brak setupu, blad sparse/CUDA/fixed-CG albo niezgodnosc identity musza zakonczyc
strict GPU bez diagonalnego ani CPU fallbacku.

(all-in-gpu-fem-validation)=
## Bramka pierwszego kamienia milowego

Pierwszy prawdziwy kamien milowy po zmianie 2026-05-23 to
`exchange + demag + lokalne pola` z Poisson demag na device:

- `fem_data_residency = device_source_of_truth`,
- `fem_exchange_operator_mode = legacy_sparse_gpu`,
- `fem_demag_operator_mode = device_hypre_poisson`,
- `hypre_execution_policy = device`,
- `demag_residency = device`,
- `uses_gpu_poisson = true`,
- `fem_gpu_rk_stage_exchange_device_resident = true`,
- `fem_gpu_rk_exchange_only_enabled = true`,
- `hot_loop_h2d_bytes = 0`,
- `hot_loop_d2h_bytes = 0`,
- `hot_loop_host_sync_count = 0`,
- `hot_loop_compute_h2d_bytes = 0`,
- `hot_loop_compute_d2h_bytes = 0`,
- `hot_loop_compute_host_sync_count = 0`,
- CPU/GPU parity po 1, 10 i 100 krokach,
- GPU wygrywa z CPU powyzej ustalonego progu rozmiaru siatki,
- profiler pokazuje RK/LLG/redukcje/operator exchange oraz demag Poisson w hot
  loopie.

Status lokalny 2026-05-15: czesc zrodlowa milestone'u zostala wdrozona i
sprawdzona przez lokalne bramki bez CUDA: `fem_gpu_rk_plan`,
`fem_gpu_state_info`, `fem_transfer_audit`, statyczne kontrakty Python oraz
testy runnera `fem-gpu` dla `gpu_rk` i `all_in_gpu`. Pelna akceptacja
milestone'u nadal wymaga kompilacji z prawdziwym MFEM+CUDA oraz
parity/transfer/profiler benchmarkow na skonfigurowanym hoscie GPU.
W waskiej sciezce `exchange_only` uniform Zeeman, uniaxial anisotropy, cubic
anisotropy, interfacial/bulk DMI dla linear tetra weak residual, precomputed
Oersted, uniform oraz per-node magnetoelastic prescribed strain,
deterministic thermal field z jawnym seedem, Zhang-Li STT i Slonczewski
STT z jawna albo geometry-derived gruboscia warstwy nie sa juz
osobnymi blockerami GPU
RK: `h_ext`, `h_ani`, `h_cubic_ani`, `h_dmi`, `h_bulk_dmi`, `h_oe`, `h_mel` i `h_therm` sa skladane do `H_eff`
na device, `E_ext`, `E_ani`, `E_dmi` i `E_mel` maja device-side redukcje po `Ms`,
lumped mass, `Ku/Ku2`, `Kc1/Kc2/Kc3`, `H_ext`, `H_ani`, `H_cubic_ani` i
`H_mel`, Slonczewski i Zhang-Li torque sa dodawane do RHS na device, a `E_total`
obejmuje `E_ex + E_ext + E_ani + E_dmi + E_mel`. Spatial/time-dependent Zeeman oraz
pozostale lokalne termy nadal musza failowac jawnie poza all-in GPU.
Benchmark preflight raportuje status adaptive GPU RK przez
`adaptive_gpu_rk_acceptance_ready` oraz
`adaptive_gpu_rk_acceptance_blockers`, a benchmark row/CSV przenosi te pola do
wynikow `fem_gpu`, takze dla `status=missing_binary`; sam preflight wypelnia
te pola rowniez dla `ok_prebuilt` i `invalid_prebuilt`, zeby prebuilt runtime
nie omijal adaptive acceptance gate. Dla brakujacej binarki GPU `exchange_only`
CSV musi tez publikowac `phase2_compute_hot_loop_sync_clean=false` oraz
`phase2_gate_reason=gpu_binary=missing`, a kolumna `error` ma jawnie wskazywac
brak binarki; samo istnienie scaffoldu retry w `gpu/cuda/integrators/rk/rk_step.cu` nie jest rownowazne
akceptacji adaptive GPU RK.
Tryb benchmarku `--require-adaptive-gpu-rk-acceptance` ma przerywac run, jezeli
ten gate nie jest gotowy. Sam preflight mozna uruchomic przez jawny alias
`--preflight` albo dluzsze `--preflight-only`; parser CLI ma wylaczone ukryte
skroty argparse, wiec smoke/CI musi uzywac jawnych nazw flag.

Do tego momentu UI, benchmarki i provenance nie moga nazywac obecnego GPU FEM
pelnym solverem GPU.

(all-in-gpu-fem-limitations)=
## Ograniczenia

Kontrakt nie kwalifikuje automatycznie zadnego operatora ani algorytmu.
Nieobslugiwane PBC, high-order, consistent mass, direct-minimizer
preconditioning oraz inne warianty zachowuja wlasne bramki i statusy.

(all-in-gpu-fem-scientific-bibliography)=
## Bibliografia techniczna

- NVIDIA, *CUDA C++ Programming Guide*,
  [docs.nvidia.com/cuda/cuda-c-programming-guide](https://docs.nvidia.com/cuda/cuda-c-programming-guide/).
- R. D. Falgout and U. M. Yang, "hypre: a Library of High Performance
  Preconditioners", *Computational Science — ICCS 2002*,
  [doi:10.1007/3-540-47789-6_66](https://doi.org/10.1007/3-540-47789-6_66).

(all-in-gpu-fem-source-code-index)=
## Source-code index

| Claim | Path | Symbol | Responsibility | Evidence status |
|---|---|---|---|---|
| Transfer-audit ABI | `native/include/fullmag_fem.h` | `fullmag_fem_backend_get_transfer_audit` | exposes transfer counters to the runner | current source |
| GPU RK plan ABI | `native/include/fullmag_fem.h` | `fullmag_fem_backend_get_gpu_rk_plan_info` | exposes the resolved GPU RK plan | current source |
| Device-resident RK step | `backends/fem/gpu/cuda/integrators/rk/rk_step.cu` | `gpu_rk_device_resident_step` | owns the CUDA RK hot-loop implementation | current source; qualification separate |
| Transfer-audit policy | `backends/fem/gpu/cuda/transfer/transfer_audit.cpp` | `configure_transfer_audit_from_env` | configures fail-closed hot-loop assertions | current source |
| Direct-minimizer resolver | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` | `resolve_gpu_relaxation_preconditioner` | keeps preconditioning on the current `none` default | full sparse `NOT VERIFIED` |
| Direct-minimizer diagonal setup | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` | `GpuExchangeMassPreconditioner::setup` | uploads only mass and exchange diagonals | current source; production setup absent |
| Direct-minimizer pointwise apply | `backends/fem/gpu/cuda/relaxation/gpu_relaxation_preconditioner.cpp` | `GpuExchangeMassPreconditioner::apply_device_component` | applies the diagonal factor independently to x/y/z | current source; not full CSR |
| PG-BB call site | `backends/fem/gpu/cuda/relaxation/pgbb.cpp` | `gpu_relax_compute_current_metrics` | conditionally invokes the current apply without fail-closed status propagation | current source; qualification separate |
| NCG call site | `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` | `gpu_relax_compute_effective_field_energy_gradient_and_direction` | conditionally invokes the current apply without fail-closed status propagation | current source; qualification separate |
| Diagonal-only manufactured fixture | `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp` | `struct ManufacturedSpdMatrix` | diagonal-only fixture; does not distinguish pointwise apply from a full sparse solve | source test fixture; off-diagonal RED belongs to Task 2 |
| Focused preconditioner contract | `backends/fem/tests/gpu_relaxation_preconditioner_contract.cpp` | `main` | exercises the current resolver and diagonal setup/apply; no sparse negative control | source test entry point; full sparse solve not proved |
