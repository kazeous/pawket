import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

const { readCurrentCommissionPolicy } = vi.hoisted(() => ({ readCurrentCommissionPolicy: vi.fn() }));
vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => ({ readCurrentCommissionPolicy }) }));
vi.mock("@pawket/config", () => ({ loadServerEnv: () => { throw new Error("UI must use the shared runtime"); } }));
vi.mock("@pawket/database", async (original) => ({ ...await original<object>(),
  createDatabase: () => { throw new Error("UI must use the shared database"); } }));
import { CurrentHelpPolicy } from "../src/ui/help/help-policy";

beforeEach(() => { readCurrentCommissionPolicy.mockReset(); });
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
  expect(markup.includes("Chính sách commission hiện chưa được công bố.")).toBe(true);
});
test("current help policy shows an unavailable state when the runtime read fails", async () => {
  readCurrentCommissionPolicy.mockRejectedValue(new Error("Synthetic read failure"));
  const markup = renderToStaticMarkup(await CurrentHelpPolicy());
  expect(readCurrentCommissionPolicy).toHaveBeenCalledOnce();
  expect(markup.includes("Chưa tải được chính sách. Vui lòng tải lại trang.")).toBe(true);
});
