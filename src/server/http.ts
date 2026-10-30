import { z } from "zod";
import type { Generation, GenerationResponse } from "@/lib/generations";
import { ApiError } from "@/server/errors";
import type { ServerRuntime } from "@/server/runtime";

export const uuidSchema = z.string().uuid();

export function publicGeneration(generation: Generation): GenerationResponse {
  const { inputImageKey: _inputKey, outputAssetKey: _outputKey, workerJobId: _workerId, generationSettings, ...publicRecord } = generation;
  void _inputKey; void _outputKey; void _workerId;
  const { orthographicViewKeys, ...safeSettings } = generationSettings;
  const views = orthographicViewKeys && typeof orthographicViewKeys === "object"
    ? Object.fromEntries(Object.keys(orthographicViewKeys).map(view => [view, `/api/v1/generations/${generation.id}/views/${view}`]))
    : undefined;
  return { ...publicRecord, generationSettings: safeSettings, ...(views ? { orthographicViews: views } : {}) };
}

export function parseGenerationId(value: string) {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "INVALID_GENERATION_ID", "The generation ID is invalid.");
  return parsed.data;
}

export function requireGeneration(runtime: ServerRuntime, id: string) {
  const generation = runtime.generations.get(id);
  if (!generation) throw new ApiError(404, "GENERATION_NOT_FOUND", "The generation was not found.");
  return generation;
}
