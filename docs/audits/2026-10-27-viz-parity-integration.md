# PR #264 — poprawki regresji i integracja

## Cel i źródła

Zachować zmiany `codex/viz-parity-20261025`, naprawić dwa P1 z review,
zweryfikować wynik z aktualnym `master` i scalić PR #264.
Baza zadania: `55266d541f2f824dfd3b25a670bc846fc42aefd6`.
Master przy rozpoczęciu: `5c5e072314fad6d3037ee064566dd07c7757d6ca`.
Izolacja: `worktrees/viz-parity-fixes-20261027`, owner Codex
`01a17c4c-9f0c-7d91-a8d4-a93507d9135c`. Pierwotne worktree i grupy
innych właścicieli pozostają chronione.

## Etapy i kryteria

1. Naprawić AABB cylindrów i wykazać RED/GREEN dla osi ukośnej,
   osi X/Y/Z oraz osi prawie równoległej do osi świata.
2. Usunąć nakładające się mutable slices z równoległej budowy kernela,
   zachować wartości, znaki, padding i brak alokacji per komórka.
3. Połączyć aktualny master; wykonać review, dozwolone kontrole źródeł,
   build aplikacji w osobnej grupie Compose i wymagane dowody UI/runtime.
4. Zaktualizować PR #264, przejść wymagane kontrole, scalić, potwierdzić
   lokalny master i wykonać cleanup wyłącznie własnego worktree.

Zakaz kompilacji testów jednostkowych Rust pozostaje w mocy.
Brak dowodu runtime, WebGL lub numerycznego nie jest wynikiem pozytywnym.

## Etap 1 — granice cylindrów

`fullmag.meshing.voxelization::_geometry_bounds` sumuje projekcję promienia
oraz połowy wysokości. Norma dwóch poprzecznych składowych osi unika utraty
precyzji w odejmowaniu `1 - a_i^2` przy prawie osiowym cylindrze.

Nowy `test_voxelization_cylinder_bounds.py`: cztery testy, przed poprawką
pięć nieudanych asercji (w tym subtesty), po poprawce wszystkie przechodzą.
Sprawdzono też trzy istniejące testy: pierścień na osi X, maskę cylindra oraz
zgodność fingerprintu Difference/Translate. Razem 7 testów PASS.
Testy użyły publicznego modelu geometrii i rzeczywistej woksylizacji,
bez buildu ani instalowania zależności na hoście. Kontrola diffu PASS.
To dowód geometrii źródłowej, nie kwalifikacja solvera.

## Etap 2 — własność buforów Newell

`newell.rs::split_kernel_plane_regions_mut` rozdziela przez `split_at_mut`
płaszczyznę zerową, dodatnie płaszczyzny oraz region ujemny z pominięciem
środkowego zerowego paddingu. `kernel_planes_mut` przekazuje każdemu workerowi
wyłącznie jego płaszczyzny. Tensor jest liczony raz na komórkę, bez dodatkowych
alokacji per komórka. Usunięto `UnsafeSyncSlice` i tworzenie nakładających się
referencji `&mut` z surowych wskaźników.

Dodany test Rust porównuje sześć składowych z bezpośrednią całką par komórek,
padding i wynik na 1 oraz 4 wątkach. Test pozostaje **NOT VERIFIED** — nie
był kompilowany ani wykonywany z powodu zakazu kompilacji testów.
`rustfmt --check`, `git diff --check` i niezależny review źródeł: PASS.
Review sprawdził też przypadki `nz=0,1,2`, bez twierdzenia o dowodzie runtime.

## Integracja i kontrole

- Etap geometrii: `eafe4811690b2c554ac377954844a1a3d3a374a4`.
- Połączenie mastera: `4d0590cf56c28f60c6eeeb5aac1148c050d90b3b`, bez konfliktów.
  Zachowane poprawki mastera dotyczące retirement i pojedynczego komunikatu
  o błędach pola w viewportcie.
- 73 testy Python dotyczące retirement i 7 testów readiness: PASS.
- Walidator zmienionej dokumentacji naukowej: PASS.
- Hook commita merge wykonał React Doctor, ale jego lint zakończył się błędem
  narzędzia `Unexpected discriminant 7 for TSTypeName`; wynik jest niepełny.
  Nie traktować tego skanu jako zielonego dowodu UI.

