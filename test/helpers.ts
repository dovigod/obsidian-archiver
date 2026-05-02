import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEST_RESULT_DIR = resolve(here, "..", "test_result");

/**
 * Returns the project-local `<repo>/test_result/` directory used as the parent
 * for `mkdtempSync` calls in tests.
 *
 * The directory is wiped before each `npm test` run via the `pretest` script
 * (so we don't race here across worker processes — each test file forks its
 * own Node process). Workers only ensure the directory exists.
 */
export function testTmpDir(): string {
  mkdirSync(TEST_RESULT_DIR, { recursive: true });
  return TEST_RESULT_DIR;
}
