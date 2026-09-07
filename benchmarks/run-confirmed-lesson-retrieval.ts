import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createLocalLessonEmbedder,
  loadConfirmedLessonRetrievalBenchmarkCorpus,
  runConfirmedLessonRetrievalBenchmark,
} from "../src/core/index.js";

function artifactDirectoryFromArgs(args: ReadonlyArray<string>): string {
  const index = args.indexOf("--artifacts");
  const directory = index >= 0 ? args[index + 1] : process.env.OPENCODE_SWE_FACTORY_EMBEDDING_ARTIFACTS;
  if (typeof directory !== "string" || directory.trim().length === 0) {
    throw new Error("Provide --artifacts <directory> or OPENCODE_SWE_FACTORY_EMBEDDING_ARTIFACTS. Artifacts must be checksum-verified.");
  }
  return directory;
}

async function main(): Promise<void> {
  const artifactDirectory = artifactDirectoryFromArgs(process.argv.slice(2));
  const corpusPath = resolve(import.meta.dir, "confirmed-lesson-retrieval.v1.json");
  const corpus = loadConfirmedLessonRetrievalBenchmarkCorpus(readFileSync(corpusPath, "utf8"));
  const embed = await createLocalLessonEmbedder({ artifactDirectory });
  const result = await runConfirmedLessonRetrievalBenchmark({ corpus, embed });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`Confirmed-lesson retrieval benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
