import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Keywords Studios — Provider of technical and creative services to the video games industry.
 *
 * Keywords Studios provides outsourced technical and creative services to
 * video game and interactive entertainment companies, including development,
 * art, testing and localization. It hires programmers, artists, QA and
 * production staff across global studios.
 *
 * Sector: Video Games (Services). HQ: Dublin, Ireland.
 *
 * Source: SmartRecruiters job board, company identifier `KeywordsStudios`
 * (`https://jobs.smartrecruiters.com/KeywordsStudios`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'KeywordsStudios';
const COMPANY_NAME = 'Keywords Studios';

@SourcePlugin({
  site: Site.KEYWORDS_STUDIOS,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class KeywordsStudiosService implements IScraper {
  private readonly logger = new Logger(KeywordsStudiosService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Keywords Studios',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Keywords Studios: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.KEYWORDS_STUDIOS;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'keywordsstudios-');
      }
    }

    this.logger.log(`Keywords Studios: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
