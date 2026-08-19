import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Miro — Visual collaboration and online whiteboard platform for distributed teams.
 *
 * Miro is a visual collaboration platform that provides an online whiteboard
 * for brainstorming, diagramming, workshops, and project planning. Teams use
 * it for real-time and asynchronous collaboration across distributed
 * workforces. It integrates with common productivity and developer tools.
 *
 * Sector: Productivity & collaboration software. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `miro`
 * (`https://jobs.ashbyhq.com/miro`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'miro';
const COMPANY_NAME = 'Miro';

@SourcePlugin({
  site: Site.MIRO,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class MiroService implements IScraper {
  private readonly logger = new Logger(MiroService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Miro',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Miro: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.MIRO;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'miro-');
      }
    }

    this.logger.log(`Miro: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
