import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CaptureView } from "./CaptureView";

describe("CaptureView", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the pre-stream check and keeps chat replay off", () => {
    render(<CaptureView deviceId="owner_test" chatEnabled={false} />);
    expect(screen.getByTestId("obs-readiness").textContent).toContain("Pre-stream check");
    expect(screen.getByRole("button", { name: "Save moment" })).toBeTruthy();
    expect(screen.getByTestId("capture-board").textContent).toContain("Chat replay is off");
    expect(screen.getByTestId("capture-board").textContent).toContain("stay on this PC");
  });
});
