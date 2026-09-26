import 'reflect-metadata';
import { IPluginMetadata, SOURCE_PLUGIN_METADATA } from '@ever-jobs/plugin';
import { GlassdoorService } from '@ever-jobs/source-glassdoor';
import { LinkedInService } from '@ever-jobs/source-linkedin';
import { NaukriService } from '@ever-jobs/source-naukri';
import { WellfoundService } from '@ever-jobs/source-wellfound';
import { ZipRecruiterService } from '@ever-jobs/source-ziprecruiter';
import { locationPauseMs } from '../jobs.service';

/**
 * Spec 1700 — boards that pace their own requests declare that gap, so a
 * multi-location search never calls them sooner than their own pacer would
 * (the first request of a scrape is unpaced inside the plugin).
 */
describe('plugin request gaps (Spec 1700)', () => {
  it.each([
    ['LinkedIn', LinkedInService, 3000],
    ['Wellfound', WellfoundService, 3000],
    ['Naukri', NaukriService, 3000],
    ['Glassdoor', GlassdoorService, 5000],
    ['ZipRecruiter', ZipRecruiterService, 5000],
  ])('%s declares a %sms gap, and a multi-location search waits at least that long', (_name, cls, gap) => {
    const meta = Reflect.getMetadata(SOURCE_PLUGIN_METADATA, cls) as IPluginMetadata;
    expect(meta.minRequestIntervalMs).toBe(gap);
    // The default operator interval (500 ms) is raised to the plugin's gap.
    expect(locationPauseMs(500, meta.minRequestIntervalMs)).toBe(gap);
  });
});
