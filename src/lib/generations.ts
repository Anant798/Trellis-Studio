export const generationStatuses = ["queued", "processing", "completed", "failed"] as const;
export type GenerationStatus = (typeof generationStatuses)[number];

export type Generation = {
  id: string;
  status: GenerationStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  inputImageKey: string;
  outputAssetKey: string | null;
  originalFilename: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  fileSize: number;
  resolution: string | null;
  generationSettings: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  workerJobId: string | null;
  inputImageUrl: string;
  assetUrl: string | null;
};

export type GenerationResponse = Omit<Generation, "inputImageKey" | "outputAssetKey" | "workerJobId"> & {
  orthographicViews?: Partial<Record<"front" | "back" | "left" | "right" | "top", string>>;
};

export type GenerationEngineStatus = {
  id: "triposr" | "hunyuan3d-2mini" | "hunyuan3d-2mv";
  label: string;
  ready: boolean;
  available: boolean;
  capability: string;
  message: string;
  deviceName: string | null;
  pythonVersion: string | null;
  code: string | null;
};

export type WorkerStatus = {
  model: "TripoSR";
  ready: boolean;
  code: string | null;
  message: string;
  deviceName: string | null;
  pythonVersion: string | null;
  issues: Array<{ code: string; message: string }>;
  engines?: GenerationEngineStatus[];
};
