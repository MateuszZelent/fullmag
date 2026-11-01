# Jeden prywatny wolumen DEV — plan wykonania

Cel: wdrożyć decyzję użytkownika bez naruszenia cudzych zasobów.
Architektura: istniejący group control volume + ograniczone subpathy, wspólne pakiety/Cargo/pnpm bez zmian.
Specyfikacja: ../specs/2026-10-31-single-private-dev-volume-design.md

- [x] Przegląd AGENTS, instrukcji, skilli i kontraktów storage; izolowane zarejestrowane worktree.
- [x] Stabilny adapter grupy, markery właściciela i rozdzielone mounty z testami.
- [x] Backend cache: jeden wolumen, stabilny unit pakietów, zgodność legacy i atestacja subpath.
- [x] Integracja launchera, frontend seed i ledger; lekkie testy Python/Linux.
- [x] Czyszczenie compiler outputs przed kompilacją i po zweryfikowanej publikacji; cross-toolchain rollback i testy POSIX.
- [x] Retencja końcowa nowego układu; zachować control/ledger/provenance, nie usunąć wspólnego wolumenu.
- [x] Source-only Compose identity i odpięcie zbędnego storage hosta z toolchain-only.
- [x] Przegląd całości, testy regresji, check kontekstów obrazów, linków i diff.
- [ ] Commit, PR/CI/integracja według AGENTS; bez restartowania obcych grup.

Ryzyka do sprawdzenia: mount root zamiast subpath; aktywny użytkownik cache; symlink prowadzący poza cache; zmiana ABI przy zachowanym unit; przerwana publikacja/cleanup; nieznane pliki w shadow workspace; pomylenie hostowych wyników z danymi builda. Testy nie kompilują natywnych unit tests.
