import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** One PrismaClient per process (Next.js dev hot reload would otherwise leak connections). */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({ datasourceUrl: process.env["DATABASE_URL"] ?? "file:./dev.db" });

if (process.env["NODE_ENV"] !== "production") globalForPrisma.prisma = prisma;
