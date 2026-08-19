import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Blossom Health — Partners with psychiatrists to expand access to affordable mental health care.
 *
 * Blossom Health is a mental health company that partners with psychiatrists
 * to expand access to affordable, timely psychiatric care. It provides
 * technology and operational support for clinical delivery. The company
 * hires across clinical and operational roles.
 *
 * Sector: Healthtech (mental health). HQ: United States.
 *
 * Source: Ashby job board, company slug `blossom-health`
 * (`https://jobs.ashbyhq.com/blossom-health`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'blossom-health';
const COMPANY_NAME = 'Blossom Health';

@SourcePlugin({
  site: Site.BLOSSOM_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class BlossomHealthService implements IScraper {
  private readonly logger = new Logger(BlossomHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Blossom Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Blossom Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.BLOSSOM_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'blossomhealth-');
      }
    }

    this.logger.log(`Blossom Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
