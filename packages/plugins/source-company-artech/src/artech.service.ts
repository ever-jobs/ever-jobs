import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Artech — IT staffing and workforce solutions firm serving enterprise clients.
 *
 * Artech is an information technology staffing and workforce solutions
 * company offering staff augmentation, direct hire, payrolling and
 * recruitment process outsourcing. It provides technology talent to
 * enterprise and government clients.
 *
 * Sector: IT staffing and workforce solutions. HQ: Morristown, New Jersey, United States.
 *
 * Source: SmartRecruiters job board, company identifier `ArtechInformationSystemLLC`
 * (`https://jobs.smartrecruiters.com/ArtechInformationSystemLLC`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ArtechInformationSystemLLC';
const COMPANY_NAME = 'Artech';

@SourcePlugin({
  site: Site.ARTECH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ArtechService implements IScraper {
  private readonly logger = new Logger(ArtechService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Artech',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Artech: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ARTECH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'artech-');
      }
    }

    this.logger.log(`Artech: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
