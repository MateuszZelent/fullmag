# Selektywne review importu certyfikatu Gamma/Floquet

27.10.2026. Historyczne źródło: 8ea04862f2630f0e7d55988ed7ebe6d6b798e227 z repozytorium Windows, odczytane bez zmiany starego worktree. Bieżąca baza przed adaptacją cb8ac7c17.

## Potwierdzony błąd i ograniczona poprawka

W build_shared_domain_linearization_state nowy certyfikat miał digest `shared_domain_content_digest("periodic_mesh_certificate_v6", periodic_certificate_json)`, czyli hash otoczki zawierającej payload i modal-equivalence binding. Import zwracał natomiast source_certificate.content_sha256 — wewnętrzny hash samego payloadu. Te wartości mają różne role i generowały różną tożsamość wejścia operatora zależnie od sposobu uzyskania tej samej równowagi.

Wydzielono dotychczasowe sprawdzanie source certificate i zachowano wszystkie porównania certificate_id, content_sha256 oraz modal_equivalence_map_binding. Po nich import zwraca ten sam obliczony outer digest co nowa konstrukcja. Nie przepisuje to istniejących artefaktów, ich hashy ani payloadów. Test rozróżnia inner/outer digest i odrzuca stale/niepełne ID, hash i mapę.

## Świadomie nieprzeniesiony zakres

Historyczny commit dodawał także moduł zgodności legacy boundary-kind (971 linii), preimage replay i plany boczne. Nie skopiowano go automatycznie. Obecny kod ma accepted Relax→Eigen handoff V3, immutable generations oraz własne kontrole material/static-physics/boundary. Zgodność takich importów musi być oceniona względem tych kontraktów. Ta adaptacja nie rozszerza dopuszczalnych warunków brzegowych ani nie łagodzi mismatch guards.

Status inwentarza: partially-adapted. Lokalny diff check PASS; regresja kompilowana wyłącznie przez eigensolve-method-contracts w GitHub Actions. Runtime zmiany i Gamma frequency-window NOT VERIFIED. Dysk WSL nadal blokuje nowy build; to niezależne od poprawności źródeł.
