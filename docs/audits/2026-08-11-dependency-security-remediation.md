# Audyt remediacji podatności zależności

Data migawki: 2026-08-11

## Stan wejściowy

GitHub Dependabot zgłasza 50 otwartych alertów: 44 npm i 6 Rust. Poziomy:
30 high, 19 medium i 1 low. Wszystkie alerty odnoszą się do pnpm-lock.yaml albo
Cargo.lock.

| Pakiet | Alerty | Poziom | Wersja wejściowa | Minimum naprawione | Właściciel i ekspozycja |
|---|---:|---|---|---|---|
| next | 18 | high, medium | 15.5.21; 16.2.6 | 16.2.11 dla zgłoszonych zakresów | Bezpośredni runtime obu aplikacji webowych |
| brace-expansion | 10 | high, medium | 1.1.14; 2.1.0; 5.0.5 | 1.1.18; 2.1.4; 5.0.9 | ESLint, Redocly, TypeScript ESLint i Storybook; narzędzia developerskie |
| postcss | 4 | high, medium | 8.4.31; 8.5.14 | 8.5.23 | Next, Tailwind i Vite; build/runtime CSS |
| js-yaml | 3 | high, medium | 4.1.1 | 4.3.1 | ESLint i Redocly; narzędzia developerskie |
| nanoid | 3 | high | 3.3.12; 5.1.9 | 3.3.17; 5.1.16 | Next/PostCSS oraz bezpośrednio legacy web |
| image-size | 2 | high | 2.0.2 | brak | vite-plugin-storybook-nextjs przez devDependency Storybook; brak produkcyjnego importu |
| vite | 2 | high, medium | 8.0.10 | 8.0.16 | Vitest i Storybook; narzędzie developerskie |
| pyo3 | 2 | high, medium | 0.24.2 | 0.29.0 | Bezpośrednio fullmag-py-core; runtime bindingów Python |
| @babel/core | 1 | low | 7.29.0 | 7.29.6 | Storybook i ESLint React Hooks; narzędzie developerskie |
| echarts | 1 | medium | 6.0.0 | 6.1.0 | Bezpośredni runtime obu aplikacji webowych |
| sharp | 1 | high | 0.34.5 | 0.35.0 | Przechodnio przez Next; optymalizacja obrazów |
| glib | 1 | medium | 0.18.5 | 0.20.0 | Linux desktop przez Tauri 2.11.2 i GTK3 |
| quinn-proto | 1 | high | 0.11.14 w Cargo.lock | 0.11.15 | Brak ścieżki w cargo tree także dla target all; osierocony wpis lockfile |
| serde_with | 1 | medium | 3.20.0 | 3.21.0 | Tauri utils; desktop i build desktop |

## Identyfikatory alertów

- nanoid: 75, 79, 80.
- js-yaml: 31, 46, 78.
- image-size: 76, 77.
- postcss: 9, 65, 66, 74.
- brace-expansion: 23, 33, 44, 45, 68, 69, 70, 71, 72, 73.
- next: 35-43 oraz 49, 50, 52, 54, 56, 58, 60, 62, 64.
- sharp: 47.
- vite: 26, 27.
- pyo3: 24, 25.
- quinn-proto: 34.
- serde_with: 32.
- echarts: 30.
- @babel/core: 28.
- glib: 1.

## Wnioski o ekspozycji

Najwyższy priorytet mają Next, sharp, ECharts, nanoid 5 i PyO3, ponieważ są
częścią grafu runtime. PostCSS i nanoid 3 są wprowadzane zarówno przez Next,
jak i narzędzia buildowe. Pozostałe podatności npm są głównie w narzędziach
developerskich, ale pozostają naprawialne i nie powinny być ignorowane.

