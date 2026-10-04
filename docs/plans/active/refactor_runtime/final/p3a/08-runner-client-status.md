# Runner: zgodność klienta i blokada miejsca

Data obserwacji: 22.09.2026, odpowiedź health około 06:40 UTC.
Źródła zadania: `C:/git/fullmag/fullmag`, branch `master`, HEAD
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`, dirty working tree.

## Korekta diagnozy

`Container profile allow-list mismatch` w kliencie mastera nie dowodzi awarii
runnera ani wycofania profilu. Profil `fem-cpu-slepc-runtime-v1` został dodany
w commicie `a020f46f0829362d942b7eeebbdd923afcc6f0f2` na linii
`codex/eigensolve-dispersion-plan-20260912`; commit nie jest przodkiem
bieżącego HEAD mastera. Istniejący runner jest skonfigurowany dla siedmiu
profili i wykonuje zadanie używające tego dodatkowego profilu.

Nie należy zmniejszać współdzielonej listy profili do sześciu tylko po to,
aby pasowała do katalogu starszego klienta. Nie zmieniono konfiguracji,
tokena, walidatorów ani kontenera.

## Zweryfikowana trasa odczytu

Zgodny klient istnieje w zarejestrowanym checkoutcie
`C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`, HEAD
`7d9b4b672dde34ab8ee1f55da98069ed264a69c4`. Jego pliki klienta, container_client
i resolvera nie miały zmian według ograniczonego git status. Nie jest to
deklaracja czystości całego tamtego worktree.

```powershell
python -B C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912/scripts/local_runner_cli.py --worktree C:/git/fullmag/fullmag container-status
```

Polecenie zakończyło się exit 0 po standardowej walidacji tożsamości kontenera
i uwierzytelnionym odczycie health. Uruchomienie jako właściciel repozytorium
wymagało zatwierdzonej eskalacji sandboxa; nie zmieniano `safe.directory`.
Jawne `--worktree` wskazuje źródła naszego zadania, niezależnie od lokalizacji
klienta. Ta trasa nie stanowi fallbacku do ręcznego Dockera ani hostowego buildu.

| Obserwacja | Wynik |
|---|---|
| Kontener | `Fullmag_build_runner`, running |
| Image | `sha256:e2e10abd7d0c425111c8c91f2031b2144ecaebefadafae8f067f32111b139cf8` |
| Health | `ok=true`, `worker_alive=true`, `accepting_jobs=true`, brak worker_error |
| Aktywny job | `6b2de4a74bf64669ae0e92610b1bb078`, state `running` |
| Profil aktywnego joba | `fem-cpu-slepc-runtime-v1`, inny worktree |
| Wolne storage | `1855225856` B, około 1,73 GiB |
| Kwalifikacja runnera | `NOT VERIFIED`, zgodnie z odpowiedzią health |

`coordinator.active_job_ids` było puste, ale `health.active_jobs` zawierało
powyższy działający job. Nie interpretowano pustej pierwszej listy jako
braku aktywnej pracy.

## Co blokuje build zadania

`build_executor.py` zarówno w masterze, jak i zgodnym kliencie wymaga co
najmniej 8 GiB wolnego miejsca przed uruchomieniem buildu. Odczyt pokazuje
wartość poniżej progu. Nie zgłaszano nowej kapsuły ani builda i nie
zatrzymywano cudzego zadania.

Próba read-only `retention-plan` przez zgodny klient zakończyła się
`Runner API request timed out`, exit 1. Nie uzyskano inventory ani listy
bezpiecznych kandydatów do usunięcia. Timeout nie jest dowodem zakończenia
skanowania po stronie serwera i nie upoważnia do restartu lub kasowania.

Następny krok dla builda: potwierdzić zakończenie aktywnej pracy i dostępność
co najmniej 8 GiB, następnie zgłosić snapshot mastera przez ten zgodny klient
z jawnym `--worktree` oraz kompletną listą wymaganych untracked wejść.
Oczyszczenie współdzielonych danych wymaga osobnej klasyfikacji i autoryzacji.
Aktualny brak builda/runtime pozostaje `NOT VERIFIED`; poprawny health nie
kwalifikuje zmian API, nauki ani wydania.
# Odczyt 23.09.2026 — build inkarnacji scope

Zgodny klient pokazał zdrowego workera i około 49,8 GB wolnego storage;
profil `fem-cpu-slepc-runtime-v1` był zajęty przez inne zadanie. Próba
`fdm-cpu-release` została odrzucona lokalnie, ponieważ ten profil nie ma
przypisanego obrazu builda. Następnie przygotowano migawkę aktualnego,
zanieczyszczonego `mastera` z jawną listą 34 nieśledzonych plików i zgłoszono
`fem-cpu-release`. API runnera zwróciło HTTP 413, a lista jobów nie zawiera
nowego zadania z tego checkoutu. Nie ponawiano zgłoszenia ani nie zmieniano
konfiguracji współdzielonego runnera. Ten przyrost nie ma dowodu kompilacji.
