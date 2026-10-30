import { ApiError, apiErrorResponse, requireLocalRequest } from "@/server/errors";
import { parseGenerationId, requireGeneration } from "@/server/http";
import { getServerRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ id: string; view: string }> };
const allowedViews = new Set(["front", "back", "left", "right", "top"]);

export async function GET(request: Request, context: RouteContext) {
  try {
    requireLocalRequest(request);
    const { id: rawId, view } = await context.params;
    const id = parseGenerationId(rawId);
    if (!allowedViews.has(view)) throw new ApiError(400, "INVALID_VIEW", "The requested orthographic view is invalid.");
    const server = await getServerRuntime();
    const generation = requireGeneration(server, id);
    const viewKeys = generation.generationSettings.orthographicViewKeys;
    const key = viewKeys && typeof viewKeys === "object" ? (viewKeys as Record<string, unknown>)[view] : undefined;
    if (typeof key !== "string") throw new ApiError(404, "VIEW_NOT_FOUND", "This generation does not contain that view.");
    let bytes: Buffer;
    try { bytes = server.storage.read(key); }
    catch { throw new ApiError(404, "VIEW_NOT_FOUND", "The stored orthographic view is unavailable."); }
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": server.storage.contentType(key),
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return apiErrorResponse(error); }
}
