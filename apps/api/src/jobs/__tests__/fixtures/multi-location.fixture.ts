import { JobPostDto, LocationDto } from '@ever-jobs/models';

/**
 * Spec 1700 — synthetic postings for the multi-location fan-out tests.
 *
 * Shaped on what a public job API with a server-side location filter returns
 * for two cities: the two result sets are mostly distinct, but a posting that
 * lists several locations ("Flexible / Remote | New York, NY", or seven cities)
 * comes back for both. Company and titles are placeholders.
 */

export const NEW_YORK = 'New York, NY';
export const CHICAGO = 'Chicago, IL';
export const AUSTIN = 'Austin, TX';

/** The id both cities return. */
export const OVERLAP_ID = 'themuse-20693577';

function posting(id: string, title: string, locationText: string): JobPostDto {
  return new JobPostDto({
    id,
    title,
    companyName: 'Acme',
    jobUrl: `https://jobs.example.com/acme/${id.replace('themuse-', '')}`,
    location: new LocationDto({ city: locationText.split('|')[0].split(',')[0].trim() }),
  });
}

/** Fresh objects on every call: the service tags and mutates what a scraper returns. */
export function newYorkJobs(): JobPostDto[] {
  return [
    posting('themuse-22123640', 'Engineer I', 'New York, NY'),
    posting('themuse-22171941', 'Engineer II', 'New York, NY|San Francisco, CA'),
    posting(OVERLAP_ID, 'Engineer III', 'Flexible / Remote|New York, NY'),
  ];
}

export function chicagoJobs(): JobPostDto[] {
  return [
    posting('themuse-18122235', 'Engineer I', 'Chicago, IL'),
    posting('themuse-22139544', 'Engineer II', 'Chicago, IL'),
    posting(OVERLAP_ID, 'Engineer III', 'Flexible / Remote|New York, NY'),
  ];
}
