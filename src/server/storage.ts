import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const keyPattern = /^(inputs|outputs)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|glb)$/i;
const contentTypeByExtension: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", glb: "model/gltf-binary" };

export type DeleteTicket = { directory: string; moved: Array<{ from: string; to: string }> };

export class LocalStorage {
  readonly root: string;
  readonly inputsDirectory: string;
  readonly outputsDirectory: string;
  private readonly trashDirectory: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.inputsDirectory = path.join(this.root, "inputs");
    this.outputsDirectory = path.join(this.root, "outputs");
    this.trashDirectory = path.join(this.root, ".trash");
    mkdirSync(this.inputsDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(this.outputsDirectory, { recursive: true, mode: 0o700 });
  }

  private resolveKey(key: string) {
    if (!keyPattern.test(key)) throw new Error("Invalid stored asset key.");
    const fullPath = path.resolve(this.root, ...key.split("/"));
    const relative = path.relative(this.root, fullPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Asset key escaped storage root.");
    return fullPath;
  }

  storeInput(id: string, extension: "png" | "jpg" | "webp", bytes: Buffer): string {
    const key = `inputs/${id}.${extension}`;
    writeFileSync(this.resolveKey(key), bytes, { flag: "wx", mode: 0o600 });
    return key;
  }

  storeOutput(id: string, bytes: Buffer): string {
    const key = `outputs/${id}.glb`;
    writeFileSync(this.resolveKey(key), bytes, { flag: "wx", mode: 0o600 });
    return key;
  }

  read(key: string): Buffer {
    return readFileSync(this.resolveKey(key));
  }

  filePath(key: string): string {
    return this.resolveKey(key);
  }

  remove(key: string) {
    const fullPath = this.resolveKey(key);
    if (existsSync(fullPath)) unlinkSync(fullPath);
  }

  contentType(key: string): string {
    const extension = path.extname(this.resolveKey(key)).slice(1).toLowerCase();
    return contentTypeByExtension[extension] ?? "application/octet-stream";
  }

  stageDelete(id: string, keys: Array<string | null>): DeleteTicket {
    const ticketDirectory = path.join(this.trashDirectory, id);
    mkdirSync(ticketDirectory, { recursive: true, mode: 0o700 });
    const moved: DeleteTicket["moved"] = [];
    try {
      for (const key of new Set(keys.filter((value): value is string => Boolean(value)))) {
        const from = this.resolveKey(key);
        if (!existsSync(from)) continue;
        const to = path.join(ticketDirectory, path.basename(from));
        copyFileSync(from, to);
        unlinkSync(from);
        moved.push({ from, to });
      }
    } catch (error) {
      for (const file of moved.reverse()) {
        if (!existsSync(file.to)) continue;
        copyFileSync(file.to, file.from);
        unlinkSync(file.to);
      }
      rmSync(ticketDirectory, { recursive: true, force: true });
      throw error;
    }
    return { directory: ticketDirectory, moved };
  }

  rollbackDelete(ticket: DeleteTicket) {
    for (const file of [...ticket.moved].reverse()) {
      if (!existsSync(file.to)) continue;
      mkdirSync(path.dirname(file.from), { recursive: true, mode: 0o700 });
      copyFileSync(file.to, file.from);
      unlinkSync(file.to);
    }
    rmSync(ticket.directory, { recursive: true, force: true });
  }

  finalizeDelete(ticket: DeleteTicket) {
    rmSync(ticket.directory, { recursive: true, force: true });
  }

  recoverPendingDeletes(findGeneration: (id: string) => { inputImageKey: string; outputAssetKey: string | null; generationSettings?: Record<string, unknown> } | null) {
    if (!existsSync(this.trashDirectory)) return;
    for (const id of readdirSync(this.trashDirectory)) {
      const directory = path.join(this.trashDirectory, id);
      const generation = findGeneration(id);
      if (!generation) {
        rmSync(directory, { recursive: true, force: true });
        continue;
      }
      const views = generation.generationSettings?.orthographicViewKeys;
      const viewKeys = views && typeof views === "object" ? Object.values(views).filter((key): key is string => typeof key === "string") : [];
      const livePaths = [generation.inputImageKey, generation.outputAssetKey, ...viewKeys]
        .filter((key): key is string => Boolean(key))
        .map(key => this.resolveKey(key));
      for (const name of readdirSync(directory)) {
        const stored = path.join(directory, name);
        const destination = livePaths.find(candidate => path.basename(candidate) === name);
        if (!destination) continue;
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        if (!existsSync(destination)) copyFileSync(stored, destination);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

export function createStorageId() { return randomUUID(); }
