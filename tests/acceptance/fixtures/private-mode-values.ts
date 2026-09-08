export const PRIVATE_MODE_PROJECT_PATH = "/repos/private-mode-acceptance";

export const SEEDED_LESSON = Object.freeze({
  title: "Run the test suite before committing",
  body: "Always run bun test before committing changes to the retrieval module.",
  rationale: "A broken suite slipped through because the tests were skipped.",
});

export const RECALL_QUERY = "run tests before committing the retrieval module";

export const CREDENTIAL = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
export const CHECKSUM_HASH =
  "a3f5c7e9b1d2f4a6c8e0b2d4f6a8c0e2a4b6d8f0c2e4a6b8d0e2f4a6c8b0d2e4";

export const BLOCKED_LESSON = Object.freeze({
  title: "Store the provider token",
  body: `Configure the CI token as token = ${CREDENTIAL} before running releases.`,
  rationale: "Release automation needs the provider token available.",
});

export const ACKNOWLEDGED_LESSON = Object.freeze({
  title: "Verify release checksums",
  body: `Compare the published artifact against its checksum: ${CHECKSUM_HASH}.`,
  rationale: "Checksum comparison catches corrupted release artifacts.",
});

export const SAFE_DOCUMENT = "# Safe guide\nRun the tests.\n";
export const BLOCKED_DOCUMENT = `token = ${CREDENTIAL}\n`;
export const ACKNOWLEDGMENT_DOCUMENT = `checksum: ${CHECKSUM_HASH}\n`;
