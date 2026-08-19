import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * AbbVie — Global research-based biopharmaceutical company developing medicines in immunology, oncology, neuroscience, and eye care.
 *
 * AbbVie is a global biopharmaceutical company that discovers, develops, and
 * commercializes medicines across therapeutic areas including immunology,
 * oncology, neuroscience, and aesthetics. It was formed in 2013 as a
 * spin-off from Abbott Laboratories. The company is headquartered in North
 * Chicago, Illinois.
 *
 * Sector: Pharmaceuticals. HQ: North Chicago, Illinois, USA.
 *
 * Source: SmartRecruiters job board, company identifier `AbbVie`
 * (`https://jobs.smartrecruiters.com/AbbVie`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'AbbVie';
const COMPANY_NAME = 'AbbVie';

@SourcePlugin({
  site: Site.ABBVIE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AbbVieService implements IScraper {
  private readonly logger = new Logger(AbbVieService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape AbbVie',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `AbbVie: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ABBVIE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'abbvie-');
      }
    }

    this.logger.log(`AbbVie: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
