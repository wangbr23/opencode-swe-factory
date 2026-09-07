import { expect, test } from "bun:test";
import { join } from "node:path";

import {
  createDefaultConfig,
  readLocalDiagnostics,
  type ConfigV1,
} from "../../src/core/index.js";
import {
  chatInput,
  createToolContext,
  textOf,
  withPlugin,
  type ChatMessageHook,
} from "./fixtures.js";

function configWithRouting(
  overrides?: Partial<ConfigV1["routing"]>,
): ConfigV1 {
  const base = createDefaultConfig();
  return {
    ...base,
    routing: {
      ...base.routing,
      ...overrides,
    },
  };
}

const ALLOWLIST = [
  {
    provider: "openai",
    model: "gpt-4.1",
    variant: "default",
    capabilities: ["toolcall"],
    privacy: "remote" as const,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4",
    variant: "thinking",
    capabilities: ["toolcall"],
    privacy: "remote" as const,
  },
];

function parseReceipt(json: string) {
  return JSON.parse(json) as {
    mode: string;
    recommendation:
      | { provider: string; model: string; variant: string; utility: number }
      | null;
    currentModel:
      | { provider: string; model: string; variant: string; utility: number }
      | null;
    isEvidenceBacked: boolean;
    gates: Array<{ gate: string; passed: boolean }>;
  };
}

// --- Receipt emission through chat.message ---

test("chat.message computes and stores a routing receipt when the allowlist is configured", () =>
  withPlugin(
    async ({ hooks, diagnosticsPath, getTool }) => {
      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      const msg = chatInput("s1", "Implement feature for adding users");
      await chatMessage(msg.input, msg.output);

      const receiptJson = textOf(
        await getTool("swe_factory_get_recommendation").execute(
          {},
          createToolContext("s1"),
        ),
      );
      const receipt = parseReceipt(receiptJson);
      expect(receipt.mode).toBe("recommendation-only");
      expect(receipt.recommendation).toMatchObject({
        provider: "openai",
        model: "gpt-4.1",
        variant: "default",
        utility: 0,
        evidenceSampleCount: 0,
        dimensions: [],
      });
      expect(receipt.isEvidenceBacked).toBe(false);
      expect(receipt.gates).toHaveLength(3);

      const diagnostics = readLocalDiagnostics(
        join(diagnosticsPath, "diagnostics.jsonl"),
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.component).toBe("routing");
      expect(diagnostics[0]!.code).toBe("routing-receipt");
      expect(diagnostics[0]!.summary).toContain(
        "recommend provider=openai model=gpt-4.1 variant=default",
      );
    },
    { config: configWithRouting({ allowlist: ALLOWLIST }) },
  ));

test("the host-selected model rides along when the message carries a variant", () =>
  withPlugin(
    async ({ hooks, getTool }) => {
      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      const msg = chatInput("s1", "Implement feature for adding users");
      await chatMessage(
        {
          ...msg.input,
          model: { providerID: "openai", modelID: "gpt-4.1" },
          variant: "default",
        },
        msg.output,
      );

      const receipt = parseReceipt(
        textOf(
          await getTool("swe_factory_get_recommendation").execute(
            {},
            createToolContext("s1"),
          ),
        ),
      );
      expect(receipt.currentModel).toEqual({
        provider: "openai",
        model: "gpt-4.1",
        variant: "default",
        utility: 0,
      });
    },
    { config: configWithRouting({ allowlist: ALLOWLIST }) },
  ));

test("recommendation mode never mutates the message model", () =>
  withPlugin(
    async ({ hooks }) => {
      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      const msg = chatInput("s1", "Implement feature for adding users");
      const before = structuredClone(msg.output);
      await chatMessage({ ...msg.input, variant: "thinking" }, msg.output);
      expect(msg.output).toEqual(before);
    },
    {
      config: configWithRouting({
        allowlist: ALLOWLIST,
        mode: "automatic",
      }),
    },
  ));

test("automatic mode still only computes the receipt", () =>
  withPlugin(
    async ({ hooks, getTool }) => {
      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      const msg = chatInput("s1", "Implement feature for adding users");
      await chatMessage(msg.input, msg.output);

      const receipt = parseReceipt(
        textOf(
          await getTool("swe_factory_get_recommendation").execute(
            {},
            createToolContext("s1"),
          ),
        ),
      );
      expect(receipt.mode).toBe("automatic");
      expect(receipt.recommendation).not.toBeNull();
    },
    {
      config: configWithRouting({
        allowlist: ALLOWLIST,
        mode: "automatic",
      }),
    },
  ));

// --- Skip paths ---

test("no receipt is stored when the allowlist is empty (default config)", () =>
  withPlugin(async ({ hooks, getTool }) => {
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    const msg = chatInput("s1", "Implement feature for adding users");
    await chatMessage(msg.input, msg.output);

    const output = textOf(
      await getTool("swe_factory_get_recommendation").execute(
        {},
        createToolContext("s1"),
      ),
    );
    expect(output).toContain("No routing receipt has been computed");
  }));

test("private mode suppresses receipt computation", () =>
  withPlugin(
    async ({ hooks, getTool }) => {
      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      await getTool("swe_factory_set_private_mode").execute(
        { enabled: true },
        createToolContext("s1"),
      );
      const msg = chatInput("s1", "Implement feature for adding users");
      await chatMessage(msg.input, msg.output);

      const output = textOf(
        await getTool("swe_factory_get_recommendation").execute(
          {},
          createToolContext("s1"),
        ),
      );
      expect(output).toContain("No routing receipt has been computed");
    },
    { config: configWithRouting({ allowlist: ALLOWLIST }) },
  ));

test("disabling the routing toggle suppresses receipt computation", () =>
  withPlugin(
    async ({ hooks, getTool }) => {
      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      await getTool("swe_factory_set_toggle").execute(
        { feature: "routing", enabled: false },
        createToolContext("s1"),
      );
      const msg = chatInput("s1", "Implement feature for adding users");
      await chatMessage(msg.input, msg.output);

      const output = textOf(
        await getTool("swe_factory_get_recommendation").execute(
          {},
          createToolContext("s1"),
        ),
      );
      expect(output).toContain("No routing receipt has been computed");
    },
    { config: configWithRouting({ allowlist: ALLOWLIST }) },
  ));

test("receipts stay isolated per session", () =>
  withPlugin(
    async ({ hooks, getTool }) => {
      const chatMessage = hooks["chat.message"] as ChatMessageHook;
      await chatMessage(
        chatInput("s1", "Implement feature for adding users").input,
        chatInput("s1", "Implement feature for adding users").output,
      );
      await chatMessage(
        chatInput("s2", "Implement feature for adding users").input,
        chatInput("s2", "Implement feature for adding users").output,
      );

      const s1 = textOf(
        await getTool("swe_factory_get_recommendation").execute(
          {},
          createToolContext("s1"),
        ),
      );
      const s2 = textOf(
        await getTool("swe_factory_get_recommendation").execute(
          {},
          createToolContext("s2"),
        ),
      );
      // computedAt stamps each message separately; everything else must match.
      const { computedAt: _s1ComputedAt, ...receipt1 } = JSON.parse(s1);
      const { computedAt: _s2ComputedAt, ...receipt2 } = JSON.parse(s2);
      expect(receipt1).toEqual(receipt2);
      expect(receipt1.recommendation).not.toBeNull();
    },
    { config: configWithRouting({ allowlist: ALLOWLIST }) },
  ));
