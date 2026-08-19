import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * The Bot Company — Develops household robots for consumers.
 *
 * The Bot Company is developing robotics technology aimed at building a
 * helpful robot for the home. The company operates a small on-site
 * engineering team drawn from technology and automotive backgrounds. It is
 * based in San Francisco, California.
 *
 * Sector: Robotics / Consumer hardware. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `thebotcompany`
 * (`https://jobs.ashbyhq.com/thebotcompany`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'thebotcompany';
const COMPANY_NAME = 'The Bot Company';

@SourcePlugin({
  site: Site.THE_BOT_COMPANY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TheBotCompanyService implements IScraper {
  private readonly logger = new Logger(TheBotCompanyService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape The Bot Company',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `The Bot Company: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.THE_BOT_COMPANY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'thebotcompany-');
      }
    }

    this.logger.log(`The Bot Company: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
