import { Bloom, EffectComposer, N8AO } from "@react-three/postprocessing";
import { useViewport3DCommandState } from "../viewport3dStore";

export interface PostProcessingLayerProps {
  /**
   * Promień otaczającej kuli sceny (Viewport3DBounds.radius), w tych samych
   * jednostkach co geometria. Sceny mikromagnetyczne mają skalę od ~1e-9 do
   * ~1e3 w zależności od konwencji jednostek, więc aoRadius (odległość w
   * jednostkach świata) musi być liczony względem tej wartości, a nie stałej
   * — patrz S-16 w audycie frontendu.
   */
  sceneRadius: number;
}

export function PostProcessingLayer({ sceneRadius }: PostProcessingLayerProps) {
  const { widgets: { effectAmbientOcclusion, effectAntialias, effectBloom } } = useViewport3DCommandState();

  if (!effectAmbientOcclusion && !effectBloom) {
    return null;
  }

  // S-16: aoRadius jest odległością w jednostkach świata; poprzednia stała
  // 0.5 zakładała scenę w skali ~1 jednostki. Sceny mikromagnetyczne mają
  // skalę od ~1e-9 do ~1e3, więc promień skalujemy względem promienia
  // otaczającej kuli sceny. Dolny próg 1e-9 zabezpiecza przed zdegenerowaną
  // (pustą) sceną, w której sceneRadius === 0 dawałoby aoRadius === 0, czyli
  // faktyczne wyłączenie AO.
  const aoRadius = Math.max(sceneRadius * 0.05, 1e-9);

  const children = [];
  if (effectAmbientOcclusion) {
    children.push(
      <N8AO
        key="ao"
        aoRadius={aoRadius}
        intensity={2.5}
        halfRes
        color="black"
        // S-16: N8AO rekonstruuje okluzję z bufora głębi. Każda
        // przezroczysta powierzchnia kontekstowa (MeshPartLayer, po S-14)
        // renderuje się z depthWrite: false, więc nie zapisuje głębi i AO
        // jej nie widzi — okluzja działa wyłącznie na nieprzezroczystej
        // geometrii (solidSurface). To świadomie zaakceptowane ograniczenie;
        // pełna naprawa wymagałaby dedykowanego depth pre-passu renderującego
        // też powierzchnie przezroczyste, co wykracza poza zakres tego
        // zadania.
      />
    );
  }
  if (effectBloom) {
    children.push(
      <Bloom
        key="bloom"
        // S-16: luminanceThreshold={0.5} był porównywany z liniową
        // luminancją pikseli (po S-02/S-03 kompozytor operuje na wartościach
        // liniowych), więc górna połowa każdej sekwencyjnej/rozbieżnej
        // palety (np. żółty koniec viridisa, ~0.90 liniowej luminancji)
        // przekraczała próg i świeciła, niszcząc czytelność mapy kolorów.
        // Scena jest w pełni unlit i nie ma żadnego źródła HDR/emissive, więc
        // nic nie powinno legalnie przekraczać liniowej luminancji 1.0 — próg
        // >= 1 czyni Bloom nieszkodliwym już dziś, bez usuwania przełącznika
        // na wypadek dodania materiału emissive/HDR w przyszłości.
        luminanceThreshold={1}
        luminanceSmoothing={0.1}
        intensity={1.2}
      />
    );
  }

  return (
    <EffectComposer
      multisampling={effectAntialias ? 4 : 0}
    >
      {children}
    </EffectComposer>
  );
}

