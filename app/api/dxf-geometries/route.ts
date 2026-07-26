import { eq, desc } from "drizzle-orm";
import { getDb } from "../../../db";
import { dxfGeometries } from "../../../db/schema";

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const detail =
    error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${detail}`;

  if (combined.includes("no such table") || combined.includes('from "dxf_geometries"')) {
    return "The dxf_geometries table is unavailable. Generate the migration locally with `pnpm run db:generate`, then deploy so the platform can apply the generated SQL to the real D1 database.";
  }

  return message;
}

export async function GET() {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(dxfGeometries)
      .orderBy(desc(dxfGeometries.createdAt));

    // Return as articleNumber -> points map
    const geometries: Record<string, { points: Array<{ x: number; y: number }>; source: string; validatedAt: string }> = {};
    for (const row of rows) {
      try {
        const points = JSON.parse(row.points);
        geometries[row.articleNumber] = {
          points,
          source: row.source,
          validatedAt: row.validatedAt,
        };
      } catch {
        // Skip malformed entries
      }
    }
    return Response.json({ geometries });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      articleNumber?: string;
      kind?: string;
      points?: Array<{ x: number; y: number }>;
    };

    const articleNumber = payload.articleNumber?.trim() ?? "";
    if (!articleNumber) {
      return Response.json({ error: "articleNumber is required" }, { status: 400 });
    }

    if (!payload.points || !Array.isArray(payload.points)) {
      return Response.json({ error: "points array is required" }, { status: 400 });
    }

    const db = getDb();

    // Check if this article already exists
    const existing = await db
      .select()
      .from(dxfGeometries)
      .where(eq(dxfGeometries.articleNumber, articleNumber))
      .limit(1);

    if (existing.length > 0) {
      // Update existing record
      await db
        .update(dxfGeometries)
        .set({
          kind: payload.kind ?? existing[0].kind,
          points: JSON.stringify(payload.points),
          validatedAt: new Date().toISOString(),
        })
        .where(eq(dxfGeometries.id, existing[0].id));
      return Response.json({ updated: true, articleNumber });
    } else {
      // Insert new record
      await db.insert(dxfGeometries).values({
        articleNumber,
        kind: payload.kind ?? "punch",
        points: JSON.stringify(payload.points),
        source: "user-upload",
      });
      return Response.json({ created: true, articleNumber }, { status: 201 });
    }
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const articleNumber = searchParams.get("articleNumber");

    if (!articleNumber) {
      return Response.json({ error: "articleNumber query param is required" }, { status: 400 });
    }

    const db = getDb();
    await db
      .delete(dxfGeometries)
      .where(eq(dxfGeometries.articleNumber, articleNumber));

    return Response.json({ deleted: true, articleNumber });
  } catch (error) {
    return Response.json(
      { error: toRouteErrorMessage(error) },
      { status: 500 }
    );
  }
}
