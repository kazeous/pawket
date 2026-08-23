import { loadServerEnv } from "@pawket/config";
import { checkDatabaseReadiness } from "@pawket/database/readiness";
import { createQueueConnection } from "@pawket/queue/connection";

import {
  createReadinessProbe,
  createReadinessResponse,
} from "../../../../http/readiness";
import { withRouteContext } from "../../../../http/route-context";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, async () => {
    const environment = loadServerEnv();
    const probe = createReadinessProbe({
      checkDatabase: async () => {
        await checkDatabaseReadiness(environment.DATABASE_URL);
      },
      checkValkey: async () => {
        const connection = createQueueConnection(environment.VALKEY_URL);
        try {
          await connection.ping();
        } finally {
          connection.disconnect();
        }
      },
      revision: environment.APP_REVISION,
    });

    return createReadinessResponse(probe);
  });
}
