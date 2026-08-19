import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Allegis Global Solutions — Workforce solutions provider delivering RPO and managed services programs.
 *
 * Allegis Global Solutions is a workforce solutions provider offering
 * recruitment process outsourcing (RPO), managed service programs (MSP) and
 * workforce advisory services. It is part of Allegis Group and operates
 * globally.
 *
 * Sector: Workforce solutions / RPO and MSP. HQ: Hanover, Maryland, United States.
 *
 * Source: SmartRecruiters job board, company identifier `AllegisGlobalSolutions`
 * (`https://jobs.smartrecruiters.com/AllegisGlobalSolutions`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AllegisGlobalSolutions';
const COMPANY_NAME = 'Allegis Global Solutions';

@SourcePlugin({
  site: Site.ALLEGIS_GLOBAL_SOLUTIONS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AllegisGlobalSolutionsService implements IScraper {
  private readonly logger = new Logger(AllegisGlobalSolutionsService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Allegis Global Solutions',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Allegis Global Solutions: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ALLEGIS_GLOBAL_SOLUTIONS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'allegisglobalsolutions-');
      }
    }

    this.logger.log(`Allegis Global Solutions: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
