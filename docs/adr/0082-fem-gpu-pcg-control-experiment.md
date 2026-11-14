# ADR 0082: jawny eksperyment sterowania paczkami PCG FEM GPU

Status: wdrażane; przyspieszenie i kwalifikacja runtime NOT VERIFIED.

## Kontekst

Chcemy porównać koszt dodatkowych zleceń AMG po osiągnięciu zbieżności z
kosztem częstszych odczytów statusu. Potrzebne jest przeplatane porównanie
dwóch polityk w tym samym binarium, z jednoznacznym provenance.

## Decyzja

Używamy zamkniętego, opcjonalnego metadata
`fem_gpu_pcg_control_experiment`, schema
`fullmag.fem.gpu.pcg_control_experiment.v1`, `status_batch_stride` 4 lub 8.
V1 wymaga jawnego FEM/GPU/double, Poissona Robin/Dirichlet, CG/AMG i braku PBC.
Nie rozszerzamy RunIntent, profilu execution, zmiennych środowiskowych ani
frontendowych capability. Brak metadata zachowuje dotychczasowy plan i runtime.

Planner przenosi zwalidowany obiekt do opcjonalnego pola FemPlanIR. Addytywny
setter C działa po create_v5 i przed pierwszym solve; pierwsza próba, także
błędna, trwale zamyka konfigurację. Context posiada politykę i surowe liczniki
prób, zleconych iteracji i wywołań AMG, niezależne od resetu workspace i
rollbacku. Terminalny getter hostowy dostarcza provenance dla RK i relaksacji.
Istniejące layouty i numery ABI nie zmieniają się.

## Konsekwencje i odbiór

Nieobsługiwane kombinacje są błędem, nie silently ignored. Żaden operator,
certyfikat ani tolerancja nie zmienia się. Wywołania API nie oznaczają
wykonanych V-cykli GPU. Wdrożenie polityki domyślnej wymaga osobnego wyniku
testu tego samego SP4 z energią, torque, residuum i pełnym Zarr; eksperyment
może wykazać regresję. Specyfikacja naukowa: [nota 0914](../physics/0914-fem-gpu-pcg-control-experiment.md).
