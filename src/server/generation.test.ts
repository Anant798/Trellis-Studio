import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { POST, GET as listGenerations } from "@/app/api/v1/generations/route";
import { GET as getGeneration, DELETE as deleteGeneration } from "@/app/api/v1/generations/[id]/route";
import { GET as getInput } from "@/app/api/v1/generations/[id]/input/route";
import { GET as getAsset } from "@/app/api/v1/generations/[id]/asset/route";
import { GET as getWorkerStatus } from "@/app/api/v1/worker/status/route";
import { getServerRuntime } from "@/server/runtime";
import { GenerationDatabase } from "@/server/database";
import { LocalStorage } from "@/server/storage";
import { detectImageType, sanitizeOriginalFilename, validateGenerationForm } from "@/server/validation";
import { ApiError } from "@/server/errors";
import { parseGenerationId } from "@/server/http";
import { TripoSRInferenceProvider, type TripoSRConfiguration } from "@/server/inference/triposr";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const routeContext = (id: string) => ({ params: Promise.resolve({ id }) });
const localHeaders = { host: "127.0.0.1:3000" };

test("generation API validates uploads, persists failed worker jobs, serves private input, and safely deletes", async t => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "trellis-api-test-"));
  const previous = { storage: process.env.STORAGE_DIR, database: process.env.DATABASE_PATH, max: process.env.MAX_UPLOAD_BYTES, python: process.env.TRIPOSR_PYTHON, model: process.env.TRIPOSR_MODEL_DIR, repo: process.env.TRIPOSR_REPO };
  process.env.STORAGE_DIR = path.join(sandbox, "storage");
  process.env.DATABASE_PATH = path.join(sandbox, "storage", "metadata.sqlite");
  process.env.MAX_UPLOAD_BYTES = "16";
  process.env.TRIPOSR_PYTHON = path.join(sandbox, "missing-python.exe");
  process.env.TRIPOSR_MODEL_DIR = "";
  process.env.TRIPOSR_REPO = path.join(sandbox, "missing-triposr-repo");
  const previewPath = path.join(process.cwd(), "public", "models", "mech_drone.glb");
  const previewHash = createHash("sha256").update(await readFile(previewPath)).digest("hex");

  try {
    await t.test("valid multipart request creates persistent job with honest worker error", async () => {
      const form = new FormData();
      form.append("image", new File([pngBytes], "..\\reference.png", { type: "image/png" }));
      const idempotencyKey = randomUUID();
      const request = new Request("http://127.0.0.1:3000/api/v1/generations", { method: "POST", headers: { ...localHeaders, "Idempotency-Key": idempotencyKey }, body: form });
      const response = await POST(request);
      assert.equal(response.status, 503);
      const body = await response.json() as { generation: { id: string; status: string; originalFilename: string; inputImageUrl: string; assetUrl: string | null; errorCode: string | null; inputImageKey?: string }; error: { code: string } };
      assert.match(body.generation.id, /^[\da-f-]{36}$/i);
      assert.equal(body.generation.status, "failed");
      assert.equal(body.generation.originalFilename, "reference.png");
      assert.equal(body.generation.assetUrl, null);
      assert.equal(body.generation.inputImageKey, undefined);
      assert.equal(body.error.code, "TRIPOSR_REPO_MISSING");
      const runtime = await getServerRuntime();
      assert.throws(() => runtime.generations.transition(body.generation.id, "processing"), /Cannot move generation/);

      const listed = await listGenerations(new Request("http://127.0.0.1:3000/api/v1/generations", { headers: localHeaders }));
      const listBody = await listed.json() as { generations: Array<{ id: string; status: string }> };
      assert.equal(listed.status, 200);
      assert.equal(listBody.generations.length, 1);
      assert.equal(listBody.generations[0].id, body.generation.id);

      const worker = await getWorkerStatus(new Request("http://127.0.0.1:3000/api/v1/worker/status", { headers: localHeaders }));
      assert.equal(worker.status, 200);
      const statusBody = await worker.json() as { worker: {
        model: string; ready: boolean; code: string; message: string; deviceName: string | null; pythonVersion: string | null;
        issues: Array<{ code: string; message: string }>;
        engines: Array<{ id: string; label: string; ready: boolean; available: boolean; capability: string; code: string | null }>;
      } };
      const { engines, ...legacyStatus } = statusBody.worker;
      assert.deepEqual(legacyStatus, {
        model: "TripoSR", ready: false, code: "TRIPOSR_REPO_MISSING",
        message: "The local TripoSR repository was not found. Set TRIPOSR_REPO to the existing clone. The isolated TripoSR Python environment is missing. Create it and set TRIPOSR_PYTHON. The TripoSR checkpoint is not installed locally. Set TRIPOSR_MODEL_DIR after downloading the official model files.",
        deviceName: null, pythonVersion: null,
        issues: [
          { code: "TRIPOSR_REPO_MISSING", message: "The local TripoSR repository was not found. Set TRIPOSR_REPO to the existing clone." },
          { code: "TRIPOSR_PYTHON_MISSING", message: "The isolated TripoSR Python environment is missing. Create it and set TRIPOSR_PYTHON." },
          { code: "TRIPOSR_CHECKPOINT_MISSING", message: "The TripoSR checkpoint is not installed locally. Set TRIPOSR_MODEL_DIR after downloading the official model files." },
        ],
      });
      assert.deepEqual(engines.map(({ id, label, ready, available, capability, code }) => ({ id, label, ready, available, capability, code })), [
        { id: "triposr", label: "TripoSR", ready: false, available: false, capability: "Single image · Shape and vertex color", code: "TRIPOSR_REPO_MISSING" },
        { id: "hunyuan3d-2mini", label: "Hunyuan3D-2mini", ready: true, available: true, capability: "Single image · Shape only · Experimental", code: null },
        { id: "hunyuan3d-2mv", label: "Hunyuan3D-2mv", ready: false, available: false, capability: "Orthographic views · Experimental", code: "MULTIVIEW_UNAVAILABLE" },
      ]);

      const detail = await getGeneration(new Request(`http://127.0.0.1:3000/api/v1/generations/${body.generation.id}`, { headers: localHeaders }), routeContext(body.generation.id));
      assert.equal(detail.status, 200);
      assert.equal((await detail.json() as { generation: { errorCode: string } }).generation.errorCode, "TRIPOSR_REPO_MISSING");

      const input = await getInput(new Request(`http://127.0.0.1:3000/api/v1/generations/${body.generation.id}/input`, { headers: localHeaders }), routeContext(body.generation.id));
      assert.equal(input.status, 200);
      assert.equal(input.headers.get("content-type"), "image/png");
      assert.deepEqual(Buffer.from(await input.arrayBuffer()), pngBytes);

      const unavailable = await getAsset(new Request(`http://127.0.0.1:3000/api/v1/generations/${body.generation.id}/asset`, { headers: localHeaders }), routeContext(body.generation.id));
      assert.equal(unavailable.status, 409);

      const sameForm = new FormData();
      sameForm.append("image", new File([pngBytes], "ignored.png", { type: "image/png" }));
      const duplicate = await POST(new Request("http://127.0.0.1:3000/api/v1/generations", { method: "POST", headers: { ...localHeaders, "Idempotency-Key": idempotencyKey }, body: sameForm }));
      assert.equal(duplicate.status, 503);
      assert.equal((await duplicate.json() as { generation: { id: string } }).generation.id, body.generation.id);

      const reloaded = await GenerationDatabase.open(process.env.DATABASE_PATH!);
      assert.equal(reloaded.get(body.generation.id)?.status, "failed");
      reloaded.close();

      const deletion = await deleteGeneration(new Request(`http://127.0.0.1:3000/api/v1/generations/${body.generation.id}`, { method: "DELETE", headers: localHeaders }), routeContext(body.generation.id));
      assert.equal(deletion.status, 204);
      const deletedInput = await getInput(new Request(`http://127.0.0.1:3000/api/v1/generations/${body.generation.id}/input`, { headers: localHeaders }), routeContext(body.generation.id));
      assert.equal(deletedInput.status, 404);
      assert.equal((await listGenerations(new Request("http://127.0.0.1:3000/api/v1/generations", { headers: localHeaders })).then(r => r.json()) as { generations: unknown[] }).generations.length, 0);
      assert.equal(createHash("sha256").update(await readFile(previewPath)).digest("hex"), previewHash);
    });

    await t.test("unsupported, mismatched, oversized, and malformed requests return structured errors", async () => {
      const postFile = async (file: File, key = randomUUID()) => {
        const form = new FormData(); form.append("image", file);
        return POST(new Request("http://127.0.0.1/api/v1/generations", { method: "POST", headers: { ...localHeaders, "Idempotency-Key": key }, body: form }));
      };
      const unsupported = await postFile(new File(["hello"], "notes.txt", { type: "text/plain" }));
      assert.equal(unsupported.status, 415);
      assert.equal((await unsupported.json() as { error: { code: string } }).error.code, "UNSUPPORTED_FILE_TYPE");
      const mismatch = await postFile(new File([pngBytes], "wrong.jpg", { type: "image/jpeg" }));
      assert.equal(mismatch.status, 415);
      const tooLarge = await postFile(new File([Buffer.alloc(17, 1)], "large.png", { type: "image/png" }));
      assert.equal(tooLarge.status, 413);
      const invalidFields = new FormData(); invalidFields.append("image", new File([pngBytes], "x.png", { type: "image/png" })); invalidFields.append("resolution", "8192");
      const invalidSettings = await POST(new Request("http://127.0.0.1/api/v1/generations", { method: "POST", headers: localHeaders, body: invalidFields }));
      assert.equal(invalidSettings.status, 400);
      const invalidId = await getGeneration(new Request("http://127.0.0.1/api/v1/generations/not-a-uuid", { headers: localHeaders }), routeContext("not-a-uuid"));
      assert.equal(invalidId.status, 400);
      const remote = await listGenerations(new Request("http://example.test/api/v1/generations", { headers: { host: "example.test" } }));
      assert.equal(remote.status, 403);
    });

    await t.test("only completed jobs expose a private GLB download", async () => {
      const runtime = await getServerRuntime();
      const id = randomUUID();
      const now = new Date().toISOString();
      const inputImageKey = runtime.storage.storeInput(id, "png", pngBytes);
      runtime.database.create({ id, status: "queued", createdAt: now, updatedAt: now, inputImageKey, originalFilename: "fixture.png", contentType: "image/png", fileSize: pngBytes.byteLength, resolution: null, generationSettings: {} }, randomUUID());
      assert.throws(() => runtime.database.transition(id, "completed"), /Cannot move generation/);
      runtime.database.transition(id, "processing");
      assert.throws(() => runtime.database.transition(id, "completed"), /require an output asset/);
      const glb = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0, 0, 0]);
      const outputAssetKey = runtime.storage.storeOutput(id, glb);
      runtime.database.transition(id, "completed", { outputAssetKey, completedAt: new Date().toISOString(), durationMs: 1200 });
      const response = await getAsset(new Request(`http://127.0.0.1:3000/api/v1/generations/${id}/asset`, { headers: localHeaders }), routeContext(id));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "model/gltf-binary");
      assert.equal(response.headers.get("content-disposition"), `attachment; filename="generation-${id}.glb"`);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), glb);
      await runtime.generations.delete(id);
      assert.equal(runtime.generations.get(id), null);
    });

    await t.test("signature validation, path-safe names, transitions, and storage rollback", async () => {
      assert.equal(detectImageType(pngBytes)?.contentType, "image/png");
      assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))?.contentType, "image/jpeg");
      assert.equal(detectImageType(Buffer.from("RIFFxxxxWEBP"))?.contentType, "image/webp");
      assert.equal(detectImageType(Buffer.from("not an image")), null);
      assert.equal(sanitizeOriginalFilename("C:\\private\\..\\photo.png"), "photo.png");
      assert.throws(() => parseGenerationId("../metadata.sqlite"), ApiError);
      const runtime = await getServerRuntime();
      assert.throws(() => runtime.storage.read("../metadata.sqlite"), /Invalid stored asset key/);
      const storage = new LocalStorage(path.join(sandbox, "storage-check"));
      await assert.rejects(GenerationDatabase.open(storage.inputsDirectory));
      const id = randomUUID();
      const key = storage.storeInput(id, "png", pngBytes);
      assert.throws(() => storage.storeInput(id, "png", pngBytes));
      const ticket = storage.stageDelete(id, [key]);
      storage.rollbackDelete(ticket);
      assert.deepEqual(storage.read(key), pngBytes);
    });
  } finally {
    const runtime = await getServerRuntime().catch(() => null);
    runtime?.database.close();
    for (const [key, value] of Object.entries({ STORAGE_DIR: previous.storage, DATABASE_PATH: previous.database, MAX_UPLOAD_BYTES: previous.max, TRIPOSR_PYTHON: previous.python, TRIPOSR_MODEL_DIR: previous.model, TRIPOSR_REPO: previous.repo })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("generation form validation enforces size before reading and rejects empty files", async () => {
  const tooLarge = new FormData(); tooLarge.append("image", new File([Buffer.alloc(11)], "large.png", { type: "image/png" }));
  await assert.rejects(validateGenerationForm(tooLarge, 10), (error: unknown) => error instanceof ApiError && error.status === 413);
  const empty = new FormData(); empty.append("image", new File([], "empty.png", { type: "image/png" }));
  await assert.rejects(validateGenerationForm(empty, 10), (error: unknown) => error instanceof ApiError && error.code === "EMPTY_IMAGE");
});

test("TripoSR provider queues work asynchronously and stores the runner's GLB output", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "trellis-triposr-test-"));
  const repoDir = path.join(sandbox, "repo");
  const pythonPath = path.join(sandbox, "python.exe");
  const modelDir = path.join(sandbox, "model");
  await mkdir(repoDir, { recursive: true });
  await mkdir(modelDir, { recursive: true });
  await writeFile(path.join(repoDir, "run.py"), "# mock worker entry point");
  await writeFile(pythonPath, "mock interpreter marker");
  await writeFile(path.join(modelDir, "config.yaml"), "model: mock");
  await writeFile(path.join(modelDir, "model.ckpt"), "mock checkpoint marker");

  const database = await GenerationDatabase.open(path.join(sandbox, "storage", "metadata.sqlite"));
  const storage = new LocalStorage(path.join(sandbox, "storage"));
  const config: TripoSRConfiguration = {
    triposrRepoDir: repoDir, triposrPythonPath: pythonPath, triposrModelDir: modelDir,
    triposrChunkSize: 4096, triposrMcResolution: 256, triposrTimeoutMs: 10_000,
    maxGeneratedAssetBytes: 1024 * 1024,
  };
  let markRunnerStarted!: () => void;
  let releaseRunner!: () => void;
  const runnerStarted = new Promise<void>(resolve => { markRunnerStarted = resolve; });
  const runnerGate = new Promise<void>(resolve => { releaseRunner = resolve; });
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }));
  const paddedJsonLength = Math.ceil(json.byteLength / 4) * 4;
  const glb = Buffer.alloc(20 + paddedJsonLength, 0x20);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.byteLength, 8);
  glb.writeUInt32LE(paddedJsonLength, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);

  try {
    const provider = new TripoSRInferenceProvider(database, storage, config, async () => {
      markRunnerStarted();
      await runnerGate;
      return glb;
    }, () => ({ pythonVersion: "3.12.14", deviceName: "Test CUDA device" }));
    await provider.initialize();
    assert.equal(provider.getWorkerStatus().ready, true);

    const id = randomUUID();
    const now = new Date().toISOString();
    const inputImageKey = storage.storeInput(id, "png", pngBytes);
    database.create({
      id, status: "queued", createdAt: now, updatedAt: now, inputImageKey,
      originalFilename: "fixture.png", contentType: "image/png", fileSize: pngBytes.byteLength,
      resolution: null, generationSettings: { model: "TripoSR" },
    }, randomUUID());
    const receipt = await provider.submitGeneration({
      id, inputImageKey, contentType: "image/png", resolution: null, generationSettings: { model: "TripoSR" },
    });
    database.setWorkerJobId(id, receipt.workerJobId);
    assert.equal(receipt.status, "queued");
    await runnerStarted;
    assert.equal(database.get(id)?.status, "processing");
    releaseRunner();

    const deadline = Date.now() + 5_000;
    while (database.get(id)?.status !== "completed" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const completed = database.get(id);
    assert.equal(completed?.status, "completed");
    assert.ok(completed?.outputAssetKey);
    assert.deepEqual(storage.read(completed!.outputAssetKey!), glb);
    assert.deepEqual(await provider.getOutputMetadata(receipt.workerJobId), {
      format: "glb", fileSize: glb.byteLength, contentType: "model/gltf-binary",
    });
  } finally {
    releaseRunner();
    database.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
