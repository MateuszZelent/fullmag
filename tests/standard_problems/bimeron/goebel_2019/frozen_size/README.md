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
