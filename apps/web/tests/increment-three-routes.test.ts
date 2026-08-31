import { beforeEach, describe, expect, test, vi } from "vitest";

import { boundedRoute } from "../src/http/route-context.js";

const platform = vi.hoisted(() => ({
  catalogHandlers: {
    workspace: vi.fn(async () => Response.json({ route: "workspace" })),
    saveDraft: vi.fn(async () => Response.json({ route: "saveDraft" })),
    handle: vi.fn(async () => Response.json({ route: "handle" })),
    showcases: vi.fn(async () => Response.json({ route: "showcases" })),
    publish: vi.fn(async () => Response.json({ route: "publish" })),
    unpublish: vi.fn(async () => Response.json({ route: "unpublish" })),
  },
  mediaCommandHandlers: {
    createUpload: vi.fn(async () => Response.json({ route: "createUpload" })),
    completeUpload: vi.fn(async (_request: Request, intentId: string) => Response.json({ intentId })),
  },
  mediaHandlers: {
    deliver: vi.fn(async (_request: Request, assetId: string, variant: string) => Response.json({ assetId, variant })),
  },
  trustHandlers: {
    challenge: vi.fn(async () => Response.json({ route: "challenge" })),
    submitReport: vi.fn(async () => Response.json({ route: "submitReport" })),
    queue: vi.fn(async () => Response.json({ route: "queue" })),
    triage: vi.fn(async (_request: Request, reportId: string) => Response.json({ reportId })),
  },
}));

vi.mock("../src/platform/runtime", () => ({ getPlatformRuntime: () => platform }));

describe("Increment 3 route inventory", () => {
  beforeEach(() => vi.clearAllMocks());

  test.each([
    ["/api/v1/creator-page", "/api/v1/creator-page"],
    ["/api/v1/creator-page/handle", "/api/v1/creator-page/handle"],
    ["/api/v1/creator-page/showcases", "/api/v1/creator-page/showcases"],
    ["/api/v1/creator-page/publish", "/api/v1/creator-page/publish"],
    ["/api/v1/creator-page/unpublish", "/api/v1/creator-page/unpublish"],
    ["/api/v1/creator-page/media/uploads", "/api/v1/creator-page/media/uploads"],
    ["/api/v1/creator-page/media/uploads/30000000-0000-4000-8000-000000000003/complete", "/api/v1/creator-page/media/uploads/[intentId]/complete"],
    ["/api/v1/content-reports", "/api/v1/content-reports"],
    ["/api/v1/content-reports/challenge", "/api/v1/content-reports/challenge"],
    ["/api/v1/admin/content-reports", "/api/v1/admin/content-reports"],
    ["/api/v1/admin/content-reports/40000000-0000-4000-8000-000000000004", "/api/v1/admin/content-reports/[reportId]"],
    ["/media/00000000-0000-4000-8000-000000000000/thumb", "/media/[assetId]/[variant]"],
  ])("maps %s to the closed metric label %s", (path, label) => {
    // Catches a new route becoming an unbounded or unmatched metric label.
    expect(boundedRoute(path)).toBe(label);
  });

  test("creator-page GET and POST delegate through the shared platform runtime", async () => {
    // Catches the compatibility runtime or the verb-to-handler mapping diverging.
    const route = await import("../src/app/api/v1/creator-page/route.js");
    const get = await route.GET(new Request("https://pawket.example/api/v1/creator-page"));
    const post = await route.POST(new Request("https://pawket.example/api/v1/creator-page", { method: "POST" }));

    expect(route.runtime).toBe("nodejs");
    expect(await get.json()).toEqual({ route: "workspace" });
    expect(await post.json()).toEqual({ route: "saveDraft" });
  });

  test.each([
    ["handle", "../src/app/api/v1/creator-page/handle/route.js", "handle"],
    ["showcases", "../src/app/api/v1/creator-page/showcases/route.js", "showcases"],
    ["publish", "../src/app/api/v1/creator-page/publish/route.js", "publish"],
    ["unpublish", "../src/app/api/v1/creator-page/unpublish/route.js", "unpublish"],
    ["upload", "../src/app/api/v1/creator-page/media/uploads/route.js", "createUpload"],
    ["report", "../src/app/api/v1/content-reports/route.js", "submitReport"],
  ])("the %s POST route delegates to the bounded platform handler", async (_name, modulePath, expectedRoute) => {
    // Catches a static route mapping to the wrong domain handler.
    const route = await import(modulePath);
    const response = await route.POST(new Request(`https://pawket.example/${expectedRoute}`, { method: "POST" }));

    expect(route.runtime).toBe("nodejs");
    expect(await response.json()).toEqual({ route: expectedRoute });
  });

  test.each([
    ["challenge", "../src/app/api/v1/content-reports/challenge/route.js"],
    ["queue", "../src/app/api/v1/admin/content-reports/route.js"],
  ])("the %s GET route delegates to the bounded platform handler", async (expectedRoute, modulePath) => {
    // Catches a public/owner GET route mapping to the wrong trust boundary.
    const route = await import(modulePath);
    const response = await route.GET(new Request(`https://pawket.example/${expectedRoute}`));

    expect(route.runtime).toBe("nodejs");
    expect(await response.json()).toEqual({ route: expectedRoute });
  });

  test("dynamic upload, triage, and media routes await and forward exact params", async () => {
    // Catches dynamic routes dropping route-owned identifiers or bypassing the platform runtime.
    const completion = await import("../src/app/api/v1/creator-page/media/uploads/[intentId]/complete/route.js");
    const triage = await import("../src/app/api/v1/admin/content-reports/[reportId]/route.js");
    const media = await import("../src/app/media/[assetId]/[variant]/route.js");
    const intentId = "30000000-0000-4000-8000-000000000003";
    const reportId = "40000000-0000-4000-8000-000000000004";
    const assetId = "50000000-0000-4000-8000-000000000005";

    const completeResponse = await completion.POST(new Request(`https://pawket.example/complete`, { method: "POST" }), { params: Promise.resolve({ intentId }) });
    const triageResponse = await triage.POST(new Request(`https://pawket.example/triage`, { method: "POST" }), { params: Promise.resolve({ reportId }) });
    const getResponse = await media.GET(new Request(`https://pawket.example/media`), { params: Promise.resolve({ assetId, variant: "thumb" }) });
    const headResponse = await media.HEAD(new Request(`https://pawket.example/media`, { method: "HEAD" }), { params: Promise.resolve({ assetId, variant: "display" }) });

    expect(await completeResponse.json()).toEqual({ intentId });
    expect(await triageResponse.json()).toEqual({ reportId });
    expect(await getResponse.json()).toEqual({ assetId, variant: "thumb" });
    expect(await headResponse.json()).toEqual({ assetId, variant: "display" });
  });
});
