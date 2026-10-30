import { NextResponse } from "next/server";
import { apiErrorResponse, requireLocalRequest } from "@/server/errors";
import { getServerRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireLocalRequest(request);
    const worker = (await getServerRuntime()).inference.getWorkerStatus();
    return NextResponse.json({ worker }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
