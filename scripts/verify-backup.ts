import { spawn } from "node:child_process";
import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { createPool } from "../packages/db/pool.js";
const pool = createPool(),
  client = await pool.connect();
const restoreName = `ticketjam_restore_${randomUUID().replaceAll("-", "")}`;
const directory = ".local/backups";
await mkdir(directory, { recursive: true, mode: 0o700 });
const dumpPath = `${directory}/${restoreName}.dump`;
const compose = [
  "compose",
  "--env-file",
  ".env",
  "-f",
  "infra/compose.yaml",
  "exec",
  "-T",
  "db",
];
async function command(args: string[], input?: string, output?: string) {
  const child = spawn("docker", [...compose, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += chunk.toString();
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`Backup verification command failed (${code}): ${error}`),
          ),
    );
  });
  const flows: Promise<unknown>[] = [completed];
  if (input) flows.push(pipeline(createReadStream(input), child.stdin));
  else child.stdin.end();
  if (output)
    flows.push(
      pipeline(child.stdout, createWriteStream(output, { mode: 0o600 })),
    );
  else child.stdout.resume();
  await Promise.all(flows);
}
let created = false;
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshot = (await client.query("SELECT pg_export_snapshot() AS id"))
    .rows[0].id;
  await command(
    [
      "pg_dump",
      "-U",
      "ticketjam",
      "-d",
      "ticketjam",
      "-Fc",
      "--no-owner",
      "--no-acl",
      `--snapshot=${snapshot}`,
    ],
    undefined,
    dumpPath,
  );
  const tables = (
    await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename as string);
  const hashes: Record<string, unknown> = {};
  const digest = (table: string) =>
    `SELECT count(*)::int AS count,md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text),'')) AS digest FROM public."${table.replaceAll('"', '""')}" t`;
  for (const table of tables)
    hashes[table] = (await client.query(digest(table))).rows[0];
  const functionQuery = `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname,arguments`;
  const functions = (await client.query(functionQuery)).rows;
  await client.query("COMMIT");
  await command(["createdb", "-U", "ticketjam", restoreName]);
  created = true;
  await command(
    [
      "pg_restore",
      "-U",
      "ticketjam",
      "-d",
      restoreName,
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
    ],
    dumpPath,
  );
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${restoreName}`;
  const restored = createPool(url.href);
  try {
    for (const table of tables) {
      const result = (await restored.query(digest(table))).rows[0];
      if (JSON.stringify(result) !== JSON.stringify(hashes[table]))
        throw new Error(`Restored data differs in ${table}`);
    }
    const restoredFunctions = (await restored.query(functionQuery)).rows;
    if (JSON.stringify(restoredFunctions) !== JSON.stringify(functions))
      throw new Error(
        "Restored public functions differ from source definitions",
      );
  } finally {
    await restored.end();
  }
  const report = {
    verifiedAt: new Date().toISOString(),
    dumpPath,
    tables: hashes,
    functions: functions.map((f) => ({
      name: f.proname,
      arguments: f.arguments,
    })),
    result:
      "all table counts, row digests and public function definitions match exported snapshot",
  };
  await writeFile(
    ".local/evidence/backup-verification.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      verified: true,
      tables: tables.length,
      functions: functions.length,
      dumpPath,
    }),
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  if (created) await command(["dropdb", "-U", "ticketjam", restoreName]);
  await pool.end();
}
