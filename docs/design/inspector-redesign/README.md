# Makieta: szklany Control Room i jeden szablon Inspectora

Interaktywna makieta docelowego wyglądu Fullmag Control Room. Jest punktem odniesienia dla
[reguł frontendu](../../../.agents/instructions/frontend.md) oraz specyfikacji
[09](../../specs/frontend-v2/09-css-design-system.md), [10](../../specs/frontend-v2/10-shell-menu-and-navigation.md),
[11](../../specs/frontend-v2/11-explorer-view.md) i [13](../../specs/frontend-v2/13-inspector-and-property-editing.md).
Wyznacza minimalny poziom jakości; implementacja może go przewyższyć.

## Uruchomienie

Makieta ma własne zależności npm i nie należy do workspace pnpm ani do buildu aplikacji.

```powershell
Set-Location docs/design/inspector-redesign
npm ci
npm run dev        # serwer deweloperski Vite
npm run build      # jeden plik dist/index.html (vite-plugin-singlefile)
```

## Co pokazuje

- **Powłoka:** pasek instancji, pasek aplikacji z menu głównym (pozycje z `appMenuModel.tsx`), ribbon z grupami
  opartymi na `ribbonTabViews.tsx`, lewa i prawa listwa ikon w stylu Photoshopa, dok na pełną szerokość
  (Telemetry, Problems, Logs, Operations, Engine, Quick chart) i pasek statusu.
- **Inspector:** 12 widoków (obiekt, materiał, tekstura, wizualizacja, moment SOT, pole zewnętrzne, Airbox,
  siatka, monitor płaski, Relax 2, Run 4, ustawienia 3D View) renderowanych przez jeden `InspectorTemplate`
  ze specyfikacji w `src/inspector/specs.tsx`.
- **Okna:** paleta poleceń Ctrl+K (węzły, pola, akcje), karty definicji symboli fizycznych, menu jednostek,
  biblioteka materiałów, menu kontekstowe pól i drzewa, potwierdzenia, podgląd JSON i Python, arkusz
  porównania z obecnym inspektorem (`public/before/*.webp`), toasty.
- **Motywy:** Catppuccin Latte i Mocha, wybór System/Jasny/Ciemny; strona respektuje też `data-theme`
  ustawione przez hosta.

## Struktura

| Ścieżka | Zawartość |
|---|---|
| `src/index.css` | tokeny (Catppuccin, szkło, pola, uniesienie, kolory domen), narzędzia `glass`, animacje |
| `src/lib/format.tsx` | formatowanie liczb i jednostek, skala cieni `SHADOW` (beautiful-shadows) |
| `src/inspector/types.ts` | kontrakt specyfikacji Inspectora (`Spec`, `Section`, `Row`, `Notice`) |
| `src/inspector/InspectorTemplate.tsx` | szablon: nagłówek, fakty, karty, komunikaty, sekcje, pasek zmian |
| `src/inspector/controls.tsx` | `PropertyRow` i kontrolki pól |
| `src/inspector/specs.tsx` | specyfikacje 12 widoków |
| `src/inspector/state.ts` | szkice, oryginały, walidacja, zatwierdzanie |
| `src/shell/` | powłoka: pasek instancji, pasek aplikacji, ribbon, listwy, panele, dok, pasek statusu |
| `src/viewport/Viewport.tsx` | ilustracyjny podgląd ściany domenowej (canvas 2D) |
| `src/components/ui/` | komponenty shadcn/ui (Radix) dodane przez CLI, plus `segmented.tsx` |

## Dane

Prawdziwe wartości pochodzą z działającej sesji `fdm_stt_pma_pulse` i z kodu: Mₛ 521 kA/m,
A_ex 1.5 × 10⁻¹¹ J/m, α 0.045, J 2.6 × 10¹⁰ A/m², ξ_DL −0.21, siatka 512 × 256 × 1, komórka 3.125 nm,
LLG + RK23, czas 7.65 ns, ⟨mx⟩ 0.0411, ⟨my⟩ 0.999, lista etapów i błędy Relax 2. Przykładowe są: pole
zewnętrzne, monitor płaski, biblioteka materiałów, tolerancje, czas trwania Run 4, część telemetrii,
logi, zasoby GPU, wyniki, wykresy i podgląd ściany domenowej.

## Wnioski z przeglądu makiety

- W jasnym motywie pola nie mogą być białe: pola są wklęsłe, zaznaczenie jest uniesione.
- Style bazowe aplikacji osadzanej obok obcego resetu CSS muszą być poza `@layer`, inaczej reset wygrywa.
- Telemetria pokazuje tylko porównania z fizycznym sensem; bez pasków udziału składników energii.
- Pasek narzędzi viewportu jest u góry, dok ma pełną szerokość między listwami.
