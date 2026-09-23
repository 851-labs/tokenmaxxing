// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { nextSegmentIndex, SegmentedControl } from "./segmented-control";

const OPTIONS = [
  { label: "7 days", value: "7d" },
  { label: "30 days", value: "30d" },
  { label: "All time", value: "all" },
] as const;

type Window = (typeof OPTIONS)[number]["value"];

function Harness() {
  const [value, setValue] = useState<Window>("30d");
  return (
    <SegmentedControl label="Time window" onChange={setValue} options={OPTIONS} value={value} />
  );
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function radios() {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

function state() {
  return radios().map((radio) => [
    radio.textContent,
    radio.getAttribute("aria-checked"),
    radio.tabIndex,
  ]);
}

describe("SegmentedControl", () => {
  it("is a labelled radio group whose only tab stop is the selected option", () => {
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe(
      "Time window",
    );
    expect(state()).toEqual([
      ["7 days", "false", -1],
      ["30 days", "true", 0],
      ["All time", "false", -1],
    ]);
  });

  it("moves selection, focus and the tab stop together on arrow keys", () => {
    const [, thirty] = radios();
    act(() => {
      thirty?.focus();
      thirty?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });

    expect(state()).toEqual([
      ["7 days", "false", -1],
      ["30 days", "false", -1],
      ["All time", "true", 0],
    ]);
    expect(document.activeElement?.textContent).toBe("All time");
  });

  it("selects on click", () => {
    act(() => radios()[0]?.click());

    expect(state()[0]).toEqual(["7 days", "true", 0]);
  });
});

describe("nextSegmentIndex", () => {
  it("wraps arrows and jumps with Home/End", () => {
    expect(nextSegmentIndex(2, 3, "ArrowRight")).toBe(0);
    expect(nextSegmentIndex(0, 3, "ArrowLeft")).toBe(2);
    expect(nextSegmentIndex(1, 3, "Home")).toBe(0);
    expect(nextSegmentIndex(1, 3, "End")).toBe(2);
    expect(nextSegmentIndex(1, 3, "Enter")).toBeNull();
  });
});
