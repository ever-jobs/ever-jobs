import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Vattenfall — Swedish state-owned power company generating and supplying electricity and heat across Northern Europe.
 *
 * Vattenfall is a Swedish state-owned energy utility that generates,
 * distributes and supplies electricity and heat. Its portfolio spans wind,
 * hydro, nuclear, solar and heat, with operations across Sweden, Germany,
 * the Netherlands, the UK and other European markets.
 *
 * Sector: Energy Utility. HQ: Solna, Stockholm, Sweden.
 *
 * Source: SmartRecruiters job board, company identifier `Vattenfall`
 * (`https://jobs.smartrecruiters.com/Vattenfall`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Vattenfall';
const COMPANY_NAME = 'Vattenfall';

@SourcePlugin({
  site: Site.VATTENFALL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class VattenfallService implements IScraper {
  private readonly logger = new Logger(VattenfallService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Vattenfall',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Vattenfall: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.VATTENFALL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'vattenfall-');
      }
    }

    this.logger.log(`Vattenfall: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
