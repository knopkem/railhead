import { describe, it, expect, beforeEach } from "vitest";
import {
  clearStop,
  hardStopRequested,
  isAbortRequested,
  isSoftStopRequested,
  requestAbort,
  requestStop,
  runStopHandlerInstalled,
  setRunStopHandlerInstalled,
} from "./stop.ts";

beforeEach(() => {
  clearStop();
  setRunStopHandlerInstalled(false);
});

describe("stop requests", () => {
  it("arms a soft stop on the first request", () => {
    expect(requestStop()).toBe("soft");
    expect(isSoftStopRequested()).toBe(true);
    expect(hardStopRequested()).toBe(false);
  });

  it("escalates every request after the first to hard, clearing the soft signal", () => {
    requestStop();
    expect(requestStop()).toBe("hard");
    expect(isSoftStopRequested()).toBe(false);
    expect(hardStopRequested()).toBe(true);
    // A third press stays hard — the loop must never re-arm and wind down.
    expect(requestStop()).toBe("hard");
  });

  it("clearStop resets the soft, hard, and abort state", () => {
    requestStop();
    requestStop();
    requestAbort();
    clearStop();
    expect(isSoftStopRequested()).toBe(false);
    expect(hardStopRequested()).toBe(false);
    expect(isAbortRequested()).toBe(false);
    expect(requestStop()).toBe("soft");
  });
});

describe("operator abort", () => {
  it("is off until requested, and stays set until cleared", () => {
    expect(isAbortRequested()).toBe(false);
    requestAbort();
    expect(isAbortRequested()).toBe(true);
    // A soft/hard request does not clear an abort — the process is ending.
    requestStop();
    expect(isAbortRequested()).toBe(true);
  });
});

describe("run stop handler registration", () => {
  it("starts uninstalled and tracks install/clear", () => {
    expect(runStopHandlerInstalled()).toBe(false);
    setRunStopHandlerInstalled(true);
    expect(runStopHandlerInstalled()).toBe(true);
    setRunStopHandlerInstalled(false);
    expect(runStopHandlerInstalled()).toBe(false);
  });
});
