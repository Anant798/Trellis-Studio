import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Generation } from "@/lib/generations";
import type { GenerationDatabase } from "@/server/database";
import type { LocalStorage } from "@/server/storage";
import { InferenceProviderError, type InferenceErrorCode, type InferenceProvider, type ProviderOutputMetadata, type ProviderReceipt, type ProviderStatus, type ProviderSubmission } from "@/server/inference/provider";
import { withGpuLock } from "@/server/inference/gpu-lock";

export type HunyuanMiniConfiguration = {
  hunyuanPythonPath: string;
  hunyuanSourceDir: string;
  hunyuanModelsDir: string;
  hunyuanTimeoutMs: number;
  maxGeneratedAssetBytes: number;
};

export type EngineStatus = {
  id: "triposr" | "hunyuan3d-2mini" | "hunyuan3d-2mv";
  label: string;
  ready: boolean;
  available: boolean;
  capability: string;
  message: string;
  deviceName: string | null;
  pythonVersion: string | null;
  code: InferenceErrorCode | null;
};

type QueueItem = { generationId: string; workerJobId: string };
const GLB_MAGIC = 0x46546c67;
const DIT_BYTES = 3_819_958_234;
const VAE_BYTES = 428_455_666;

function probe(config: HunyuanMiniConfiguration) {
  const pythonExists = existsSync(config.hunyuanPythonPath);
  const ditDir = path.join(config.hunyuanModelsDir, "tencent", "Hunyuan3D-2mini", "hunyuan3d-dit-v2-mini");
  const vaeDir = path.join(config.hunyuanModelsDir, "tencent", "Hunyuan3D-2mini", "hunyuan3d-vae-v2-mini");
  const ditPath = path.join(ditDir, "model.fp16.safetensors");
  const vaePath = path.join(vaeDir, "model.fp16.safetensors");
  if (!pythonExists) return { ready: false, code: "HUNYUAN_PYTHON_MISSING" as const, message: "The isolated Hunyuan3D Python environment is missing.", pythonVersion: null, deviceName: null };
  if (![ditDir, vaeDir].every(dir => existsSync(path.join(dir, "config.yaml"))) || !existsSync(ditPath) || !existsSync(vaePath) || statSync(ditPath).size !== DIT_BYTES || statSync(vaePath).size !== VAE_BYTES) {
    return { ready: false, code: "HUNYUAN_CHECKPOINT_MISSING" as const, message: "The verified Hunyuan3D-2mini shape checkpoints are missing or incomplete.", pythonVersion: null, deviceName: null };
  }
  const result = spawnSync(config.hunyuanPythonPath, ["-c", "import json,sys,torch,diffusers,transformers,accelerate,trimesh,rembg; from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline; print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'cuda':torch.cuda.is_available(),'device':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"], {
    cwd: config.hunyuanSourceDir,
    windowsHide: true,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONPATH: [config.hunyuanSourceDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
  });
  if (result.error || result.status !== 0) return { ready: false, code: "HUNYUAN_DEPENDENCIES_MISSING" as const, message: "The isolated Hunyuan3D environment is missing a required inference dependency.", pythonVersion: null, deviceName: null };
  try {
    const runtime = JSON.parse(result.stdout.trim()) as { python: string; cuda: boolean; device: string | null };
    if (!runtime.cuda || !runtime.device) return { ready: false, code: "HUNYUAN_CUDA_UNAVAILABLE" as const, message: "CUDA is unavailable to the isolated Hunyuan3D environment.", pythonVersion: runtime.python, deviceName: runtime.device };
    return { ready: true, code: null, message: "Hunyuan3D-2mini shape generation is ready.", pythonVersion: runtime.python, deviceName: runtime.device };
  } catch {
    return { ready: false, code: "HUNYUAN_DEPENDENCIES_MISSING" as const, message: "The isolated Hunyuan3D environment returned an invalid diagnostic response.", pythonVersion: null, deviceName: null };
  }
}

function runHunyuan(generation: Generation, inputPath: string, config: HunyuanMiniConfiguration): Promise<Buffer> {
  const directory = mkdtempSync(path.join(tmpdir(), `trellis-hunyuan-${generation.id.slice(0, 8)}-`));
  const outputPath = path.join(directory, "mesh.glb");
  const scriptPath = path.join(process.cwd(), "scripts", "hunyuan3d_mini_worker.py");
  return new Promise<Buffer>((resolve, reject) => {
    let logTail = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(config.hunyuanPythonPath, [scriptPath, inputPath, outputPath], {
      cwd: config.hunyuanSourceDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
        HY3DGEN_MODELS: config.hunyuanModelsDir,
        PYTHONPATH: [config.hunyuanSourceDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
    });
    const append = (chunk: Buffer) => { logTail = `${logTail}${chunk.toString("utf8")}`.slice(-24_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, config.hunyuanTimeoutMs);
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error("Could not start the local Hunyuan3D process.", { generationId: generation.id, error: String(error) });
      reject(new InferenceProviderError("HUNYUAN_INFERENCE_FAILED", "The isolated Hunyuan3D process could not start."));
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) { reject(new InferenceProviderError("HUNYUAN_TIMEOUT", "Hunyuan3D exceeded the configured generation time limit.")); return; }
      if (code !== 0) {
        const oom = /out of memory|cuda error.*memory|cudnn_status_alloc_failed/i.test(logTail);
        console.error("Hunyuan3D process exited with an error.", { generationId: generation.id, exitCode: code, outputTail: logTail });
        reject(new InferenceProviderError(oom ? "HUNYUAN_OUT_OF_MEMORY" : "HUNYUAN_INFERENCE_FAILED", oom ? "Hunyuan3D ran out of GPU memory." : "Hunyuan3D could not generate a mesh. Check the local worker log."));
        return;
      }
      try {
        const size = statSync(outputPath).size;
        const file = readFileSync(outputPath);
        if (size > config.maxGeneratedAssetBytes || file.byteLength < 12 || file.readUInt32LE(0) !== GLB_MAGIC || file.readUInt32LE(8) !== file.byteLength) {
          throw new InferenceProviderError("HUNYUAN_OUTPUT_INVALID", "Hunyuan3D finished without producing a valid GLB model.");
        }
        resolve(file);
      } catch (error) {
        reject(error instanceof InferenceProviderError ? error : new InferenceProviderError("HUNYUAN_OUTPUT_INVALID", "Hunyuan3D finished without a readable GLB model."));
      }
    });
  }).finally(() => rmSync(directory, { recursive: true, force: true }));
}

