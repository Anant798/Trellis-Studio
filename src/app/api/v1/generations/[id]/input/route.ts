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
    let bytes: Buffer;
    try { bytes = server.storage.read(generation.inputImageKey); }
    catch { throw new ApiError(404, "INPUT_IMAGE_NOT_FOUND", "The stored reference image is unavailable."); }
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": generation.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `inline; filename="${generation.originalFilename.replace(/["\\\r\n]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return apiErrorResponse(error); }
}
