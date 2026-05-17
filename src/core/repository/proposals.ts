import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ProposalKind,
  type ProposalRecord,
  ProposalRecordSchema,
} from "@core/schema";

export interface ProposalWriteResult {
  absolutePath: string;
  relativePath: string;
}

/**
 * Filesystem-backed staging area for taxonomy/classification decisions that
 * the system is not allowed to apply automatically. Layout:
 *
 *   vault/_proposals/{kind}/{id}.json
 *
 * Each kind is a separate directory so reviewers can iterate over a single
 * decision class at a time. Records use the same uuid v7 ids as conversations
 * and queue jobs, so directory listings sort chronologically.
 */
export class ProposalRepository {
  constructor(private readonly vaultPath: string) {}

  private dirFor(kind: ProposalKind): string {
    return join(resolve(this.vaultPath), "_proposals", kind);
  }

  pathFor(kind: ProposalKind, id: string): { abs: string; rel: string } {
    const file = `${id}.json`;
    return {
      abs: join(this.dirFor(kind), file),
      rel: join("_proposals", kind, file),
    };
  }

  async write(record: ProposalRecord): Promise<ProposalWriteResult> {
    const { abs, rel } = this.pathFor(record.kind, record.id);
    await mkdir(this.dirFor(record.kind), { recursive: true });
    await writeFile(abs, JSON.stringify(record, null, 2), "utf8");
    return { absolutePath: abs, relativePath: rel };
  }

  async list(kind: ProposalKind): Promise<ProposalRecord[]> {
    const dir = this.dirFor(kind);
    if (!existsSync(dir)) {
      return [];
    }
    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".json"))
      .sort();
    const out: ProposalRecord[] = [];
    for (const file of files) {
      const text = await readFile(join(dir, file), "utf8");
      const parsed = ProposalRecordSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        out.push(parsed.data);
      }
    }
    return out;
  }

  /**
   * Look up a proposal by id across both surviving kinds. Returns null when
   * no file is found.
   */
  async findById(id: string): Promise<ProposalRecord | null> {
    for (const kind of ["manual_edit", "raw_invalid"] as const) {
      const { abs } = this.pathFor(kind, id);
      if (!existsSync(abs)) {
        continue;
      }
      const text = await readFile(abs, "utf8");
      const parsed = ProposalRecordSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        return parsed.data;
      }
    }
    return null;
  }

  async remove(kind: ProposalKind, id: string): Promise<void> {
    const { abs } = this.pathFor(kind, id);
    await rm(abs, { force: true });
  }
}
