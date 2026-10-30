"use client";

import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Grid, OrbitControls, useGLTF } from "@react-three/drei";
import type { OrbitControls as OrbitControlsInstance } from "three-stdlib";
import * as THREE from "three";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import type { ModelDimensions } from "@/lib/model";
import { applyPreviewMaterialSettings, cloneSceneForMaterialPreview, FALLBACK_MATERIAL } from "@/components/material-preview";
import type { MaterialSettings } from "@/components/material-preview";

type ModelViewerProps = {
  assetUrl: string;
  assetName: string;
  resetVersion: number;
  onLoaded: (dimensions: ModelDimensions) => void;
  onError: (message: string) => void;
};

class ViewerErrorBoundary extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error.message || "The GLB could not be parsed.");
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

function Drone({ assetUrl, resetVersion, onLoaded, materialSettings, onMaterialDefaults }: Pick<ModelViewerProps, "assetUrl" | "resetVersion" | "onLoaded"> & {
  materialSettings: MaterialSettings | null;
  onMaterialDefaults: (settings: MaterialSettings) => void;
}) {
  const { scene } = useGLTF(assetUrl);
  const { camera, size } = useThree();
  const controlsRef = useRef<OrbitControlsInstance | null>(null);
  const materialState = useMemo(() => cloneSceneForMaterialPreview(scene), [scene]);

  const bounds = useMemo(() => {
    materialState.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(materialState.scene);
    const center = box.getCenter(new THREE.Vector3());
    const dimensions = box.getSize(new THREE.Vector3());
    const radius = Math.max(dimensions.length() / 2, 0.001);
    return { center, dimensions, radius };
  }, [materialState.scene]);
  const [materialsReady, setMaterialsReady] = useState(false);

  useEffect(() => {
    onMaterialDefaults(materialState.defaults);
    setMaterialsReady(true);
  }, [materialState, onMaterialDefaults]);

  useLayoutEffect(() => {
    if (!materialsReady) return;
    applyPreviewMaterialSettings(materialState.snapshots, materialSettings);
  }, [materialSettings, materialState, materialsReady]);

  useLayoutEffect(() => {
    if (bounds.dimensions.length() === 0) return;
    const perspectiveCamera = camera as THREE.PerspectiveCamera;
    const aspect = Math.max(size.width / Math.max(size.height, 1), 0.1);
    const verticalHalfFov = THREE.MathUtils.degToRad(perspectiveCamera.fov / 2);
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * aspect);
    const fitAngle = Math.max(0.08, Math.min(verticalHalfFov, horizontalHalfFov));
    const distance = bounds.radius / Math.sin(fitAngle) * 1.18;
    const direction = new THREE.Vector3(1.25, 0.78, 1.45).normalize();

    perspectiveCamera.position.copy(direction.multiplyScalar(distance));
    perspectiveCamera.near = Math.max(bounds.radius / 1000, 0.01);
    perspectiveCamera.far = Math.max(distance + bounds.radius * 5, 1000);
    perspectiveCamera.lookAt(0, 0, 0);
    perspectiveCamera.updateProjectionMatrix();

    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.minDistance = bounds.radius * 0.4;
      controlsRef.current.maxDistance = distance * 5;
      controlsRef.current.update();
    }
  }, [bounds, camera, resetVersion, size.height, size.width]);

  useLayoutEffect(() => {
    onLoaded({ x: bounds.dimensions.x, y: bounds.dimensions.y, z: bounds.dimensions.z, radius: bounds.radius });
  }, [bounds, onLoaded]);

  const gridSize = Math.max(bounds.dimensions.x, bounds.dimensions.z, bounds.dimensions.y, 1);

  return <>
    <group position={[-bounds.center.x, -bounds.center.y, -bounds.center.z]}>
      <primitive object={materialState.scene} dispose={null}/>
    </group>
    <ambientLight intensity={1.15}/>
    <hemisphereLight args={["#d6e3ff", "#171a22", 1.1]}/>
    <directionalLight color="#fff4e8" intensity={2.1} position={[gridSize * 1.8, gridSize * 2.4, gridSize * 2.3]}/>
    <directionalLight color="#5b8fe8" intensity={1.05} position={[-gridSize * 2, gridSize * 0.4, -gridSize]}/>
    <pointLight color="#1558c9" intensity={gridSize * 0.018} distance={gridSize * 7} position={[gridSize * 0.5, -gridSize * 0.1, gridSize * 2]}/>
    <Grid
      args={[gridSize * 2.2, gridSize * 2.2]}
      position={[0, -bounds.dimensions.y / 2, 0]}
      cellSize={gridSize / 42}
      sectionSize={gridSize / 7}
      cellColor="#283248"
      sectionColor="#315ca8"
      cellThickness={0.35}
      sectionThickness={0.65}
      fadeDistance={bounds.radius * 3}
      fadeStrength={1.5}
    />
    <OrbitControls ref={controlsRef} makeDefault enableDamping dampingFactor={0.08} enablePan enableZoom enableRotate/>
  </>;
}

