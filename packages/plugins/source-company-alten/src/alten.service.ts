import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * ALTEN — Engineering and technology consultancy serving automotive, aerospace, energy, and industrial sectors.
 *
 * ALTEN is a France-headquartered engineering and technology consulting
 * group. It delivers R&D and IT engineering services to clients in the
 * automotive, aerospace, energy, rail, and industrial equipment sectors.
 *
 * Sector: Engineering & technology consulting. HQ: Boulogne-Billancourt, France.
 *
 * Source: SmartRecruiters job board, company identifier `ALTEN`
 * (`https://jobs.smartrecruiters.com/ALTEN`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ALTEN';
const COMPANY_NAME = 'ALTEN';

@SourcePlugin({
  site: Site.ALTEN,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ALTENService implements IScraper {
  private readonly logger = new Logger(ALTENService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape ALTEN',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `ALTEN: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ALTEN;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'alten-');
      }
    }

    this.logger.log(`ALTEN: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
