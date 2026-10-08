// Browser-only synthetic panels. No product route and no private content snapshots.
import { createRoot } from "react-dom/client";
import { CommissionSession } from "../src/ui/commissions/commission-session";
import { CommissionDetail } from "../src/ui/commissions/commission-detail";
import { OrderResolutionPanel } from "../src/ui/resolutions/order-resolution-panel";
import { actorId, fixtureOrder, fixtureResolution } from "./resolution-fixture-data";
function Fixture() {
  const surface = new URLSearchParams(window.location.search).get("surface") ?? "buyer";
  const initial = fixtureResolution(surface); const order = { ...fixtureOrder, role: initial.resolution.role };
  return <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4"><h1>Commission</h1><CommissionSession actorUserId={actorId}>
    {surface === "closed" ? <CommissionDetail initial={{ controls: { intakeMode: "enabled", paymentsMode: "manual_only", fulfillmentMode: "enabled" }, order: { ...order, state: "closed", closeReason: "cancelled_by_agreement" } }} initialResolution={initial} />
      : <OrderResolutionPanel order={order} initial={initial} onRefresh={async () => undefined} />}
  </CommissionSession></main>;
}
if (typeof document !== "undefined" && document.getElementById("fixture")) createRoot(document.getElementById("fixture")!).render(<Fixture />);
