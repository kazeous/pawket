import { and, asc, eq } from "drizzle-orm";

import type { PawketTransaction } from "./client.js";
import {
  systemBusinessCalendarHolidays,
  systemBusinessCalendarVersions,
} from "./schema.js";

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sourceLabelPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const configuredCalendarSourceLabel = "pawket-env:VN_BUSINESS_HOLIDAYS";
const configuredHolidayName = "Configured Vietnam public holiday";

export type BusinessCalendarHoliday = Readonly<{ date: string; name: string }>;

export type BusinessDayWindow = Readonly<{
  calendarVersion: string;
  receiptDate: string;
  refundNotBefore: string;
  refundDue: string;
}>;

export class BusinessCalendarError extends Error {
  constructor(message: "Business calendar is invalid" | "Business calendar version conflicts" | "Business calendar version was not found") {
    super(message);
    this.name = "BusinessCalendarError";
  }
}

function parseDateOnly(value: string): Date {
  if (!dateOnlyPattern.test(value)) throw new BusinessCalendarError("Business calendar is invalid");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BusinessCalendarError("Business calendar is invalid");
  }
  return parsed;
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function vietnamDateFromInstant(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new BusinessCalendarError("Business calendar is invalid");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function calculateBusinessDayWindow(input: {
  receiptDate: string;
  calendarVersion: string;
  holidays: Iterable<string>;
}): BusinessDayWindow {
  if (!versionPattern.test(input.calendarVersion)) {
    throw new BusinessCalendarError("Business calendar is invalid");
  }
  const receiptDate = parseDateOnly(input.receiptDate);
  const holidays = new Set([...input.holidays].map((holiday) => formatDateOnly(parseDateOnly(holiday))));
  let cursor = receiptDate;
  let businessDay = 0;
  let refundNotBefore = "";
  let refundDue = "";

  while (businessDay < 7) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const date = formatDateOnly(cursor);
    const weekday = cursor.getUTCDay();
    if (weekday === 0 || weekday === 6 || holidays.has(date)) continue;
    businessDay += 1;
    if (businessDay === 5) refundNotBefore = date;
    if (businessDay === 7) refundDue = date;
  }

  return {
    calendarVersion: input.calendarVersion,
    receiptDate: input.receiptDate,
    refundNotBefore,
    refundDue,
  };
}

function normalizeHolidays(holidays: ReadonlyArray<BusinessCalendarHoliday>): BusinessCalendarHoliday[] {
  const seen = new Set<string>();
  return holidays
    .map((holiday) => {
      const date = formatDateOnly(parseDateOnly(holiday.date));
      const name = holiday.name.trim();
      if (!name || [...name].length > 100 || seen.has(date)) {
        throw new BusinessCalendarError("Business calendar is invalid");
      }
      seen.add(date);
      return { date, name };
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

export async function importBusinessCalendarVersion(
  tx: PawketTransaction,
  input: {
    version: string;
    sourceLabel: string;
    publishedAt: Date;
    importedAt?: Date;
    holidays: ReadonlyArray<BusinessCalendarHoliday>;
  },
): Promise<"inserted" | "already_present"> {
  if (
    !versionPattern.test(input.version) ||
    !sourceLabelPattern.test(input.sourceLabel) ||
    Number.isNaN(input.publishedAt.getTime()) ||
    (input.importedAt !== undefined && Number.isNaN(input.importedAt.getTime()))
  ) {
    throw new BusinessCalendarError("Business calendar is invalid");
  }
  const holidays = normalizeHolidays(input.holidays);
  const importedAt = input.importedAt ?? new Date();
  if (importedAt < input.publishedAt) {
    throw new BusinessCalendarError("Business calendar is invalid");
  }
  const [inserted] = await tx
    .insert(systemBusinessCalendarVersions)
    .values({
      version: input.version,
      sourceLabel: input.sourceLabel,
      publishedAt: input.publishedAt,
      importedAt,
    })
    .onConflictDoNothing()
    .returning({ version: systemBusinessCalendarVersions.version });

  if (inserted) {
    if (holidays.length > 0) {
      await tx.insert(systemBusinessCalendarHolidays).values(
        holidays.map((holiday) => ({
          calendarVersion: input.version,
          holidayDate: holiday.date,
          name: holiday.name,
        })),
      );
    }
    return "inserted";
  }

  const [version] = await tx
    .select()
    .from(systemBusinessCalendarVersions)
    .where(eq(systemBusinessCalendarVersions.version, input.version))
    .limit(1);
  const storedHolidays = await tx
    .select({ date: systemBusinessCalendarHolidays.holidayDate, name: systemBusinessCalendarHolidays.name })
    .from(systemBusinessCalendarHolidays)
    .where(eq(systemBusinessCalendarHolidays.calendarVersion, input.version))
    .orderBy(asc(systemBusinessCalendarHolidays.holidayDate));
  if (
    !version ||
    version.sourceLabel !== input.sourceLabel ||
    version.publishedAt.getTime() !== input.publishedAt.getTime() ||
    JSON.stringify(storedHolidays) !== JSON.stringify(holidays)
  ) {
    throw new BusinessCalendarError("Business calendar version conflicts");
  }
  return "already_present";
}

export async function importConfiguredBusinessCalendarVersion(
  tx: PawketTransaction,
  input: {
    version: string;
    holidayDates: ReadonlyArray<string>;
    importedAt?: Date;
  },
): Promise<"inserted" | "already_present"> {
  if (input.holidayDates.length > 64) {
    throw new BusinessCalendarError("Business calendar is invalid");
  }

  const importedAt = input.importedAt ?? new Date();
  const [storedVersion] = await tx
    .select({ publishedAt: systemBusinessCalendarVersions.publishedAt })
    .from(systemBusinessCalendarVersions)
    .where(eq(systemBusinessCalendarVersions.version, input.version))
    .limit(1);
  const publishedAt = storedVersion?.publishedAt ?? importedAt;

  return importBusinessCalendarVersion(tx, {
    version: input.version,
    sourceLabel: configuredCalendarSourceLabel,
    publishedAt,
    importedAt: importedAt < publishedAt ? publishedAt : importedAt,
    holidays: input.holidayDates.map((date) => ({
      date,
      name: configuredHolidayName,
    })),
  });
}

export async function calculateStoredReceiptBusinessDayWindow(
  tx: PawketTransaction,
  input: { receiptDate: string; calendarVersion: string },
): Promise<BusinessDayWindow> {
  parseDateOnly(input.receiptDate);
  const [version] = await tx
    .select({ version: systemBusinessCalendarVersions.version })
    .from(systemBusinessCalendarVersions)
    .where(eq(systemBusinessCalendarVersions.version, input.calendarVersion))
    .limit(1);
  if (!version) throw new BusinessCalendarError("Business calendar version was not found");
  const holidays = await tx
    .select({ date: systemBusinessCalendarHolidays.holidayDate })
    .from(systemBusinessCalendarHolidays)
    .where(
      and(
        eq(systemBusinessCalendarHolidays.calendarVersion, input.calendarVersion),
      ),
    );
  return calculateBusinessDayWindow({
    receiptDate: input.receiptDate,
    calendarVersion: input.calendarVersion,
    holidays: holidays.map((holiday) => holiday.date),
  });
}
