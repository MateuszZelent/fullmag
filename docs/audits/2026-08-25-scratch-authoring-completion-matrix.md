# Macierz kompletności scratch authoring

## Zakres i werdykt

Macierz obejmuje rzeczywisty przepływ od pustej sesji do authoringu
ferromagnetyka, a nie tylko obecność komponentów. `PASS` oznacza dowód
wykonania ścieżki lub kontraktu; `PARTIAL` oznacza, że UI i zapis sceny są
zweryfikowane, ale nie wykonano solvera; `BLOCKED` oznacza brak wymaganego
środowiska wykonawczego.

Werdykt bieżący: warstwa frontendowego authoringu FDM/FEM jest dowiedziona,
ale pełny cel pozostaje otwarty na jednej bramce managed FEM. Ocena całości:
około **97%**, pozostałe **3%** to wykonanie i kwalifikacja solvera FEM.

## Macierz wymagań

| Wymaganie | Status | Autorytatywny dowód |
|---|---|---|
| Pusta sesja FDM/FEM CPU/double | PASS | `POST /v2/sessions` w `smoke-scratch-authoring-ui.mjs`; kontrakty `create_scratch_session_*` w `crates/fullmag-api/src/router_v2/tests.rs` |
| Primitive ferromagnetyka i translacja | PASS | świeży smoke FDM/FEM: Box `X ferromagnet`, pełna translacja `[2e-8,-1e-8,0]`; modele draft/apply i testy geometry lifecycle |
| Materiał i parametry SI | PASS | smoke zapisuje oraz odczytuje CoFeB, `Ms`, `Aex`, `alpha`, `Dind`, `Dbulk`; panelowe i API boundary tests |
| Tekstura magnetyczna Y | PASS | smoke zapisuje `Uniform Y` z kierunkiem `[0,1,0]`; testy atomic texture transaction i Python round-trip |
| Exchange i demag | PASS | smoke wykonuje off → on i sprawdza `scene.study`; `PhysicsInteractionPanel` oraz readiness tests |
| FDM global/per-object grid | PASS | smoke sprawdza `default_cell` i per-object override; `StudyGlobalAuthoringModel` oraz FDM round-trip |
| FEM policy/Airbox z pustego Universe | PASS (UI) | wybieralny `model:universe`, `FEM Airbox setup`, zapis manual policy i materializacja `model:airbox`; świeży smoke ma `fem_airbox_policy=true` |
| Study, Relax, Run i readiness | PARTIAL | readiness, study authoring, command ACK i gating są zaimplementowane/testowane; pełne solverowe wykonanie FEM wymaga managed runtime |
| Eksport Python/ProblemIR 0.3 | PASS | `test_scratch_authoring_ui_roundtrip.py`: **9 passed** przy zgodnym środowisku `uv` |
| Invalidation, revision safety i stabilność Inspectora | PASS (frontend) | targeted Vitest **21 plików / 356/356**, helper browser **7/7**, delayed-ACK regression identity/focus/scroll/opacity/animation |
| FDM/FEM browser authoring smoke | PASS | `CONTROL_ROOM_SCRATCH_BACKEND=fdm/fem` na świeżym Next/API; oba manifesty zakończone kodem `0` |
| Managed FEM `mesh_build`/`relax` i browser qualification | BLOCKED | `justfile:ensure-managed-fem-runtime` wymaga bundla; `fullmag-native.ext4` ma 0 B, brak archiwum runtime, brak ext4 mount, aktywnego bundla i obrazu `fullmag/fem-gpu:local` |

## Bramy niezaliczone

Nie wolno oznaczyć celu jako 100%, dopóki nie zostaną wykonane w kanonicznej
ścieżce container-backed `just`:

1. `just ensure-managed-fem-runtime` z poprawnym obrazem/storage;
2. managed FEM CPU `mesh_build` oraz `relax` dla tej sceny;
3. browser/WebGL qualification z manifestem `requested/effective/resolved == FEM/CPU`;
4. dowód terminalnego ACK, artefaktów i eksportu po rzeczywistym wykonaniu.

Hostowy build lub lokalny binarny smoke nie zastępuje tych bram zgodnie z
`AGENTS.md` i planem implementacji.

## Stan worktree

- Worktree: `D:/git/fullmag/worktrees/scratch-authoring-ui`
- Branch: `codex/scratch-authoring-ui`
- Ostatni commit implementacji: `eb877d930`
- Ostatnie commity dowodowe: `c125b1083`, `7e3feda3b` (ten dokument)
- Drzewo robocze: czyste.
