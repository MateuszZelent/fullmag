# Raport implementacyjny — verifier/proweniencja GPU D-07

## Zakres

Zmiana obejmuje wyłącznie `scripts/verify_fdm_multilayer_cuda_parity.py` oraz
fokusowe testy tego verifiera. Nie zmieniono backendu, UI, `justfile` ani
konfiguracji managed storage.

## Wynik

Verifier nie kwalifikuje już artefaktu CUDA, jeżeli ogólna realizacja jest
`cuda_assisted_multilayer`, transfer telemetry wskazuje host-authoritative/CPU
residency albo proweniencja zawiera fallback. Pozytywny wynik wymaga teraz:

- requested lane `fdm/gpu/strict` z fallback policy `forbidden` i precision
  zgodną z `cuda-fp64` albo `cuda-fp32`;
- resolved execution shape `cuda_native_multilayer_convolution`;
- braku lossy/resolved fallbacku i braku ignorowanych terminów fizycznych;
- kompletnej dostępnej tożsamości urządzenia: nazwa, compute capability, wersja
  drivera CUDA i runtime CUDA;
- `cuFFT`, natywnego operatora multilayer i device-resident transfer metadata;
- dokładnie jednego zarejestrowanego refreshu z licznikami `L` forward, `L`
  inverse i `L²` pair accumulations, gdzie `L` pochodzi z manifestu warstw;
- zgodności identyfikatorów warstw, długości pól, `source_hash` (gdy jest
  publikowany) i `engine_version` pomiędzy referencją i kandydatem;
- dla FP32: natywnej referencji CUDA FP64 z identyczną tożsamością urządzenia;
- schematu `fdm_multilayer_thresholds.v1`, zamrożonego ograniczenia
  `SP4-derived, not canonical SP4 qualification` oraz SHA-256 pliku progów.

Wynik pozytywny ma schemat `fdm_multilayer_cuda_parity.v2`, status `verified`,
scope `bounded_d07_demag_refresh_parity` i jawne `qualification_claim=null`.
Zapisuje sprawdzoną tożsamość artefaktu, urządzenia, transfer telemetry, D-07
telemetry, hash progów oraz właściwy dla lane'u próg parity. Progi FP64 i FP32
pozostają rozdzielone. Referencja i kandydat muszą ponadto mieć terminalny
`status=completed`, kanoniczny snapshot `H_demag` i ten sam numer kroku.

## Test-first i weryfikacja

Cykl RED wykazał osobno akceptację host-authoritative/fallback CUDA, brak
kontroli terminalnego statusu, malformed fallback oraz możliwość zestawienia
snapshotów z różnych kroków. Każda luka dostała test przed odpowiadającą jej
zmianą implementacji.

Końcowy fokusowy plik verifiera:

```text
python3 -m pytest -q -p no:cacheprovider \
  scripts/test_verify_fdm_multilayer_cuda_parity.py
11 passed in 0.13s
```

Końcowy fokusowy zestaw regresyjny:

```text
PYTHONPATH=packages/fullmag-py/src:. python3 -m pytest -q -p no:cacheprovider \
  scripts/test_verify_fdm_multilayer_cuda_parity.py \
  tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/test_managed_cuda_recipe.py \
  scripts/test_fdm_multilayer_runtime_targets.py
20 passed in 0.48s
```

Dodatkowo wykonano `python3 -m py_compile` dla verifiera i testu oraz
`git diff --check`; oba polecenia zakończyły się kodem 0.

### Korekta evidence po rereview

Po uwadze reviewera usunięto z raportu nieaktualne liczniki z pośrednich faz
RED/GREEN. Powyższe `11 passed` i `20 passed` pochodzą ze świeżych przebiegów
wykonanych na commicie bazowym `0cc5486329c1beaa8ccbf67c429e00a715a3fb5b`
przed tą wyłącznie dokumentacyjną korektą.

## Granica kwalifikacji i luki rezydualne

Ta zmiana jest wzmocnieniem fail-closed verifiera, nie kwalifikacją CUDA D-07.
Bieżący kod runtime publikuje ogólny engine `cuda_assisted_multilayer` i
`host_authoritative_with_cuda_field_roundtrips`; taki artefakt jest teraz
odrzucany jako `cuda_device_residency_not_qualified`, nawet jeżeli lokalny etap
demag raportuje poprawne `L/L/L²`.

Nie wykonano świeżego managed-runtime runu GPU. Metadata runu nie publikuje
obecnie device UUID, wersji biblioteki cuFFT, SHA-256 binarium runtime, hashy i
liczności kernel catalog, transferów ograniczonych dokładnie do warm
device-resident refreshu ani danych per-layer energy potrzebnych do pełnego
Etapu 15. Recipe przechowuje część source/runtime hashy poza katalogami
`reference`/`candidate`, lecz bieżący interfejs verifiera ich nie otrzymuje;
zgodnie z briefem nie zmieniano `justfile` i nie wynajdywano tych danych. Pełna
kwalifikacja wymaga osobnego świeżego artefaktu native CUDA, który naprawdę
spełni te bramki.
