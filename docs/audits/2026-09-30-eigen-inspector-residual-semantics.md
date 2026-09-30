# Inspector modu — semantyka residuali

W panelu Eigen Mode pojedynczy Residual łączył residual_norm metadanych modu
z wartością wykresu. Kanoniczny residual_norm jest aliasem bezwzględnego L2;
wartość wykresu może być aliasem różnego typu. Brak jawnego relative L2 i scope
utrudniał ocenę jakości rozwiązania względem tolerancji.

Dodano wspólny adapter eigenResidualSummary i osobne wiersze: bezwzględny L2,
względny L2, zakres residualu oraz wartość widma o nieokreślonym typie.
Adapter wymaga skończonych nieujemnych liczb. Nie przelicza residuali między
normalizacjami, nie przyznaje kwalifikacji i nie wyprowadza scope z magnitudy.
Brak lub nieznany scope pozostaje Not available. Dane nadal pochodzą z
istniejących resource hooks; brak nowych endpointów i zmian OpenAPI.

Dowody: siedem testów Node PASS; strict TypeScript nowego adaptera PASS;
syntax check dokładnego staged panelu PASS; API i architecture hygiene PASS
po uruchomieniu z katalogu aplikacji. React Doctor 0.9.12 staged/files exit0:
dwie wcześniejsze uwagi poza zmienionymi liniami (eksport identity helpera,
lista akcji). Początkowy architecture check wykonany ze złego cwd był
nieważny i został zastąpiony właściwą kontrolą.

NOT VERIFIED: pełny typecheck aplikacji i browser/render; w worktree brak
kompletnych zależności aplikacji. Użyto wyłącznie już zainstalowanego TypeScript
oraz React Doctor z głównego checkoutu, bez kopiowania lub instalacji pakietów.

Luka S07: metadata writer modal_manifest nie publikuje block_residuals.scope.
Ten fragment uczciwie prezentuje brak danych; nie implementuje jeszcze
propagacji natywnego certyfikatu przez writer/API. Kolejny krok: powiązać
certyfikat v3 z tożsamością próbki/modu i wystawić go w właściwym zasobie,
z walidacją kontraktu, runtime oraz browser proof.
