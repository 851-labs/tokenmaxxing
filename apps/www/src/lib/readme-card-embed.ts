import { README_CARD_WIDTH } from "./readme-card";
import type { ReadmeCardOptions } from "./readme-card";
import { siteUrl } from "./site";

type ReadmeCardEmbedFormat = "html" | "markdown";

/** Site path of a profile's README card, e.g. `/card/pondorasti.svg?theme=dark`. */
function readmeCardPath(login: string, options: ReadmeCardOptions): string {
  const params = new URLSearchParams();
  if (options.theme !== "auto") {
    params.set("theme", options.theme);
  }
  if (options.hideSpend) {
    params.set("hide", "spend");
  }
  if (options.layout !== "full") {
    params.set("layout", options.layout);
  }
  const query = params.toString();

  return `/card/${encodeURIComponent(login)}.svg${query === "" ? "" : `?${query}`}`;
}

/**
 * Copy-paste snippet linking the card to the profile, for a GitHub README.
 *
 * With the auto theme, the HTML snippet is a `<picture>` with a dark and a
 * light source: GitHub resolves `prefers-color-scheme` there against the
 * viewer's GitHub theme. Markdown has no such element, so its single image
 * uses the card's own auto theme, which follows the viewer's system theme.
 */
function readmeCardSnippet(
  login: string,
  options: ReadmeCardOptions,
  format: ReadmeCardEmbedFormat,
): string {
  const image = (theme: ReadmeCardOptions["theme"]) =>
    siteUrl(readmeCardPath(login, { ...options, theme }));
  const profile = siteUrl(`/${encodeURIComponent(login)}`);
  const alt = `${login}'s tokenmaxxing stats`;
  if (format === "markdown") {
    return `[![${alt}](${image(options.theme)})](${profile})`;
  }
  if (options.theme !== "auto") {
    return `<a href="${profile}"><img src="${image(options.theme)}" alt="${alt}" width="${README_CARD_WIDTH}"></a>`;
  }

  return [
    `<a href="${profile}">`,
    `  <picture>`,
    `    <source media="(prefers-color-scheme: dark)" srcset="${image("dark")}">`,
    `    <img src="${image("light")}" alt="${alt}" width="${README_CARD_WIDTH}">`,
    `  </picture>`,
    `</a>`,
  ].join("\n");
}

export { readmeCardPath, readmeCardSnippet };

export type { ReadmeCardEmbedFormat };
