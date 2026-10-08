# Walidacja polityki solvera modalnego FEM

Polityka w `problem_meta.runtime_metadata.modal_solver_policy` jest obiektem
z opcjonalnymi polami `residual_tolerance`, `max_outer_iterations` oraz
`max_linear_iterations`. Nieznane pola są błędem deserializacji; literówka
nie może zmienić jawnego żądania w wybór domyślnych parametrów.

Brak klucza, pusty obiekt lub obiekt ze wszystkimi znanymi wartościami `null`
wybiera domyślne ustawienia adaptera natywnego. Planner normalizuje te trzy
przypadki do `solver_policy: None`. Cała wartość `modal_solver_policy: null`
nie jest obiektem i pozostaje błędnym typem. Częściowa polityka zachowuje
zadane wartości; pozostałe parametry są rozwiązywane przez adapter natywny.

Zadana tolerancja musi być skończona i dodatnia; jest bezwymiarowa.
Publiczny Python DSL odrzuca `True` i `False` jako tolerancję przez `TypeError`
przed konwersją do float. Nie interpretuje ich jako 1.0 i 0.0. Niepoprawny
zakres liczbowy nadal zgłasza `ValueError`. Zadane
limity iteracji muszą być dodatnimi liczbami całkowitymi i mieścić się
w natywnym zakresie signed i32. Nie są zaokrąglane ani ograniczane przez clamp.
Normalizacja pustej polityki zachowuje publiczną semantykę
`FemEigenSolverPolicy()` i resetu wszystkich pól etapu.

Dla polityki znormalizowanej do `None` provenance ma
`source: native_petsc_slepc_defaults` oraz `delegates_to_native_defaults: true`.
Parametry wykonania odczytuje się z diagnostyki natywnej; sam plan nie dowodzi
rzeczywistego rozwiązania ani osiągniętej dokładności fizycznej.

Źródła: `FemEigenSolverPolicyIR` w `crates/fullmag-ir/src/plan.rs`,
`eigen_solver_policy` w `crates/fullmag-plan/src/fem.rs`,
`native_solver_diagnostics_json_with_expected_digest` w `crates/fullmag-runner/src/fem/eigen_native_window.rs`.
Regresje GHA: pełne fullmag-ir oraz filtr
`fem_eigen_modal_solver_policy` w fullmag-plan.

Python → IR: `world._fem_eigen_solver_policy` przekazuje `solver_rtol` bez
konwersji do `FemEigenSolverPolicy.__post_init__` w `fullmag/model/study.py`.
Regresja `test_fem_eigen_solver_policy_rejects_boolean_residual_tolerance`
należy do `packages/fullmag-py/tests/test_api.py`, uruchamianego w GHA.
