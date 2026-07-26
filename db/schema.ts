import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const dxfGeometries = sqliteTable("dxf_geometries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  articleNumber: text("article_number").notNull(),
  kind: text("kind").notNull(), // punch | die
  points: text("points").notNull(), // JSON stringified Point[]
  source: text("source").notNull().default("user-upload"),
  validatedAt: text("validated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
