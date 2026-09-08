import { recommendModel } from "../core/models/model-recommendation.js";
import type { ModelAllowlistEntry } from "../types/config-types.js";
import type { SqliteConnection } from "../types/sqlite-types.js";
import type { ResolvedFeatureToggles } from "../types/feature-toggle-types.js";
import type {
  ModelEligibilityRejection,
  ModelRoutingCandidate,
} from "../types/model-eligibility-types.js";
import type { RankedDimensionContribution } from "../types/model-ranking-types.js";
import type {
  ComputeRoutingReceiptInput,
  ComputeRoutingReceiptResult,
  RoutingReceipt,
  RoutingReceiptDimension,
  RoutingReceiptState,
} from "../types/routing-receipt-types.js";

export type {
  ComputeRoutingReceiptInput,
  ComputeRoutingReceiptResult,
  RoutingReceipt,
  RoutingReceiptDimension,
  RoutingReceiptState,
} from "../types/routing-receipt-types.js";

/**
 * V1 builds routing candidates straight from the configured allowlist and
 * marks every entry available: the allowlist is the user's authoritative
 * curation, and the package has no runtime host availability probe yet (T65).
 * Observed cost/latency estimates are likewise unknown at the boundary, so
 * hard cost/latency limits only bind once evidence-backed estimates exist.
 */
function toRoutingCandidate(entry: ModelAllowlistEntry): ModelRoutingCandidate {
  return {
    provider: entry.provider,
    model: entry.model,
    variant: entry.variant,
    capabilities: entry.capabilities,
    privacy: entry.privacy,
    available: true,
  };
}

function hasContributionValue(
  contribution: RankedDimensionContribution,
): contribution is RankedDimensionContribution & { score: number; normalizedWeight: number } {
  return contribution.score !== null && contribution.normalizedWeight !== null;
}

function toReceiptDimensions(
  contributions: ReadonlyArray<RankedDimensionContribution>,
): RoutingReceiptDimension[] {
  return contributions.filter(hasContributionValue).map((contribution) => ({
    dimension: contribution.dimension,
    score: contribution.score,
    weight: contribution.normalizedWeight,
    backedBy: contribution.sampleCount > 0 ? "evidence" : "prior",
  }));
}

/**
 * One-line diagnostic summary of a routing receipt. Contains only model
 * identities, utilities, and gate verdicts — never task text. Model identity
 * is written as key=value pairs (not a slash-joined path) so the diagnostics
 * path redaction does not blank it out.
 */
export function describeRoutingReceipt(receipt: RoutingReceipt): string {
  if (receipt.recommendation === null) {
    return `routing receipt: no eligible model (${receipt.rejections.length} rejected)`;
  }
  const recommendation = receipt.recommendation;
  return [
    "routing receipt:",
    `recommend provider=${recommendation.provider} model=${recommendation.model} variant=${recommendation.variant}`,
    `utility=${recommendation.utility.toFixed(3)}`,
    `evidence=${receipt.isEvidenceBacked ? "backed" : "thin"}`,
  ].join(" ");
}

export function createRoutingReceiptState(): RoutingReceiptState {
  return { lastBySession: new Map() };
}

/**
 * Computes the recommendation-mode routing receipt for one incoming message.
 * Private mode and the routing toggle win over everything; an empty allowlist
 * means the user configured no candidates, so no receipt is computed. The
 * computation is fail-open: a structured failure is returned instead of throwing.
 */
export function computeRoutingReceipt(
  connection: SqliteConnection,
  toggles: ResolvedFeatureToggles,
  input: ComputeRoutingReceiptInput,
): ComputeRoutingReceiptResult {
  if (toggles.privateMode) {
    return { status: "skipped", reason: "private-mode" };
  }
  if (!toggles.routing) {
    return { status: "skipped", reason: "routing-disabled" };
  }
  if (input.mode === "disabled") {
    return { status: "skipped", reason: "routing-mode-disabled" };
  }
  if (input.allowlist.length === 0) {
    return { status: "skipped", reason: "empty-allowlist" };
  }

  const now = input.now ?? new Date();

  let rejections: ReadonlyArray<ModelEligibilityRejection>;
  let receipt: RoutingReceipt;
  try {
    const result = recommendModel(connection, {
      candidates: input.allowlist.map(toRoutingCandidate),
      preset: input.preset,
      gates: input.gates,
      now,
      requiredCapabilities: [],
      privacyPolicy: "any",
      hardLimits: input.hardLimits,
      ...(input.currentModel ? { currentModel: input.currentModel } : {}),
      ...(input.priors !== undefined && input.priors.length > 0
        ? { priors: input.priors }
        : {}),
      ...(input.targetProfile ? { targetProfile: input.targetProfile } : {}),
      ...(input.loadEvidence ? { loadEvidence: input.loadEvidence } : {}),
    });

    rejections = result.rejections;
    receipt = {
      mode: input.mode,
      preset: result.preset,
      recommendation: result.recommendation
        ? {
            provider: result.recommendation.provider,
            model: result.recommendation.model,
            variant: result.recommendation.variant,
            utility: result.recommendation.utility,
            evidenceSampleCount: result.recommendation.evidenceSampleCount,
            evidenceWeightShare: result.recommendation.evidenceWeightShare,
            dimensions: toReceiptDimensions(result.recommendation.contributions),
          }
        : null,
      isEvidenceBacked: result.isEvidenceBacked,
      currentModel: result.currentModel
        ? {
            provider: result.currentModel.provider,
            model: result.currentModel.model,
            variant: result.currentModel.variant,
            utility: result.currentModel.utility,
          }
        : null,
      gates: result.gates,
      rejections,
      computedAt: now.toISOString(),
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return { status: "computed", receipt };
}
