import { describe, expect, it } from "vitest";

import { jobHistory, workerCards } from "./team";
import type { Job } from "../types";

function job(partial: Partial<Job> & Pick<Job, "jobId" | "type" | "agent" | "state">): Job {
  return {
    projectId: "proj_1",
    progress: 0,
    dependencies: [],
    createdAt: "2026-10-14T00:00:00Z",
    startedAt: null,
    completedAt: null,
    error: null,
    mediaId: "media_1",
    message: "",
    subjectId: "",
    explanation: "",
    ...partial,
  };
}

describe("worker cards", () => {
  it("shows two short editors running while packaging and QA wait", () => {
    const cards = workerCards([
      job({
        jobId: "scout",
        type: "scout_moments",
        agent: "moment_scout",
        state: "completed",
        progress: 1,
        explanation: "Looking for moments that can stand on their own.",
        createdAt: "2026-10-14T00:00:01Z",
      }),
      job({
        jobId: "short-a",
        type: "create_short",
        agent: "clip_editor",
        state: "running",
        progress: 0.5,
        explanation: "Making a vertical Short from this moment.",
        createdAt: "2026-10-14T00:00:02Z",
      }),
      job({
        jobId: "short-b",
        type: "create_short",
        agent: "clip_editor",
        state: "running",
        progress: 0.2,
        explanation: "Making a vertical Short from this moment.",
        createdAt: "2026-10-14T00:00:03Z",
      }),
      job({
        jobId: "package",
        type: "package_content",
        agent: "packaging_agent",
        state: "waiting_for_dependency",
        explanation: "Writing a title and hook from the moment. Nothing is published.",
        createdAt: "2026-10-14T00:00:04Z",
      }),
      job({
        jobId: "qa",
        type: "qa_content",
        agent: "qa_agent",
        state: "paused",
        explanation: "Checking the Short is vertical, captioned, and ready to review.",
        createdAt: "2026-10-14T00:00:05Z",
      }),
    ]);
    expect(cards.map((card) => `${card.name} ${card.label}`)).toEqual([
      "Clip Scout Done",
      "Short Editor A Running",
      "Short Editor B Running",
      "Packaging Waiting",
      "QA Paused",
    ]);
    expect(cards[1].canPause).toBe(true);
    expect(cards[4].canResume).toBe(true);
    expect(cards[3].explanation).toContain("Nothing is published");
    const history = jobHistory([
      job({
        jobId: "qa",
        type: "qa_content",
        agent: "qa_agent",
        state: "completed",
        message: "The Short is vertical, captioned, and ready to review.",
        explanation: "Checking the Short is vertical, captioned, and ready to review.",
        createdAt: "2026-10-14T00:00:05Z",
      }),
      job({
        jobId: "pack",
        type: "package_content",
        agent: "packaging_agent",
        state: "waiting_for_dependency",
        message: "",
        explanation: "Writing a title and hook from the moment. Nothing is published.",
        createdAt: "2026-10-14T00:00:04Z",
      }),
    ]);
    expect(history[0].title).toBe("QA · QA");
    expect(history[0].label).toContain("ready to review");
    expect(history[1].label).toBe("Waiting");
  });
});
