// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ReadmeCardSection } from "./readme-card-section";

const writeText = vi.fn(async (_text: string) => {});

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<ReadmeCardSection login="pondorasti" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("ReadmeCardSection", () => {
  it("starts with the default card and a Markdown snippet that links it to the profile", () => {
    expect(preview().getAttribute("src")).toBe("/card/pondorasti.svg");
    expect(preview().getAttribute("alt")).toBe("Preview of pondorasti's README card");
    expect(preloader()).toBeNull();
    expect(snippet()).toBe(
      "[![pondorasti's tokenmaxxing stats](https://tokenmaxxing.sh/card/pondorasti.svg)](https://tokenmaxxing.sh/pondorasti)",
    );
  });

  it("puts each chosen option in the snippet's card URL", () => {
    choose("Card theme", "Dark");
    choose("Card size", "Compact");
    choose("Show spend on the card", "Hide");

    expect(snippet()).toContain(
      "(https://tokenmaxxing.sh/card/pondorasti.svg?theme=dark&hide=spend&layout=compact)",
    );
  });

  it("keeps the loaded card on screen, dimmed, until the newly chosen one has loaded", () => {
    choose("Card theme", "Dark");

    // The old card stays; the new one loads out of sight.
    expect(preview().getAttribute("src")).toBe("/card/pondorasti.svg");
    expect(preview().className).toContain("opacity-60");
    expect(preloader()?.getAttribute("src")).toBe("/card/pondorasti.svg?theme=dark");

    act(() => {
      preloader()?.dispatchEvent(new Event("load"));
    });

    expect(preview().getAttribute("src")).toBe("/card/pondorasti.svg?theme=dark");
    expect(preview().className).not.toContain("opacity-60");
    expect(preloader()).toBeNull();
  });

  it("shows the new card's own failure rather than a stale card when it can't load", () => {
    choose("Card size", "Compact");
    act(() => {
      preloader()?.dispatchEvent(new Event("error"));
    });

    expect(preview().getAttribute("src")).toBe("/card/pondorasti.svg?layout=compact");
    expect(preloader()).toBeNull();
  });

  it("writes the HTML snippet as a picture that follows the viewer's theme, or one image", () => {
    choose("Snippet format", "HTML");

    expect(snippet()).toBe(
      [
        `<a href="https://tokenmaxxing.sh/pondorasti">`,
        `  <picture>`,
        `    <source media="(prefers-color-scheme: dark)" srcset="https://tokenmaxxing.sh/card/pondorasti.svg?theme=dark">`,
        `    <img src="https://tokenmaxxing.sh/card/pondorasti.svg?theme=light" alt="pondorasti's tokenmaxxing stats" width="600">`,
        `  </picture>`,
        `</a>`,
      ].join("\n"),
    );

    choose("Card theme", "Light");

    expect(snippet()).toBe(
      `<a href="https://tokenmaxxing.sh/pondorasti"><img src="https://tokenmaxxing.sh/card/pondorasti.svg?theme=light" alt="pondorasti's tokenmaxxing stats" width="600"></a>`,
    );
  });

  it("copies exactly the snippet on screen and confirms it", async () => {
    choose("Card size", "Compact");
    choose("Snippet format", "HTML");
    const shown = snippet();

    await act(async () => {
      copyButton().click();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(shown);
    expect(copyButton().textContent).toBe("Copied");
  });
});

function choose(group: string, option: string) {
  const radio = [
    ...container.querySelectorAll<HTMLButtonElement>(
      `[role="radiogroup"][aria-label="${group}"] [role="radio"]`,
    ),
  ].find((candidate) => candidate.textContent === option);
  if (radio === undefined) {
    throw new Error(`No "${option}" option in "${group}"`);
  }
  act(() => radio.click());
}

/** The card on screen. */
function preview(): HTMLImageElement {
  const image = container.querySelector<HTMLImageElement>("img[alt^='Preview']");
  if (image === null) {
    throw new Error("No preview image");
  }
  return image;
}

/** The hidden image that loads a newly chosen card before it is shown. */
function preloader(): HTMLImageElement | null {
  return container.querySelector<HTMLImageElement>("img[aria-hidden='true']");
}

function snippet(): string {
  return container.querySelector("code")?.textContent ?? "";
}

function copyButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button:not([role='radio'])");
  if (button === null) {
    throw new Error("No copy button");
  }
  return button;
}
