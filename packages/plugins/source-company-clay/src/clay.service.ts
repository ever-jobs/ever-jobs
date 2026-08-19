import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Clay — Data enrichment and go-to-market automation platform for sales teams.
 *
 * Clay is a go-to-market platform that aggregates data from many providers
 * to enrich records and automate outbound and prospecting workflows. It
 * combines data enrichment with AI-assisted research and messaging. The
 * company is headquartered in New York.
 *
 * Sector: B2B SaaS / go-to-market software. HQ: New York, New York, USA.
 *
 * Source: Ashby job board, company slug `claylabs`
 * (`https://jobs.ashbyhq.com/claylabs`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'claylabs';
const COMPANY_NAME = 'Clay';

@SourcePlugin({
  site: Site.CLAY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ClayService implements IScraper {
  private readonly logger = new Logger(ClayService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Clay',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Clay: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CLAY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'clay-');
      }
    }

    this.logger.log(`Clay: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
