import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Generation } from "@/lib/generations";
import type { GenerationDatabase } from "@/server/database";
import type { LocalStorage } from "@/server/storage";
import { InferenceProviderError, type InferenceErrorCode, type InferenceProvider, type ProviderOutputMetadata, type ProviderReceipt, type ProviderStatus, type ProviderSubmission } from "@/server/inference/provider";
import { withGpuLock } from "@/server/inference/gpu-lock";

export type TripoSRConfiguration = {
  triposrRepoDir: string;
  triposrPythonPath: string;
  triposrModelDir: string;
  triposrChunkSize: number;
  triposrMcResolution: number;
  triposrTimeoutMs: number;
  maxGeneratedAssetBytes: number;
};

export type TripoSRWorkerStatus = {
  model: "TripoSR";
  ready: boolean;
  code: InferenceErrorCode | null;
  message: string;
  deviceName: string | null;
  pythonVersion: string | null;
  issues: Array<{ code: InferenceErrorCode; message: string }>;
};

type QueueItem = { generationId: string; workerJobId: string };
type RuntimeProbe = { pythonVersion: string; deviceName: string };
export type TripoSRRunner = (generation: Generation, inputPath: string, config: TripoSRConfiguration) => Promise<Buffer>;
export type TripoSRProbe = (config: TripoSRConfiguration) => RuntimeProbe;

const LOG_TAIL_LIMIT = 24_000;
const VALID_GLB_MAGIC = 0x46546c67;

