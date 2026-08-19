import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Standard Bots — Builds AI-powered six-axis robotic arms for industrial automation.
 *
 * Standard Bots is a robotics company building AI-powered six-axis robot
 * arms with a vertically integrated approach intended to make industrial
 * automation more accessible. Its RO1 robot arm targets manufacturing and
 * automation tasks. The company is based in New York.
 *
 * Sector: Industrial automation / Robotics. HQ: Glen Cove, New York, USA.
 *
 * Source: Ashby job board, company slug `standardbots`
 * (`https://jobs.ashbyhq.com/standardbots`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'standardbots';
const COMPANY_NAME = 'Standard Bots';

@SourcePlugin({
  site: Site.STANDARD_BOTS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StandardBotsService implements IScraper {
  private readonly logger = new Logger(StandardBotsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Standard Bots',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Standard Bots: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STANDARD_BOTS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'standardbots-');
      }
    }

    this.logger.log(`Standard Bots: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
