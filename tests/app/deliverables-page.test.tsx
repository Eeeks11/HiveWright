// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DeliverablesPage from "../../src/app/(dashboard)/deliverables/page";

vi.mock("@/components/outcomes/final-outputs-page", () => ({
  FinalOutputsPage: () => <div>Hive-isolated final outputs</div>,
}));

describe("DeliverablesPage", () => {
  it("renders the client-side final outputs surface", () => {
    render(<DeliverablesPage />);

    expect(screen.getByText("Hive-isolated final outputs")).toBeTruthy();
  });
});
