import { z } from "zod";
import type { MarkReadTarget } from "@pawket/notifications";
import { tipRequest, TipRequestError } from "../tips/tip-client";

// Keep client projections small and reject navigation outside the notice link allowlist.
const uuid = "[0-9a-fA-F-]{36}";
const link = new RegExp(`^/(?:commissions/${uuid}|creator/commissions/${uuid}|admin/cases/${uuid}|help/cases|creator/tips|creator/apply|creator)$`, "u");
const itemSchema = z.object({ id: z.uuid(), kind: z.string(), variant: z.string().nullable(), title: z.string().max(200), body: z.string().max(1000),
  actionLabel: z.string().max(200), actionRequired: z.boolean(), linkPath: z.string().regex(link), count: z.number().int().positive(),
  createdAt: z.iso.datetime(), read: z.boolean() });
export const inboxSchema = z.object({ items: z.array(itemSchema).max(30), nextCursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u).nullable() });
export const summarySchema = z.object({ unread: z.number().int().min(0).max(99) });
export type InboxPage = Readonly<{ items: readonly z.infer<typeof itemSchema>[]; nextCursor: string | null }>;

export async function readNotificationPage(cursor: string): Promise<InboxPage> {
  return inboxSchema.parse(await tipRequest(`/api/v1/notifications?cursor=${encodeURIComponent(cursor)}`, {}, 131_072));
}

export async function writeNotification(path: string, method: "POST" | "PUT", body: unknown): Promise<void> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    if (response.status !== 204) throw new TipRequestError("dependency_unavailable");
  } finally { clearTimeout(timer); }
}
export const markNotificationRead = (target: MarkReadTarget) => writeNotification("/api/v1/notifications/read", "POST", target);
