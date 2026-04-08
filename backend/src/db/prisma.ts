import { PrismaClient } from "../generated/client";

declare global {
  // eslint-disable-next-line no-var
  var __excalidashPrisma: PrismaClient | undefined;
}

const prismaClient = globalThis.__excalidashPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__excalidashPrisma = prismaClient;
}

/**
 * Enable WAL journal mode and set a busy timeout for SQLite.
 * WAL allows concurrent reads during writes; busy_timeout makes writers
 * wait instead of failing immediately when the database is locked.
 */
async function configureSqlite() {
  try {
    await prismaClient.$executeRawUnsafe("PRAGMA journal_mode = WAL;");
    await prismaClient.$executeRawUnsafe("PRAGMA busy_timeout = 5000;");
  } catch {
    // Silently ignore — only relevant for SQLite
  }
}

configureSqlite();

export { prismaClient as prisma };
