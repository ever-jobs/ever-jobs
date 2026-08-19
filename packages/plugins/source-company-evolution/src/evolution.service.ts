import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Evolution — B2B developer and provider of live online casino games.
 *
 * Evolution is a Swedish company that develops, produces and licenses live
 * casino and online gaming products for the B2B online casino industry. It
 * operates broadcasting studios in many countries and hires game presenters,
 * studio staff, engineering and corporate roles.
 *
 * Sector: Gaming (Live Casino). HQ: Stockholm, Sweden.
 *
 * Source: SmartRecruiters job board, company identifier `Evolution`
 * (`https://jobs.smartrecruiters.com/Evolution`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Evolution';
const COMPANY_NAME = 'Evolution';

@SourcePlugin({
  site: Site.EVOLUTION,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class EvolutionService implements IScraper {
  private readonly logger = new Logger(EvolutionService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Evolution',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Evolution: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.EVOLUTION;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'evolution-');
      }
    }

    this.logger.log(`Evolution: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
