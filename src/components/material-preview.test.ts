import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { applyPreviewMaterialSettings, cloneSceneForMaterialPreview } from "./material-preview";

test("preview material edits stay on cloned materials, preserve geometry, and reset per-material defaults", () => {
  const source = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(1, 2, 3);
  const firstMaterial = new THREE.MeshStandardMaterial({ color: "#b84b31", metalness: 0.15, roughness: 0.7 });
  const secondMaterial = new THREE.MeshStandardMaterial({ color: "#315ca8", metalness: 0.8, roughness: 0.25 });
  source.add(new THREE.Mesh(geometry, [firstMaterial, secondMaterial]));

  const geometryPositions = Array.from(geometry.attributes.position.array);
  const geometryIndices = Array.from(geometry.index!.array);
  const preview = cloneSceneForMaterialPreview(source);
  const previewMesh = preview.scene.children[0] as THREE.Mesh;
  const previewMaterials = previewMesh.material as THREE.MeshStandardMaterial[];

  assert.notEqual(previewMaterials[0], firstMaterial);
  assert.notEqual(previewMaterials[1], secondMaterial);
  assert.equal(previewMesh.geometry, geometry);

  const edited = { baseColor: "#45c7a1", metalness: 0.95, roughness: 0.08 };
  applyPreviewMaterialSettings(preview.snapshots, edited);
  assert.equal(previewMaterials[0].color.getHexString(), "45c7a1");
  assert.equal(previewMaterials[0].metalness, 0.95);
  assert.equal(previewMaterials[0].roughness, 0.08);
  assert.equal(previewMaterials[1].color.getHexString(), "45c7a1");
  assert.equal(firstMaterial.color.getHexString(), "b84b31");
  assert.equal(firstMaterial.metalness, 0.15);
  assert.equal(firstMaterial.roughness, 0.7);
  assert.deepEqual(Array.from(geometry.attributes.position.array), geometryPositions);
  assert.deepEqual(Array.from(geometry.index!.array), geometryIndices);

  applyPreviewMaterialSettings(preview.snapshots, null);
  assert.equal(previewMaterials[0].color.getHexString(), "b84b31");
  assert.equal(previewMaterials[0].metalness, 0.15);
  assert.equal(previewMaterials[0].roughness, 0.7);
  assert.equal(previewMaterials[1].color.getHexString(), "315ca8");
  assert.equal(previewMaterials[1].metalness, 0.8);
  assert.equal(previewMaterials[1].roughness, 0.25);
});
