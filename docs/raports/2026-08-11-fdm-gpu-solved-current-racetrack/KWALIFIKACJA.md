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

## Aktualizacja: producent obserwabli Halla

Dodano `scripts/build_skyrmion_hall_artifact.py` oraz receptury
`build-fdm-racetrack-hall-artifact` i `verify-fdm-racetrack-hall-artifact`.
Producent rekonstruuje `Q(t)` i środek skyrmionu z zaakceptowanego
`fields/m.zarr`, regularnej siatki FDM i binarnej maski FMRM. Używa
orientowanego ładunku Berg–Lüscher oraz `weighted_gls.v1`; zapisuje digesty
źródła pola, siatki, mapowania węzłów i stage.

Ukierunkowane testy Python po zmianie: `37 passed`. Na krótkim zapisanym
przebiegu CUDA z dwiema próbkami producent odtworzył `Q=-0.9999996915` i
`Q=-0.9999994352`, a następnie odrzucił kąt z `reason_code=insufficient_samples`.
To zamyka ścieżkę źródło → obserwabla i dowodzi braku pozornego Halla, ale nie
zmienia klasyfikacji kwalifikacyjnej: pełny managed workload, kalibracja
niepewności, zasób v2/UI oraz rzeczywisty common-limit Fullmag↔MuMax nadal są
otwarte.

## Aktualizacja: świeży przebieg referencyjnego MuMax3

Zbudowano z lokalnego checkoutu `external_solvers/3` binarny official MuMax3
3.12 w kontenerze CUDA 12.4 i uruchomiono GPU common-limit na 10 ps, z
`heun_fixed`, `FixDt=1e-13 s`, autosave co 1 ps, siatką `256×64×1` i
`DemagAccuracy=6`. Przebieg zakończył się kodem wyjścia 0 i zapisał 11 próbek
`m000000.ovf`–`m000010.ovf` oraz 11 wierszy `table.txt`. Dowody są utrwalone
poza checkoutem pod:

```text
/mnt/fullmag-zfn2-native/mumax3-official-20260813/
```

To jest dowód wykonywalności referencji, a nie zaliczony comparator Fullmag–MuMax.
Checkout `external_solvers/3` używa `DemagAccuracy = 6`, `m.LoadFile(...)` i
`B_ext.Add(LoadFile(...), 1)`; literalny fixture z `SetDemagAccuracy(6)` oraz
`m = LoadFile(...)` nie jest zgodny z tym API i został tylko lokalnie
zadaptowany. Digesty przebiegu:

| Artefakt | SHA-256 |
|---|---|
| official MuMax3 binary | `1763c7a1f9ed779abdd8ee755a6d2af771b76dc8ab2e2212efe74e0a44f5f600` |
| input `common_limit_short.mx3` | `629e6a99904d9a633870410df404dd16a431fb0d46ccfc6a656bd645b1c2550c` |
| `table.txt` | `2065c794215911c93c8890c6d46b0637a9e6addc5119600c6e8e53eec1efc81f` |
| injected `B_eq` OVF | `8aab24038afbe266398cf4eff5e373ee60f36cd3108bdaacea026a87f6b6e3a9` |

Dodano `scripts/parse_mumax_common_limit.py`, który dekoduje rzeczywiste binarne
OVF MuMax3 (marker little-endian `1234567.0`), sprawdza tabelę, siatkę, digesty
oraz nie interpoluje czasów. Historyczne warianty z czasowym autosave ujawniły
odpowiednio brak początkowego wiersza tabeli albo overshoot `3.1 ps` zamiast
`3.0 ps`; oba przypadki są odrzucane. Nie są one bieżącym dowodem kadencji.

Wersja referencyjna użyta do końcowej walidacji parsera stosuje jawne
`Steps(10)` + `TableSave()` + `Save(m)` i dała manifest
`mumax_racetrack_common_limit_input.v2` z
`trajectory_source.kind=mumax_table_save_steps_v1`, 11 próbkami, krokiem
próbkowania `1 ps`, digestem
siatki `c609ccdc81396fdb287bbe4eda504dc778b4900e079541e7d5871a0a7ba5ab65`,
digestem tabeli `0b197e1c6fb0a7112b8ffdf465e4316b09f420c3ed528b20a0df6a808f8a503b`
i digestem binarium podanym powyżej. Fixture repozytorium został zmieniony na
analogiczny jawny harmonogram `Steps(50)` dla `5 ps`.

Brakuje nadal drugiej strony common-limit: pełnego manifestu trajektorii
Fullmag uruchomionego na tym samym zamrożonym `B_eq`, tym samym integratorze,
demag policy, kroku i próbkowaniu. Dodatkowo aktualny przebieg MuMax ma grid
origin znormalizowany do narożnika komórki `[0, 0, 0]`, podczas gdy eksport
torque Fullmag zachowuje fizyczne `z=3 nm`; przed porównaniem trzeba ustalić
wersjonowaną konwencję płaskiego wycinka i wygenerować oba digesty w tej samej
konwencji. Nie wolno zatem raportować `status=pass` comparatora ani wyliczać
zgodności kąta Halla z tego jednostronnego przebiegu.
