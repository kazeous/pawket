import { describe, expect, test } from "vitest";

import { UnsafeStructuredDataError } from "@pawket/security/structured-data";

import {
  metricsRegistry,
  recordCatalogOperation,
  recordContentReportOperation,
  recordCreatorDirectoryResolution,
  recordPublicMediaOperation,
  setPublicContentReportBacklogMetric,
  setPublicMediaProcessingBacklogMetric,
  setPublicMediaStorageAvailabilityMetric,
} from "../src/index.js";

const assetId = "3f1c9a2e-5b7d-4a11-9c3e-8d2f6b4a7c05";
const reportDetail = "The cover image on this page copies my own portfolio photograph.";
const creatorHandle = "sunlit-ceramics";

describe("Increment 3 bounded metrics", () => {
  test("Increment 3 metrics reject IDs and free text as labels", () => {
    // Catches an Increment 3 recorder that would turn an asset ID or reporter prose into label cardinality.
    expect(() =>
      recordPublicMediaOperation({ operation: assetId as never, outcome: "succeeded" }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordContentReportOperation({ operation: "submit", outcome: reportDetail as never }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordCatalogOperation({ operation: "publish", outcome: creatorHandle as never }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordCreatorDirectoryResolution({ source: creatorHandle as never, outcome: "succeeded" }),
    ).toThrow(UnsafeStructuredDataError);
  });

  test("rejects open-ended purpose, variant, reason, and source label values", () => {
    // Catches a closed label set silently accepting a new free-text dimension.
    expect(() =>
      recordPublicMediaOperation({
        operation: "delivery",
        outcome: "succeeded",
        purpose: "profile" as never,
      }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordPublicMediaOperation({
        operation: "delivery",
        outcome: "succeeded",
        variant: "original" as never,
      }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordContentReportOperation({
        operation: "hide",
        outcome: "succeeded",
        reason: "looks_wrong" as never,
      }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordCatalogOperation({ operation: "suspend" as never, outcome: "succeeded" }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordContentReportOperation({ operation: "reopen" as never, outcome: "succeeded" }),
    ).toThrow(UnsafeStructuredDataError);
  });

  test("rejects outcomes outside each family's closed vocabulary", () => {
    // Catches an outcome vocabulary drifting apart from the Increment 2 metric contract.
    expect(() =>
      recordCatalogOperation({ operation: "draft", outcome: "attention_required" }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordPublicMediaOperation({
        operation: "upload",
        outcome: "attention_required",
        purpose: "showcase",
      }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      recordCreatorDirectoryResolution({ source: "alias", outcome: "attention_required" }),
    ).toThrow(UnsafeStructuredDataError);
  });

  test("rejects unbounded backlog and storage gauge inputs", () => {
    // Catches a negative, non-finite, or unknown-area gauge write reaching Prometheus.
    expect(() => setPublicMediaProcessingBacklogMetric({ oldestPendingSeconds: -1 })).toThrow(
      UnsafeStructuredDataError,
    );
    expect(() =>
      setPublicMediaProcessingBacklogMetric({ oldestPendingSeconds: Number.NaN }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() => setPublicContentReportBacklogMetric({ oldestOpenSeconds: -1 })).toThrow(
      UnsafeStructuredDataError,
    );
    expect(() =>
      setPublicContentReportBacklogMetric({ oldestOpenSeconds: Number.POSITIVE_INFINITY }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      setPublicMediaStorageAvailabilityMetric({ area: "backup" as never, available: true }),
    ).toThrow(UnsafeStructuredDataError);
    expect(() =>
      setPublicMediaStorageAvailabilityMetric({
        area: "quarantine",
        available: "yes" as never,
      }),
    ).toThrow(UnsafeStructuredDataError);
  });

  test("exports only closed Increment 3 label combinations", async () => {
    recordCatalogOperation({ operation: "draft", outcome: "succeeded" });
    recordCatalogOperation({ operation: "publish", outcome: "rejected" });
    recordCatalogOperation({ operation: "unpublish", outcome: "succeeded" });
    recordCatalogOperation({ operation: "handle_claim", outcome: "rejected" });
    recordCatalogOperation({ operation: "handle_rename", outcome: "retryable_failure" });
    recordPublicMediaOperation({ operation: "upload", outcome: "succeeded", purpose: "avatar" });
    recordPublicMediaOperation({
      operation: "process",
      outcome: "attention_required",
      purpose: "showcase",
    });
    recordPublicMediaOperation({
      operation: "delivery",
      outcome: "succeeded",
      purpose: "cover",
      variant: "display",
    });
    recordCreatorDirectoryResolution({ source: "canonical", outcome: "succeeded" });
    recordCreatorDirectoryResolution({ source: "alias", outcome: "succeeded" });
    recordCreatorDirectoryResolution({ source: "unknown", outcome: "rejected" });
    recordContentReportOperation({
      operation: "submit",
      outcome: "succeeded",
      reason: "impersonation",
    });
    recordContentReportOperation({ operation: "challenge", outcome: "rejected" });
    recordContentReportOperation({ operation: "dismiss", outcome: "succeeded", reason: "spam_or_scam" });
    recordContentReportOperation({ operation: "hide", outcome: "succeeded", reason: "privacy" });
    recordContentReportOperation({ operation: "restore", outcome: "succeeded", reason: "privacy" });
    setPublicMediaProcessingBacklogMetric({ oldestPendingSeconds: 42 });
    setPublicContentReportBacklogMetric({ oldestOpenSeconds: 0 });
    setPublicMediaStorageAvailabilityMetric({ area: "quarantine", available: true });
    setPublicMediaStorageAvailabilityMetric({ area: "derivative", available: false });

    const exported = await metricsRegistry.metrics();

    expect(exported).toContain('pawket_catalog_operations_total{operation="draft",outcome="succeeded"} 1');
    expect(exported).toContain('pawket_catalog_operations_total{operation="handle_rename",outcome="retryable_failure"} 1');
    expect(exported).toContain(
      'pawket_public_media_operations_total{operation="process",outcome="attention_required",purpose="showcase",variant="none"} 1',
    );
    expect(exported).toContain(
      'pawket_public_media_operations_total{operation="delivery",outcome="succeeded",purpose="cover",variant="display"} 1',
    );
    expect(exported).toContain(
      'pawket_creator_directory_resolutions_total{source="alias",outcome="succeeded"} 1',
    );
    expect(exported).toContain(
      'pawket_public_content_report_operations_total{operation="submit",outcome="succeeded",reason="impersonation"} 1',
    );
    expect(exported).toContain(
      'pawket_public_content_report_operations_total{operation="challenge",outcome="rejected",reason="none"} 1',
    );
    expect(exported).toContain("pawket_public_media_oldest_pending_seconds 42");
    expect(exported).toContain("pawket_public_content_report_oldest_open_seconds 0");
    expect(exported).toContain('pawket_public_media_storage_available{area="quarantine"} 1');
    expect(exported).toContain('pawket_public_media_storage_available{area="derivative"} 0');
    expect(exported).not.toContain(assetId);
    expect(exported).not.toContain(creatorHandle);
    expect(exported).not.toMatch(/copies my own portfolio/u);
  });
});