image-size jest osiągalny wyłącznie przez vite-plugin-storybook-nextjs 3.3.0,
który należy do devDependency @storybook/nextjs-vite. Repozytorium nie importuje
image-size ani jego funkcji bezpośrednio. Alert nie ma wersji naprawionej, więc
nie może zostać uczciwie oznaczony jako naprawiony. Remediacja ma najpierw
sprawdzić nowszego właściciela lub usunięcie pluginu; pozostawienie jest
dopuszczalne wyłącznie jako dev-only bez produkcyjnego przetwarzania obrazów.

glib 0.18.5 pochodzi wyłącznie z linuxowego stosu GTK3 używanego przez Tauri.
Nie można bezpiecznie wymusić glib 0.20 override'em, ponieważ generacja GTK jest
sprzężona wersjami. Naprawa wymaga wersji Tauri/Wry przechodzącej na zgodną
generację GTK albo zmiany backendu desktopowego.

quinn-proto 0.11.14 pozostaje wpisem Cargo.lock, ale cargo tree nie znajduje
żadnego aktywnego konsumenta nawet z target all. Należy usunąć wpis przez
przeliczenie lockfile, a nie dodawać sztuczną zależność.

## Planowane wersje docelowe

- Control Room: Next 16.2.11, eslint-config-next 16.2.11, ECharts 6.1.0.
- Legacy web: poprawiona wersja Next zgodna z React 19, nanoid 5.1.16,
  PostCSS co najmniej 8.5.23 i ECharts 6.1.0.
- Graf przechodni npm: brace-expansion 1.1.18, 2.1.4 i 5.0.9; js-yaml 4.3.1;
  nanoid 3.3.17; Vite co najmniej 8.0.16; Babel core co najmniej 7.29.6;
  sharp co najmniej 0.35.0.
- Rust: PyO3 0.29.0, serde_with co najmniej 3.21.0, quinn-proto usunięty lub
  co najmniej 0.11.15, glib co najmniej 0.20.0 przez kompatybilnego właściciela.

## Status

| Etap | Implementacja | Weryfikacja | GitHub |
|---|---|---|---|
| Inwentaryzacja | zakończona | grafy pnpm i Cargo odtworzone | 50 otwartych |
| npm | naprawialne wersje zaktualizowane; image-size pozostaje dev-only bez poprawki | pnpm audit prod: 0; Control Room typecheck i webpack build: pass; pełne testy odtwarzają 18 bazowych failures, jeden niestabilny test przeszedł w izolacji; lint odtwarza identyczne 4 błędy i 7 ostrzeżeń bazowych; legacy blokują brakujące moduły debug obecne w bazie | nieprzeliczone |
| Rust | PyO3 0.29.2, quinn-proto 0.11.15 i serde_with 3.21.0; glib 0.18.5 pozostaje upstream blocker Tauri/GTK3 | fullmag-py-core cargo check: pass; test compile potwierdza migrację Python::initialize i zatrzymuje się wyłącznie na bazowym fixture MeshIR; cargo-audit niedostępny | nieprzeliczone |
| Końcowa kwalifikacja | nie rozpoczęta | nie rozpoczęta | nieprzeliczone |

## Ograniczenia po etapie Rust

PyO3 0.29.2 kompiluje produkcyjny crate fullmag-py-core bez zmian publicznego
API. Jedyna wymagana migracja testowa to oficjalna zmiana nazwy inicjalizacji z
prepare_freethreaded_python na Python::initialize. Kompilacja testów przechodzi
przez tę zmianę i zatrzymuje się na dwóch istniejących polach starego fixture
MeshIR: elements i boundary_faces, które nie należą do remediacji zależności.

Próba punktowej aktualizacji glib do 0.20.0 została poprawnie odrzucona przez
resolver: gtk 0.18.2 wymagany przez Tauri 2.11.2 deklaruje glib z linii 0.18.
Naprawa wymaga skoordynowanej migracji całego linuxowego backendu GTK/Tauri;
override pojedynczego crate'a byłby niezgodny ABI. Alert pozostaje otwarty z
właścicielem fullmag-desktop i warunkiem zamknięcia: wydanie Tauri/Wry zgodne z
GTK-rs 0.20 lub migracja backendu desktopowego.
