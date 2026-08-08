type ShareProfileImageOutcome = "cancelled" | "downloaded" | "shared";

interface ShareProfileImageInput {
  imagePath: string;
  login: string;
  profileUrl: string;
}

interface ShareProfileImageDeps {
  canShare?: (data: ShareData) => boolean;
  download: (file: File) => void;
  fetch: (input: string) => Promise<Response>;
  share?: (data: ShareData) => Promise<void>;
}

async function shareProfileImage(
  input: ShareProfileImageInput,
  deps: ShareProfileImageDeps = browserShareDeps(),
): Promise<ShareProfileImageOutcome> {
  const response = await deps.fetch(input.imagePath);
  if (!response.ok) {
    throw new Error(`Profile image responded ${response.status}`);
  }

  const blob = await response.blob();
  if (blob.type !== "image/png") {
    throw new Error(`Profile image returned ${blob.type || "an unknown content type"}`);
  }
  const file = new File([blob], `${safeFilename(input.login)}-tokenmaxxing.png`, {
    type: "image/png",
  });
  const shareData: ShareData = {
    files: [file],
    text: `${input.login} on tokenmaxxing.sh\n${input.profileUrl}`,
    title: `${input.login} on tokenmaxxing.sh`,
  };
  const canShare = deps.share !== undefined && (deps.canShare?.(shareData) ?? true);

  if (canShare && deps.share !== undefined) {
    try {
      await deps.share(shareData);
      return "shared";
    } catch (error) {
      if (isAbortError(error)) {
        return "cancelled";
      }
    }
  }

  deps.download(file);
  return "downloaded";
}

function browserShareDeps(): ShareProfileImageDeps {
  return {
    canShare: navigator.canShare === undefined ? undefined : (data) => navigator.canShare(data),
    download: downloadProfileImage,
    fetch: globalThis.fetch.bind(globalThis),
    share: navigator.share === undefined ? undefined : (data) => navigator.share(data),
  };
}

function downloadProfileImage(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.download = file.name;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function safeFilename(login: string): string {
  return login.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "profile";
}

export { safeFilename, shareProfileImage };

export type { ShareProfileImageDeps, ShareProfileImageInput, ShareProfileImageOutcome };
