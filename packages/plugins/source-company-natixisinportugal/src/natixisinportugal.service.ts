import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Natixis in Portugal — Center of expertise of Natixis (Groupe BPCE) supporting corporate and investment banking.
 *
 * Natixis in Portugal is a center of expertise of Natixis, part of France's
 * Groupe BPCE. Based in Porto, it delivers technology, operations, and
 * financial expertise supporting Groupe BPCE's Corporate & Investment
 * Banking and Asset & Wealth Management activities.
 *
 * Sector: Banking / corporate & investment banking. HQ: Porto, Portugal.
 *
 * Source: SmartRecruiters job board, company identifier `natixisinportugal`
 * (`https://jobs.smartrecruiters.com/natixisinportugal`). The company's live
 * postings are served by SmartRecruiters. Rather than re-implement
 * SmartRecruiters parsing (and risk drift), this plugin resolves the
 * registered SmartRecruiters source plugin from the `PluginRegistry` at
 * runtime and delegates the fetch + field mapping to it, then re-stamps the
 * company identity (site, companyName, id prefix) onto the results — so every
 * SmartRecruiters field fix is inherited automatically. This honours the "no
 * plugin imports a peer plugin directly; discover via the registry" rule.
 */
const COMPANY_SLUG = 'natixisinportugal';
const COMPANY_NAME = 'Natixis in Portugal';

@SourcePlugin({
  site: Site.NATIXIS_IN_PORTUGAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class NatixisInPortugalService implements IScraper {
  private readonly logger = new Logger(NatixisInPortugalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const smartrecruiters = this.registry?.getScraper(Site.SMARTRECRUITERS);
    if (!smartrecruiters) {
      this.logger.error(
        'SmartRecruiters source plugin is not registered; cannot scrape Natixis in Portugal',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'SmartRecruiters source plugin is not registered'),
      );
    }

    this.logger.log(
      `Natixis in Portugal: delegating to SmartRecruiters (slug ${COMPANY_SLUG})`,
    );

    const result = await smartrecruiters.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.NATIXIS_IN_PORTUGAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^sr-/, 'natixisinportugal-');
      }
    }

    this.logger.log(`Natixis in Portugal: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
