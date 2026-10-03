# P8-27 — kompletna trasa workspace w pakiecie

## Problem i zmiana

Native CLI/desktop otwierają `/workspace?fullmag_api_instance=<UUID>`, podczas
gdy wcześniejsze bramki pakowania wymagały tylko rootowego `index.html`.
Nie dowodziło to obecności strony otwieranej przez launcher. Static export
Control Room ma `trailingSlash: true`, więc wymaganą stroną jest
`workspace/index.html`.

Wspólny staging runtime Node wymaga teraz niepustych, regularnych stron
`index.html` i `workspace/index.html`, bez przejścia przez link, przed
kopiowaniem plików bootstrapu. MSI, producent i walidator portable oraz
kontrole archive release wymagają workspace. Nie zmieniono trasy ani
publicznego kontraktu API.

Release Windows/Linux korzysta ze wspólnego stagingu zamiast ręcznej kopii
części plików. Poprzednia ręczna kopia pomijała importowany
`scripts/dev-server-public-origin.mjs`. Nowa ścieżka kopiuje kompletny
deklarowany runtime bootstrapu, z weryfikacją hashów.

## Dowody i granice

- Interpretowane kontrole pakietu i kontraktu release: 24 PASS, 8 subtests
  PASS; receipt `37ad1ac3f2914dbf8e9abd7fb27a6d66` w profilu
  `windows-control-room-source-check/static-package`.
- Fixture skopiowanego serwera Node, w katalogu ze spacjami, obsługuje root,
  asset i `/workspace` bez checkoutu aplikacji. Dodatkowa kontrola zachowania
  `fullmag_api_instance` w URL: PASS,
  receipt `3d1dd9b445464616a264aba740b6afbc` z hashami źródeł.
- Brakująca, pusta lub katalogowa strona workspace odrzucana przed kopiowaniem
  bootstrapu. Test rzeczywistego bloku producenta MSI kopiuje stronę workspace
  i wszystkie pliki runtime.
- PowerShell parser MSI, YAML parser release i Bash syntax obu skryptów: PASS.
- Nie kompilowano testów jednostkowych ani produktu. Test HTTP używa HTML
  fixture, nie realnego React/viewportu ani procesu API. Browser/WebGL,
  clean install/upgrade/rollback, bieżący pełny build i solver: NOT VERIFIED.
- Niezależne bounded source review: PASS, brak P0/P1. Potwierdzono mapowanie
  Next export na native URL, kompletną closure bootstrapu i bramki producentów.

To fragment bramki artefaktów P8-C. Nie zamyka dystrybucji Windows ani całego
P0–P8. Nadal pozostają domyślne zasoby usługi, accepted execution cutover,
managed build i wymagane dowody runtime/nauki/wydania. Sesja 3104 zachowana.
