// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CliLoginRequestSummary } from "@tokenmaxxing/api-contract";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { runApi } from "../lib/api";
import { CliLoginApproval } from "./login_.cli";

vi.mock("../lib/api", () => ({
  errorMessage: (_error: unknown, fallback: string) => fallback,
  runApi: vi.fn(),
}));

const summary: CliLoginRequestSummary = {
  code: "K3QF-W8MT",
  createdAt: "2026-09-22T12:00:00.000Z",
  deviceArch: "arm64",
  deviceName: "mallory-box",
  devicePlatform: "linux",
  deviceVersion: "1.2.3",
  expiresAt: "2026-09-22T12:10:00.000Z",
  legacyClient: false,
  status: "pending",
};

const approveCliLogin = vi.fn(() => ({ deviceName: summary.deviceName, ok: true }));
const fakeClient = {
  me: {
    approveCliLogin,
    describeCliLogin: () => summary,
    me: () => ({ user: { avatarUrl: null, id: "user_alice", login: "alice", name: null } }),
  },
};

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  approveCliLogin.mockClear();
  vi.mocked(runApi).mockImplementation(async (call) => call(fakeClient as never) as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CliLoginApproval", () => {
  it("shows the requesting device and never approves without a click", async () => {
    await render(<CliLoginApproval code={summary.code} />);

    const button = approveButton();
    expect(button?.textContent).toBe("Approve mallory-box");
    expect(container.textContent).toContain("mallory-box");
    expect(container.textContent).toContain("linux · arm64");
    expect(container.textContent).toContain("alice");

    // Signed in, code in the URL, details loaded — and still nothing approved.
    await settle();
    expect(approveCliLogin).not.toHaveBeenCalled();

    await act(async () => {
      button?.click();
    });
    await settle();

    expect(approveCliLogin).toHaveBeenCalledTimes(1);
    expect(approveCliLogin).toHaveBeenCalledWith({ payload: { code: summary.code } });
    expect(container.textContent).toContain("Approved mallory-box");
  });
});

async function render(element: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  await settle();
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function approveButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Approve"),
  );
}
