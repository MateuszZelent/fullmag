# Kwalifikacja FDM GPU solved-current racetrack

Stan: mechanizm kwalifikacji jest zaimplementowany, ale `racetrack_m1_v1` nie
jest produkcyjnie zakwalifikowany. Nie ma świeżego manifestu zarządzanego CUDA,
więc ten dokument nie promuje capability.

## Dokładny zakres

Jedyny kandydat do przyszłej promocji to
`backend=fdm, device=gpu, precision=double, mode=strict,
workload=racetrack_m1_v1`. Zakres nie obejmuje FP32, CPU jako zastępstwa GPU,
FEM, M2/M3, PBC, Oersteda, MTJ, temperatury ani multi-GPU. MuMax3 porównuje
wyłącznie wspólny limit magnetodynamiczny z identycznym polem torque; nie jest
oraclem solved-current ani spin accumulation.

## Recepta i manifest

```bash
just verify-fdm-gpu-solved-current-racetrack-production
```

Recepta buduje i uruchamia kontrakty FDM/CUDA oraz CLI w zarządzanym
kontenerze, a następnie waliduje manifest:

```text
/zfn2/mateuszz/git/fullmag/reports/fdm-gpu-racetrack/
  fdm_gpu_solved_current_racetrack_qualification_v1.json
```

Manifest jest atomowym indeksem dokładnie 12 artefaktów. Każdy musi zawierać
`status=pass`, source commit, snapshot/digest źródła i wejść oraz tę samą
tożsamość runtime: GPU UUID, driver/runtime CUDA, build digest i wolną pamięć.
Walidator odrzuca niezgodne tożsamości i snapshoty. Dane producenta używają
`.tmp`; summary nie powstaje przed walidacją kompletnego zestawu.

## Bramy fail-closed

1. `workload_signs_units`: fixture, znaki, jednostki i tuple.
2. `solved_charge`: analityka, CPU oracle, CUDA parity, bilans, zbieżność.
3. `direct_she_steady_spin`: analityka, CPU/CUDA, bilans, zbieżność.
4. `hm_fm_interface`: transparentny, zero, real/imaginary mixing, orientacja.
5. `transport_torque`: oracle, maska FM, device RHS; prescribed torque zakazany.
6. `transport_llg_lifecycle`: RK, rollback, checkpoint/restart, device hot loop.
7. `stable_skyrmion`: trzy siatki, $Q$, energia, promień i środek.
8. `driven_racetrack`: prądy $\{-1.5,-1.0,-0.5,0.5,1.0,1.5\}\times10^{12}\,\mathrm{A\,m^{-2}}$, bez anihilacji/krawędzi.
9. `hall_angle`: wersja algorytmu, okno ustalone i niepewność.
10. `mumax_common_limit`: wspólne torque oraz literalna/zbieżna demag policy; nie transport oracle.
11. `product_contract`: Python/UI round-trip, normalized IR i `m`, `J_c`, `mu_s`, `Q_spin`, `T_tr_G`, $Q$, środek, kąt Halla.
12. `production_runtime`: restart, determinizm, pamięć, wydajność, sanitizer, fallback i transfery.

Globalnie wymagane są `fallbacks=[]`,
`hot_loop_host_device_transfers=0` oraz
`torque_provenance=solved_transport`. Brak, nadmiar, zły hash lub niepełne
ilości kończą się reason code i niezerowym wyjściem.

## Granica kwalifikacji

| Poziom | Stan | Dowód |
|---|---|---|
| Implemented | częściowo | kontrakty CUDA i kod transportu istnieją |
| Executable | niepotwierdzone | kontrakty składników nie są pełnym workloadem |
| Validated | nie | brak świeżego manifestu 12 bramek |
| Production-qualified | nie | wymagany PASS recepty managed CUDA |

Capability pozostaje niepromowane do czasu kompletnego świeżego manifestu.
