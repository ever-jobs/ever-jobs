import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Lotus Health — Combines medical records, AI, and physicians to provide personalized health guidance.
 *
 * Lotus Health provides a service that combines a user's medical records
 * with AI and real physicians to deliver personalized healthcare guidance.
 * It aims to make personalized health support broadly accessible. The
 * company hires across engineering and clinical functions.
 *
 * Sector: Healthtech (healthcare AI). HQ: United States.
 *
 * Source: Ashby job board, company slug `lotushealth`
 * (`https://jobs.ashbyhq.com/lotushealth`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'lotushealth';
const COMPANY_NAME = 'Lotus Health';

@SourcePlugin({
  site: Site.LOTUS_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class LotusHealthService implements IScraper {
  private readonly logger = new Logger(LotusHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Lotus Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Lotus Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.LOTUS_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'lotushealth-');
      }
    }

    this.logger.log(`Lotus Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
