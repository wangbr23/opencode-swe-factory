import { expect, test } from "bun:test";

import {
  OPENCODE_COMPATIBILITY_MANIFEST,
  checkOpenCodeCompatibility,
} from "../../src/opencode/compatibility.js";
import {
  createChatMessageFixture,
  createSystemTransformOutputFixture,
  type ChatMessageHook,
  type SystemTransformHook,
} from "./fixtures.js";

test("the manifest pins the minimum version and the contract-tested versions", () => {
  expect(OPENCODE_COMPATIBILITY_MANIFEST).toEqual({
    schemaVersion: 1,
    minimumVersion: "1.18.27",
    testedVersions: ["1.18.27", "1.18.29", "1.18.30"],
  });
  expect(checkOpenCodeCompatibility("1.18.27")).toEqual({
    status: "supported",
    version: "1.18.27",
  });
  expect(checkOpenCodeCompatibility("1.18.29")).toEqual({
    status: "supported",
    version: "1.18.29",
  });
});

test("every version at or above the minimum is supported, so updates never disable injection", () => {
  expect(checkOpenCodeCompatibility("1.18.28")).toEqual({
    status: "supported",
    version: "1.18.28",
  });
  expect(checkOpenCodeCompatibility("1.18.31")).toEqual({
    status: "supported",
    version: "1.18.31",
  });
  expect(checkOpenCodeCompatibility("2.0.0")).toEqual({
    status: "supported",
    version: "2.0.0",
  });
});

test("the compatibility gate rejects malformed and older versions", () => {
  expect(checkOpenCodeCompatibility("1.18")).toEqual({
    status: "unsupported",
    version: "1.18",
    reason: "invalid-version",
  });
  expect(checkOpenCodeCompatibility("01.18.27")).toEqual({
    status: "unsupported",
    version: "01.18.27",
    reason: "invalid-version",
  });
  expect(checkOpenCodeCompatibility("1.18.26")).toEqual({
    status: "unsupported",
    version: "1.18.26",
    reason: "below-minimum-version",
  });
});

test("baseline fixtures conform to the pinned plugin hook contracts", async () => {
  const chatMessageHook: ChatMessageHook = async (input, output) => {
    expect(input.sessionID).toBe("session-1");
    expect(input.messageID).toBe("message-1");
    expect(output.message.model).toEqual({ providerID: "openai", modelID: "gpt-4.1" });
  };
  const systemTransformHook: SystemTransformHook = async (_input, output) => {
    expect(output.system).toEqual(["existing primary system block"]);
  };
  const chatMessage = createChatMessageFixture();

  await chatMessageHook(chatMessage.input, chatMessage.output);
  expect(systemTransformHook).toBeTypeOf("function");
  expect(createSystemTransformOutputFixture().system).toEqual(["existing primary system block"]);
});
