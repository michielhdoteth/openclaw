import { describe, expect, it } from "vitest";
import { resolveEventWebPushNotification } from "./event-web-push.js";

describe("event Web Push classification", () => {
  it("classifies only final chat events as agent completion", () => {
    expect(
      resolveEventWebPushNotification("chat", { state: "final", runId: "run-1" }),
    ).toMatchObject({ category: "agent-finished", tag: "openclaw-agent-finished-run-1" });
    expect(resolveEventWebPushNotification("chat", { state: "delta", runId: "run-1" })).toBeNull();
  });

  it("classifies questions and strips control characters from durable tags", () => {
    expect(
      resolveEventWebPushNotification("question.requested", { id: "question\n1" }),
    ).toMatchObject({ category: "agent-question", tag: "openclaw-question-question 1" });
  });

  it("classifies only failed task and cron terminal events", () => {
    expect(
      resolveEventWebPushNotification("task", {
        action: "upserted",
        task: { id: "task-1", title: "Build", status: "failed" },
      }),
    ).toMatchObject({
      category: "background-task-failed",
      identifiedBody: "Build needs attention.",
    });
    expect(
      resolveEventWebPushNotification("cron", {
        action: "finished",
        jobId: "cron-1",
        status: "error",
        job: { name: "Nightly" },
      }),
    ).toMatchObject({
      category: "scheduled-task-failed",
      identifiedBody: "Nightly needs attention.",
    });
    expect(
      resolveEventWebPushNotification("cron", {
        action: "finished",
        jobId: "cron-1",
        status: "ok",
      }),
    ).toBeNull();
  });
});
