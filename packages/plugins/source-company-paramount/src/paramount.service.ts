import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Paramount — US media and entertainment company spanning film, television and streaming.
 *
 * Paramount is a media and entertainment company that produces and
 * distributes film and television content and operates streaming services
 * and broadcast networks. This SmartRecruiters careers page hosts a subset
 * of its openings across corporate and operational roles.
 *
 * Sector: Media & Entertainment. HQ: New York, New York, USA.
 *
 * Source: SmartRecruiters job board, company identifier `ParamountATL`
 * (`https://jobs.smartrecruiters.com/ParamountATL`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'ParamountATL';
const COMPANY_NAME = 'Paramount';

@SourcePlugin({
  site: Site.PARAMOUNT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ParamountService implements IScraper {
  private readonly logger = new Logger(ParamountService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Paramount',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Paramount: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.PARAMOUNT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'paramount-');
      }
    }

    this.logger.log(`Paramount: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
