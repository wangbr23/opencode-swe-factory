import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  loadRoutingReplayBenchmarkCorpus,
  runRoutingReplayBenchmark,
} from "../src/core/index.js";

function main(): void {
  const corpusPath = resolve(import.meta.dir, "synthetic-routing-replay.v1.json");
  const corpus = loadRoutingReplayBenchmarkCorpus(readFileSync(corpusPath, "utf8"));
  const result = runRoutingReplayBenchmark({ corpus });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `Synthetic routing replay benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
