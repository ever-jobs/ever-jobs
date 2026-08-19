import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Adaptive Security — AI-powered cybersecurity platform defending against deepfakes and AI-driven social engineering.
 *
 * Adaptive Security builds AI-powered cybersecurity products that protect
 * organizations from threats including deepfakes, voice scams, and AI-driven
 * social engineering. Its products integrate with enterprise platforms such
 * as Google Workspace and Microsoft 365. The company raised an $81M Series B
 * in December 2025.
 *
 * Sector: AI Cybersecurity. HQ: New York, New York, United States.
 *
 * Source: Ashby job board, company slug `adaptivesecurity`
 * (`https://jobs.ashbyhq.com/adaptivesecurity`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'adaptivesecurity';
const COMPANY_NAME = 'Adaptive Security';

@SourcePlugin({
  site: Site.ADAPTIVE_SECURITY,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class AdaptiveSecurityService implements IScraper {
  private readonly logger = new Logger(AdaptiveSecurityService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Adaptive Security',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Adaptive Security: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.ADAPTIVE_SECURITY;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'adaptivesecurity-');
      }
    }

    this.logger.log(`Adaptive Security: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
