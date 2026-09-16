# Profil energii bimeronu z frozen spins

Ten katalog realizuje FDM-owy pilot i sweep dla tego samego układu Göbel/rDMI
co `../scenario_fdm.py`. Parametr `target_radius_nm` opisuje żądany promień
konturu `m_x=0`; skrypt wylicza z niego parametr `radius` presetu, a analiza
raportuje promień zmierzony z końcowego pola.

`scenario_fdm.py` ma jawne etapy: zapis stanu początkowego, relaksację z
`FrozenSpins`, hold z tą samą referencją oraz opcjonalną relaksację po
zwolnieniu. Protokoły `p0`, `p2`, `p3` i `ring` odpowiadają odpowiednio brakowi
maski, dwóm pinom przy analitycznych ekstremach `m_z`, dwóm pinom z pinem
centralnym oraz cienkiemu pierścieniowi wokół konturu. Wszystkie piny obejmują
pełną grubość filmu i nie dodają sztucznej energii karnej.

Domyślny algorytm `constrained_relax` to `llg_overdamped`. Do szybkiego
testu diagnostycznego można jawnie ustawić
`FULLMAG_BIMERON_RELAX_ALGORITHM=projected_gradient_bb` (skrót: `bb`). Dla
tego wariantu czas fizyczny relaksacji jest pomijany, a limit stanowią kroki
algorytmu. Wynik jest oznaczony jako diagnostyczny do czasu osobnego,
zarządzanego receipt potwierdzającego pełną ścieżkę FrozenSpins dla PG-BB;
nie należy łączyć go automatycznie z kwalifikowaną krzywą LLG.

Najpierw wyświetl macierz:

```text
python tests/standard_problems/bimeron/goebel_2019/frozen_size/run_sweep.py --series pilot
```

Uruchomienie korzysta z profilu storage zarejestrowanego dla tego worktree i
wymaga jawnego `--run`. Przykład krótkiego pilota do diagnostyki:

```text
python tests/standard_problems/bimeron/goebel_2019/frozen_size/run_sweep.py --run --series pilot --limit 1 --device gpu --release --relax-max-steps 64 --relax-time-s 2e-13 --hold-time-s 2e-13 --release-time-s 2e-13
```

Po każdym przypadku `analyze.py` zapisuje `analysis.json`, a `verify.py`
oddziela spełnienie kontraktu od ostrzeżeń i oznacza limit czasu/kroków jako
`not_converged`. `profile_summary.json` zachowuje pełną strukturę wyników,
`profile_energy.csv` udostępnia płaską tabelę `R -> E`, a `report.py` generuje
`profile_report.md` bez łączenia niezaakceptowanych punktów gładką krzywą.
Runtime frozen-spins v1 publikuje `max_torque_Apm` jako maksimum po wolnych
stopniach swobody; analizator mapuje tę wartość do `free_torque_metric` i
przelicza ją na tesle. Jeżeli nie ma kontraktowo zgodnej metryki, wynik
pozostaje jawnie oznaczony jako `not_emitted`; ogólna metryka `max_torque_T`
nie jest za nią podstawiana. Do profilu energii należy używać
pola `profile_energy`, które wskazuje ostatni pomiar etapu `constrained_hold`;
pole `energy` opisuje stan terminalny, a więc po release, gdy release został
włączony.
Jeżeli runtime nie publikuje dryfu referencji, analizator porównuje zapisane
`m_initial` z checkpointami constrained na rzeczywistych indeksach maski i
oznacza źródło jako `state_artifact_comparison`; brak któregoś artefaktu nadal
pozostaje ostrzeżeniem.

## Walidacja baseline → frozen

Przed budową profilu rozmiaru uruchom test parowany dla jednego seed radius:

```text
python tests/standard_problems/bimeron/goebel_2019/frozen_size/paired_validation.py \
  --run --seed-radius-nm 5 --device gpu
```

`p0` relaksuje teksturę bez zamrożonych spinów i mierzy `R_area`, `R_core`
oraz położenia przeciwnych ekstremów `m_z`. Następnie `p3` ładuje zapisany
stan baseline, zamraża dwa zmierzone ekstrema oraz centrum, a po constrained
hold wykonuje release. `paired_summary.json` i `paired_report.md` zapisują
porównanie stanu początkowego, hold i release; ten przebieg jest warunkiem
interpretacji późniejszego sweepu `R -> E`.
