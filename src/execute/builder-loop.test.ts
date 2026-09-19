import { describe, it, expect } from "vitest";
import { builderRecoveryFor } from "./builder-loop.ts";

describe("builderRecoveryFor — session death routes (ADR 0022 §5)", () => {
  it("resumes the same session on an infra blip or server-state failure", () => {
    expect(builderRecoveryFor("blip")).toBe("resume-session");
    expect(builderRecoveryFor("server-state")).toBe("resume-session");
  });

  it("forces a fresh session from the last commit when the session's own content is the problem", () => {
    expect(builderRecoveryFor("capacity")).toBe("fresh-session");
    expect(builderRecoveryFor("diagnosed")).toBe("fresh-session");
    expect(builderRecoveryFor("fatal-config")).toBe("fresh-session");
  });
});
