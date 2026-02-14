import { describe, expect, it } from "vitest";
import { classifyShutdownSignal } from "../src/cli/commands/fleetctl.js";

describe("classifyShutdownSignal", () => {
  it("starts graceful shutdown on the first signal", () => {
    const tracker = { requestedAtMs: null as number | null };

    const action = classifyShutdownSignal(tracker, 10_000);

    expect(action).toBe("start");
    expect(tracker.requestedAtMs).toBe(10_000);
  });

  it("ignores near-duplicate signals that arrive immediately after the first signal", () => {
    const tracker = { requestedAtMs: null as number | null };

    classifyShutdownSignal(tracker, 10_000);
    const action = classifyShutdownSignal(tracker, 10_050, 250);

    expect(action).toBe("ignore");
  });

  it("forces exit after the arm delay has elapsed", () => {
    const tracker = { requestedAtMs: null as number | null };

    classifyShutdownSignal(tracker, 10_000);
    const action = classifyShutdownSignal(tracker, 10_400, 250);

    expect(action).toBe("force_exit");
  });
});
