# Task 9 — publiczny racetrack solved-current

## Zakres wykonany

- Dodano płaski, modułowy scenariusz publicznego DSL w
  `examples/fdm_gpu_solved_current_skyrmion_racetrack.py`.
- Scenariusz deklaruje `relax_zero_current`, checkpoint
  `relaxed_zero_current`, przejście `drive_solved_current` oraz sześć
  niezależnych runów drive, każdy restartowany z checkpointu.
- Relaksacja zachowuje istniejący moduł solved-current przy `J=0` i wyłącza
  `transport_torque`; torque zostaje włączony wyłącznie przed drive.
- Terminale zachowują kontrakt orientacji: `x-=-J_x`, `x+=+J_x`. Sweep ma
  dokładnie `{-1.5,-1.0,-0.5,+0.5,+1.0,+1.5}e12 A/m2`.
- HM/FM, obie powierzchnie interfejsu `hm:z+` i `fm:z-`, direct SHE,
  `native_m1_v1`, strict FP64 oraz brak prescribed torque/Oersteda są
  authorowane wyłącznie typowanym DSL.
- Dodano fail-closed validator
  `scripts/verify_fdm_gpu_racetrack_output.py`. Wymaga zaakceptowanej
  relaksacji i checkpointu, sześciu drive, pól transportu, trajektorii i
  artefaktu kąta Halla oraz jednej spójnej rewizji dla checkpointu, snapshotów,
  pól i analizy.

## Dowody

Uruchomiono:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  tests/standard_problems/transport/racetrack_m1_v1/test_scenario.py \
  scripts/test_verify_fdm_gpu_racetrack_output.py -q
```

Wynik: `4 passed`.

Testy obejmują zeroprądową relaksację, kolejność i znaki wszystkich sześciu
drive, restart z checkpointu, aktywację torque, runtime CUDA device 0,
requested transport tuple FDM/GPU/FP64/strict, interfejs HM/FM i odrzucenie
nieaktualnej rewizji spin snapshotu przez validator.

## Granica kwalifikacji

To jest dowód authoringu i kontraktu artefaktów, nie świeża kwalifikacja
runtime CUDA ani fizyczna kwalifikacja produkcyjna. Validator wymaga
`qualification_boundary=not_production_qualified`; uruchomienie managed CUDA,
analiza zbieżności i promocja capability pozostają zadaniami późniejszych bramek.

Płaski `StudyBuilder` normalizuje runtime wykonawczy do `cuda:0`, natomiast
publiczny transportowy requested tuple pozostaje `device="gpu"` zgodnie z
fixture. Asset geometrii magnetu jest kanonicznie nazwany `fm_geom`, a publiczne
referencje regionu/elektrod/interfejsu pozostają `fm`.
