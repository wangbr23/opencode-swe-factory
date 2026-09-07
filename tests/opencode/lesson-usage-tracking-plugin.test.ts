import { expect, test } from "bun:test";

import {
  proposeLessonCandidate,
  reviewLessonCandidate,
  type SecretScanResult,
} from "../../src/core/index.js";
import { chatInput, withPlugin, type ChatMessageHook } from "./fixtures.js";

const clearScan: SecretScanResult = {
  disposition: "clear",
  findings: [],
  redactedText: "",
};

test("chat.message records retrieval hits for injected lessons", () =>
  withPlugin(async ({ hooks, connection, projectId }) => {
    const candidate = proposeLessonCandidate(connection, {
      projectId,
      scope: "project",
      draft: {
        title: "Always use parameterized queries",
        body: "Never concatenate user input into SQL strings to prevent injection attacks",
        rationale: "Security best practice",
        applicability: {},
        provenance: {},
      },
      secretScan: clearScan,
    });
    reviewLessonCandidate(connection, {
      candidateId: candidate.id,
      decision: "approve",
    });

    const msg = chatInput("s1", "Fix the SQL query in the user module");
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(msg.input, msg.output);

    const hit = connection.database
      .query<{ lesson_id: string; version: number; retrieved_day: string }, []>(
        "SELECT lesson_id, version, retrieved_day FROM lesson_retrieval_hits",
      )
      .get();
    expect(hit).not.toBeNull();
    const approvedLesson = connection.database
      .query<{ id: string }, []>("SELECT id FROM lessons")
      .get();
    expect(hit!.lesson_id).toBe(approvedLesson!.id);
    expect(hit!.version).toBe(1);
    expect(hit!.retrieved_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }));

test("chat.message succeeds without lesson hits when nothing is retrieved", () =>
  withPlugin(async ({ hooks, connection }) => {
    const msg = chatInput("s1", "Add a login feature");
    const chatMessage = hooks["chat.message"] as ChatMessageHook;
    await chatMessage(msg.input, msg.output);

    const hits = connection.database
      .query<unknown, []>("SELECT * FROM lesson_retrieval_hits")
      .all();
    expect(hits).toEqual([]);
  }));
