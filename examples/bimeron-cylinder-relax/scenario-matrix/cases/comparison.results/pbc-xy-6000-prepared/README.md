# Powtórka relaksacji warstwy i walca: PBC XY, 6000 kroków BB

W `cases/` jest 12 osobnych wejść. `input-preflight.json` wiąże każde wejście z
oryginalnym wariantem, SHA-256 skryptu i planowaną sąsiednią ścieżką `.zarr`.
Sprawdzono wszystkie wejścia przez Python → ProblemIR, bez uruchamiania Solve.
Geometria, materiały, tekstury, aktywne oddziaływania i wybór FDM GPU double
pozostały takie jak w serii bazowej. Zmiany to limit BB 6000 oraz globalna
periodyczność XY z otwartym Z. W przyjętej polityce `truncated_images` sumuje
się przesunięcia od −10 do +10 okresów na każdej osi okresowej. Okres 600 nm
obejmuje warstwę i walec. PBC nie narzuca kierunku magnetyzacji.

## Stan wykonania

Na używanym backendzie `fullmag-master` żądanie wielobryłowego PG-BB z PBC jest
odrzucane przez `fullmag_plan::fdm::fdm_multilayer_projected_bb_error` i
`plan_fdm_multilayer`. Sprawdzona lokalna referencja `origin/master` pod
`38a716821c0350bbf52266528684ee92cd745a70` zawiera te same ograniczenia.
Periodyczny kernel dla jednej siatki nie jest dowodem dla sprzężonych obiektów
z różnymi materiałami i rDMI ograniczonym do warstwy. Nie wykonano obliczeń z
tej powtórki ani nie zmieniono bramki backendu.

## Kolejność uruchomienia

1. Rozszerzyć istniejący tor `multilayer_convolution` FP64 dla wyrównanych
   siatek o periodyczne kernele własne i wzajemne. Okres ustala wspólna
   komórka obliczeniowa w XY. Różnica wysokości źródła i odbiorcy pozostaje
   w przesunięciu kernela dla każdej uporządkowanej pary obiektów.
2. Zakwalifikować periodyczne sąsiedztwo lokalne. Warstwa łączy własne
   przeciwległe brzegi; walec w środku komórki nie może sztucznie łączyć
   przeciwległych ścian swojej małej siatki. Walec oddziałuje ze swoimi kopiami
   magnetostatycznie. Szczelina 5 nm nie przenosi wymiany ani rDMI.
3. Na małej siatce sprawdzić pole i energię względem jawnej sumy przesuniętych
   kopii, wzajemność kernelów oraz rozdzielenie rDMI warstwy i walca. Sprawdzić
   także regresję istniejących otwartych brzegów. Dopiero po tym dopuścić
   właściwy wariant w plannerze i sprawdzić rzeczywiste wykonanie CUDA.
4. W tej samej grupie na 3342 wykonać najpierw jeden przypadek z docelową
   geometrią i sprawdzić provenance, pola, Zarr i kryterium zbieżności. Następnie
   wykonać 12 przypadków. Zachować serię bazową do porównania.

Na WSL przy ostatnim pomiarze pozostawało około 880 MiB. Przed kolejną serią
potrzebny jest zapas miejsca na nowe wyniki i artefakty. Zakończone przebiegi
bazowe oraz prezentacja wstępna pozostały zapisane.
