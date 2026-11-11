import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's query engine is a native binary: keep it out of the server bundle.
  serverExternalPackages: ["@prisma/client", "prisma"],
  poweredByHeader: false,
};

export default nextConfig;
