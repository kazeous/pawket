import { loadServerEnv } from "@pawket/config";
import { checkDatabaseReadiness } from "@pawket/database/readiness";

import {
  createReadinessProbe,
  createReadinessResponse,
} from "../../../../http/readiness";
import { createValkeyReadinessCheck } from "../../../../http/readiness-checks";
import { withRouteContext } from "../../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, async () => {
    const environment = loadServerEnv();
    const probe = createReadinessProbe({
      checkDatabase: (signal) => checkDatabaseReadiness(environment.DATABASE_URL, signal),
      checkValkey: createValkeyReadinessCheck(environment.VALKEY_URL),
      revision: environment.APP_REVISION,
    });

    return createReadinessResponse(probe);
  });
}
