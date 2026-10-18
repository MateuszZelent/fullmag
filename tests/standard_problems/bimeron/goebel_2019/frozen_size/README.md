# Profil energii bimeronu z frozen spins

Ten katalog realizuje FDM-owy pilot i sweep dla układu Göbel/rDMI
z jawnymi nadpisaniami parametrów materiału zapisanymi w metadanych.
Parametr `target_radius_nm` opisuje żądany promień
konturu `m_x=0`; skrypt wylicza z niego parametr `radius` presetu, a analiza
raportuje promień zmierzony z końcowego pola.

`scenario_fdm.py` ma jawne etapy: zapis stanu początkowego, relaksację z
`FrozenSpins`, hold z tą samą referencją oraz opcjonalną relaksację po
zwolnieniu. Protokoły `p0`, `p2`, `p3` i `ring` odpowiadają odpowiednio brakowi
maski, dwóm pinom przy analitycznych ekstremach `m_z`, dwóm pinom z pinem
centralnym oraz cienkiemu pierścieniowi wokół konturu. Wszystkie piny obejmują
pełną grubość filmu i nie dodają sztucznej energii karnej.

Parametr `cell_nm` określa rozdzielczość w płaszczyźnie `xy`; komórka w osi `z`
pozostaje równa grubości warstwy 0,5 nm. Dzięki temu wariant `h=0.25 nm` ma
jedną warstwę FDM (320 000 komórek), a nie sztucznie wprowadzoną drugą warstwę.
Eksperyment może jawnie zwiększyć szerokość toru przez
`FULLMAG_BIMERON_TRACK_Y_NM`; seria `dense` używa 80 nm i próbuje promienie od
3 do 20 nm co 0,5 nm, pozostawiając zapas na ścianę bimeronu.

Algorytm `constrained_relax` to `llg_overdamped`. Obecna ścieżka CUDA
odrzuca PG-BB z frozen spins; opcja presetu `bb` nie jest dowodem obsługi
tego połączenia. Do kontroli pierścienia używamy LLG.

## Kontrakt metodologiczny po audycie

Pierścień narzuca pełne wektory `m_i = m_i_ref`, a nie jedynie promień.
Energia jest zatem warunkowa względem szerokości ściany początkowej,
szerokości i położenia maski. Nie zwiększamy liczby zamrożonych komórek
wyłącznie w celu wygładzenia wykresu. Liczba komórek i hashe maski muszą
pozostać widoczne przy każdym punkcie.

Aktualny eksperyment: D=0,004 J/m², A=1,5e-11 J/m, Ms=580000 A/m,
Ku=800000 J/m³, film 100×80×0,5 nm, komórka 0,5×0,5×0,5 nm,
PBC x z `truncated_images`, szerokość ściany 1,5 nm i pierścienia 0,5 nm.
Siatka promieni wynosi 1,5–10 nm co 0,5 nm.

`R_area=sqrt(A_component/pi)` dotyczy wybranej spójnej składowej
`background_sign * mx < 0`. `R_core` jest połową najkrótszej odległości
między ekstremami mz wybranej tekstury, z uwzględnieniem PBC x.
Skala h/2 jest wskaźnikiem rozdzielczości siatki, nie przedziałem ufności.

`thresholds.v1.json` zachowuje surowy próg torque 1e-5 T.
`thresholds.working.v2.json` jawnie definiuje próg roboczy 0,005 T i zakres
`working_profile_not_release`. Zmiana polityki nie przepisuje historycznych
plików weryfikacji. Przejście polityki roboczej nie dowodzi niezależności
energii od czasu relaksacji ani naturalnego minimum.

Kontrole wymagane przed interpretacją minimum:

1. Jeden swobodny P0 przy identycznych parametrach; zapis jego pełnego pola,
   energii i promienia. Nie wykonujemy osobnego P0 dla każdego R.
2. Pierścień przejęty z tego samego zrelaksowanego pola; porównanie energii,
   promienia i wszystkich wektorów po dalszej relaksacji. To test zachowania
   stanu, a nie dowód powrotu po zaburzeniu.
3. Ponowne obliczenia R=1,5; 5; 6,5; 8; 10 nm z dłuższą relaksacją
   i progiem 0,001 T. Raportujemy różnice energii w J, bez utożsamiania
   małej zmienności ostatniego okna hold z błędem równowagi.
4. Przy R=5; 6,5; 8 nm osobne kontrole szerokości pierścienia 0,75 nm
   oraz radialnego przesunięcia maski ±0,125 nm, przy niezmienionym presecie.
   `FULLMAG_BIMERON_RING_RADIUS_OFFSET_NM` zmienia promień maski, nie siatkę
   ani środek tekstury. To czułość ograniczenia; nie szacuje błędu
   dyskretyzacji ani nie zastępuje testu sztywnego przesunięcia tekstury.

Wszystkie nowe przebiegi wykonujemy z `--run-mode interactive`.
`audit_validation.py --output-root <katalog-w-storage-runs>` wypisuje
macierz 15 kontroli i końcowy pełny profil 18 promieni, wraz z dokładnymi
poleceniami, bez uruchamiania symulacji.
Dodanie `--run` uruchamia je kolejno, wyłącznie po potwierdzeniu zgodności
zarządzanego runtime ze źródłami. Brak zgodności zatrzymuje wykonanie;
skrypt nie zastępuje zatwierdzonej kolejki lokalnym buildem.
Wyniki kontroli zapisujemy oddzielnie. Dodatnia energia względem tła może
oznaczać gałąź metastabilną; minimum próbek nie jest globalnym minimum.
Zakres runtime to FDM GPU; FDM CPU, FEM CPU i FEM GPU pozostają poza
kwalifikacją tego eksperymentu. Źródła semantyki: `common.py::FrozenCase`,
`scenario_fdm.py::_constraint_for_case`, `analyze.py::_measure`,
`verify.py::verify_analysis`; kanoniczna fizyka:
`docs/physics/0996-frozen-spins-constraint.md`.

Najpierw wyświetl macierz:

```text
python tests/standard_problems/bimeron/goebel_2019/frozen_size/run_sweep.py --series pilot
```

Pełny gęsty profil z podglądem w UI uruchamia się przez serię `dense`:

```text
python tests/standard_problems/bimeron/goebel_2019/frozen_size/run_sweep.py --run --series dense --cell-nm 0.5 --track-y-nm 80 --run-mode interactive --web-port 3100 --table-every-steps 500 --field-every-steps 1000 --hold-time-s 2e-12 --with-background
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
Jednorazowy wynik wolnej relaksacji można dołączyć do raportu przez
`report.py profile_summary.json --free-reference <free-analysis.json>`; jest
wtedy pokazany jako osobny punkt kontrolny, a nie kolejny punkt sweepu.
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
oraz położenia przeciwnych ekstremów `m_z`. Następnie domyślny `ring` ładuje
zapisany stan baseline i zamraża pierścień dla jego zmierzonego promienia.
Opcja `--frozen-protocol p3` wybiera dwa zmierzone ekstrema oraz centrum.
Po constrained hold następuje release. `paired_summary.json` i
`paired_report.md` zapisują porównanie pełnych pól, energii i promieni.
Nieudany lub niezbieżny P0 zatrzymuje kontrolę przed etapem frozen.
Przejście kontroli wymaga zachowania pola, energii i promienia także po hold,
a nie wyłącznie dokładnego wczytania pliku stanu początkowego.
