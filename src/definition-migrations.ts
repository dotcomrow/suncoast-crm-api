import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { config } from "./config.js";
import { createCustomObjectDefinition, customFieldDefinition, customObjectDefinitionBody, customObjectDefinitionSpec, migrateCustomObjectDefinition } from "./custom-objects.js";
import { pool } from "./db.js";

const metadata = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  version: z.number().int().positive()
});
const initialFile = z.object({
  apiVersion: z.literal("crm.suncoast.systems/v1"),
  kind: z.literal("CustomObjectDefinition"),
  metadata,
  spec: customObjectDefinitionSpec
});
const migrationFile = z.object({
  apiVersion: z.literal("crm.suncoast.systems/v1"),
  kind: z.literal("CustomObjectMigration"),
  metadata,
  spec: z.object({ add_fields: z.array(customFieldDefinition).min(1) })
});
const definitionFile = z.discriminatedUnion("kind", [initialFile, migrationFile]);

export interface DefinitionMigrationFile {
  filename: string;
  checksum: string;
  document: z.infer<typeof definitionFile>;
}

export async function loadDefinitionMigrationFiles(directory = fileURLToPath(new URL("../definitions/", import.meta.url))): Promise<DefinitionMigrationFile[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const filenames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => relative(directory, resolve(entry.parentPath, entry.name))).sort();
  const files = await Promise.all(filenames.map(async (filename) => {
    const raw = await readFile(resolve(directory, filename), "utf8");
    const document = definitionFile.parse(JSON.parse(raw));
    if (document.kind === "CustomObjectDefinition") customObjectDefinitionBody.parse({ name: document.metadata.name, ...document.spec });
    return { filename, checksum: createHash("sha256").update(raw).digest("hex"), document };
  }));
  const grouped = new Map<string, DefinitionMigrationFile[]>();
  for (const file of files) grouped.set(file.document.metadata.name, [...(grouped.get(file.document.metadata.name) ?? []), file]);
  for (const [name, objectFiles] of grouped) {
    const ordered = [...objectFiles].sort((left, right) => left.document.metadata.version - right.document.metadata.version);
    ordered.forEach((file, index) => {
      const expected = index + 1;
      if (file.document.metadata.version !== expected) throw new Error(`Definition ${name} must have contiguous versions starting at 1; expected ${expected}`);
      if (expected === 1 && file.document.kind !== "CustomObjectDefinition") throw new Error(`Definition ${name} version 1 must be CustomObjectDefinition`);
      if (expected > 1 && file.document.kind !== "CustomObjectMigration") throw new Error(`Definition ${name} version ${expected} must be CustomObjectMigration`);
    });
  }
  return files.sort((left, right) => left.document.metadata.name.localeCompare(right.document.metadata.name) || left.document.metadata.version - right.document.metadata.version);
}

export async function reconcileDefinitionMigrations(): Promise<void> {
  const files = await loadDefinitionMigrationFiles();
  for (const file of files) {
    const { name, version } = file.document.metadata;
    const existing = await pool.query("SELECT checksum,filename FROM crm_custom_object_definition_migrations WHERE object_name=$1 AND version=$2", [name, version]);
    if (existing.rowCount) {
      if (existing.rows[0].checksum !== file.checksum || existing.rows[0].filename !== file.filename) throw new Error(`Applied custom-object migration ${name} v${version} has changed`);
      continue;
    }
    if (version > 1) {
      const previous = await pool.query("SELECT 1 FROM crm_custom_object_definition_migrations WHERE object_name=$1 AND version=$2", [name, version - 1]);
      if (!previous.rowCount) throw new Error(`Cannot apply ${name} v${version} before v${version - 1}`);
    }
    if (file.document.kind === "CustomObjectDefinition") {
      if (version !== 1) throw new Error(`Definition ${name} must start at version 1`);
      await createCustomObjectDefinition(config().CRM_TENANT_ID, { name, ...file.document.spec });
    } else {
      await migrateCustomObjectDefinition(config().CRM_TENANT_ID, name, file.document.spec.add_fields);
    }
    await pool.query("INSERT INTO crm_custom_object_definition_migrations (object_name,version,filename,checksum) VALUES ($1,$2,$3,$4)", [name, version, file.filename, file.checksum]);
    console.log(`Applied custom-object definition ${name} v${version} from ${file.filename}`);
  }
}
