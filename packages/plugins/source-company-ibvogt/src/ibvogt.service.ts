import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ib vogt — Global developer of turnkey utility-scale solar PV and battery storage projects.
 *
 * ib vogt is a Berlin-based developer of utility-scale solar photovoltaic
 * and battery storage projects. It provides services spanning development,
 * financing, EPC, and operations and maintenance, with projects across
 * multiple international markets.
 *
 * Sector: Solar & Storage Development. HQ: Berlin, Berlin, Germany.
 *
 * Source: SmartRecruiters job board, company identifier `ib-vogt-GmbH`
 * (`https://jobs.smartrecruiters.com/ib-vogt-GmbH`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ib-vogt-GmbH';
const COMPANY_NAME = 'ib vogt';

@SourcePlugin({
  site: Site.IB_VOGT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class IbVogtService implements IScraper {
  private readonly logger = new Logger(IbVogtService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape ib vogt',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `ib vogt: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.IB_VOGT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'ibvogt-');
      }
    }

    this.logger.log(`ib vogt: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
