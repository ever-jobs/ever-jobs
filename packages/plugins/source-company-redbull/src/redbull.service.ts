import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Red Bull — Energy drink company with a large media, sports, esports and entertainment arm.
 *
 * Red Bull is an Austrian company known for its energy drink and for Red
 * Bull Media House, which produces sports, music, gaming and entertainment
 * content. It owns sports teams and runs global events, and hires across
 * marketing, media production, sports and esports.
 *
 * Sector: Media & Entertainment. HQ: Fuschl am See, Salzburg, Austria.
 *
 * Source: SmartRecruiters job board, company identifier `RedBull`
 * (`https://jobs.smartrecruiters.com/RedBull`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'RedBull';
const COMPANY_NAME = 'Red Bull';

@SourcePlugin({
  site: Site.RED_BULL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class RedBullService implements IScraper {
  private readonly logger = new Logger(RedBullService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Red Bull',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Red Bull: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.RED_BULL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'redbull-');
      }
    }

    this.logger.log(`Red Bull: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
