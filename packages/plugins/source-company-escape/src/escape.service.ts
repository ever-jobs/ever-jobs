import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Escape — API security and automated application security testing platform.
 *
 * Escape builds an API security platform that discovers APIs and
 * automatically tests applications for vulnerabilities. Its engineering
 * roles focus on building automated pentesting and security testing
 * capabilities.
 *
 * Sector: API Security. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `escape`
 * (`https://jobs.ashbyhq.com/escape`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'escape';
const COMPANY_NAME = 'Escape';

@SourcePlugin({
  site: Site.ESCAPE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EscapeService implements IScraper {
  private readonly logger = new Logger(EscapeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Escape',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Escape: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ESCAPE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'escape-');
      }
    }

    this.logger.log(`Escape: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
