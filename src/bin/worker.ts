#!/usr/bin/env node
import { runWorker } from "@core/worker";

runWorker().catch((err) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
