import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TIPPY_NOT_CONNECTED, TippyRail } from "./TippyRail";

describe("Tippy rail", () => {
  it("keeps the composer disconnected from a model", async () => {
    const onSubmit = vi.fn(async () => TIPPY_NOT_CONNECTED);
    render(<TippyRail onSubmit={onSubmit} />);
    expect(screen.getAllByText(TIPPY_NOT_CONNECTED).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByTestId("tippy-composer"), {
      target: { value: "Find my best clips" },
    });
    fireEvent.click(screen.getByTestId("tippy-submit"));
    expect(onSubmit).toHaveBeenCalledWith("Find my best clips");
    const reply = await screen.findByTestId("tippy-reply");
    expect(reply.textContent).toContain(TIPPY_NOT_CONNECTED);
  });
});
