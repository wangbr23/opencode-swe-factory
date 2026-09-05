import { rules as recommendedSecretLintRules } from "@secretlint/secretlint-rule-preset-recommend";

export type SecretConfidence = "high" | "low";

export type SecretFindingKind = "credential" | "token-shape" | "hash" | "high-entropy";

export type SecretScanDisposition = "clear" | "acknowledgment-required" | "blocked";

export type SecretFinding = Readonly<{
  confidence: SecretConfidence;
  kinds: ReadonlyArray<SecretFindingKind>;
  region: Readonly<{
    start: number;
    end: number;
  }>;
  scannerRuleIds: ReadonlyArray<string>;
}>;

export type SecretScanResult = Readonly<{
  disposition: SecretScanDisposition;
  findings: ReadonlyArray<SecretFinding>;
  redactedText: string;
}>;

export type UnmergedFinding = {
  confidence: SecretConfidence;
  kind: SecretFindingKind;
  start: number;
  end: number;
  scannerRuleId?: string;
};

export const filterCommentsRuleId = "@secretlint/secretlint-rule-filter-comments";
export const secretLintConfig = {
  rules: recommendedSecretLintRules
    .filter((rule) => rule.meta.id !== filterCommentsRuleId)
    .map((rule) => ({ id: rule.meta.id, rule })),
};

export const genericCredentialPattern = /\b(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|secret|password)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=-]{16,})["']?/gi;
export const hashPattern = /\b(?:[a-f\d]{32}|[a-f\d]{40}|[a-f\d]{64})\b/gi;
export const tokenPattern = /[A-Za-z\d_+/-]{32,}={0,2}/g;
export const exampleContextPattern = /\b(?:example|sample|demo|dummy|placeholder|fake|test(?:ing)?|your[_-]?(?:token|key|secret))\b/i;
export const privateKeyRuleId = "@secretlint/secretlint-rule-privatekey";
