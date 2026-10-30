# I5 — preflight integracji aktualnego mastera, 28.10.2026

Remote master potwierdzony przez git ls-remote: `2c67d8f904b1dede9268bbbc8bf6257cbe33aa4f`. Preview wykonano na `0a02ca80970d69c4246f6c9573a1eababd423c98`, merge-base `1afcb531630d6cd5b8caba1f8a4d4593bb29cdb7`. Branch ma 139 własnych commitów, master 215 commitów spoza brancha. Incoming diff obejmuje 583 pliki. Liczby commitów nie mierzą ukończenia funkcji.

Git hosta 2.34.1 nie obsługuje merge-tree --write-tree. Pierwsza próba zakończyła się na usage, bez zmiany źródeł. Wykonano zgodny odczytowy git merge-tree base head master. Preview wskazał 78 ścieżek z nakładaniem zmian i 12 ścieżek z tekstowymi znacznikami konfliktów:

- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- `apps/control-room/src/kernel/commands/projectWorkspaceCommandPolicy.ts`
- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- `crates/fullmag-api/src/live_retirement.rs`
- `docs/guides/docker-volume-development.md`
- `scripts/docker_dev.py`
- `scripts/docker_dev_codegen.py`
- `scripts/docker_volume_activate.py`
- `scripts/docker_volume_dev.py`
- `scripts/test_docker_live_retirement.py`
- `scripts/test_docker_retirement_refusal.py`
- `scripts/test_docker_volume_readiness_receipt.py`

To preview starego merge-tree, a nie certyfikat pełnej strategii merge ani kompletny wykaz konfliktów rename/binary. Nie utworzono merge commit, nie zmieniono brancha ani indeksu. Status Git przed/po był identyczny. Incoming master nie dotyka obu zmodyfikowanych plików cudzej pracy: audytu shared-domain-assembly-publication oraz planu runtime-to-results-refactor; ich bajtów ani stagingu nie zmieniano. Przed właściwym merge trzeba ponownie sprawdzić stan, untracked collisions, aktualny ref i instrukcje z mastera.

Następny krok I5: zachować zawartość obcej pracy i wykonać kontrolowaną integrację mastera na branchu zadania z semantycznym rozwiązaniem konfliktów. Klient API musi zachować nowe upstreamowe kontrakty oraz scoped file imports i zakaz automatycznego Compute Fields przy forbidden commandability. Launcher musi zachować upstream recovery/identity guards oraz nowy klucz generacji zamrożonej konfiguracji frontendu. Po integracji wymagane CI i odbiór runtime; nie wolno opierać merge do mastera na testach starszego drzewa.

Docker nadal nie odpowiada. Nie restartowano współdzielonego środowiska i nie uznano I3/I4/I5/I7 za zamknięte. Wyniki signed15 i screenshoty są zachowane. Szczegóły: [dowód JSON](2026-10-28-eigensolve-master-integration-preflight.evidence.json).
