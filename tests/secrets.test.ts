import { expect, test } from "bun:test";

import { scanTextForSecrets, SecretScanError } from "../src/core/secrets.js";

test("blocks high-confidence provider credentials without returning their values", async () => {
  const credential = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  const result = await scanTextForSecrets(`token = ${credential}`);

  expect(result.findings).toEqual([
    expect.objectContaining({
      confidence: "high",
      kinds: ["credential", "high-entropy"],
      scannerRuleIds: ["@secretlint/secretlint-rule-github"],
    }),
  ]);
  expect(result.disposition).toBe("blocked");
  expect(result.redactedText).toBe("token = [REDACTED]");
  expect(JSON.stringify(result)).not.toContain(credential);
});

test("does not let scanned text disable high-confidence rules", async () => {
  const credential = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  const result = await scanTextForSecrets([
    "// secretlint-disable-next-line",
    `token = ${credential}`,
  ].join("\n"));

  expect(result.disposition).toBe("blocked");
  expect(result.findings).toEqual([
    expect.objectContaining({
      confidence: "high",
      scannerRuleIds: ["@secretlint/secretlint-rule-github"],
    }),
  ]);
  expect(result.redactedText).not.toContain(credential);
});

test("requires acknowledgment for examples, hashes, generic tokens, and entropy matches", async () => {
  const example = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  const hash = "a3f5c7e9b1d2f4a6c8e0b2d4f6a8c0e2a4b6d8f0c2e4a6b8d0e2f4a6c8b0d2e4";
  const entropyToken = "aZ9+/Kq3Vb7Nw2Xy6Lm0Rt4Ce8Hu1Jd5";
  const result = await scanTextForSecrets([
    `example token = ${example}`,
    `checksum: ${hash}`,
    "api_key = abcdefghijklmnopqrstuvwxyz123456",
    `opaque value ${entropyToken}`,
  ].join("\n"));

  expect(result.findings).toHaveLength(4);
  expect(result.disposition).toBe("acknowledgment-required");
  expect(result.findings.every((finding) => finding.confidence === "low")).toBe(true);
  expect(result.findings.map((finding) => finding.kinds)).toEqual([
    ["credential", "high-entropy"],
    ["hash"],
    ["high-entropy", "token-shape"],
    ["high-entropy"],
  ]);
  expect(result.redactedText).not.toContain(example);
  expect(result.redactedText).not.toContain(hash);
  expect(result.redactedText).not.toContain(entropyToken);
});

test("merges overlapping findings into one exact redaction region", async () => {
  const value = "abcdefghijklmnopqrstuvwxyz123456";
  const text = `secret=${value}`;
  const result = await scanTextForSecrets(text);

  expect(result.findings).toEqual([
    expect.objectContaining({
      confidence: "low",
      kinds: ["high-entropy", "token-shape"],
      region: { start: 7, end: text.length },
    }),
  ]);
  expect(result.redactedText).toBe("secret=[REDACTED]");
});

test("leaves benign text unchanged", async () => {
  const text = "Use the documented configuration value and run the test suite.";

  await expect(scanTextForSecrets(text)).resolves.toEqual({ disposition: "clear", findings: [], redactedText: text });
});

test("does not include input values in invalid-input or scanner-failure errors", async () => {
  const value = "sensitive-value-that-must-not-appear";

  await expect(scanTextForSecrets(value)).resolves.toBeDefined();
  await expect(scanTextForSecrets(null as unknown as string)).rejects.toThrow("Secret scanner input must be a string.");
  expect(new SecretScanError().message).toBe("Secret scanning failed.");
  expect(new SecretScanError().message).not.toContain(value);
});
