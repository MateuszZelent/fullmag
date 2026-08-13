# Task 10 — MuMax3 common-limit comparator: korekta pola zamrożonego

## Zakres

Dodano exporter `scripts/export_fullmag_transport_torque_for_mumax.py`, który
przyjmuje wyłącznie zaakceptowany snapshot Fullmag z `m` i
`T_tr_G [s^-1]`, a następnie zapisuje `B_eq [T]` jako OVF2 oraz manifest v1.
Dla kanonicznego jawnego RHS Gilberta stosuje dokładnie
`B_eq = (m × T_tr_G) / gamma_e`. `alpha` nie znika z proweniencji: jest
zapisywane wraz z `gamma_rad_s_T` i identyfikatorem konwencji, choć redukcja
algebraiczna pola nie zależy od jego wartości. Eksporter fail-closed odrzuca
niezaakceptowany snapshot, złą jednostkę, inną formułę, niejednostkowe `m` i
nie-tangentne `T_tr_G`; nie wykonuje ukrytej projekcji.

Comparator i manifesty common-limit są podniesione do v2. Oddzielają digest
źródłowego `T_tr_G` (`s^-1`) od digestu wstrzykniętego `B_eq` (`T`), wymagają
tej samej konwencji, `alpha`, `gamma_rad_s_T`, flagi frozen torque oraz braku
dynamicznej rekalkulacji transportu. Wymagają również exact `heun_fixed`,
całkowitych relacji `dt`, sample interval i czasu trwania, initial sample oraz
digestu rzeczywistego `table.txt` MuMax3.

MuMax3 nie jest tutaj oraclem solved-current. Fixture ładuje stan relaksacji i
pole `B_eq` wyeksportowane z Fullmag i nie używa wbudowanego modelu
current-torque. Fixture ustawia `GammaLL = 1.76085963023e11 rad/(T s)`,
jednorazowo ładuje `B_ext`, i zapisuje `TableSave`, `TableAutoSave(5e-12)`
oraz `AutoSave(m, 5e-12)`. Comparator wymaga digestu binarium MuMax3, skryptu,
tabeli i końcowego OVF. Rozdziela `m_rms`, energię, $Q$, środek, prędkość i
$\Theta_H$; utrata topologii, różna kadencja, dynamiczny torque lub niezgodna
tożsamość są błędami zamykającymi porównanie.

## Dowody wykonane

- `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -q -p no:cacheprovider scripts/test_compare_fdm_racetrack_mumax.py` — `15 passed`.
- `PYTHONPYCACHEPREFIX=/tmp/fullmag-pycache python3 -m py_compile scripts/export_fullmag_transport_torque_for_mumax.py scripts/compare_fdm_racetrack_mumax.py scripts/test_compare_fdm_racetrack_mumax.py` — PASS.
- `just --list` parsuje receptę `verify-fdm-gpu-racetrack-mumax-common-limit`.
- `just verify-fdm-gpu-racetrack-mumax-common-limit` bez wejść kończy się
  fail-closed kodem `2` przed utworzeniem raportu.

## Środowisko MuMax

Lokalne binarium istnieje pod `/home/kkingstoun/.local/bin/mumax3`; obrazy
`mumax3-build:latest` i `matmoa/amumax:build` są również lokalnie dostępne.
Nie uruchomiono porównania dynamicznego: nie ma świeżego zaakceptowanego
snapshota `T_tr_G/m`, manifestu Fullmag common-limit, manifestu MuMax3,
stanu `relaxed_zero_current.ovf` ani artefaktów z managed FDM GPU. Syntetyczne
testy nie są dowodem runtime ani kwalifikacją fizyczną.

## Następna bramka

Zebrać pełny managed FDM GPU run, podać zaakceptowany snapshot przez
`FULLMAG_RACETRACK_TORQUE_SNAPSHOT` (receptura wtedy wywołuje exporter),
manifesty common-limit i `relaxed_zero_current.ovf`. Wynik można zaakceptować
wyłącznie po publikacji
`/zfn2/mateuszz/git/fullmag/reports/fdm-gpu-racetrack-mumax/<source-digest>/racetrack_mumax_common_limit_v2.json`.
