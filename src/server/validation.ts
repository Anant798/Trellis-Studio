import { z } from "zod";
import { ApiError } from "@/server/errors";
import type { ValidatedImage } from "@/server/generations";

const generationFieldsSchema = z.object({
  resolution: z.enum(["512", "1024", "1536"]).optional(),
  inputMode: z.enum(["single-image", "orthographic-views"]).default("single-image"),
  engine: z.enum(["triposr", "hunyuan3d-2mini", "hunyuan3d-2mv"]).default("triposr"),
}).strict();

export function detectImageType(bytes: Uint8Array): { contentType: ValidatedImage["contentType"]; extension: ValidatedImage["extension"] } | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return { contentType: "image/png", extension: "png" };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { contentType: "image/jpeg", extension: "jpg" };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return { contentType: "image/webp", extension: "webp" };
  return null;
}

export function sanitizeOriginalFilename(value: string) {
  const basename = value.replace(/\\/g, "/").split("/").at(-1) || "reference-image";
  const safe = basename.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return safe || "reference-image";
}

export async function validateGenerationForm(formData: FormData, maxUploadBytes: number) {
  const fieldsResult = generationFieldsSchema.safeParse({
    resolution: formData.get("resolution") ?? undefined,
    inputMode: formData.get("inputMode") ?? undefined,
    engine: formData.get("engine") ?? undefined,
  });
  if (!fieldsResult.success) throw new ApiError(400, "INVALID_SETTINGS", "The requested generation settings are invalid or unsupported.");
  const validateFile = async (entry: FormDataEntryValue | null, label: string): Promise<ValidatedImage> => {
    if (!(entry instanceof File)) throw new ApiError(400, "IMAGE_REQUIRED", `Add a PNG, JPG, or WebP ${label} image.`);
    if (entry.size < 1) throw new ApiError(400, "EMPTY_IMAGE", `The ${label} image is empty.`);
    if (entry.size > maxUploadBytes) throw new ApiError(413, "UPLOAD_TOO_LARGE", `Each image is limited to ${Math.floor(maxUploadBytes / 1024 / 1024)} MB.`);
    const bytes = Buffer.from(await entry.arrayBuffer());
    const detected = detectImageType(bytes);
    if (!detected) throw new ApiError(415, "UNSUPPORTED_FILE_TYPE", `The ${label} file is not a supported PNG, JPG, or WebP image.`);
    if (entry.type && entry.type !== detected.contentType) throw new ApiError(415, "CONTENT_TYPE_MISMATCH", `The ${label} file content does not match its declared image type.`);
    return {
      bytes,
      contentType: detected.contentType,
      extension: detected.extension,
      originalFilename: sanitizeOriginalFilename(entry.name),
      fileSize: bytes.byteLength,
    };
  };

  if (fieldsResult.data.inputMode === "single-image") {
    if (fieldsResult.data.engine === "hunyuan3d-2mv") throw new ApiError(422, "ENGINE_INPUT_MISMATCH", "Hunyuan3D-2mv requires orthographic views.");
    return { image: await validateFile(formData.get("image"), "reference"), views: null, resolution: fieldsResult.data.resolution ?? null, inputMode: fieldsResult.data.inputMode, engine: fieldsResult.data.engine };
  }

  if (fieldsResult.data.engine !== "hunyuan3d-2mv") throw new ApiError(422, "ENGINE_INPUT_MISMATCH", "Orthographic views require a multi-view compatible engine.");
  const views: Partial<Record<"front" | "back" | "left" | "right" | "top", ValidatedImage>> = {};
  let totalBytes = 0;
  for (const view of ["front", "back", "left", "right", "top"] as const) {
    const entry = formData.get(view);
    if (entry === null) continue;
    views[view] = await validateFile(entry, view);
    totalBytes += views[view]!.fileSize;
  }
  if (!views.front) throw new ApiError(400, "FRONT_VIEW_REQUIRED", "A front view is required for an orthographic image set.");
  if (totalBytes > maxUploadBytes * 5) throw new ApiError(413, "UPLOAD_TOO_LARGE", "The combined orthographic images exceed the upload limit.");
  return { image: views.front, views, resolution: null, inputMode: fieldsResult.data.inputMode, engine: fieldsResult.data.engine };
}
