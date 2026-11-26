# Aktualność suwaków wizualizacji — odbiór 07.11.2026

## Zmienione zachowanie

NumberField po zmianie zakresu, Reset albo aktualizacji zatwierdzonej wartości
pokazuje bieżące ustawienie, zamiast bezterminowo zachowywać poprzedni draft.
Dotyczy m.in. liczby, długości, grubości i opacity strzałek pola.
Zmiana powierzchnia→objętość może aktualizować budżet strzałek; kontrolka ma
pokazywać ten sam budżet, który otrzymuje renderer.

Właścicielem zatwierdzonej wartości pozostaje kontroler wizualizacji; NumberField
ma tylko lokalny draft aktywnej interakcji. Draft jest związany z value/min/max/step.
Zmiana tego wejścia zeruje draft w tym samym renderowaniu, bez remountu pola.
Unrelated renders zachowują aktywny draft. Wysyłanie jest nadal łączone w jedną
klatkę, a aktualny callback i anulowanie nieaktualnej klatki są synchronizowane
przed paint przez useLayoutEffect. Nie dodano API, pól fizycznych lub store’a.

Wariant resetu w useEffect pozostawiał starą wartość na jeden commit oraz okno
na uruchomienie starego RAF. Reset przez key remountowałby pole i gubił focus.
Wybrano warunkową aktualizację lokalnego stanu bez remountu oraz layout cleanup
zewnętrznego zasobu RAF. [React: korekta stanu po zmianie props](https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes),
[React: useLayoutEffect](https://react.dev/reference/react/useLayoutEffect).

## Zakres kodu i dowody

Commit: f6d176fb4ed53912f00c32373639d2cd2a0a79f9, wypchnięty na branch zadania.

- apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx::NumberField
- apps/control-room/src/modules/inspector/panels/ObjectVisualizationNumberField.dom.test.tsx
- apps/control-room/scripts/fixtures/inspector-actions-page.tsx
- apps/control-room/scripts/smoke-inspector-actions.mjs

| Sprawdzenie | Wynik |
|---|---|
| Pierwsza reprodukcja DOM | 3 FAIL / 1 PASS: stale draft, zakres, stary commit |
| Review wyścigu przed paint | potwierdzony; dodatkowe 3 testy FAIL przy passive effects |
| Końcowe testy NumberField i sekcji | 10/10 PASS |
| ESLint czterech plików, max-warnings=0 | PASS |
| TypeScript całego bieżącego frontendu, incremental=false | PASS |
| Niezależny review | jedyny required: timing RAF, naprawiony i pokryty RED→GREEN |
| Inspector browser CI | PASS, 9 kroków, w tym nowe Object/Airbox |
| Pełne kontrakty frontendu | PASS: TypeScript/lint, 912 plików testowych PASS, 1 skipped; 9481 testów PASS, 13 skipped; dodatkowy zestaw 3/3 PASS |
| Drugi browser job | PASS; całe CI42367863006 SUCCESS |

[CI42367863006](https://github.com/MateuszZelent/fullmag/actions/runs/42367863006)
sprawdza dokładny commit f6d176fb4ed53912f00c32373639d2cd2a0a79f9.
Browser fixture używa rzeczywistego NumberField, Slider i InspectorShell.
Keyboard commit zmienia 10→9, potem canonical value 12 i Reset 10/max20.
Asercje obejmują stabilne root/scroll viewport/input/Apply, focus i scroll,
brak unrelated disabled/opacity zmian, brak aktywnych opacity animations,
jedno wywołanie callbacku oraz mniej niż 16 commitów React przy aktualizacjach.
Stare testy pending/rejected/accepted ACK i resetu nadal przechodzą.

To kontrolowane callbacki fixture, nie ACK serwera ani naukowy end-to-end.
Wykryto zero mutujących żądań API w sprawdzanym zakresie. Zmiana nie dotyczy
cyklu WebGL i nie kwalifikuje solvera lub nowego pakietu backendu.

## Artefakty i oględziny

Dowody lokalne:
private/frontend/verification/visualization-number-field-20261107/
w control volume grupy 3203: red.log, layout-race-red.log, green-final.log,
eslint-final.log, typecheck-final.log.

Artefakt GitHub nr 13572009010, inspector-actions-browser-fixture:
717 694 B, zapisany i bezpiecznie rozpakowany pod
verification/visualization-number-field-20261107/ci-42367863006-inspector/.
artifact-manifest.json przypina wszystkie pliki. Wyświetlono i obejrzano
cztery screeny inspector-number-{object,airbox}-{ack-before,reset-after}.png:
liczby 9→10 i położenie thumb odpowiadają zakresom 1–40→1–20;
układ panelu i focus nie zmieniają się. To nie są screeny pola Oersteda.

Oryginalne 63 wpisy indeksu Git zachowano dokładnie; commit używał osobnego
indeksu obejmującego tylko powyższe cztery pliki. Brak Solve, restartu,
zmiany rezerwacji i ingerencji w dane wynikowe.
