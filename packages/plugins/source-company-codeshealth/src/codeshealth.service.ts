import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Codes Health — Builds technology products for healthcare delivery and operations.
 *
 * Codes Health is a healthcare technology company building software products
 * for healthcare delivery and operations. It hires across engineering and
 * product functions. The company posts roles including software engineering.
 *
 * Sector: Healthtech. HQ: United States.
 *
 * Source: Ashby job board, company slug `codes-health`
 * (`https://jobs.ashbyhq.com/codes-health`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'codes-health';
const COMPANY_NAME = 'Codes Health';

@SourcePlugin({
  site: Site.CODES_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CodesHealthService implements IScraper {
  private readonly logger = new Logger(CodesHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Codes Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Codes Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CODES_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'codeshealth-');
      }
    }

    this.logger.log(`Codes Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
