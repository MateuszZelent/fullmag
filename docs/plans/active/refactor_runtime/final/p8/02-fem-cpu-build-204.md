# P8-C — managed regresja FEM CPU, build 204

Data: 02.10.2026. Status w chwili zlecenia: QUEUED. Wynik: NOT VERIFIED.

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