function probeRuntime(config: TripoSRConfiguration): RuntimeProbe {
  const result = spawnSync(config.triposrPythonPath, [
    "-c",
    "import json,sys,torch,numpy,PIL,einops,omegaconf,rembg,trimesh,transformers,xatlas,torchmcubes; print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'cuda':torch.cuda.is_available(),'device':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))",
  ], { cwd: config.triposrRepoDir, windowsHide: true, encoding: "utf8", timeout: 300_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("The isolated Python environment cannot import CUDA-enabled PyTorch.");
  const runtime = JSON.parse(result.stdout.trim()) as { python: string; cuda: boolean; device: string | null };
  const majorMinor = runtime.python.split(".").slice(0, 2).map(Number);
  const supported = majorMinor[0] === 3 && majorMinor[1] >= 10 && majorMinor[1] <= 14;
  if (!supported) throw new Error("TripoSR requires a PyTorch-supported Python 3.10–3.14 environment.");
  if (!runtime.cuda || !runtime.device) throw new Error("CUDA is unavailable to PyTorch in the configured environment.");
  return { pythonVersion: runtime.python, deviceName: runtime.device };
}

export function inspectTripoSR(config: TripoSRConfiguration, probe: TripoSRProbe = probeRuntime): TripoSRWorkerStatus {
  const issues: TripoSRWorkerStatus["issues"] = [];
  const repositoryReady = existsSync(path.join(config.triposrRepoDir, "run.py"));
  if (!repositoryReady) issues.push({ code: "TRIPOSR_REPO_MISSING", message: "The local TripoSR repository was not found. Set TRIPOSR_REPO to the existing clone." });
  const pythonReady = Boolean(config.triposrPythonPath && existsSync(config.triposrPythonPath));
  if (!pythonReady) issues.push({ code: "TRIPOSR_PYTHON_MISSING", message: "The isolated TripoSR Python environment is missing. Create it and set TRIPOSR_PYTHON." });
  let runtime: RuntimeProbe | null = null;
  if (repositoryReady && pythonReady) {
    try {
      runtime = probe(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The TripoSR runtime could not be verified.";
      issues.push({
        code: message.includes("CUDA") ? "TRIPOSR_CUDA_UNAVAILABLE" : "TRIPOSR_DEPENDENCIES_MISSING",
        message,
      });
    }
  }
  const checkpointReady = Boolean(config.triposrModelDir && existsSync(path.join(config.triposrModelDir, "config.yaml")) && existsSync(path.join(config.triposrModelDir, "model.ckpt")));
  if (!checkpointReady) issues.push({ code: "TRIPOSR_CHECKPOINT_MISSING", message: "The TripoSR checkpoint is not installed locally. Set TRIPOSR_MODEL_DIR after downloading the official model files." });
  if (issues.length) {
    return {
      model: "TripoSR", ready: false, code: issues[0].code,
      message: issues.map(issue => issue.message).join(" "),
      deviceName: runtime?.deviceName ?? null, pythonVersion: runtime?.pythonVersion ?? null, issues,
    };
  }
  return { model: "TripoSR", ready: true, code: null, message: "The TripoSR environment checks pass. The first completed job will confirm actual inference.", ...runtime!, issues: [] };
}

function runTripoSR(generation: Generation, inputPath: string, config: TripoSRConfiguration): Promise<Buffer> {
  const runDirectory = mkdtempSync(path.join(tmpdir(), `trellis-triposr-${generation.id.slice(0, 8)}-`));
  const script = path.join(config.triposrRepoDir, "run.py");
  const args = [
    script,
    inputPath,
    "--output-dir", runDirectory,
    "--device", "cuda:0",
    "--chunk-size", String(config.triposrChunkSize),
    "--mc-resolution", String(config.triposrMcResolution),
    "--model-save-format", "glb",
    "--pretrained-model-name-or-path", config.triposrModelDir,
  ];

  return new Promise<Buffer>((resolve, reject) => {
    let logTail = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(config.triposrPythonPath, args, {
      cwd: config.triposrRepoDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    const appendLog = (chunk: Buffer) => { logTail = `${logTail}${chunk.toString("utf8")}`.slice(-LOG_TAIL_LIMIT); };
    child.stdout.on("data", appendLog);
    child.stderr.on("data", appendLog);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, config.triposrTimeoutMs);

    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error("Could not start the local TripoSR process.", { generationId: generation.id, error: String(error) });
      reject(new InferenceProviderError("TRIPOSR_INFERENCE_FAILED", "The local TripoSR process could not start. Check the worker setup and logs."));
    });

    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new InferenceProviderError("TRIPOSR_TIMEOUT", "TripoSR exceeded the configured generation time limit."));
        return;
      }
      if (code !== 0) {
        const outOfMemory = /out of memory|cuda error.*memory|cudnn_status_alloc_failed/i.test(logTail);
        reject(new InferenceProviderError(
          outOfMemory ? "TRIPOSR_OUT_OF_MEMORY" : "TRIPOSR_INFERENCE_FAILED",
          outOfMemory
            ? "TripoSR ran out of GPU memory. Close GPU-heavy apps or lower the worker chunk size and mesh resolution before retrying."
            : "TripoSR could not generate a mesh. Check the local worker logs for details.",
        ));
        console.error("TripoSR process exited with an error.", { generationId: generation.id, exitCode: code, outputTail: logTail });
        return;
      }

      try {
        const meshPath = path.join(runDirectory, "0", "mesh.glb");
        const fileSize = statSync(meshPath).size;
        if (fileSize > config.maxGeneratedAssetBytes) {
          throw new InferenceProviderError("TRIPOSR_OUTPUT_INVALID", "The generated model exceeds the configured local asset size limit.");
        }
        const file = readFileSync(meshPath);
        if (file.byteLength < 12 || file.readUInt32LE(0) !== VALID_GLB_MAGIC || file.readUInt32LE(8) !== file.byteLength) {
          throw new InferenceProviderError("TRIPOSR_OUTPUT_INVALID", "TripoSR finished without producing a valid GLB model.");
        }
        resolve(file);
      } catch (error) {
        reject(error instanceof InferenceProviderError ? error : new InferenceProviderError("TRIPOSR_OUTPUT_INVALID", "TripoSR finished without producing a readable GLB model."));
      }
    });
  }).finally(() => {
    rmSync(runDirectory, { recursive: true, force: true });
  });
}

export class TripoSRInferenceProvider implements InferenceProvider {
  private readonly pending: QueueItem[] = [];
  private isRunning = false;
  private status: TripoSRWorkerStatus;

  constructor(
    private readonly database: GenerationDatabase,
    private readonly storage: LocalStorage,
    private readonly config: TripoSRConfiguration,
    private readonly runner: TripoSRRunner = runTripoSR,
    probe: TripoSRProbe = probeRuntime,
  ) {
    this.status = inspectTripoSR(config, probe);
  }

  getWorkerStatus() { return { ...this.status }; }

