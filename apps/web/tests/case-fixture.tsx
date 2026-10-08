import { createRoot } from "react-dom/client";
import { CaseQueue } from "../src/ui/cases/case-queue";
import { CaseDetail } from "../src/ui/cases/case-detail";
import { caseFixture, caseId, ownerId, queueFixture } from "./case-fixture-data";
import type { CaseDetailView } from "../src/ui/cases/case-client";
function Fixture() {
  const surface = new URLSearchParams(window.location.search).get("surface");
  const detail: CaseDetailView = { ...caseFixture, ...(surface === "delivered" ? { orderState: "delivered" as const } : {}),
    ...(surface === "refund_not_received" || surface === "refund_overdue" ? { kind: surface, sourceType: "commission_refund_obligation" } : {}) };
  return <main className="page-shell stack"><h1>Khiếu nại &amp; hoàn tiền</h1>{surface === "queue" ? <CaseQueue initialCases={[queueFixture]} /> : <CaseDetail initial={detail} caseId={caseId} actorUserId={ownerId} />}</main>;
}
if (typeof document !== "undefined" && document.getElementById("fixture")) createRoot(document.getElementById("fixture")!).render(<Fixture />);
