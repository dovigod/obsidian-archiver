#!/usr/bin/env node
// Copies *.md prompt files from src/core/llm/prompts/ to dist/core/llm/prompts/
// after the TypeScript build, since `tsc` only emits .ts → .js.
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { stdout } from "node:process";

const SRC = "src/core/llm/prompts";
const DST = "dist/core/llm/prompts";

const files = (await readdir(SRC)).filter((f) => f.endsWith(".md"));
await mkdir(DST, { recursive: true });
for (const file of files) {
  await copyFile(join(SRC, file), join(DST, file));
}
stdout.write(`copied ${files.length} prompt files to ${DST}\n`);
