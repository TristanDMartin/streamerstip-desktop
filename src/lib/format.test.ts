import { describe, expect, it } from "vitest";

import {
  formatBytes,
  formatDuration,
  jobLabel,
  jobPhase,
  phaseLabel,
  searchSubject,
} from "./format";

describe("job phases", () => {
  it("maps durable states onto the visible phases", () => {
    expect(jobPhase("queued")).toBe("queued");
    expect(jobPhase("waiting_for_dependency")).toBe("queued");
    expect(jobPhase("retrying")).toBe("running");
    expect(jobPhase("running")).toBe("running");
    expect(jobPhase("completed")).toBe("done");
    expect(jobPhase("failed")).toBe("failed");
    expect(phaseLabel("done")).toBe("Done");
  });

  it("labels the import pipeline in creator language", () => {
    expect(jobLabel("extract_audio")).toBe("Waveform");
    expect(jobLabel("transcribe_media")).toBe("Transcript");
    expect(jobLabel("probe_media")).toBe("Probe media");
    expect(searchSubject("Where did I talk about GTA VI?")).toBe("gta vi");
    expect(formatDuration(125000)).toBe("2:05");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
