import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CreateCard } from "./HomeView";

describe("CreateCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("reports an empty New Project click instead of dropping it", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<CreateCard onCreate={onCreate} />);
    fireEvent.click(screen.getByTestId("create-project"));
    expect(onCreate).toHaveBeenCalledWith("");
  });

  it("creates a project from the typed name", async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<CreateCard onCreate={onCreate} />);
    fireEvent.change(screen.getByTestId("new-project-name"), {
      target: { value: "  Stream  " },
    });
    fireEvent.click(screen.getByTestId("create-project"));
    expect(onCreate).toHaveBeenCalledWith("Stream");
  });
});
