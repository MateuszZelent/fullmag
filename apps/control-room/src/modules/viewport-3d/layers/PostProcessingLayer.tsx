import { Bloom, EffectComposer, N8AO } from "@react-three/postprocessing";
import { useViewport3DCommandState } from "../viewport3dStore";

export function PostProcessingLayer() {
  const { widgets: { effectAmbientOcclusion, effectAntialias, effectBloom } } = useViewport3DCommandState();

  if (!effectAmbientOcclusion && !effectBloom) {
    return null;
  }

  const children = [];
  if (effectAmbientOcclusion) {
    children.push(
      <N8AO 
        key="ao"
        aoRadius={0.5} 
        intensity={2.5} 
        halfRes 
        color="black" 
      />
    );
  }
  if (effectBloom) {
    children.push(
      <Bloom 
        key="bloom"
        luminanceThreshold={0.5} 
        luminanceSmoothing={0.1} 
        intensity={1.2} 
      />
    );
  }

  return (
    <EffectComposer 
      multisampling={effectAntialias ? 4 : 0}
      autoClear={false}
    >
      {children}
    </EffectComposer>
  );
}
