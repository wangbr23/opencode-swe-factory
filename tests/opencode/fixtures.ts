import type { Hooks } from "@opencode-ai/plugin";

export type ChatMessageHook = NonNullable<Hooks["chat.message"]>;
export type ChatMessageHookInput = Parameters<ChatMessageHook>[0];
export type ChatMessageHookOutput = Parameters<ChatMessageHook>[1];
export type SystemTransformHook = NonNullable<Hooks["experimental.chat.system.transform"]>;
export type SystemTransformHookOutput = Parameters<SystemTransformHook>[1];

export function createChatMessageFixture(): Readonly<{
  input: ChatMessageHookInput;
  output: ChatMessageHookOutput;
}> {
  return {
    input: {
      sessionID: "session-1",
      messageID: "message-1",
      agent: "build",
      model: {
        providerID: "openai",
        modelID: "gpt-4.1",
      },
    },
    output: {
      message: {
        id: "message-1",
        sessionID: "session-1",
        role: "user",
        time: { created: 0 },
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-4.1",
        },
      },
      parts: [],
    },
  };
}

export function createSystemTransformOutputFixture(): SystemTransformHookOutput {
  return { system: ["existing primary system block"] };
}
