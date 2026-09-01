import { DISCIPLINES, PublicCatalogQueryError, type Discipline } from "@pawket/catalog";
import { loadServerEnv } from "@pawket/config";
import { notFound } from "next/navigation";

import { getPlatformRuntime } from "../../platform/runtime";
import { AppShell } from "../../ui/app-shell";
import { CreatorDirectory } from "./creator-directory";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
function one(value: string | string[] | undefined): string | null { return typeof value === "string" ? value : value === undefined ? "" : null; }

export default async function CreatorsPage({ searchParams }: Readonly<{ searchParams: Promise<Search> }>) {
  if (loadServerEnv().CREATOR_PUBLISHING_MODE !== "general_audience") notFound();
  const raw = await searchParams;
  if (Object.keys(raw).some((key) => !["discipline", "handle", "cursor"].includes(key))) notFound();
  const discipline = one(raw.discipline); const handle = one(raw.handle); const cursor = one(raw.cursor);
  if (discipline === null || handle === null || cursor === null || (discipline && !(DISCIPLINES as readonly string[]).includes(discipline)) || (handle && !/^[a-z0-9-]{1,30}$/u.test(handle))) notFound();
  let directory;
  try { directory = await getPlatformRuntime().publicCatalog.listPublicCreators({ discipline: (discipline || null) as Discipline | null, handlePrefix: handle, cursor: cursor || null, limit: 24 }); }
  catch (error) { if (error instanceof PublicCatalogQueryError) notFound(); throw error; }

  return <AppShell context="Khám phá" action={{ href: "/sign-in", label: "Đăng nhập" }}>
    <header className="workspace-header reveal"><div><p className="eyebrow">Danh bạ công khai</p><h1>Khám phá nhà sáng tạo</h1><p className="lede">Tìm các trang đang xuất bản theo chuyên ngành hoặc tiền tố handle.</p></div></header>
    <form className="directory-filter work-surface" action="/creators" method="get"><label htmlFor="directory-discipline">Chuyên ngành</label><select id="directory-discipline" name="discipline" defaultValue={discipline}><option value="">Tất cả</option>{DISCIPLINES.map((item) => <option key={item} value={item}>{item}</option>)}</select><label htmlFor="directory-handle">Handle bắt đầu bằng</label><input id="directory-handle" name="handle" defaultValue={handle} pattern="[a-z0-9-]{0,30}" /><button>Tìm kiếm</button></form>
    <CreatorDirectory items={directory.items} nextCursor={directory.nextCursor} query={{ discipline, handle }} />
  </AppShell>;
}
