import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Structube — Canadian modern furniture and home decor retailer with stores nationwide.
 *
 * Structube is a Canadian retailer of modern furniture and home decor. It
 * operates a network of stores across Canada alongside an e-commerce site.
 * The company sells contemporary furniture, lighting, and accessories for
 * the home.
 *
 * Sector: Home furnishings retail. HQ: Montreal, Quebec, Canada.
 *
 * Source: SmartRecruiters job board, company identifier `Structube1`
 * (`https://jobs.smartrecruiters.com/Structube1`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'Structube1';
const COMPANY_NAME = 'Structube';

@SourcePlugin({
  site: Site.STRUCTUBE,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class StructubeService implements IScraper {
  private readonly logger = new Logger(StructubeService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Structube',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Structube: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.STRUCTUBE;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'structube-');
      }
    }

    this.logger.log(`Structube: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
