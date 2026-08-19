import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Common Room — AI-native customer intelligence and go-to-market platform.
 *
 * Common Room is a customer-intelligence platform that unifies first-party
 * customer data with buyer signals from sources such as social media,
 * communities, and product usage into a person-level view for go-to-market
 * teams. It includes AI agents for research, enrichment, and outbound. The
 * company was founded in 2020 and is headquartered in Seattle.
 *
 * Sector: B2B SaaS / go-to-market software. HQ: Seattle, Washington, USA.
 *
 * Source: Ashby job board, company slug `commonroom`
 * (`https://jobs.ashbyhq.com/commonroom`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'commonroom';
const COMPANY_NAME = 'Common Room';

@SourcePlugin({
  site: Site.COMMON_ROOM,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class CommonRoomService implements IScraper {
  private readonly logger = new Logger(CommonRoomService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Common Room',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Common Room: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.COMMON_ROOM;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'commonroom-');
      }
    }

    this.logger.log(`Common Room: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
