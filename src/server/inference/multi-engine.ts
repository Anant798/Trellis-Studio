import type { GenerationDatabase } from "@/server/database";
import { InferenceProviderError, type InferenceProvider, type ProviderOutputMetadata, type ProviderReceipt, type ProviderStatus, type ProviderSubmission } from "@/server/inference/provider";
import type { LocalStorage } from "@/server/storage";
import { HunyuanMiniInferenceProvider, type EngineStatus, type HunyuanMiniConfiguration } from "@/server/inference/hunyuan-mini";
import { TripoSRInferenceProvider, type TripoSRConfiguration } from "@/server/inference/triposr";

export class MultiEngineInferenceProvider implements InferenceProvider {
  private readonly hunyuan: HunyuanMiniInferenceProvider;
  private readonly triposr: TripoSRInferenceProvider;

  constructor(database: GenerationDatabase, storage: LocalStorage, triposrConfig: TripoSRConfiguration, hunyuanConfig: HunyuanMiniConfiguration) {
    this.triposr = new TripoSRInferenceProvider(database, storage, triposrConfig);
    this.hunyuan = new HunyuanMiniInferenceProvider(database, storage, hunyuanConfig);
  }

  async initialize() {
    await this.triposr.initialize();
    await this.hunyuan.initialize();
  }

  getWorkerStatus() {
    const triposr = this.triposr.getWorkerStatus();
    const engines: EngineStatus[] = [
      {
        id: "triposr", label: "TripoSR", ready: triposr.ready, available: triposr.ready,
        capability: "Single image · Shape and vertex color", message: triposr.message,
        deviceName: triposr.deviceName, pythonVersion: triposr.pythonVersion, code: triposr.code,
      },
      this.hunyuan.status,
      {
        id: "hunyuan3d-2mv", label: "Hunyuan3D-2mv", ready: false, available: false,
        capability: "Orthographic views · Experimental", message: "Multi-view is not enabled: the official 2mv model has not been installed and tested on this 6 GB GPU.",
        deviceName: null, pythonVersion: null, code: "MULTIVIEW_UNAVAILABLE",
      },
    ];
    return { ...triposr, engines };
  }

  submitGeneration(request: ProviderSubmission): Promise<ProviderReceipt> {
    const engine = String(request.generationSettings.engine ?? "triposr");
    if (engine === "hunyuan3d-2mini") return this.hunyuan.submitGeneration(request);
    if (engine === "hunyuan3d-2mv") {
      return Promise.reject(new InferenceProviderError("MULTIVIEW_UNAVAILABLE", "Hunyuan3D-2mv is unavailable because genuine multi-view inference has not been verified on this machine."));
    }
    if (engine !== "triposr") {
      return Promise.reject(new InferenceProviderError("TRIPOSR_INFERENCE_FAILED", "The selected generation engine is not supported."));
    }
    return this.triposr.submitGeneration(request);
  }

  getJobStatus(workerJobId: string): Promise<{ status: ProviderStatus }> {
    return workerJobId.startsWith("hunyuan:") ? this.hunyuan.getJobStatus(workerJobId) : this.triposr.getJobStatus(workerJobId);
  }

  getOutputMetadata(workerJobId: string): Promise<ProviderOutputMetadata | null> {
    return workerJobId.startsWith("hunyuan:") ? this.hunyuan.getOutputMetadata(workerJobId) : this.triposr.getOutputMetadata(workerJobId);
  }

  requestCancellation(workerJobId: string): Promise<boolean> {
    return workerJobId.startsWith("hunyuan:") ? this.hunyuan.requestCancellation(workerJobId) : this.triposr.requestCancellation(workerJobId);
  }
}

