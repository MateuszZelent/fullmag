# P8-53BY — kontrakty CI, zależność Explorera i typ limitu CPU

Data: 14.10.2026. Baza `7f76dab063982f4efe2210dd21a5ecd924c0316c`.
Status: **SOURCE CHECKS PASS; nowy wynik CI i build/runtime NOT VERIFIED**.

## Stan integracji i konkretne niepowodzenia

Commity 53BW oraz 53BX są na remote w
[PR #163](https://github.com/MateuszZelent/fullmag/pull/163), head 7f76dab0,
base c8766135. Hosted CI jest autoryzowane. Job `source-contracts`
115714136178 skompilował runnera i wykonał testy: 1778 PASS, 6 FAIL,
1 ignored. Poprzedni E0004 ustąpił, ale cały job pozostaje failed.
Niepowodzenia dotyczą brakującego storage env oraz kontraktów publikacji
antenowej; nie zaliczono ich jako odbioru runtime.

| Niepowodzenie CI | Poprawka tego przyrostu | Weryfikacja |
|---|---|---|
| `control-room-contracts` 115714136489: Unexpected production dependency `studyStageSource` | Jeden jawny wpis realnego, samodzielnego modułu do strict VM loadera; bez wildcardów lub stubu | Managed interpreted driver 31/31 PASS |
| `python-contracts` 115714136602: test wymaga natychmiastowego sąsiedztwa storage resolvera i jednego dawnego kroku; liczy display names Setup Node.js | Storage musi poprzedzać wszystkie kroki cargo test i wymagany gate. Wersje checkout/setup-node są sprawdzane na rzeczywistych YAML uses, niezależnie od etykiet kroków | Managed bootstrap 15/15 PASS |
| `generated-api-determinism` 115714136532: E0282 w dwóch cgroup quota readerach | `tightest_limit: Option<u64>` zgodnie z `CpuQuota::Limited.capacity_millis`; bez castów lub zmiany arytmetyki | Read-only Rust parser PASS; kompilacja Linux wymaga CI |

## Receipts

- Bootstrap: `cec39e98b05640209eed71f8f8145c83`, completed, exit 0,
  15 testów, zero skips. Source before=after
  `23dfe6f37133f7fae46b89612bdd3837ab12b9a41bf2008b096c6e82704507ef`.
- Explorer: `e812f744977349d5a83643d91b6c8e17`, passed, exit 0,
  31 przypadków, `emitted_code=false`, `solver_execution=false`.
  Source before=after
  `cb785807ec9a1cb001fb5e62186290919a148978953412d3ddef1b38f6f8f1a3`.
  Fingerprint checkera obejmuje wszystkie rzeczywiste źródła TS aplikacji,
  w tym `src/shared/domain/study/studyStageSource.ts`.

Nie kompilowano unit targets lokalnie. Nie zmieniano workflow ani
produkcyjnego Explorera; poprawiony został jego interpretowany driver.
Bounded review całego przyrostu: brak actionable P0/P1/P2.
Ten przyrost nie dowodzi naprawy wszystkich pozostałych niepowodzeń CI,
pełnego native buildu, nowych restore frames ani zamknięcia P8.

## Zakończone usunięcie pobocznego formatowania

Użytkownik jawnie zatwierdził „Tak, usuń tylko swoje formatowanie”. Root
ponownie zweryfikował każdy z 69 plików runnera jako dokładnie
rustfmt(aktualny HEAD), sprawdził niezmienione bajty przed zapisem i usunął
wyłącznie swój formatter output. Operacja handle 72029: terminal exit 0.
Diff runnera jest pusty; zacommitowany adaptive arm pozostał w HEAD.
Index nie został zmieniony. Wcześniejsze oczekiwanie opisane w 53BW jest
zakończone, a automatycznych odmów nie obchodzono przed uzyskaniem zgody.
Odtworzono też standardowe końce linii checkoutu przez Git filters; po
kontroli `git status --short -- crates/fullmag-runner` nie wskazuje zmian.
Canonical content jest identyczny z HEAD, nie zmieniono treści indexu.
