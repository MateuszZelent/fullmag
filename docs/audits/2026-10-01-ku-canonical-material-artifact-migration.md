# Ku — migracja tożsamości materiału i artefaktów

## Cel i autoryzacja

Użytkownik jawnie zatwierdził migrację equilibrium_artifact.v8 / LinearizationState.v7 po przedstawieniu propozycji ku-material-artifact-migration-approval.md. Zakres: producenci Rust, odbiorniki Python/COMSOL oraz manifesty single-/multi-k; bez przepisywania historycznych danych i aktywnej kapsuły #188.

## Kontrakt

- Bez Ku: zachowane equilibrium_artifact.v7 / LinearizationState.v6, raw MaterialIR hash, nazwy i preimage digestów.
- Z Ku (także jawne Ku=0): equilibrium_artifact.v8 / LinearizationState.v7, istniejący canonical equilibrium material hash w material_signature i material_snapshot_id.
- material_identity_kind=canonical_equilibrium_material.v2; oddzielny raw hash material_provenance_signature; material_provenance_scope=materialization_plan. Nie jest to rekonstrukcja pierwotnego authored relaxation request.
- Równoważne osie u, -u i skalowana u zachowują tożsamość fizyczną. Zmiana Ku lub fizycznej osi odrzucana. Provided source pozostaje niezmieniony; nowe state zapisuje raw hash obecnego wejścia.
- Certyfikaty przyjęcia, completion, pola, mesh/phase i content identity pozostają wymagane. Stary format nie może podszyć się pod nowy przez dodatkowe pola.

## Zrealizowane zmiany źródeł

| Obszar | Zmiana | Granica dowodu |
|---|---|---|
| Rust | Wersjonowany loader i material identity, producer/state/native snapshot | Parser składni; typy i runtime wymagają managed buildu |
| Manifesty | Pary ścieżek v8/v7 dla single i multi-k; legacy zachowane | Regresje źródeł; bez nowych wyników solvera |
| Publikacja pól | Remap i retencja wersjonowanych plików z oryginalnym sample ID | Regresja Rust przygotowana, bez kompilacji |
| Python/COMSOL | Wersjonowane payloady, digesty, source/canonical/raw binding | Lekkie regresje; nie stanowią porównania z COMSOL |
| Odbiorniki benchmarków | Dobór jednej rodziny plików i odrzucenie mieszanych sidecarów | 44 lekkie testy runtime/parity PASS |
| Dokumentacja | Nota0831 +source-map, ADR0023, spec artefaktów | Walidator mapy źródeł i public examples PASS |

## Weryfikacja i review

- Nowe regresje migracji:20PASS; COMSOL/payload29PASS; runtime/parity44PASS; istniejący verifier9PASS. Kontrole AST i diffPASS.
-10plikówRust przeszło parser składni. Przygotowano regresje canonical/raw, loadera v8, publikacji par schematów i retencji/remap sampleID; nie kompilowano ich.
- Niezależne review nie znalazło P1 ani błędu matematycznego canonicalizacji. P2 cichego wyboru legacy przy błędnych diagnostics naprawiono: jeden explicit schema-pair selector, odrzucenie missing/mixed/unknown i brak accepted handoff. Końcowy niezależny review tej delty bez P1/P2.
- Odbiornik COMSOL dopuszcza puste historyczne tablice obok nowych ścieżek multi-k; malformed i niepuste mieszane rodziny odrzucane.

Dokładne grupy Python: test_equilibrium_material_artifact_v8.py (20), test_comsol_equilibrium_artifacts.py +test_comsol_linearization_binding.py +test_equilibrium_payload_validation.py (29), test_verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py +test_validate_fem_periodic_antidot_relax_eigenmodes_runtime.py (44), unittest scripts.test_verify_fem_frequency_domain_eigen_artifacts (9).

Dodatkowa bramka konsumenta: test_validate_comsol_dispersion_scientific_gate.py —49testów+54podprzypadkiPASS. Łącznie151lekkichtestów+54podprzypadkiPASS. To kontrola skryptów i fixture'ów, nie nowe porównanie wyników fizycznych z COMSOL.

## Stan runtime i pozostałe bramki

Publiczny guard Ku pozostaje aktywny. Nie wolno uznać migracji za walidację modów Ku ani CPU/GPU parity. Native unit tests nie zostały zbudowane ani wykonane zgodnie z AGENTS.md.

#188: build succeeded, ale trwający Γ używa wcześniejszej kapsuły b2edf2fbc0295c83f6d768ad8bd3391904017c5f871d0244afe15c4b3a1a4a46. Nie zawiera tej migracji. Kontroler90201 i kontener7df4be7c5ace nadal aktywne; ostatnia kontrola base4/50, bez terminalnej nowej częstotliwości. Nie restartowano ani nie usuwano danych.

Następnie: końcowe review i testy migracji -> commit/push -> managed runtime-v2 build -> wersjonowane artefakty runtime -> odrębny dowód Ku przed zdjęciem guarda. Równolegle kontynuacja #188, signed DE/BV i zbieżność; COMSOL A1, inne interakcje, waveguide, GPU, browser i integracja S00–S12 pozostają otwarte.

## Commit/push i blokada buildu

Migracja została zapisana i wysłana jako `799be85d3e1c40ee1d7790797d6f81536e9d9ce9`. HEAD i remote branch sprawdzone i zgodne; worktree czysty po commicie.

Próba `local_runner_cli.py submit --operation build --profile fem-cpu-slepc-runtime-v2 --source commit --ref 799be85d3e1c40ee1d7790797d6f81536e9d9ce9 --request-key ku-canonical-artifact-v8-799be85d3e1c40ee` zakończona exit1: `Storage is busy: eigensolve-dispersion-plan-20260-c5dfad6d7f548079. Reuse the running task or wait; do not allocate a random target.`

Nie powstał nowy job ani receipt tej migracji. Runner jest healthy/accepting, profil runtime-only dostępny, wolne około42,6GiB. Blokadą jest lease aktywnego wykonania #188, a nie brak profilu lub miejsca. Nie obejściowo zmieniono celu storage, nie restartowano koordynatora i nie przerwano Γ. Rejestr worktree także podlega temu lease; checkpoint pozostaje w wersjonowanym planie.

Następny krok po zwolnieniu lease: ponowić to samo zlecenie z pełnym SHA i request-key; zweryfikować terminalny receipt, runtime_only=true i brak unit_targets. Następnie osobne bramki artefaktów i Ku. Cały cel S00–S12 nie jest zamknięty.
