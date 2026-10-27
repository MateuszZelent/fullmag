# Brak assembly_kind w publikacji signed14

## Dowody i przyczyna

`2026-10-27-eigensolve-signed14-publication-failure.evidence.json` zachowuje 14 certyfikowanych checkpointów runu 78af971e. Pełne spektra odczytane przed utratą klienta Docker są w /tmp/eigen-signed14-checkpoints.json. Każdy mode ma assembly_kind=null, mimo obecności operator_input_signature_sha256, phase_constraint_sha256 i source_mesh_topology_sha256.

Łańcuch źródłowy: eigen_native_window.rs::execute_native_modal_window wybiera typed shared_domain_problem i buduje shared_domain_identity z hashami, ale bez assembly_kind. eigen_native_artifacts.rs::native_modal_artifacts_with_selection_binding kopiuje solver_diagnostics[assembly_kind] do certyfikatu i spektrum; brak staje się null. eigen_path_artifacts.rs::materialize_selected_path_physical_potential_artifacts wymaga dokładnie mfem_weak_form_shared_domain przed zaakceptowaniem istniejącego manifestu. Null nie spełnia tego warunku. Potwierdza to co najmniej jedną przyczynę odrzucenia; pozostałe powiązania manifestu trzeba potwierdzić w ponownym runtime.

## Poprawka

Producer wiąże assembly_kind wyłącznie wewnątrz istniejącej gałęzi typed shared_domain_identity. Brak/null zostaje uzupełniony kontraktem tej ścieżki; każda sprzeczna, pusta lub nietekstowa wartość jest błędem. Nie zmieniono walidatora manifestu, hashy, wyboru solvera ani progów residualu. Osobna ścieżka nonshared nie wywołuje tej funkcji.

## Weryfikacja

Dodano testy brak/null/prawidłowa wartość i trzy negatywne przypadki, ze sprawdzeniem zachowania innych metadanych. Testy Rust uruchamia istniejący workflow eigensolve-method-contracts (cargo test -p fullmag-runner --lib); lokalna kompilacja testów nie została wykonana. diff --check PASS. Wdrożenie i finalna publikacja modów: NOT VERIFIED.

Docker CLI w WSL ma niedostępny cel dowiązania; odczyt _ping istniejącego socketu przekroczył 5 s, Windows docker.exe zwrócił exec format error. Nie restartowano usług. Nadal można pracować nad źródłami i CI; brak dostępu nie został uznany za dowód zatrzymania kontenerów.

## CI potwierdzone

GitHub Actions run40462460952/job122050023787 dla commita7d4a74c79cd0a3d82b3bb4b50c5af0be05854111: source-contracts SUCCESS. Log zawiera oba shared_domain_assembly_identity_tests zakończone ok oraz 1820 passed, 0 failed, 1 ignored. Jest to dowód kontraktów Rust; nie zastępuje nowego wykonania FEM ani publikacji w UI.
