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

  // Use custom logger that shows actual parameter values instead of placeholders
  prisma = new PrismaClient({
    log: process.env.NODE_ENV === "development" 
      ? [
          {
            emit: "event",
            level: "query",
          },
          "error",
          "warn",
        ]
      : ["error"],
  });

  // Add custom query event listener to log actual parameter values instead of placeholders
  if (process.env.NODE_ENV === "development") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.$on("query" as never, (e: any) => {
      try {
        // Parse the params JSON string to get actual values
        const params: unknown[] = JSON.parse(e.params);
        // Replace $1, $2, etc. with actual values in the query string
        let queryWithParams = e.query;
        params.forEach((param: unknown, index: number) => {
          const placeholder = `$${index + 1}`;
          const value = typeof param === "string" ? `'${param.replace(/'/g, "''")}'` : String(param);
          queryWithParams = queryWithParams.replace(placeholder, value);
        });
        console.log(`[prisma:query] ${queryWithParams}`);
        console.log(`[prisma:query] Duration: ${e.duration}ms`);
      } catch (err) {
        // Fallback to default logging if parsing fails
        console.log(`[prisma:query] ${e.query}`);
        console.log(`[prisma:query] Params: ${e.params}`);
        if (err instanceof Error) {
          console.log(`[prisma:query] Parse error: ${err.message}`);
        }
      }
    });
  }

  // Graceful shutdown
  process.on("beforeExit", async () => {
    await prisma?.$disconnect();
  });

  return prisma;
}

