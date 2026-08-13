# Task 10 — MuMax3 common-limit comparator

## Zakres

Dodano wersjonowany fixture `mumax/common_limit.mx3`, fail-closed comparator
`scripts/compare_fdm_racetrack_mumax.py`, jego syntetyczne testy jednostkowe i
recepturę `just verify-fdm-gpu-racetrack-mumax-common-limit`.

MuMax3 nie jest tutaj oraclem solved-current. Fixture ładuje stan relaksacji i
pole równoważne torque wyeksportowane z Fullmag; nie używa wbudowanego modelu
current-torque. Comparator wymaga tego samego digestu siatki i pola torque,
potwierdzenia jego wstrzyknięcia, digestu binarium MuMax3, digestu skryptu oraz
końcowego OVF. Rozdziela `m_rms`, energię, $Q$, środek, prędkość i
$\Theta_H$, a utrata topologii, inny czas próbkowania lub inny literalny
common-limit są błędami zamykającymi porównanie.

## Dowody wykonane

- `PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile scripts/compare_fdm_racetrack_mumax.py scripts/test_compare_fdm_racetrack_mumax.py`
- `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -s scripts/test_compare_fdm_racetrack_mumax.py -q` — `9 passed`.
- `just --list` parsuje receptę `verify-fdm-gpu-racetrack-mumax-common-limit`.
- `just verify-fdm-gpu-racetrack-mumax-common-limit` bez manifestów/OVF kończy
  się fail-closed kodem `2` przed utworzeniem raportu.

## Środowisko MuMax

Lokalne binarium istnieje pod `/home/kkingstoun/.local/bin/mumax3`; obrazy
`mumax3-build:latest` i `matmoa/amumax:build` są również lokalnie dostępne.
Nie uruchomiono porównania dynamicznego: nie ma jeszcze świeżego manifestu
Fullmag, manifestu MuMax3 ani eksportowanych plików `relaxed_zero_current.ovf`
i `fullmag_transport_torque_common_limit_field.ovf`. Syntetyczne testy nie są
dowodem runtime ani kwalifikacją fizyczną.

## Następna bramka

Zebrać oba manifesty oraz dwa OVF z prawdziwego managed FDM GPU run, podać je
recepturze przez zmienne `FULLMAG_RACETRACK_*`, a następnie zaakceptować wynik
wyłącznie wtedy, gdy opublikowany zostanie
`/zfn2/mateuszz/git/fullmag/reports/fdm-gpu-racetrack-mumax/<source-digest>/racetrack_mumax_common_limit_v1.json`.
