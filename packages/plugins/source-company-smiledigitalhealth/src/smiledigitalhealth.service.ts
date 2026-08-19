import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Smile Digital Health — Health data platform and FHIR-based clinical data repository for healthcare interoperability.
 *
 * Smile Digital Health builds a health data fabric and clinical data
 * repository based on the HL7 FHIR standard, enabling data ingestion,
 * storage, and exchange for payers, providers, and life-sciences
 * organizations.
 *
 * Sector: Health Tech / Interoperability. HQ: Toronto, Ontario, Canada.
 *
 * Source: Lever job board, company slug `smiledigitalhealth`
 * (`https://jobs.lever.co/smiledigitalhealth`). The company's live
 * postings are served by Lever. Rather than re-implement Lever parsing (and
 * risk drift), this plugin resolves the registered Lever source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Lever field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'smiledigitalhealth';
const COMPANY_NAME = 'Smile Digital Health';

@SourcePlugin({
  site: Site.SMILE_DIGITAL_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SmileDigitalHealthService implements IScraper {
  private readonly logger = new Logger(SmileDigitalHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const lever = this.registry?.getScraper(Site.LEVER);
    if (!lever) {
      this.logger.error(
        'Lever source plugin is not registered; cannot scrape Smile Digital Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Lever source plugin is not registered'),
      );
    }

    this.logger.log(
      `Smile Digital Health: delegating to Lever (slug ${COMPANY_SLUG})`,
    );

    const result = await lever.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SMILE_DIGITAL_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^lever-/, 'smiledigitalhealth-');
      }
    }

    this.logger.log(`Smile Digital Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
