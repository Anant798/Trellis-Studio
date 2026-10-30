import type { Generation } from "@/lib/generations";

export type ProviderStatus = "queued" | "processing" | "completed" | "failed";
export type ProviderSubmission = Pick<Generation, "id" | "inputImageKey" | "contentType" | "resolution" | "generationSettings">;
export type ProviderReceipt = { workerJobId: string; status: "queued" | "processing" };
export type ProviderOutputMetadata = { format: "glb"; fileSize: number; contentType: "model/gltf-binary" };
export type InferenceErrorCode =
  | "TRIPOSR_REPO_MISSING"
  | "TRIPOSR_PYTHON_MISSING"
  | "TRIPOSR_DEPENDENCIES_MISSING"
  | "TRIPOSR_CHECKPOINT_MISSING"
  | "TRIPOSR_REMBG_MODEL_MISSING"
  | "TRIPOSR_CUDA_UNAVAILABLE"
  | "TRIPOSR_INFERENCE_FAILED"
  | "TRIPOSR_OUT_OF_MEMORY"
  | "TRIPOSR_TIMEOUT"
  | "TRIPOSR_OUTPUT_INVALID"
  | "HUNYUAN_PYTHON_MISSING"
  | "HUNYUAN_DEPENDENCIES_MISSING"
  | "HUNYUAN_CHECKPOINT_MISSING"
  | "HUNYUAN_CUDA_UNAVAILABLE"
  | "HUNYUAN_INFERENCE_FAILED"
  | "HUNYUAN_OUT_OF_MEMORY"
  | "HUNYUAN_TIMEOUT"
  | "HUNYUAN_OUTPUT_INVALID"
  | "MULTIVIEW_UNAVAILABLE"
  | "WORKER_INTERRUPTED";

export class InferenceProviderError extends Error {
  constructor(readonly code: InferenceErrorCode, message: string) {
    super(message);
    this.name = "InferenceProviderError";
  }
}

export interface InferenceProvider {
  submitGeneration(request: ProviderSubmission): Promise<ProviderReceipt>;
  getJobStatus(workerJobId: string): Promise<{ status: ProviderStatus }>;
  getOutputMetadata(workerJobId: string): Promise<ProviderOutputMetadata | null>;
  requestCancellation(workerJobId: string): Promise<boolean>;
}
