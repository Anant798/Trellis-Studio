import { NextResponse } from "next/server";
import { ActiveGenerationError, GenerationNotFoundError } from "@/server/generations";
import { ApiError, apiErrorResponse, requireLocalRequest } from "@/server/errors";
import { parseGenerationId, publicGeneration, requireGeneration } from "@/server/http";
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
    return NextResponse.json({ generation: publicGeneration(requireGeneration(server, id)) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    requireLocalRequest(request);
    const { id: rawId } = await context.params;
    const id = parseGenerationId(rawId);
    const server = await getServerRuntime();
    requireGeneration(server, id);
    await server.generations.delete(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof GenerationNotFoundError) return apiErrorResponse(new ApiError(404, "GENERATION_NOT_FOUND", "The generation was not found."));
    if (error instanceof ActiveGenerationError) return apiErrorResponse(new ApiError(409, "GENERATION_ACTIVE", error.message));
    return apiErrorResponse(error);
  }
}
