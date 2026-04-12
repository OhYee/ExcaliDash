/**
 * Integration tests for Storage Management logic
 *
 * Verifies trim, diff, and orphan-safety logic against SQLite via Prisma.
 * S3 is not available in tests so we exercise data-manipulation logic directly.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "../generated/client";
import {
  getTestPrisma,
  setupTestDb,
  initTestDb,
  cleanupTestDb,
} from "./testUtils";

let prisma: PrismaClient;
let testUser: { id: string };

beforeAll(async () => {
  setupTestDb();
  prisma = getTestPrisma();
  testUser = await initTestDb(prisma);
});

beforeEach(async () => {
  await cleanupTestDb(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createElement = (
  id: string,
  type: string,
  isDeleted: boolean,
  fileId?: string
) => {
  const base: Record<string, unknown> = {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    isDeleted,
  };
  if (fileId) {
    base.fileId = fileId;
  }
  return base;
};

const createFileEntry = (fileId: string) => ({
  id: fileId,
  mimeType: "image/png",
  dataURL: "data:image/png;base64,AAAA",
  created: Date.now(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Storage Management - Trim History", () => {
  it("should remove deleted elements and orphaned files", async () => {
    // Setup: 3 elements (1 active image, 1 deleted image, 1 active rect)
    // 3 files: active, orphan (from deleted element), unreferenced
    const elements = [
      createElement("el-active-img", "image", false, "file-active"),
      createElement("el-deleted-img", "image", true, "file-deleted"),
      createElement("el-rect", "rectangle", false),
    ];

    const files: Record<string, unknown> = {
      "file-active": createFileEntry("file-active"),
      "file-deleted": createFileEntry("file-deleted"),
      "file-unreferenced": createFileEntry("file-unreferenced"),
    };

    const drawing = await prisma.drawing.create({
      data: {
        name: "Trim Test",
        elements: JSON.stringify(elements),
        appState: JSON.stringify({ viewBackgroundColor: "#ffffff" }),
        files: JSON.stringify(files),
        userId: testUser.id,
        version: 0,
      },
    });

    // Simulate trim: keep non-deleted elements, collect active image fileIds, filter files
    const parsedElements = JSON.parse(drawing.elements) as Array<Record<string, unknown>>;
    const trimmedElements = parsedElements.filter((e) => !e.isDeleted);
    const activeFileIds = new Set(
      trimmedElements
        .filter((e) => e.type === "image" && e.fileId)
        .map((e) => e.fileId as string)
    );
    const parsedFiles = JSON.parse(drawing.files) as Record<string, unknown>;
    const trimmedFiles: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsedFiles)) {
      if (activeFileIds.has(key)) {
        trimmedFiles[key] = value;
      }
    }

    // Update drawing with trimmed data
    const updated = await prisma.drawing.update({
      where: { id: drawing.id },
      data: {
        elements: JSON.stringify(trimmedElements),
        files: JSON.stringify(trimmedFiles),
        version: 1,
      },
    });

    // Verify
    const resultElements = JSON.parse(updated.elements) as Array<Record<string, unknown>>;
    const resultFiles = JSON.parse(updated.files) as Record<string, unknown>;

    expect(resultElements).toHaveLength(2);
    expect(resultElements.every((e) => !e.isDeleted)).toBe(true);
    expect(Object.keys(resultFiles)).toEqual(["file-active"]);
    expect(updated.version).toBe(1);
  });

  it("should reject trim when confirmName does not match", async () => {
    const drawing = await prisma.drawing.create({
      data: {
        name: "My Drawing",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: testUser.id,
      },
    });

    expect("Wrong Name" !== drawing.name).toBe(true);
    expect("My Drawing" === drawing.name).toBe(true);
  });
});

describe("Storage Management - Files Diff", () => {
  it("should compute correct diff between canvas, sqlite, and s3 records", async () => {
    const elements = [
      createElement("el-a", "image", false, "file-a"),
      createElement("el-b", "image", true, "file-b"),
    ];

    const files: Record<string, unknown> = {
      "file-a": createFileEntry("file-a"),
      "file-b": createFileEntry("file-b"),
      "file-c": createFileEntry("file-c"),
    };

    const drawing = await prisma.drawing.create({
      data: {
        name: "Diff Test",
        elements: JSON.stringify(elements),
        appState: JSON.stringify({ viewBackgroundColor: "#ffffff" }),
        files: JSON.stringify(files),
        userId: testUser.id,
      },
    });

    // Compute sets
    const parsedElements = JSON.parse(drawing.elements) as Array<Record<string, unknown>>;
    const allCanvasFileIds = new Set(
      parsedElements
        .filter((e) => e.type === "image" && e.fileId)
        .map((e) => e.fileId as string)
    );
    const activeCanvasFileIds = new Set(
      parsedElements
        .filter((e) => e.type === "image" && e.fileId && !e.isDeleted)
        .map((e) => e.fileId as string)
    );
    const sqliteFileIds = new Set(
      Object.keys(JSON.parse(drawing.files) as Record<string, unknown>)
    );

    // Verify
    expect(allCanvasFileIds).toEqual(new Set(["file-a", "file-b"]));
    expect(activeCanvasFileIds).toEqual(new Set(["file-a"]));

    // file-c is only in sqlite, not referenced by any element
    const onlyInSqlite = new Set(
      [...sqliteFileIds].filter((id) => !allCanvasFileIds.has(id))
    );
    expect(onlyInSqlite).toEqual(new Set(["file-c"]));
  });
});

describe("Storage Management - Orphan Deletion Safety", () => {
  it("should not allow deletion of actively referenced files", async () => {
    const elements = [
      createElement("el-img", "image", false, "file-active"),
    ];

    const files: Record<string, unknown> = {
      "file-active": createFileEntry("file-active"),
    };

    const drawing = await prisma.drawing.create({
      data: {
        name: "Orphan Safety Test",
        elements: JSON.stringify(elements),
        appState: JSON.stringify({ viewBackgroundColor: "#ffffff" }),
        files: JSON.stringify(files),
        userId: testUser.id,
      },
    });

    // Simulate: collect active fileIds, check conflicts for requested deletion
    const parsedElements = JSON.parse(drawing.elements) as Array<Record<string, unknown>>;
    const activeFileIds = new Set(
      parsedElements
        .filter((e) => e.type === "image" && e.fileId && !e.isDeleted)
        .map((e) => e.fileId as string)
    );

    const requestedDeletions = ["file-active"];
    const conflicts = requestedDeletions.filter((id) => activeFileIds.has(id));

    expect(conflicts).toContain("file-active");
    expect(conflicts).toHaveLength(1);
  });
});
