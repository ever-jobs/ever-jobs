import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * TENEX.AI — AI-augmented managed detection and response (MDR) cybersecurity provider.
 *
 * TENEX.AI provides managed detection and response services that combine AI
 * automation with human analysts for threat detection and response. Its
 * roles focus on threat detection engineering and security operations.
 *
 * Sector: Managed Detection & Response. HQ: United States.
 *
 * Source: Ashby job board, company slug `tenex`
 * (`https://jobs.ashbyhq.com/tenex`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'tenex';
const COMPANY_NAME = 'TENEX.AI';

@SourcePlugin({
  site: Site.TENEX_AI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class TENEXAIService implements IScraper {
  private readonly logger = new Logger(TENEXAIService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape TENEX.AI',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `TENEX.AI: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.TENEX_AI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'tenexai-');
      }
    }

    this.logger.log(`TENEX.AI: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
