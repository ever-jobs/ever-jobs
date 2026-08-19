import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SPAN — Makes a smart electrical panel that helps homes manage energy, solar, batteries, and EV charging.
 *
 * SPAN designs and builds a smart home electrical panel and related products
 * that give homeowners visibility and control over their electricity use.
 * Its products integrate with solar, battery storage, and EV charging to
 * support home electrification. The company focuses on reducing carbon
 * emissions from the built environment.
 *
 * Sector: Home electrification / grid. HQ: San Francisco, California, USA.
 *
 * Source: Ashby job board, company slug `span`
 * (`https://jobs.ashbyhq.com/span`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'span';
const COMPANY_NAME = 'SPAN';

@SourcePlugin({
  site: Site.SPAN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SPANService implements IScraper {
  private readonly logger = new Logger(SPANService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape SPAN',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `SPAN: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SPAN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'span-');
      }
    }

    this.logger.log(`SPAN: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