export class HunyuanMiniInferenceProvider implements InferenceProvider {
  private readonly pending: QueueItem[] = [];
  private isRunning = false;
  readonly status: EngineStatus;

  constructor(private readonly database: GenerationDatabase, private readonly storage: LocalStorage, private readonly config: HunyuanMiniConfiguration) {
    const result = probe(config);
    this.status = { id: "hunyuan3d-2mini", label: "Hunyuan3D-2mini", available: result.ready, capability: "Single image · Shape only · Experimental", ...result };
  }

  async initialize() {
    for (const generation of this.database.listByStatus("processing")) {
      if (generation.generationSettings.engine !== "hunyuan3d-2mini") continue;
      this.database.transition(generation.id, "failed", { errorCode: "WORKER_INTERRUPTED", errorMessage: "The Hunyuan3D worker stopped before this job finished. Retry it to start a new job." });
    }
    for (const generation of this.database.listByStatus("queued")) {
      if (generation.generationSettings.engine !== "hunyuan3d-2mini") continue;
      if (!this.status.ready) this.database.transition(generation.id, "failed", { errorCode: this.status.code ?? "HUNYUAN_DEPENDENCIES_MISSING", errorMessage: this.status.message });
      else this.pending.push({ generationId: generation.id, workerJobId: `hunyuan:${generation.id}` });
    }
    this.schedule();
  }

  async submitGeneration(request: ProviderSubmission): Promise<ProviderReceipt> {
    if (!this.status.ready) throw new InferenceProviderError(this.status.code ?? "HUNYUAN_DEPENDENCIES_MISSING", this.status.message);
    const workerJobId = `hunyuan:${request.id}`;
    this.pending.push({ generationId: request.id, workerJobId });
    setImmediate(() => this.schedule());
    return { workerJobId, status: "queued" };
  }

  async getJobStatus(workerJobId: string): Promise<{ status: ProviderStatus }> {
    const generation = this.database.get(this.generationId(workerJobId));
    if (!generation) throw new InferenceProviderError("HUNYUAN_INFERENCE_FAILED", "The Hunyuan3D generation job no longer exists.");
    return { status: generation.status };
  }

  async getOutputMetadata(workerJobId: string): Promise<ProviderOutputMetadata | null> {
    const generation = this.database.get(this.generationId(workerJobId));
    if (generation?.status !== "completed" || !generation.outputAssetKey) return null;
    return { format: "glb", fileSize: statSync(this.storage.filePath(generation.outputAssetKey)).size, contentType: "model/gltf-binary" };
  }

  async requestCancellation(workerJobId: string): Promise<boolean> {
    const id = this.generationId(workerJobId);
    const index = this.pending.findIndex(item => item.generationId === id);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    const generation = this.database.get(id);
    if (generation?.status !== "queued") return false;
    this.database.transition(id, "failed", { errorCode: "HUNYUAN_INFERENCE_FAILED", errorMessage: "The generation was stopped before inference began." });
    return true;
  }

  private generationId(workerJobId: string) {
    if (!workerJobId.startsWith("hunyuan:")) throw new InferenceProviderError("HUNYUAN_INFERENCE_FAILED", "The Hunyuan3D worker job ID is invalid.");
    return workerJobId.slice("hunyuan:".length);
  }

  private schedule() { if (!this.isRunning && this.pending.length) { this.isRunning = true; void this.drain(); } }

  private async drain() {
    try {
      while (this.pending.length) {
        const item = this.pending.shift()!;
        const generation = this.database.get(item.generationId);
        if (!generation || generation.status !== "queued") continue;
        const startedAt = Date.now();
        try {
          this.database.transition(generation.id, "processing");
          const file = await withGpuLock(() => runHunyuan(generation, this.storage.filePath(generation.inputImageKey), this.config));
          const outputAssetKey = this.storage.storeOutput(generation.id, file);
          try { this.database.transition(generation.id, "completed", { outputAssetKey, durationMs: Math.max(Date.now() - startedAt, 0) }); }
          catch (error) { this.storage.remove(outputAssetKey); throw error; }
        } catch (error) {
          const current = this.database.get(generation.id);
          const providerError = error instanceof InferenceProviderError ? error : new InferenceProviderError("HUNYUAN_INFERENCE_FAILED", "Hunyuan3D could not generate a model. Check the worker logs.");
          if (current?.status === "queued" || current?.status === "processing") this.database.transition(generation.id, "failed", { errorCode: providerError.code, errorMessage: providerError.message, durationMs: Math.max(Date.now() - startedAt, 0) });
          console.error("Hunyuan3D generation failed.", { generationId: generation.id, code: providerError.code, error: String(error) });
        }
      }
    } finally { this.isRunning = false; if (this.pending.length) this.schedule(); }
  }
}

