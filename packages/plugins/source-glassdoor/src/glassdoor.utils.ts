import { CompensationDto, CompensationInterval, LocationDto, JobType, getJobTypeFromString } from '@ever-jobs/models';
import { parseLocationText } from '@ever-jobs/common';

/**
 * Parse compensation from Glassdoor payPeriodAdjustedPay data.
 */
export function parseCompensation(header: any): CompensationDto | null {
  const pay = header.payPeriodAdjustedPay;
  if (!pay || (!pay.p10 && !pay.p50 && !pay.p90)) return null;

  const payPeriod = (header.payPeriod ?? '').toUpperCase();
  let interval = CompensationInterval.YEARLY;
  if (payPeriod === 'HOURLY' || payPeriod === 'HOUR') interval = CompensationInterval.HOURLY;
  else if (payPeriod === 'MONTHLY' || payPeriod === 'MONTH') interval = CompensationInterval.MONTHLY;
  else if (payPeriod === 'WEEKLY' || payPeriod === 'WEEK') interval = CompensationInterval.WEEKLY;

  return new CompensationDto({
    minAmount: pay.p10 ?? null,
    maxAmount: pay.p90 ?? null,
    currency: header.payCurrency ?? 'USD',
    interval,
  });
}

/**
 * Get the correct cursor for a given page number from pagination data.
 */
export function getCursorForPage(paginationCursors: { cursor: string; pageNumber: number }[], page: number): string | null {
  const entry = paginationCursors.find((c) => c.pageNumber === page);
  return entry?.cursor ?? null;
}

/**
 * Parse location from Glassdoor header data.
 */
export function parseLocation(header: any): LocationDto {
  const locationName = header.locationName ?? '';
  return parseLocationText(locationName).location ?? new LocationDto({});
}

/**
 * Map Glassdoor job type value to JobType enum.
 */
export function getJobTypeEnum(value: string): JobType | null {
  const map: Record<string, JobType> = {
    fulltime: JobType.FULL_TIME,
    parttime: JobType.PART_TIME,
    contract: JobType.CONTRACT,
    internship: JobType.INTERNSHIP,
    temporary: JobType.TEMPORARY,
  };
  return map[value.toLowerCase()] ?? getJobTypeFromString(value);
}
