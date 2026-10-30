import { randomUUID } from "node:crypto";
import type { Generation } from "@/lib/generations";
import type { GenerationDatabase, NewGeneration } from "@/server/database";
import { InvalidGenerationTransitionError } from "@/server/database";
import { LocalStorage } from "@/server/storage";
import { InferenceProviderError, type InferenceProvider } from "@/server/inference/provider";

export type ValidatedImage = {
  bytes: Buffer;
  contentType: Generation["contentType"];
  extension: "png" | "jpg" | "webp";
  originalFilename: string;
  fileSize: number;
};

export type CreateGenerationInput = {
  image: ValidatedImage;
  views?: Partial<Record<"front" | "back" | "left" | "right" | "top", ValidatedImage>> | null;
  inputMode?: "single-image" | "orthographic-views";
  engine?: "triposr" | "hunyuan3d-2mini" | "hunyuan3d-2mv";
  resolution: string | null;
  generationSettings: Record<string, unknown>;
  idempotencyKey: string;
};

export class GenerationNotFoundError extends Error {}
export class ActiveGenerationError extends Error {}

export class GenerationService {
  constructor(private readonly database: GenerationDatabase, private readonly storage: LocalStorage, private readonly provider: InferenceProvider) {}

  get(id: string) { return this.database.get(id); }
  list(limit: number) { return this.database.list(limit); }

  async create(input: CreateGenerationInput): Promise<{ generation: Generation; duplicate: boolean; providerError: InferenceProviderError | null }> {
    const existing = this.database.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return { generation: existing, duplicate: true, providerError: null };

    const id = randomUUID();
    const now = new Date().toISOString();
    const storedKeys: string[] = [];
    const orthographicViewKeys: Partial<Record<"front" | "back" | "left" | "right" | "top", string>> = {};
    let inputImageKey: string;
    try {
      if (input.inputMode === "orthographic-views" && input.views) {
        for (const [view, image] of Object.entries(input.views) as Array<[keyof typeof input.views, ValidatedImage]>) {
          if (!image) continue;
          const key = view === "front"
            ? this.storage.storeInput(id, image.extension, image.bytes)
            : this.storage.storeInput(randomUUID(), image.extension, image.bytes);
          storedKeys.push(key);
          orthographicViewKeys[view] = key;
        }
        if (!orthographicViewKeys.front) throw new Error("Orthographic front view was not stored.");
        inputImageKey = orthographicViewKeys.front;
      } else {
        inputImageKey = this.storage.storeInput(id, input.image.extension, input.image.bytes);
        storedKeys.push(inputImageKey);
      }
    } catch (error) {
      for (const key of storedKeys) this.storage.remove(key);
      throw error;
    }
    const value: NewGeneration = {
      id, status: "queued", createdAt: now, updatedAt: now, inputImageKey,
      originalFilename: input.image.originalFilename, contentType: input.image.contentType,
      fileSize: input.image.fileSize, resolution: input.resolution,
      generationSettings: {
        ...input.generationSettings,
        engine: input.engine ?? "triposr",
        inputMode: input.inputMode ?? "single-image",
        ...(input.inputMode === "orthographic-views" ? { orthographicViewKeys } : {}),
      },
    };

    let generation: Generation;
    try { generation = this.database.create(value, input.idempotencyKey); }
    catch (error) {
      const duplicate = this.database.findByIdempotencyKey(input.idempotencyKey);
      if (duplicate) {
        const ticket = this.storage.stageDelete(id, storedKeys);
        this.storage.finalizeDelete(ticket);
        return { generation: duplicate, duplicate: true, providerError: null };
      }
      const ticket = this.storage.stageDelete(id, storedKeys);
      this.storage.finalizeDelete(ticket);
      throw error;
    }

    try {
      const receipt = await this.provider.submitGeneration({
        id: generation.id, inputImageKey: generation.inputImageKey, contentType: generation.contentType,
        resolution: generation.resolution, generationSettings: generation.generationSettings,
      });
      generation = this.database.setWorkerJobId(id, receipt.workerJobId);
      if (receipt.status === "processing") generation = this.database.transition(id, "processing");
      return { generation, duplicate: false, providerError: null };
    } catch (error) {
      const providerError = error instanceof InferenceProviderError ? error : new InferenceProviderError("TRIPOSR_INFERENCE_FAILED", "The local TripoSR worker is unavailable.");
      generation = this.database.transition(id, "failed", {
        errorCode: providerError.code,
        errorMessage: providerError.message,
        durationMs: Math.max(Date.now() - Date.parse(now), 0),
      });
      return { generation, duplicate: false, providerError };
    }
  }

  async delete(id: string): Promise<void> {
    const generation = this.database.get(id);
    if (!generation) throw new GenerationNotFoundError("Generation not found.");
    if (generation.status === "queued" || generation.status === "processing") throw new ActiveGenerationError("An active generation cannot be deleted.");

    const views = generation.generationSettings.orthographicViewKeys;
    const viewKeys = views && typeof views === "object" ? Object.values(views).filter((key): key is string => typeof key === "string") : [];
    const ticket = this.storage.stageDelete(id, [generation.inputImageKey, ...viewKeys, generation.outputAssetKey]);
    try { this.database.delete(id); }
    catch (error) {
      this.storage.rollbackDelete(ticket);
      throw error;
    }
    try { this.storage.finalizeDelete(ticket); }
    catch (error) { console.warn("Generation files remain in private trash after deletion.", { generationId: id, error: String(error) }); }
  }

  transition(id: string, status: "processing" | "completed" | "failed", data?: Parameters<GenerationDatabase["transition"]>[2]) {
    try { return this.database.transition(id, status, data); }
    catch (error) {
      if (error instanceof InvalidGenerationTransitionError) throw error;
      throw error;
    }
  }
}
