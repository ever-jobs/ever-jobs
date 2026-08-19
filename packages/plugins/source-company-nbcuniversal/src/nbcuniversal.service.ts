import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * NBCUniversal — US media and entertainment conglomerate spanning film, television and streaming.
 *
 * NBCUniversal is a media and entertainment company that develops, produces
 * and distributes news, film and television content and operates streaming
 * and theme park businesses. It is part of Comcast and hires across
 * production, editorial, marketing, technology and corporate roles.
 *
 * Sector: Media & Entertainment. HQ: New York, New York, USA.
 *
 * Source: SmartRecruiters job board, company identifier `NBCUniversal3`
 * (`https://jobs.smartrecruiters.com/NBCUniversal3`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'NBCUniversal3';
const COMPANY_NAME = 'NBCUniversal';

@SourcePlugin({
  site: Site.NBCUNIVERSAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NBCUniversalService implements IScraper {
  private readonly logger = new Logger(NBCUniversalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape NBCUniversal',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `NBCUniversal: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NBCUNIVERSAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'nbcuniversal-');
      }
    }

    this.logger.log(`NBCUniversal: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
