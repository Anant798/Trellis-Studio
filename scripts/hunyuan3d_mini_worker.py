"""Run one shape-only Hunyuan3D-2mini inference as a Trellis worker process."""

import sys
import time
from pathlib import Path

import torch
import trimesh
from pygltflib import GLTF2, Material, PbrMetallicRoughness
from PIL import Image
from hy3dgen.rembg import BackgroundRemover
from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline


def add_default_pbr_material(glb_path: Path) -> None:
    """Add a neutral, untextured material without touching mesh geometry."""
    gltf = GLTF2().load(str(glb_path))
    if not gltf.meshes or not any(mesh.primitives for mesh in gltf.meshes):
        raise RuntimeError("Hunyuan3D exported a GLB without mesh primitives.")

    material_index = len(gltf.materials or [])
    if gltf.materials is None:
        gltf.materials = []
    gltf.materials.append(
        Material(
            name="Trellis Studio neutral PBR (untextured)",
            pbrMetallicRoughness=PbrMetallicRoughness(
                baseColorFactor=[0.56, 0.64, 0.78, 1.0],
                metallicFactor=0.05,
                roughnessFactor=0.82,
            ),
            doubleSided=True,
        )
    )
    for mesh in gltf.meshes:
        for primitive in mesh.primitives:
            if primitive.material is None:
                primitive.material = material_index
    gltf.save_binary(str(glb_path))


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: hunyuan3d_mini_worker.py INPUT_IMAGE OUTPUT_GLB")

    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    image = BackgroundRemover()(Image.open(input_path).convert("RGBA"))

    pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        "tencent/Hunyuan3D-2mini",
        subfolder="hunyuan3d-dit-v2-mini",
        variant="fp16",
        use_safetensors=True,
        device="cuda",
    )

    # Tencent's custom pipeline calls the Diffusers offload helper but does
    # not define DiffusionPipeline.components. Supply its three actual modules
    # so the documented Accelerate CPU-offload helper can sequence them.
    pipeline.components = {
        "conditioner": pipeline.conditioner,
        "model": pipeline.model,
        "vae": pipeline.vae,
    }
    pipeline.enable_model_cpu_offload()
    pipeline.device = torch.device("cuda")

    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    mesh = pipeline(
        image=image,
        num_inference_steps=50,
        octree_resolution=384,
        num_chunks=8000,
        generator=torch.manual_seed(12345),
        output_type="trimesh",
    )[0]
    inference_seconds = time.perf_counter() - started
    mesh.export(output_path, file_type="glb")
    add_default_pbr_material(output_path)

    loaded = trimesh.load(output_path, force="scene")
    meshes = [geometry for geometry in loaded.geometry.values() if isinstance(geometry, trimesh.Trimesh)]
    vertices = sum(len(geometry.vertices) for geometry in meshes)
    faces = sum(len(geometry.faces) for geometry in meshes)
    if output_path.stat().st_size < 12 or vertices == 0 or faces == 0:
        raise RuntimeError("The exported GLB is empty or contains no mesh geometry.")

    print(
        "HUNYUAN_RESULT "
        f"{{'seconds': {inference_seconds:.2f}, 'peak_allocated_mib': {torch.cuda.max_memory_allocated() / 2**20:.0f}, "
        f"'peak_reserved_mib': {torch.cuda.max_memory_reserved() / 2**20:.0f}, 'bytes': {output_path.stat().st_size}, "
        f"'meshes': {len(meshes)}, 'vertices': {vertices}, 'faces': {faces}}}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