## Blokada zarządzanego buildu

Grupa: `fullmag-worktree-viz-parity-fixes-20261027-5b749a9673c78c81`.
Toolchain, obraz development i obraz backendu przygotowane przez launcher
w Docker BuildKit. Nie zbudowano jeszcze aplikacji backendowej.

Próba startu `7d885a90260f4943bd23de9d3f96b055` zakończyła się
`outcome-unknown-resources-retained` podczas tworzenia sieci
`fullmag-net-7fe412b3870c5c8a`:

> all predefined address pools have been fully subnetted

Wolumen kontrolny:
`fullmag-build-control-fullmag-worktree-viz-parity-fixes-20261027-5b749a9673c78c81-7fe412b3870c5c8a`.
Szczegóły buildu i receipty pozostają w tym wolumenie, bez kopiowania do
hostowego storage. Nie ponowiono niejednoznacznego startu ani nie usuwano
cudzych sieci, kontenerów, cache lub wyników. Istniejący launcher nie oferuje
konfiguracji jawnego subnetu dla pojedynczej grupy.

## Retencja etapu

Własne obrazy BuildKit i wolumen kontrolny pozostają potrzebne do wznowienia
oraz zachowania receiptów. Wolumeny build/package nie mają jeszcze
zweryfikowanego następcy, więc nie kwalifikują się do usunięcia. Rejestr
worktree otrzymuje stan `blocked` do wyjaśnienia blokady. Główny ext4 przy preflight
miał około 3.4 GiB wolnego; build-data nadal należą do wolumenów Docker,
nie tego hostowego katalogu. Nie wykonano prune ani usuwania danych.

## Stan

**BLOCKED przed merge**: potrzebna zgodna ścieżka odzyskania nieudanego
startu grupy. Następnie build aplikacji,
kontrole frontendu, runtime/browser/WebGL, CI i merge PR #264. Poprawki
źródłowe oraz review nie zastępują tych brakujących dowodów.

## Checkpoint końcowy próby

Poprawka kernela i raport: `24d6ba876f788b4dd4d70ed813a69272eaa0643a`.
Commity źródłowe wypchnięto zwykłym fast-forward na branch PR #264.

Usunięto wyłącznie pustą sieć `fullmag-net-ee53e6fda06a6b8e`
(ID `1b7b3c89db15e18a2f0a985d2a07a89d5ad2bf7b6ce9da6873e8f8e0f5b82dec`).
Rejestr `storage/index/design-pr268-fixes-20261026.task.json` potwierdzał
`completed`, merged PR #272, runtime i worktree usunięte; bezpośrednio przed
operacją powtórnie potwierdzono zero endpointów i zero kontenerów projektu.
Nie usuwano żadnych wolumenów ani danych użytkownika. To usunięcie pozostałej
sieci, nie globalny prune ani cleanup innych danych.

Po potwierdzeniu braku backendu i frontendu zadania podjęto jedną próbę `up`.
Launcher odmówił przed mutacją:

> DEV control volume has an active operation but no services; daemon outcome is unknown and resources were retained

Odczyt oryginalnego receipt potwierdza brak `backend_container`,
`frontend_container` i `config_sha256`; aktywny helper
`fullmag-control-7d885a90260f4943bd23de9d3f96b055` zachowuje lease.
Nie usunięto markera `active`, nie nadpisano receipt i nie przejęto ownera.
Istniejące trasy resume/recreate wymagają receiptów i usług, których ten start
nie utworzył; legacy orphan recovery jawnie nie kwalifikuje volume-only DEV.
Potrzebne jest obsługiwane, przypięte odzyskanie nieudanego startu przed
utworzeniem usług, z zachowaniem receiptów. Nie uruchamiać obejścia w obcej
grupie ani hostowego Cargo.

Review obu poprawek: brak actionable findings. Lokalne kontrole Python:
7 geometrii + 73 retirement + 7 readiness = 87 PASS. CI uruchomione dla
commita źródłowego; w chwili checkpointu część workflow nadal trwała.
Aplikacja backendowa, pełne kontrole frontendu, runtime, WebGL i test Rust
pozostają **NOT VERIFIED**. PR nie został scalony, master nie był zmieniany.
