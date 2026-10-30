import { GenerationDatabase } from "@/server/database";
import { getServerConfig } from "@/server/config";
import { GenerationService } from "@/server/generations";
import { MultiEngineInferenceProvider } from "@/server/inference/multi-engine";
import { LocalStorage } from "@/server/storage";

export type ServerRuntime = { database: GenerationDatabase; storage: LocalStorage; generations: GenerationService; inference: MultiEngineInferenceProvider };

export async function createServerRuntime(storageDir?: string, databasePath?: string): Promise<ServerRuntime> {
  const config = getServerConfig();
  const storage = new LocalStorage(storageDir ?? config.storageDir);
  const database = await GenerationDatabase.open(databasePath ?? config.databasePath);
  storage.recoverPendingDeletes(id => database.get(id));
  const inference = new MultiEngineInferenceProvider(database, storage, config, config);
  await inference.initialize();
  return { database, storage, generations: new GenerationService(database, storage, inference), inference };
}

const globalRuntime = globalThis as typeof globalThis & { __trellisRuntime?: Promise<ServerRuntime> };

export function getServerRuntime() {
  globalRuntime.__trellisRuntime ??= createServerRuntime();
  return globalRuntime.__trellisRuntime;
}
