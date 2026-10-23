// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
const { read, verify } = vi.hoisted(() => ({ read: vi.fn(), verify: vi.fn(async () => "synthetic-actor") }));
vi.mock("../src/ui/commissions/commission-session", () => ({ useCommissionSession: () => verify,
  useCommissionCommand: () => ({ execute: vi.fn(), locked: false }), CommandFeedback: () => null }));
vi.mock("../src/ui/commissions/commission-client", async (original) => ({ ...await original<object>(), commissionRead: read }));
import { CommissionThread } from "../src/ui/commissions/commission-thread";
import { fixtureOrder } from "./resolution-fixture-data";

test("opening an order marks only its messages once on client mount, never during server render or refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetch = vi.fn().mockRejectedValue(new Error("disabled")); vi.stubGlobal("fetch", fetch);
  read.mockImplementation(async (path: string) => path.includes("thread") ? { thread: { items: [], nextBeforeSequence: null, writable: false } }
    : { history: { items: [], nextBeforeVersion: null } });
  const refresh = vi.fn(async () => undefined);
  const view = (version: number) => <StrictMode><CommissionThread order={{ ...fixtureOrder, version, state: "completed" }} fulfillmentMode="enabled" disabled={false} reviewExpired={false} onRefresh={refresh} /></StrictMode>;
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    renderToStaticMarkup(view(1)); expect(fetch).not.toHaveBeenCalled();
    await act(async () => root.render(view(1)));
    await act(async () => root.render(view(2)));
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0]![0]).toBe("/api/v1/notifications/read");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ orderId: fixtureOrder.id });
    expect(container.querySelector('[role="alert"]')).not.toBeNull(); // The normal completed-order notice still renders.
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
