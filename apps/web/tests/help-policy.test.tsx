import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const { readCurrentCommissionPolicy, readCurrent, readRevision } = vi.hoisted(() => ({ readCurrentCommissionPolicy: vi.fn(), readCurrent: vi.fn(), readRevision: vi.fn() }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => ({ readCurrentCommissionPolicy, trustPolicies: { readCurrent, readRevision } }) }));
vi.mock("../src/ui/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@pawket/config", () => ({ loadServerEnv: () => { throw new Error("UI must use the shared runtime"); } }));
vi.mock("@pawket/database", async (original) => ({ ...await original<object>(),
  createDatabase: () => { throw new Error("UI must use the shared database"); } }));
import { CurrentHelpPolicy } from "../src/ui/help/help-policy";
import HelpPage from "../src/app/help/page";
import PolicyVersionPage from "../src/app/help/policies/[revisionId]/page";

beforeEach(() => { vi.resetAllMocks(); readCurrentCommissionPolicy.mockResolvedValue(null); readCurrent.mockResolvedValue(null); });
test("current help policy reads the reviewed document through the platform runtime", async () => {
  readCurrentCommissionPolicy.mockResolvedValue({ revisionId: "synthetic-policy", revisionNumber: 2, document: "Synthetic <policy>", checksum: "synthetic", acceptsOrders: true });
  const markup = renderToStaticMarkup(await CurrentHelpPolicy());
  expect(readCurrentCommissionPolicy).toHaveBeenCalledOnce();
  expect(markup.includes("Phiên bản 2")).toBe(true); expect(markup.includes("Synthetic &lt;policy&gt;")).toBe(true);
});
test("current help policy shows unpublished when the runtime read returns no policy", async () => {
  readCurrentCommissionPolicy.mockResolvedValue(null);
  const markup = renderToStaticMarkup(await CurrentHelpPolicy());
  expect(readCurrentCommissionPolicy).toHaveBeenCalledOnce();
  expect(markup.match(/Chưa được công bố/gu)).toHaveLength(3);
});

test("help lists three policies and marks unpublished ones", async () => {
  const markup = renderToStaticMarkup(await CurrentHelpPolicy());
  for (const title of ["Chính sách commission và hoàn tiền", "Quy định cộng đồng", "Chính sách xử lý vi phạm và kháng nghị"]) expect(markup).toContain(title);
  expect(markup.match(/Chưa được công bố/gu)).toHaveLength(3);
  expect(readCurrentCommissionPolicy).toHaveBeenCalledOnce();
  expect(readCurrent.mock.calls).toEqual([["community_rules"], ["enforcement_appeals"]]);
});
test("trust policies render reviewed documents as escaped text regardless of switches", async () => {
  readCurrent.mockImplementation(async (kind: string) => ({ revisionId: kind, kind, revisionNumber: 3, document: `Synthetic <${kind}>`, effectiveAt: "2026-10-10T00:00:00.000Z" }));
  const markup = renderToStaticMarkup(await CurrentHelpPolicy());
  expect(markup).toContain("Synthetic &lt;community_rules&gt;"); expect(markup).toContain("Synthetic &lt;enforcement_appeals&gt;");
  expect(markup.match(/Chưa được công bố/gu)).toHaveLength(1);
});
test("one unavailable policy does not suppress other published policies", async () => {
  readCurrentCommissionPolicy.mockRejectedValue(new Error("Synthetic read failure"));
  readCurrent.mockImplementation(async (kind: string) => kind === "community_rules" ? { revisionNumber: 1, document: "Synthetic community policy" } : null);
  const markup = renderToStaticMarkup(await CurrentHelpPolicy());
  expect(markup).toContain("Chưa tải được chính sách. Vui lòng tải lại trang.");
  expect(markup).toContain("Synthetic community policy"); expect(markup.match(/Chưa được công bố/gu)).toHaveLength(1);
});
test("help links locked accounts to the resend page", async () => {
  const markup = renderToStaticMarkup(await HelpPage());
  expect(markup).toContain('href="/help/locked/resend"'); expect(markup).toContain("Tài khoản bị khóa?");
});
test("policy version page awaits params and reads the penalty's immutable revision", async () => {
  const revisionId = "10000000-0000-4000-8000-000000000001";
  readRevision.mockResolvedValue({ revisionId, kind: "enforcement_appeals", revisionNumber: 1, document: "Original <policy>", effectiveAt: "2026-10-10T00:00:00.000Z" });
  const markup = renderToStaticMarkup(await PolicyVersionPage({ params: Promise.resolve({ revisionId }) }));
  expect(readRevision).toHaveBeenCalledWith(revisionId); expect(readCurrent).not.toHaveBeenCalled();
  expect(markup).toContain("Phiên bản 1"); expect(markup).toContain("Original &lt;policy&gt;");
});
test("current help policy shows an unavailable state when the runtime read fails", async () => {
  readCurrentCommissionPolicy.mockRejectedValue(new Error("Synthetic read failure"));
  const markup = renderToStaticMarkup(await CurrentHelpPolicy());
  expect(readCurrentCommissionPolicy).toHaveBeenCalledOnce();
  expect(markup.includes("Chưa tải được chính sách. Vui lòng tải lại trang.")).toBe(true);
});
