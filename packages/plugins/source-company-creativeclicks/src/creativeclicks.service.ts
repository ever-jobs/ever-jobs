import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Creative Clicks — Performance-marketing and mobile advertising company operating across digital acquisition channels.
 *
 * Creative Clicks is an Amsterdam-based performance-marketing and adtech
 * company working on digital customer-acquisition and mobile advertising.
 * The Recruitee board creativeclicks.recruitee.com returned 8 live offers,
 * mostly Amsterdam internships and freelance roles (AI product, digital
 * marketing, operations, UX/UI) plus a Toronto account-management position.
 *
 * Sector: Performance marketing / adtech (e-commerce adjacent). HQ: Amsterdam, Netherlands.
 *
 * Source: Recruitee careers board, subdomain `creativeclicks`
 * (`https://creativeclicks.recruitee.com`). The company's live postings
 * are served by Recruitee. Rather than re-implement Recruitee parsing (and
 * risk drift), this plugin resolves the registered Recruitee source plugin
 * from the `PluginRegistry` at runtime and delegates the fetch + field
 * mapping to it, then re-stamps the company identity (site, companyName, id
 * prefix) onto the results — so every Recruitee field fix is inherited
 * automatically. This honours the "no plugin imports a peer plugin directly;
 * discover via the registry" rule.
 */
const COMPANY_SLUG = 'creativeclicks';
const COMPANY_NAME = 'Creative Clicks';

@SourcePlugin({
  site: Site.CREATIVE_CLICKS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CreativeClicksService implements IScraper {
  private readonly logger = new Logger(CreativeClicksService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const recruitee = this.registry?.getScraper(Site.RECRUITEE);
    if (!recruitee) {
      this.logger.error(
        'Recruitee source plugin is not registered; cannot scrape Creative Clicks',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Recruitee source plugin is not registered'),
      );
    }

    this.logger.log(
      `Creative Clicks: delegating to Recruitee (slug ${COMPANY_SLUG})`,
    );

    const result = await recruitee.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CREATIVE_CLICKS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^recruitee-/, 'creativeclicks-');
      }
    }

    this.logger.log(`Creative Clicks: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
