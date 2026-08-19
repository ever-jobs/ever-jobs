import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Talan — French consulting group focused on technology, data and business transformation.
 *
 * Talan is a France-headquartered international consulting group
 * specialising in technology, data, AI and business transformation. It
 * delivers advisory and implementation services to enterprise clients across
 * Europe, the UK and other regions.
 *
 * Sector: Technology & management consulting. HQ: Paris, France.
 *
 * Source: SmartRecruiters job board, company identifier `Talan`
 * (`https://jobs.smartrecruiters.com/Talan`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Talan';
const COMPANY_NAME = 'Talan';

@SourcePlugin({
  site: Site.TALAN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TalanService implements IScraper {
  private readonly logger = new Logger(TalanService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Talan',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Talan: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TALAN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'talan-');
      }
    }

    this.logger.log(`Talan: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
