"""Standalone Blender UV projection/bake proof of concept for Trellis Studio.

Run with Blender's bundled Python, e.g.:
  blender --background --factory-startup --python scripts/blender_projection_poc.py -- \
    --source storage/outputs/<generation-id>.glb \
    --image storage/inputs/<generation-id>.png \
    --generation-id <generation-id> \
    --output .uv-cache/phase53b-projection/textured.glb

The camera defaults to +Y looking toward -Y, which was visually established for
the supplied Hunyuan sample. It does not modify the source GLB or application DB.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sqlite3
import struct
import sys
import time
from pathlib import Path

import bpy
from mathutils import Vector


NEUTRAL = (0.52, 0.55, 0.60, 1.0)


def cli_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--generation-id", required=True)
    parser.add_argument("--database", default="storage/trellis.sqlite")
    parser.add_argument("--resolution", type=int, default=2048)
    parser.add_argument("--camera-axis", choices=("+Y", "-Y", "+X", "-X", "+Z", "-Z"), default="+Y")
    return parser.parse_args(argv)


def world_bounds(mesh_objects):
    points = [obj.matrix_world @ vert.co for obj in mesh_objects for vert in obj.data.vertices]
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    return lo, hi


def geom_fingerprint(mesh_objects):
    """Hash world-space triangle corners, independent of UV-induced vertex splits."""
    faces = []
    for obj in mesh_objects:
        mesh = obj.data
        for poly in mesh.polygons:
            indices = list(poly.vertices)
            if len(indices) < 3:
                continue
            for k in range(1, len(indices) - 1):
                coords = []
                for index in (indices[0], indices[k], indices[k + 1]):
                    p = obj.matrix_world @ mesh.vertices[index].co
                    coords.append(tuple(round(float(v), 6) for v in p))
                coords.sort()
                faces.append(tuple(coords))
    faces.sort()
    digest = hashlib.sha256()
    for triangle in faces:
        digest.update(json.dumps(triangle, separators=(",", ":")).encode("ascii"))
        digest.update(b"\n")
    return {"triangles": len(faces), "sha256_world_triangle_geometry": digest.hexdigest()}


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.cameras, bpy.data.lights, bpy.data.materials):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def verify_association(db_path, generation_id, source_path, image_path):
    db_path = Path(db_path).resolve()
    source_path = Path(source_path).resolve()
    image_path = Path(image_path).resolve()
    with sqlite3.connect(db_path) as conn:
        row = conn.execute(
            "SELECT input_image_key, output_asset_key, status FROM generations WHERE id=?",
            (generation_id,),
        ).fetchone()
    if not row:
        raise RuntimeError(f"Generation ID {generation_id} is not in {db_path}")
    input_key, output_key, status = row
    if status != "completed":
        raise RuntimeError(f"Generation {generation_id} status is {status!r}, expected 'completed'")
    if image_path != (db_path.parent / input_key).resolve():
        raise RuntimeError(f"Image does not match DB input key {input_key!r}")
    if source_path != (db_path.parent / output_key).resolve():
        raise RuntimeError(f"Source GLB does not match DB output key {output_key!r}")
    return {"generation_id": generation_id, "input_key": input_key, "output_key": output_key}


def make_material(name, color):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = color
    mat.node_tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def run():
    started = time.perf_counter()
    args = cli_args()
    source = Path(args.source).resolve()
    image_path = Path(args.image).resolve()
    output = Path(args.output).resolve()
    if not source.is_file() or not image_path.is_file():
        raise FileNotFoundError(f"Source or reference image missing: {source} | {image_path}")
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite existing output: {output}")
    if args.resolution < 256 or args.resolution > 4096:
        raise ValueError("Resolution must be between 256 and 4096")
    association = verify_association(args.database, args.generation_id, source, image_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(source))
    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not mesh_objects:
        raise RuntimeError("Source GLB contains no mesh objects")
    source_stats = {
        "mesh_count": len(mesh_objects),
        "vertices": sum(len(obj.data.vertices) for obj in mesh_objects),
        "polygons": sum(len(obj.data.polygons) for obj in mesh_objects),
        "bounds_world": world_bounds(mesh_objects),
        "geometry": geom_fingerprint(mesh_objects),
        "uv_layers_before": {obj.name: [uv.name for uv in obj.data.uv_layers] for obj in mesh_objects},
    }

    # Establish the projection camera orientation in scene/world space.
    axis = {"+X": (1, 0, 0), "-X": (-1, 0, 0), "+Y": (0, 1, 0), "-Y": (0, -1, 0), "+Z": (0, 0, 1), "-Z": (0, 0, -1)}[args.camera_axis]
    lo, hi = source_stats["bounds_world"]
    center = Vector(tuple((lo[i] + hi[i]) * 0.5 for i in range(3)))
    dims = Vector(tuple(hi[i] - lo[i] for i in range(3)))
    radius = max(dims.length * 0.5, 1e-3)
    camera_data = bpy.data.cameras.new("ProjectionCamera")
    camera = bpy.data.objects.new("ProjectionCamera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.location = center + Vector(axis) * radius * 4.0
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.view_layer.update()
    camera_forward = (center - camera.location).normalized()
    right = camera.matrix_world.to_3x3() @ Vector((1, 0, 0))
    up = camera.matrix_world.to_3x3() @ Vector((0, 1, 0))
    camera_data.type = "ORTHO"
    # Fit horizontally with a small margin; preserve the source image's aspect ratio.
    camera_data.ortho_scale = max(dims.x * 1.08, dims.y * 1.08, dims.z * 1.08)
    scene = bpy.context.scene
    scene.camera = camera
    reference = bpy.data.images.load(str(image_path), check_existing=False)
    reference.colorspace_settings.name = "sRGB"
    scene.render.resolution_x, scene.render.resolution_y = reference.size[:]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.render.bake.use_pass_color = True
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.margin = 12
    scene.render.bake.margin_type = "EXTEND"
    scene.render.bake.use_selected_to_active = False
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.color_mode = "RGBA"

    # One UV island layout per object; mesh vertex positions and connectivity stay untouched.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(island_margin=0.008, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
        bpy.ops.uv.lightmap_pack(
            PREF_CONTEXT="ALL_FACES",
            PREF_PACK_IN_ONE=True,
            PREF_NEW_UVLAYER=False,
            PREF_BOX_DIV=12,
            PREF_MARGIN_DIV=0.01,
        )
        bpy.ops.object.mode_set(mode="OBJECT")
        obj.select_set(False)

    # Preserve an explicit camera-space UV set only for projection lookup.
    # Blender's Camera shader socket is version-dependent; explicit UV math is
    # deterministic for this orthographic bake and the projection UV set is
    # removed again before GLB export (only the atlas UV remains).
    projection_width = camera_data.ortho_scale
    aspect = float(reference.size[0]) / float(reference.size[1])
    projection_height = projection_width / aspect
    for obj in mesh_objects:
        mesh = obj.data
        projection_uv = mesh.uv_layers.new(name="ProjectionUV")
        for loop in mesh.loops:
            world_point = obj.matrix_world @ mesh.vertices[loop.vertex_index].co
            relative = world_point - center
            projection_uv.data[loop.index].uv = (
                0.5 + relative.dot(right) / projection_width,
                0.5 + relative.dot(up) / projection_height,
            )
        if mesh.uv_layers.get("UVMap"):
            mesh.uv_layers.active = mesh.uv_layers.get("UVMap")
            mesh.uv_layers.get("UVMap").active_render = True

    # Determine camera-visible polygons through the mesh BVH. Only these polygons
    # receive source-image projection; occluded/unobserved polygons bake neutral.
    from mathutils.bvhtree import BVHTree
    projected_material = bpy.data.materials.new("ProjectionBakeSource")
    projected_material.use_nodes = True
    nodes = projected_material.node_tree.nodes
    nodes.clear()
    projection_map = nodes.new("ShaderNodeUVMap")
    projection_map.uv_map = "ProjectionUV"
    image_node = nodes.new("ShaderNodeTexImage")
    image_node.image = reference
    image_node.projection = "FLAT"
    image_node.extension = "CLIP"
    emit = nodes.new("ShaderNodeEmission")
    out = nodes.new("ShaderNodeOutputMaterial")
    projected_material.node_tree.links.new(projection_map.outputs["UV"], image_node.inputs["Vector"])
    projected_material.node_tree.links.new(image_node.outputs["Color"], emit.inputs["Color"])
    projected_material.node_tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    fallback_material = make_material("NeutralUnobservedSurface", NEUTRAL)
    texture_image = bpy.data.images.new("TrellisProjection_2048", width=args.resolution, height=args.resolution, alpha=True)
    texture_image.file_format = "PNG"
    texture_image.colorspace_settings.name = "sRGB"

    visible_counts = {}
    for obj in mesh_objects:
        mesh = obj.data
        mesh.materials.clear()
        mesh.materials.append(projected_material)
        mesh.materials.append(fallback_material)
        tree = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get(), epsilon=0.0)
        inv = obj.matrix_world.inverted()
        direction_local = (inv.to_3x3() @ camera_forward).normalized()
        visible_count = 0
        for poly in mesh.polygons:
            world_center = obj.matrix_world @ poly.center
            offset = world_center - center
            ray_origin_world = camera.location + right * offset.dot(right) + up * offset.dot(up)
            origin_local = inv @ ray_origin_world
            hit = tree.ray_cast(origin_local, direction_local, radius * 8.0)
            is_visible = hit[0] is not None and hit[2] == poly.index
            poly.material_index = 0 if is_visible else 1
            visible_count += int(is_visible)
        visible_counts[obj.name] = {"camera_visible_polygons": visible_count, "fallback_polygons": len(mesh.polygons) - visible_count}

    # Bake emission to UV atlas on CPU. A shared active target is set in both
    # temporary materials so fallback regions are genuinely neutral in the atlas.
    for mat in (projected_material, fallback_material):
        target = mat.node_tree.nodes.new("ShaderNodeTexImage")
        target.image = texture_image
        target.select = True
        mat.node_tree.nodes.active = target
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]
    bpy.ops.object.bake(type="EMIT", margin=12, use_clear=True)

    # Replace temporary face material split with one exported textured PBR material.
    final_mat = bpy.data.materials.new("SourceImageProjection_Baked_PBR")
    final_mat.use_nodes = True
    final_nodes = final_mat.node_tree.nodes
    final_nodes.clear()
    final_out = final_nodes.new("ShaderNodeOutputMaterial")
    principled = final_nodes.new("ShaderNodeBsdfPrincipled")
    principled.inputs["Metallic"].default_value = 0.05
    principled.inputs["Roughness"].default_value = 0.82
    final_tex = final_nodes.new("ShaderNodeTexImage")
    final_tex.image = texture_image
    final_mat.node_tree.links.new(final_tex.outputs["Color"], principled.inputs["Base Color"])
    final_mat.node_tree.links.new(principled.outputs["BSDF"], final_out.inputs["Surface"])
    for obj in mesh_objects:
        obj.data.materials.clear()
        obj.data.materials.append(final_mat)
        for poly in obj.data.polygons:
            poly.material_index = 0
        if obj.data.uv_layers.get("ProjectionUV"):
            obj.data.uv_layers.remove(obj.data.uv_layers.get("ProjectionUV"))
        if obj.data.uv_layers.get("UVMap"):
            obj.data.uv_layers.active = obj.data.uv_layers.get("UVMap")
            obj.data.uv_layers.get("UVMap").active_render = True
    texture_image.pack()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_image_format="AUTO",
        export_apply=False,
        export_materials="EXPORT",
        use_selection=True,
    )

    # Save atlas separately for inspection, and a same-angle before/after render.
    atlas_path = output.with_name(output.stem + "_atlas.png")
    texture_image.filepath_raw = str(atlas_path)
    texture_image.file_format = "PNG"
    texture_image.save()
    report_path = output.with_suffix(".report.json")
    report = {
        "blender_version": bpy.app.version_string,
        "association": association,
        "source_glb": str(source),
        "reference_image": str(image_path),
        "output_glb": str(output),
        "camera_axis": args.camera_axis,
        "resolution": [args.resolution, args.resolution],
        "bake_device": "CPU",
        "bake_margin_pixels": 12,
        "source_geometry": source_stats,
        "visible_face_assignment": visible_counts,
        "uv_validation": {},
        "texture": {"atlas_png": str(atlas_path), "packed_in_glb": True},
        "elapsed_seconds_through_export": round(time.perf_counter() - started, 3),
        "limitations": [
            "Projected source-image colors are not AI-generated surface detail.",
            "Back and occluded surfaces use a neutral fallback; unseen details are not reconstructed.",
            "A single view can create projection distortion near silhouette edges and UV seams.",
        ],
    }
    uv_report = {}
    for obj in mesh_objects:
        uv = obj.data.uv_layers.active
        uv_name = uv.name if uv else None
        uv_loop_count = len(uv.data) if uv else 0
        object_name = obj.name
        finite = True
        in_range = True
        degenerate = 0
        for poly in obj.data.polygons:
            loops = list(poly.loop_indices)
            coords = [uv.data[i].uv for i in loops]
            for p in coords:
                finite &= math.isfinite(float(p.x)) and math.isfinite(float(p.y))
                in_range &= -1e-6 <= p.x <= 1.000001 and -1e-6 <= p.y <= 1.000001
            area = 0.0
            for i in range(1, len(coords) - 1):
                a, b, c = coords[0], coords[i], coords[i + 1]
                area += abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5
            if area < 1e-12:
                degenerate += 1
        overlap_faces = None
        overlap_check = "operator unavailable"
        try:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="DESELECT")
            bpy.ops.uv.select_overlap()
            bpy.ops.object.mode_set(mode="OBJECT")
            overlap_faces = sum(1 for poly in obj.data.polygons if poly.select)
            overlap_check = "Blender UV Select Overlap operator after Smart UV Project + Lightmap Pack; selected polygon count"
        except Exception as exc:
            try:
                if obj.mode != "OBJECT":
                    bpy.ops.object.mode_set(mode="OBJECT")
            except Exception:
                pass
            overlap_check = f"failed: {type(exc).__name__}: {exc}"
        uv_report[object_name] = {"uv_layer": uv_name, "loop_uv_count": uv_loop_count, "finite": finite, "within_0_1": in_range, "degenerate_uv_polygons": degenerate, "overlap_polygons_selected": overlap_faces, "overlap_check": overlap_check}
    report["uv_validation"] = uv_report

    # Reload the actual exported GLB, check it structurally, and compare its
    # world-space triangle geometry against the source import.
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=str(output))
    output_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    output_geometry = geom_fingerprint(output_meshes)
    glb_bytes = output.read_bytes()
    magic, glb_version, declared_length = struct.unpack_from("<4sII", glb_bytes, 0)
    json_length, json_type = struct.unpack_from("<II", glb_bytes, 12)
    glb_json = json.loads(glb_bytes[20 : 20 + json_length])
    bin_header = 20 + json_length
    bin_length, bin_type = struct.unpack_from("<II", glb_bytes, bin_header)
    bin_offset = bin_header + 8
    embedded_image_refs = []
    for image in glb_json.get("images", []):
        view = glb_json.get("bufferViews", [])[image["bufferView"]] if "bufferView" in image else None
        embedded_image_refs.append(bool(
            image.get("uri") is None
            and view
            and view.get("buffer", 0) == 0
            and view.get("byteLength", 0) > 0
            and view.get("byteOffset", 0) + view.get("byteLength", 0) <= bin_length
        ))
    output_uv = []
    output_materials = []
    output_texture_nodes = 0
    for obj in output_meshes:
        output_uv.append({"object": obj.name, "layers": [layer.name for layer in obj.data.uv_layers], "loop_uv_count": len(obj.data.uv_layers.active.data) if obj.data.uv_layers.active else 0})
        for mat in obj.data.materials:
            if mat:
                output_materials.append(mat.name)
                if mat.use_nodes:
                    output_texture_nodes += sum(1 for node in mat.node_tree.nodes if node.type == "TEX_IMAGE" and node.image)
    report["output_validation"] = {
        "glb_header_valid": magic == b"glTF" and glb_version == 2 and declared_length == len(glb_bytes),
        "glb_bytes": len(glb_bytes),
        "embedded_images": len(embedded_image_refs),
        "all_images_embedded_in_binary": bool(embedded_image_refs) and all(embedded_image_refs),
        "image_mime_types": [image.get("mimeType") for image in glb_json.get("images", [])],
        "texture_count": len(glb_json.get("textures", [])),
        "texture_image_byte_lengths": [glb_json["bufferViews"][image["bufferView"]]["byteLength"] for image in glb_json.get("images", []) if "bufferView" in image],
        "output_mesh_count": len(output_meshes),
        "output_vertices": sum(len(obj.data.vertices) for obj in output_meshes),
        "output_polygons": sum(len(obj.data.polygons) for obj in output_meshes),
        "output_bounds_world": world_bounds(output_meshes) if output_meshes else None,
        "output_geometry": output_geometry,
        "geometry_hash_matches_source": output_geometry == source_stats["geometry"],
        "reloaded_uv": output_uv,
        "material_assignments": output_materials,
        "reloaded_image_texture_nodes": output_texture_nodes,
    }
    if not report["output_validation"]["glb_header_valid"]:
        raise RuntimeError("Exported GLB header/length validation failed")
    if not report["output_validation"]["all_images_embedded_in_binary"]:
        raise RuntimeError("The GLB did not embed all image texture data")
    if not report["output_validation"]["geometry_hash_matches_source"]:
        raise RuntimeError("Exported mesh geometry differs from source geometry hash")
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("POC_REPORT", json.dumps(report, separators=(",", ":")))
    print(f"POC_OUTPUT={output}")
    print(f"POC_ATLAS={atlas_path}")
    print(f"POC_REPORT_PATH={report_path}")
    print(f"POC_RUNTIME_SECONDS={report['elapsed_seconds_through_export']}")


if __name__ == "__main__":
    run()
