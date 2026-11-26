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

/** Copy-paste snippet linking the card to the profile, for a GitHub README. */
function readmeCardSnippet(
  login: string,
  options: ReadmeCardOptions,
  format: ReadmeCardEmbedFormat,
): string {
  const image = siteUrl(readmeCardPath(login, options));
  const profile = siteUrl(`/${encodeURIComponent(login)}`);
  const alt = `${login}'s tokenmaxxing stats`;
  if (format === "html") {
    return `<a href="${profile}"><img src="${image}" alt="${alt}" width="${README_CARD_WIDTH}"></a>`;
  }

  return `[![${alt}](${image})](${profile})`;
}

export { readmeCardPath, readmeCardSnippet };

export type { ReadmeCardEmbedFormat };
