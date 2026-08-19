import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Oxfam America — U.S. affiliate of the global Oxfam confederation working on poverty, inequality, and humanitarian response.
 *
 * Oxfam America is the United States member of the international Oxfam
 * confederation, a non-profit focused on fighting poverty and inequality
 * through humanitarian response, development programs, and advocacy. It
 * hires program, advocacy, and operational staff, including consultant
 * roles.
 *
 * Sector: Non-profit (international development / humanitarian). HQ: Boston, Massachusetts, USA.
 *
 * Source: SmartRecruiters job board, company identifier `oxfamamerica2`
 * (`https://jobs.smartrecruiters.com/oxfamamerica2`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'oxfamamerica2';
const COMPANY_NAME = 'Oxfam America';

@SourcePlugin({
  site: Site.OXFAM_AMERICA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class OxfamAmericaService implements IScraper {
  private readonly logger = new Logger(OxfamAmericaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Oxfam America',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Oxfam America: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.OXFAM_AMERICA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'oxfamamerica-');
      }
    }

    this.logger.log(`Oxfam America: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
