import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const nextConfig: NextConfig = { reactStrictMode: true, outputFileTracingRoot: projectRoot, serverExternalPackages: ["sql.js"] };
export default nextConfig;
