# P6-D — resource hooks trwałych ramek obserwacji

Data: 29.09.2026
Status: **TYPECHECK/LINT PASS, REGRESJE ZAPISANE / NOT RUN**

## Zakres

Control Room ma jeden zestaw resource hooks dla publicznego kontraktu
observation frames:

- katalog z exact `run_id`, filtrem stage i immutable cursorem,
- descriptor wybranej ramki,
- historyczną magnetyzację z kanonicznego FMVP v4.

Każdy klucz przechodzi przez `useSessionScopedResourceKey`, więc zawiera
tożsamość sesji i epoch. Zmiana frame ID przerywa stary inflight request. Klucz
listy ma stabilną kolejność parametrów i nie rozdziela równoważnych zapytań.
Freshness descriptorów obejmuje `frame_id`, runtime epoch i accepted revision.
Ciężkie pole preferuje `field_generation_id` zakodowane w FMVP v4, z ETag jako
fallbackiem transportowym.

Hooki używają wyłącznie `ControlRoomApi.data.observationFrames`; nie tworzą
bezpośredniego `fetch`, osobnego klienta, store'a globalnego ani drugiego codec.

## Dowody

- `pnpm --dir apps/control-room typecheck`: **PASS**,
- scoped ESLint obu nowych plików: **PASS**,
- `git diff --check`: **PASS**.

Regresje czystych identity/revision helperów zostały zapisane, ale nie są
uruchamiane zgodnie z aktywnym zakazem kompilacji testów jednostkowych.

## Granica

Przyrost daje kanoniczną warstwę pobierania. Nie zmienia jeszcze wyboru source
w Explorerze, nie przypina ramki w workspace, nie podłącza jej do viewportu ani
wykresu i nie stanowi browser/WebGL proof. Te elementy wymagają osobnej zmiany
interakcji i dowodu wizualnego.

P6 rośnie z **1% do 2%**. Cały plan pozostaje około **49%**.
