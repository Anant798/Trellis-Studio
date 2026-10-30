import { ApiError, apiErrorResponse, requireLocalRequest } from "@/server/errors";
import { parseGenerationId, requireGeneration } from "@/server/http";
import { getServerRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    requireLocalRequest(request);
    const { id: rawId } = await context.params;
    const id = parseGenerationId(rawId);
    const server = await getServerRuntime();
    const generation = requireGeneration(server, id);
    if (generation.status !== "completed" || !generation.outputAssetKey) throw new ApiError(409, "ASSET_NOT_READY", "This generation has no completed output asset.");
    let bytes: Buffer;
    try { bytes = server.storage.read(generation.outputAssetKey); }
    catch { throw new ApiError(404, "OUTPUT_ASSET_NOT_FOUND", "The generated asset is unavailable."); }
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": server.storage.contentType(generation.outputAssetKey),
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename="generation-${id}.glb"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return apiErrorResponse(error); }
}
