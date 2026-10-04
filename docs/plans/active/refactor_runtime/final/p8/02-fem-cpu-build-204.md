# P8-C — managed regresja FEM CPU, build 204

Data: 02.10.2026. Build: SUCCEEDED, exit 0. Artefakty: zweryfikowane.
Runtime, fizyka i kwalifikacja Windows: NOT VERIFIED.

Cel: sprawdzić produkcyjną kompilację oraz pakowanie istniejącego profilu
Linux FEM CPU po poprawkach konfiguracji CPU/GPU i eksportów/linkowania.
Ta próba nie kwalifikuje natywnego Windows, solvera ani fizyki.

| Pole | Wartość |
|---|---|
| Build | 204 |
| Job ID | `c13c7fd4a12c40ca82690cbeba13ec27` |
| Profile | `fem-cpu-release` |
| Source mode | commit; clean capsule, cudze dirty backendy wyłączone |
| Commit | `a55fa13d76052cdc5e3f96d8369127752061237d` |
| Source digest | `51a801b3c60c60b9644304860f7271d73e877d51b897ead2c9c4e6db8042b191` |
| Source identity SHA-256 | `2cfff7ec03faf593561c7021e8ca9076a301d28f46cc239b2477c68da284dded` |
| Capture ID | `8307a96919c248288c466d542669e520` |
| Worktree ID | `fullmag-0950f4dca4ffe38f` |
| Request key | `refactor-p8-fem-cpu-policy-a55fa13-20261002` |

Preflight koordynatora: running, worker_alive=true, accepting_jobs=true,
worker_error=null. Storage około 37,8 GB wolnego. Aktywny cudzy build 203
`d30406a2ef6d42cb9120ce04d58d646a` pozostawiono bez ingerencji; build 204
przyjęto do tej samej kolejki. Koordynator ma historyczny błąd membership
innej kapsuły; nie potraktowano go jako wyniku nowego zadania ani nie
restartowano procesu. Bieżący worker został potwierdzony jako żywy.

Użyto dostępnego zgodnego klienta kolejki z checkoutu eigensolve, z jawnym
`--worktree` wskazującym główny checkout Fullmaga. Nie zmieniono konfiguracji
runnera, profili, mountów ani image. Nie skasowano cache i nie uruchomiono
hostowego fallbacku. Sesja 3104 pozostaje zachowana.

Źródłowo profil `fem-cpu-release` wykonuje production build CLI/API i frontend
static build; nie zlecono kompilacji testów jednostkowych. Receipt końcowy
musi potwierdzić faktyczny profil, image, źródła, komendy, terminalny exit 0
i niepuste wymagane artefakty. Sam QUEUED/RUNNING nie jest PASS.

Następny krok: obserwować ten sam Job ID, odczytać terminalny receipt i logi,
sprawdzić tożsamość źródeł oraz kompletność artefaktów. Awaria ma zostać
rozpoznana przed ponowieniem. Po buildzie pozostają odrębne bramki runtime,
Windows dependency bundle/launcher/storage, instalacja i kwalifikacja lane'ów.

## Checkpoint — rozpoczęta praca

02.10.2026: ten sam job przeszedł do RUNNING, coordinator local-host,
exit_code=null. Source digest i commit pozostają zgodne z tabelą.
Potwierdzono żywy worker `aec2d9b7ff91` /
`fullmag-worker-c13c7fd4a12c40ca82690cbeba13ec27`. Proces entrypoint zawiera
właściwy job ID, source digest i profil fem-cpu-release. Log klienta oraz
stdout workera były jeszcze puste; nie dowodzą wykonania konkretnych etapów
kompilacji. Nie restartowano ani nie ponowiono próby. Wynik, receipt końcowy
i wymagane artefakty pozostają NOT VERIFIED.

Kolejna obserwacja tego samego kontenera: log workera potwierdził
`native-build` / `make install-cli-dev` zakończony exit_code=0,
duration_ms=804315.857. Rozpoczęto `frontend-dependencies` przez frozen-lockfile
install Control Room. Job nadal RUNNING. To dowód ukończenia jednej fazy
kompilacji, nie terminalnego pakietu. Zachowano worker i job ID.
Źródła są nadal dokładnie wcześniejszym commitem z tabeli; późniejsze poprawki
packagera MSI i discovery MFEM Windows nie są objęte tym buildem.

## Wynik końcowy

Ten sam job zakończył się SUCCEEDED, exit_code=0. Worker ma terminalny
receipt i zakończył proces; nie ponowiono buildu. Trzy fazy mają exit 0:

| Faza | Czas | Zakres |
|---|---|---|
| native-build | 804,3 s | `make install-cli-dev`, produkcyjne CLI/API/Python/native |
| frontend-dependencies | 470,9 s | frozen-lockfile install Control Room |
| frontend-build | 475,3 s | `make web-build-static` |

Image: `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`.
Build receipt SHA-256:
`cc1d103a59e36a250b0a2e7cadf5270ed6682589263da7e6465c060a906aa685`.
Coordinator receipt SHA-256:
`2038f21d699d1592ef0abdf5275b02ce7046bbd2a8b4283402dedcbffa3681dc`.

Receipt znajduje się w kanonicznym storage, pod
`runs/fullmag-0950f4dca4ffe38f/c13c7fd4a12c40ca82690cbeba13ec27/artifacts/build-receipt.json`.
Sprawdzono source commit, capsule digest, clean source snapshot i snapshot
SHA-256 zgodne z tabelą. Osobne `native_source_identity_sha256` w receipcie
wynosi `144fa6d843b9d2ab0bae9884bc6b5834cb88cd8cd0c24bb2eab4b480b320f73f`;
to hash serializacji rekordu identity, nie pole source_snapshot_sha256.

Niezależna kontrola na hoście zweryfikowała wszystkie **119** ścieżek,
rozmiarów i hashów SHA-256, łącznie **291 618 738 B**. Wymagane niepuste
artefakty CLI, API, Python core, `libfullmag_fem.so` i static UI istnieją.
Puste stderr logi są dozwolone i nie zostały zaliczone jako payload produktu.

Wynik potwierdza managed produkcyjny build/pakowanie profilu Linux FEM CPU
na dokładnym starszym SHA. Receipt zachowuje `qualification=NOT VERIFIED`;
nie zawiera runtime contracts ani naukowych scenariuszy. Nie dowodzi native
Windows, actual solver execution, FEM GPU, instalacji, recovery ani późniejszych
zmian MSI/discovery. Nie kompilowano testów jednostkowych. Sesja 3104 zachowana.