export default function ModelViewer({ assetUrl, assetName, resetVersion, onLoaded, onError }: ModelViewerProps) {
  const [materialDefaults, setMaterialDefaults] = useState<MaterialSettings | null>(null);
  const [materialSettings, setMaterialSettings] = useState<MaterialSettings | null>(null);
  const [controlsOpen, setControlsOpen] = useState(true);
  const handleMaterialDefaults = useCallback((settings: MaterialSettings) => {
    setMaterialDefaults(settings);
    setMaterialSettings(null);
  }, []);
  const shownSettings = materialSettings ?? materialDefaults ?? FALLBACK_MATERIAL;
  const updateMaterial = (changes: Partial<MaterialSettings>) => {
    setMaterialSettings({ ...shownSettings, ...changes });
  };

  return <>
    <Canvas
      className="model-canvas"
      camera={{ position: [0, 0, 500], fov: 34, near: 0.01, far: 10000 }}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      fallback={<div className="viewer-error viewer-webgl-error">WebGL is unavailable in this browser.</div>}
      aria-label={`Interactive 3D viewer for ${assetName}`}
    >
      <color attach="background" args={["#07080d"]}/>
      <ViewerErrorBoundary key={assetUrl} onError={onError}>
        <Suspense fallback={null}>
          <Drone assetUrl={assetUrl} resetVersion={resetVersion} onLoaded={onLoaded} materialSettings={materialSettings} onMaterialDefaults={handleMaterialDefaults}/>
        </Suspense>
      </ViewerErrorBoundary>
    </Canvas>
    <section className={`material-controls ${controlsOpen ? "" : "collapsed"}`} aria-label="Preview material adjustments">
      <div className="material-controls-heading"><span><SlidersHorizontal size={12}/> MATERIAL ADJUSTMENTS</span><button type="button" aria-expanded={controlsOpen} onClick={() => setControlsOpen(open => !open)}>{controlsOpen ? "HIDE" : "EDIT"}</button></div>
      {controlsOpen && <>
        <label className="material-control color-control"><span>Base color</span><input type="color" aria-label="Material base color" value={shownSettings.baseColor} disabled={!materialDefaults} onChange={event => updateMaterial({ baseColor: event.currentTarget.value })}/></label>
        <label className="material-control"><span>Metalness <output>{shownSettings.metalness.toFixed(2)}</output></span><input type="range" aria-label="Material metalness" min="0" max="1" step="0.01" value={shownSettings.metalness} disabled={!materialDefaults} onChange={event => updateMaterial({ metalness: Number(event.currentTarget.value) })}/></label>
        <label className="material-control"><span>Roughness <output>{shownSettings.roughness.toFixed(2)}</output></span><input type="range" aria-label="Material roughness" min="0" max="1" step="0.01" value={shownSettings.roughness} disabled={!materialDefaults} onChange={event => updateMaterial({ roughness: Number(event.currentTarget.value) })}/></label>
        <button type="button" className="material-reset" disabled={!materialDefaults || materialSettings === null} onClick={() => setMaterialSettings(null)}><RotateCcw size={11}/> Reset to model defaults</button>
        <p>Preview only · Download retains the saved GLB materials. These controls do not generate textures.</p>
      </>}
    </section>
  </>;
}
