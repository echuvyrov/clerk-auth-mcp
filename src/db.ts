/**
 * Prisma client for cocompetitorai.
 *
 * Uses the schema.prisma in this package. Make sure these environment variables are set:
 * - POSTGRES_PRISMA_URL (connection pool URL)
 * - POSTGRES_URL_NON_POOLING (direct connection URL)
 *
 * These can be set in your environment or a .env file.
 */

import { PrismaClient } from "@prisma/client";

// Singleton pattern: reuse the same client across server instances.
// Prisma best practice: use one instance per process.
let prisma: PrismaClient | null = null;

export function getPrismaClient(): PrismaClient | null {
  // Only initialize if database URLs are provided
  if (!process.env.POSTGRES_PRISMA_URL || !process.env.POSTGRES_URL_NON_POOLING) {
    return null;
  }

  if (prisma) {
    return prisma;
  }

  prisma = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

  // Graceful shutdown
  process.on("beforeExit", async () => {
    await prisma?.$disconnect();
  });

  return prisma;
}

