# P8-A — usunięcie archiwalnej kopii legacy web

Data checkpointu: 26.09.2026.

## Zakres

Usunięto 981 śledzonych plików spod `_to_delete_legacy_web`. Katalog był
archiwalną kopią starego frontendu; aktywne skrypty root `web:dev`, `web:build`
i `web:typecheck` wskazują `apps/control-room`, a `apps/web/dev-server.mjs`
pozostaje shimem uruchamiającym Control Room.

Usunięcie zostało jawnie zaakceptowane przez użytkownika 26.09.2026. Nie objęło
`apps/control-room`, `apps/web`, historycznego inventory P0 ani zewnętrznych
klientów API.

## Weryfikacja

- `git ls-files _to_delete_legacy_web`: 981 śledzonych ścieżek przed commitem,
  wszystkie oznaczone jako usunięte;
- katalog `_to_delete_legacy_web` nie istnieje w working tree;
- poza historycznym inventory P0 oraz rejestrem decyzji nie ma aktywnej
  referencji repozytorium do tej ścieżki;
- właściwe kontrole backendu/runtime bieżącego przyrostu pozostają zielone;
  usunięty katalog nie jest częścią aktywnego workspace ani tras builda.

## Granica dowodu

To jest częściowy cutover P8-A. Nie dowodzi usunięcia legacy writerów backendu,
zgodności klientów zewnętrznych, gotowości paczek, pełnej macierzy CAE ani
kwalifikacji wydania. Te bramki pozostają otwarte.