import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Harmattan AI — Develops autonomous drone platforms for defense applications.
 *
 * Harmattan AI is a defense company building autonomous drone platforms
 * spanning air defense, ISR, strike, and electronic warfare capabilities.
 * The company operates R&D and engineering hubs across Europe and North
 * Africa and is headquartered in Paris, France.
 *
 * Sector: Defense / Autonomous systems. HQ: Paris, France.
 *
 * Source: Ashby job board, company slug `harmattan-ai`
 * (`https://jobs.ashbyhq.com/harmattan-ai`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'harmattan-ai';
const COMPANY_NAME = 'Harmattan AI';

@SourcePlugin({
  site: Site.HARMATTAN_AI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HarmattanAIService implements IScraper {
  private readonly logger = new Logger(HarmattanAIService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Harmattan AI',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Harmattan AI: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HARMATTAN_AI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'harmattanai-');
      }
    }

    this.logger.log(`Harmattan AI: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
