import os from "node:os";
import path from "node:path";

function positiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function getServerConfig() {
  const storageDir = path.resolve(process.env.STORAGE_DIR || "./storage");
  const publicDir = path.resolve(process.cwd(), "public");
  const relative = path.relative(publicDir, storageDir);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error("STORAGE_DIR must be outside the public directory.");
  }

  const configuredDb = process.env.DATABASE_PATH || path.join(storageDir, "trellis.sqlite");
  const databasePath = path.resolve(configuredDb);
  const databaseRelative = path.relative(publicDir, databasePath);
  if (!databaseRelative.startsWith("..") && !path.isAbsolute(databaseRelative)) {
    throw new Error("DATABASE_PATH must be outside the public directory.");
  }
  const triposrRepoDir = path.resolve(process.env.TRIPOSR_REPO || path.join(os.homedir(), "Desktop", "TripoSR"));
  const triposrPythonPath = path.resolve(process.env.TRIPOSR_PYTHON || path.join(process.cwd(), ".venv-triposr", "Scripts", "python.exe"));
  const triposrModelDir = process.env.TRIPOSR_MODEL_DIR?.trim() ? path.resolve(process.env.TRIPOSR_MODEL_DIR.trim()) : "";
  const hunyuanPythonPath = path.resolve(process.env.HUNYUAN_PYTHON || path.join(process.cwd(), ".uv-cache", "hunyuan3d-env", "Scripts", "python.exe"));
  const hunyuanSourceDir = path.resolve(process.env.HUNYUAN_SOURCE || path.join(process.cwd(), ".uv-cache", "Hunyuan3D-2-source"));
  const hunyuanModelsDir = path.resolve(process.env.HY3DGEN_MODELS || path.join(process.cwd(), ".uv-cache", "hy3dgen-models"));
  return {
    storageDir,
    databasePath,
    maxUploadBytes: positiveInteger(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024, 50 * 1024 * 1024),
    triposrRepoDir,
    triposrPythonPath,
    triposrModelDir,
    hunyuanPythonPath,
    hunyuanSourceDir,
    hunyuanModelsDir,
    triposrChunkSize: positiveInteger(process.env.TRIPOSR_CHUNK_SIZE, 4096, 8192),
    triposrMcResolution: positiveInteger(process.env.TRIPOSR_MC_RESOLUTION, 256, 512),
    triposrTimeoutMs: positiveInteger(process.env.TRIPOSR_TIMEOUT_MS, 900_000, 3_600_000),
    hunyuanTimeoutMs: positiveInteger(process.env.HUNYUAN_TIMEOUT_MS, 1_200_000, 3_600_000),
    maxGeneratedAssetBytes: positiveInteger(process.env.MAX_GENERATED_ASSET_BYTES, 256 * 1024 * 1024, 1024 * 1024 * 1024),
  };
}

export function isLocalRequest(request: Request): boolean {
  const host = request.headers.get("host");
  if (!host) return false;
  let hostname: string;
  try { hostname = new URL(`http://${host}`).hostname.toLowerCase(); } catch { return false; }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname)) return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname.toLowerCase() === hostname && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname.toLowerCase());
  } catch { return false; }
}
