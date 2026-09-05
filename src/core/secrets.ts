import { lintSource } from "@secretlint/core";
import {
  exampleContextPattern,
  genericCredentialPattern,
  hashPattern,
  privateKeyRuleId,
  secretLintConfig,
  tokenPattern,
  type SecretConfidence,
  type SecretFinding,
  type SecretFindingKind,
  type SecretScanDisposition,
  type SecretScanResult,
  type UnmergedFinding,
} from "./secrets-types.js";

export type {
  SecretConfidence,
  SecretFinding,
  SecretFindingKind,
  SecretScanDisposition,
  SecretScanResult,
} from "./secrets-types.js";

export class SecretScanError extends Error {
  constructor() {
    super("Secret scanning failed.");
    this.name = "SecretScanError";
  }
}

/**
 * Scans untrusted text before it reaches persistent storage. Findings contain
 * offsets only; callers must use the original text to render an approved UI.
 */
export async function scanTextForSecrets(text: string): Promise<SecretScanResult> {
  if (typeof text !== "string") {
    throw new TypeError("Secret scanner input must be a string.");
  }

  try {
    const result = await lintSource({
      source: { filePath: "input.txt", content: text, ext: ".txt", contentType: "text" },
      options: { config: secretLintConfig, maskSecrets: true, noPhysicFilePath: true },
    });
    const findings: UnmergedFinding[] = result.messages.map((message) => ({
      confidence: isExampleContext(text, message.range) && message.ruleId !== privateKeyRuleId ? "low" : "high",
      kind: "credential",
      start: message.range[0],
      end: message.range[1],
      scannerRuleId: message.ruleId,
    }));

    addPatternFindings(text, genericCredentialPattern, "token-shape", findings, (match) => ({
      start: match.index + match[0].lastIndexOf(match[1] ?? ""),
      end: match.index + match[0].length - (match[0].endsWith("\"") || match[0].endsWith("'") ? 1 : 0),
    }));
    addPatternFindings(text, hashPattern, "hash", findings);
    addEntropyFindings(text, findings);

    const normalizedFindings = mergeFindings(findings);
    return {
      disposition: getDisposition(normalizedFindings),
      findings: normalizedFindings,
      redactedText: redactText(text, normalizedFindings),
    };
  } catch {
    throw new SecretScanError();
  }
}

function getDisposition(findings: ReadonlyArray<SecretFinding>): SecretScanDisposition {
  if (findings.some((finding) => finding.confidence === "high")) {
    return "blocked";
  }
  return findings.length === 0 ? "clear" : "acknowledgment-required";
}

function isExampleContext(text: string, range: readonly [number, number]): boolean {
  const lineStart = text.lastIndexOf("\n", range[0] - 1) + 1;
  return exampleContextPattern.test(text.slice(Math.max(lineStart, range[0] - 48), range[0]));
}

function addPatternFindings(
  text: string,
  pattern: RegExp,
  kind: SecretFindingKind,
  findings: UnmergedFinding[],
  regionForMatch: (match: RegExpExecArray) => { start: number; end: number } = (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }),
): void {
  for (const match of text.matchAll(pattern)) {
    const region = regionForMatch(match);
    findings.push({ confidence: "low", kind, ...region });
  }
}

function addEntropyFindings(text: string, findings: UnmergedFinding[]): void {
  for (const match of text.matchAll(tokenPattern)) {
    if (shannonEntropy(match[0]) >= 4.2) {
      findings.push({
        confidence: "low",
        kind: "high-entropy",
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  return [...counts.values()].reduce((entropy, count) => {
    const probability = count / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
}

function mergeFindings(findings: UnmergedFinding[]): ReadonlyArray<SecretFinding> {
  const sorted = [...findings].filter(({ start, end }) => start < end).sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{
    confidence: SecretConfidence;
    kinds: Set<SecretFindingKind>;
    start: number;
    end: number;
    scannerRuleIds: Set<string>;
  }> = [];

  for (const finding of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || finding.start > previous.end) {
      merged.push({
        confidence: finding.confidence,
        kinds: new Set([finding.kind]),
        start: finding.start,
        end: finding.end,
        scannerRuleIds: new Set(finding.scannerRuleId === undefined ? [] : [finding.scannerRuleId]),
      });
      continue;
    }
    previous.confidence = previous.confidence === "high" || finding.confidence === "high" ? "high" : "low";
    previous.end = Math.max(previous.end, finding.end);
    previous.kinds.add(finding.kind);
    if (finding.scannerRuleId !== undefined) {
      previous.scannerRuleIds.add(finding.scannerRuleId);
    }
  }

  return merged.map(({ confidence, kinds, start, end, scannerRuleIds }) => ({
    confidence,
    kinds: [...kinds].sort(),
    region: { start, end },
    scannerRuleIds: [...scannerRuleIds].sort(),
  }));
}

function redactText(text: string, findings: ReadonlyArray<SecretFinding>): string {
  let redactedText = "";
  let cursor = 0;
  for (const { region } of findings) {
    redactedText += `${text.slice(cursor, region.start)}[REDACTED]`;
    cursor = region.end;
  }
  return `${redactedText}${text.slice(cursor)}`;
}
