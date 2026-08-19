import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * World Wildlife Fund — U.S. arm of the global environmental conservation non-profit.
 *
 * World Wildlife Fund, Inc. is the United States organization of the global
 * WWF network, a non-profit dedicated to nature and wildlife conservation.
 * It employs conservation scientists, policy specialists, communicators, and
 * operational staff to support environmental programs worldwide.
 *
 * Sector: Non-profit (environmental conservation). HQ: Washington, D.C., USA.
 *
 * Source: SmartRecruiters job board, company identifier `WorldWildlifeFundInc1`
 * (`https://jobs.smartrecruiters.com/WorldWildlifeFundInc1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'WorldWildlifeFundInc1';
const COMPANY_NAME = 'World Wildlife Fund';

@SourcePlugin({
  site: Site.WORLD_WILDLIFE_FUND,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class WorldWildlifeFundService implements IScraper {
  private readonly logger = new Logger(WorldWildlifeFundService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape World Wildlife Fund',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `World Wildlife Fund: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.WORLD_WILDLIFE_FUND;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'worldwildlifefund-');
      }
    }

    this.logger.log(`World Wildlife Fund: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
