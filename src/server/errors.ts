import { NextResponse } from "next/server";
import { isLocalRequest } from "@/server/config";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  console.error("Generation API request failed.", error);
  return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "The request could not be completed." } }, { status: 500 });
}

export function requireLocalRequest(request: Request) {
  if (!isLocalRequest(request)) throw new ApiError(403, "LOCAL_ACCESS_ONLY", "This personal API is available only from the local machine.");
}