  async initialize() {
    const interrupted = this.database.listByStatus("processing");
    for (const generation of interrupted) {
      if (generation.generationSettings.engine && generation.generationSettings.engine !== "triposr") continue;
      this.database.transition(generation.id, "failed", {
        errorCode: "WORKER_INTERRUPTED",
        errorMessage: "The local worker stopped before this generation finished. Retry it to start a new job.",
      });
    }
    for (const generation of this.database.listByStatus("queued")) {
      if (generation.generationSettings.engine && generation.generationSettings.engine !== "triposr") continue;
      if (!this.status.ready) {
        this.database.transition(generation.id, "failed", {
          errorCode: this.status.code ?? "TRIPOSR_DEPENDENCIES_MISSING",
          errorMessage: this.status.message,
        });
        continue;
      }
      this.pending.push({ generationId: generation.id, workerJobId: `local:${generation.id}` });
    }
    this.schedule();
  }

  async submitGeneration(request: ProviderSubmission): Promise<ProviderReceipt> {
    if (!this.status.ready) {
      throw new InferenceProviderError(this.status.code ?? "TRIPOSR_DEPENDENCIES_MISSING", this.status.message);
    }
    const workerJobId = `local:${request.id}`;
    this.pending.push({ generationId: request.id, workerJobId });
    setImmediate(() => this.schedule());
    return { workerJobId, status: "queued" };
  }

  async getJobStatus(workerJobId: string): Promise<{ status: ProviderStatus }> {
    const generation = this.database.get(this.generationId(workerJobId));
    if (!generation) throw new InferenceProviderError("TRIPOSR_INFERENCE_FAILED", "The local generation job no longer exists.");
    return { status: generation.status };
  }

  async getOutputMetadata(workerJobId: string): Promise<ProviderOutputMetadata | null> {
    const generation = this.database.get(this.generationId(workerJobId));
    if (generation?.status !== "completed" || !generation.outputAssetKey) return null;
    const fileSize = statSync(this.storage.filePath(generation.outputAssetKey)).size;
    return { format: "glb", fileSize, contentType: "model/gltf-binary" };
  }

  async requestCancellation(workerJobId: string): Promise<boolean> {
    const id = this.generationId(workerJobId);
    const index = this.pending.findIndex(item => item.generationId === id);
    if (index >= 0) {
      this.pending.splice(index, 1);
      const generation = this.database.get(id);
      if (generation?.status === "queued") {
        this.database.transition(id, "failed", { errorCode: "TRIPOSR_INFERENCE_FAILED", errorMessage: "The generation was stopped before inference began." });
        return true;
      }
    }
    return false;
  }

  private generationId(workerJobId: string) {
    if (!workerJobId.startsWith("local:")) throw new InferenceProviderError("TRIPOSR_INFERENCE_FAILED", "The local generation job ID is invalid.");
    return workerJobId.slice("local:".length);
  }

  private schedule() {
    if (this.isRunning || this.pending.length === 0) return;
    this.isRunning = true;
    void this.drain();
  }

  private async drain() {
    try {
      while (this.pending.length) {
        const item = this.pending.shift()!;
        const generation = this.database.get(item.generationId);
        if (!generation || generation.status !== "queued") continue;
        const startedAt = Date.now();
        try {
          this.database.transition(generation.id, "processing");
          const output = await withGpuLock(() => this.runner(generation, this.storage.filePath(generation.inputImageKey), this.config));
          const outputAssetKey = this.storage.storeOutput(generation.id, output);
          try {
            this.database.transition(generation.id, "completed", { outputAssetKey, durationMs: Math.max(Date.now() - startedAt, 0) });
          } catch (error) {
            this.storage.remove(outputAssetKey);
            throw error;
          }
        } catch (error) {
          const current = this.database.get(generation.id);
          const providerError = error instanceof InferenceProviderError
            ? error
            : new InferenceProviderError("TRIPOSR_INFERENCE_FAILED", "TripoSR could not generate a model. Check the local worker logs for details.");
          if (current?.status === "queued" || current?.status === "processing") {
            try {
              this.database.transition(generation.id, "failed", {
                errorCode: providerError.code,
                errorMessage: providerError.message,
                durationMs: Math.max(Date.now() - startedAt, 0),
              });
            } catch (persistError) {
              console.error("Could not persist TripoSR failure status.", { generationId: generation.id, error: String(persistError) });
            }
          }
          console.error("TripoSR generation failed.", { generationId: generation.id, code: providerError.code, error: String(error) });
        }
      }
    } finally {
      this.isRunning = false;
      if (this.pending.length) this.schedule();
    }
  }
}
