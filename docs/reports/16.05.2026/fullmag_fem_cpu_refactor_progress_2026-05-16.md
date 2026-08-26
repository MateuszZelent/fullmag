# Postep refaktoryzacji native FEM CPU — 16.05.2026

Ten wpis zamyka kontraktowy wycinek modularizacji native FEM CPU. Dokumentuje
kontrakty zrodlowe, granice wlascicielstwa i lokalne bramki testowe. Produkcyjna
kwalifikacja runtime MFEM/libCEED i fixture numeryczne pozostaja osobnymi
gate'ami.

## Zakres zamkniety kontraktowo

| Zadanie | Status |
|---|---|
| Dodac dokumentacje fizyczna u gory plikow solvera | zrobione kontraktowo dla aktywnych interakcji |
| Wydzielic lokalne oddzialywania (`anis`, `cubic`, `DMI`, `thermal`, `STT`, `Oersted`) | zrobione kontraktowo |
| Wydzielic `DemagSubsystem` / `demag_poisson` | zrobione kontraktowo |
| Wydzielic device/runtime z `mfem_bridge.cpp` | zrobione kontraktowo |
| Rozbic `Context` na `FemMesh`, `FemState`, `FemFieldBuffers`, `FemWorkspace` itd. | zrobione kontraktowo |
| Stworzyc pelna macierz testow FEM CPU | zrobione kontraktowo |

Granice wlascicielstwa sa weryfikowane przez `boundary docstring` oraz przez
`fem_interaction_docs_contract`.

## Bramki kontraktowe

Zakres interakcji obejmuje: `fem_interaction_docs_contract`,
`fem_zeeman_contract`, `fem_anisotropy_contract`, `fem_dmi_contract`,
`fem_thermal_brown_contract`, `fem_stt_contract`, `fem_oersted_contract`,
`fem_magnetoelastic_contract` i `fem_effective_field_contract`.

Podzial device/runtime obejmuje `fem_source_facade_contract`,
`fem_mfem_context_contract`, `fem_mfem_device_contract`,
`fem_gpu_state_runtime_contract`, `fem_state_io_contract` oraz
`fem_cpu_threads_contract`. Warstwa fasady obejmuje `backend_lifecycle`,
`backend_step`, `eigen_dense`, `interrupt` i `availability`.

Rdzen podzialu `Context` jest sprawdzany przez `fem_source_facade_contract`,
`fem_plan_fields_contract`, `fem_mesh_contract`, `fem_state_contract`,
`fem_material_fields_contract` i `fem_field_buffers_contract`. Sciezka runtime
jest dodatkowo pokryta przez `fem_rk_explicit_contract`,
`fem_mfem_context_contract`, `fem_gpu_state_runtime_contract`,
`fem_demag_contract`, `fem_demag_poisson_contract` i
`fem_demag_fem_bem_contract`.

Context pozostaje compatibility facade i nie jest juz wlascicielem plaskich pol core/runtime/interaction/workspace.

## Demag Poisson

Podzial obejmuje `fem_demag_contract` i `fem_demag_poisson_contract` oraz
moduly `demag_poisson_rhs.*`, `demag_poisson_boundary.*`,
`demag_poisson_hypre.*`, `demag_poisson_periodic.*`,
`demag_poisson_recovery.*`, `demag_poisson_energy.*`,
`demag_poisson_cache.*` i `demag_poisson_telemetry.*`.

aktywna walidacja runtime demag MFEM-stack pozostaje osobna od kontraktowego
podzialu modulow.

## Macierz walidacji

Pelna macierz znajduje sie w `docs/validation/fem_cpu_validation_matrix.md` i
zawiera sekcje `Current Local Gates`, `Required Physics Fixtures` oraz
`Environment Boundary`. runtime-open fixture/convergence gates MFEM-stack pozostaja osobna kwalifikacja.

dalsza walidacja runtime MFEM-stack i fixture fizyczne pozostaje osobna; wpis
nie zamyka aktywnej kwalifikacji runtime MFEM/libCEED.
