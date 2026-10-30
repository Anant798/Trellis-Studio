import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerConfig } from "@/server/config";
import { getServerRuntime } from "@/server/runtime";
import { ApiError, apiErrorResponse, requireLocalRequest } from "@/server/errors";
import { publicGeneration } from "@/server/http";
import { validateGenerationForm } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireLocalRequest(request);
    const limitInput = new URL(request.url).searchParams.get("limit") ?? "20";
    const limitParsed = z.coerce.number().int().min(1).max(50).safeParse(limitInput);
    if (!limitParsed.success) throw new ApiError(400, "INVALID_LIMIT", "History limit must be between 1 and 50.");
    const service = (await getServerRuntime()).generations;
    return NextResponse.json({ generations: service.list(limitParsed.data).map(publicGeneration) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    requireLocalRequest(request);
    const config = getServerConfig();
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > config.maxUploadBytes * 5 + 128 * 1024) {
      throw new ApiError(413, "UPLOAD_TOO_LARGE", `Uploads are limited to ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB per image.`);
    }

    let formData: FormData;
    try { formData = await request.formData(); }
    catch { throw new ApiError(400, "INVALID_MULTIPART_BODY", "Upload a multipart form containing an image field."); }
    const validated = await validateGenerationForm(formData, config.maxUploadBytes);
    const idempotencyValue = request.headers.get("idempotency-key") ?? randomUUID();
    const keyResult = z.string().uuid().safeParse(idempotencyValue);
    if (!keyResult.success) throw new ApiError(400, "INVALID_IDEMPOTENCY_KEY", "The idempotency key must be a UUID.");

    const result = await (await getServerRuntime()).generations.create({
      ...validated,
      generationSettings: {
        engine: validated.engine,
        inputMode: validated.inputMode,
        model: validated.engine,
        chunkSize: config.triposrChunkSize,
        meshResolution: config.triposrMcResolution,
      },
      idempotencyKey: keyResult.data,
    });
    const providerError = result.providerError ?? (result.generation.status === "failed" && result.generation.errorCode ? { code: result.generation.errorCode, message: result.generation.errorMessage ?? "The generation worker is unavailable." } : null);
    const status = providerError ? 503 : result.duplicate ? 200 : 202;
    return NextResponse.json({
      generation: publicGeneration(result.generation),
      ...(providerError ? { error: { code: providerError.code, message: providerError.message } } : {}),
    }, { status, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
