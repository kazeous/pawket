import { loadServerEnv, resolveRevisionAttestation } from "@pawket/config";
import { checkDatabaseReadiness } from "@pawket/database/readiness";
import { createS3ObjectStorage } from "@pawket/public-media";

import {
  createReadinessProbe,
  createReadinessResponse,
} from "../../../../http/readiness";
import {
  createObjectStorageReadinessCheck,
  createValkeyReadinessCheck,
} from "../../../../http/readiness-checks";
import { withRouteContext } from "../../../../http/route-context";

export const runtime = "nodejs";

type PublicMediaStorageReadinessCheck = ReturnType<
  typeof createObjectStorageReadinessCheck
>;

let publicMediaStorageReadinessCheck:
  | PublicMediaStorageReadinessCheck
  | null
  | undefined;

function storageReadinessCheck(
  environment: ReturnType<typeof loadServerEnv>,
): PublicMediaStorageReadinessCheck | undefined {
  if (publicMediaStorageReadinessCheck !== undefined) {
    return publicMediaStorageReadinessCheck ?? undefined;
  }

  if (
    !environment.PUBLIC_MEDIA_S3_ENDPOINT ||
    !environment.PUBLIC_MEDIA_S3_REGION ||
    !environment.PUBLIC_MEDIA_S3_ACCESS_KEY_ID ||
    !environment.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY ||
    !environment.PUBLIC_MEDIA_QUARANTINE_BUCKET ||
    !environment.PUBLIC_MEDIA_DERIVATIVE_BUCKET
  ) {
    publicMediaStorageReadinessCheck = null;
    return undefined;
  }

  publicMediaStorageReadinessCheck = createObjectStorageReadinessCheck(
    createS3ObjectStorage({
      endpoint: environment.PUBLIC_MEDIA_S3_ENDPOINT,
      region: environment.PUBLIC_MEDIA_S3_REGION,
      accessKeyId: environment.PUBLIC_MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: environment.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY,
      quarantineBucket: environment.PUBLIC_MEDIA_QUARANTINE_BUCKET,
      derivativeBucket: environment.PUBLIC_MEDIA_DERIVATIVE_BUCKET,
      forcePathStyle: environment.PUBLIC_MEDIA_S3_FORCE_PATH_STYLE,
    }),
  );
  return publicMediaStorageReadinessCheck;
}

export function GET(request: Request): Promise<Response> {
  return withRouteContext(request, async () => {
    const environment = loadServerEnv();
    const checkPublicMediaStorage = storageReadinessCheck(environment);
    const probe = createReadinessProbe({
      checkDatabase: (signal) => checkDatabaseReadiness(environment.DATABASE_URL, signal),
      checkValkey: createValkeyReadinessCheck(environment.VALKEY_URL),
      publishingMode: environment.CREATOR_PUBLISHING_MODE,
      ...(checkPublicMediaStorage === undefined ? {} : { checkPublicMediaStorage }),
      revision: resolveRevisionAttestation(
        environment.APP_REVISION,
        environment.APP_BUILD_REVISION,
      ),
    });

    return createReadinessResponse(probe);
  });
}
