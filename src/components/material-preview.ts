import * as THREE from "three";

export type MaterialSettings = { baseColor: string; metalness: number; roughness: number };
export type MaterialSnapshot = { material: THREE.MeshStandardMaterial; settings: MaterialSettings };
export const FALLBACK_MATERIAL: MaterialSettings = { baseColor: "#8fa3c7", metalness: 0.05, roughness: 0.82 };

export function cloneSceneForMaterialPreview(scene: THREE.Object3D) {
  const previewScene = scene.clone(true);
  const snapshots: MaterialSnapshot[] = [];

  previewScene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const originals = Array.isArray(object.material) ? object.material : [object.material];
    const previewMaterials = originals.map(original => {
      const candidate = original as THREE.Material & { color?: THREE.Color; map?: THREE.Texture; alphaMap?: THREE.Texture };
      const material = original instanceof THREE.MeshStandardMaterial
        ? original.clone()
        : new THREE.MeshStandardMaterial({ color: candidate.color ?? 0xffffff, map: candidate.map ?? null, alphaMap: candidate.alphaMap ?? null });
      snapshots.push({
        material,
        settings: {
          baseColor: `#${material.color.getHexString()}`,
          metalness: material.metalness,
          roughness: material.roughness,
        },
      });
      return material;
    });

    if (!previewMaterials.length) {
      const material = new THREE.MeshStandardMaterial(FALLBACK_MATERIAL);
      snapshots.push({ material, settings: { ...FALLBACK_MATERIAL } });
      object.material = material;
    } else {
      object.material = Array.isArray(object.material) ? previewMaterials : previewMaterials[0];
    }
  });

  return { scene: previewScene, snapshots, defaults: snapshots[0]?.settings ?? { ...FALLBACK_MATERIAL } };
}

export function applyPreviewMaterialSettings(snapshots: MaterialSnapshot[], settings: MaterialSettings | null) {
  for (const { material, settings: original } of snapshots) {
    const selected = settings ?? original;
    material.color.set(selected.baseColor);
    material.metalness = selected.metalness;
    material.roughness = selected.roughness;
    material.needsUpdate = true;
  }
}
