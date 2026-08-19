import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Havoc AI — Develops autonomous surface vessels and collaborative autonomy software.
 *
 * Havoc AI builds autonomous surface vessels and the collaborative autonomy
 * software that coordinates them. The company focuses on maritime defense
 * and multi-vessel autonomous operations. Its engineering spans autonomy
 * systems and full-stack software.
 *
 * Sector: Defense (Maritime Autonomy). HQ: USA.
 *
 * Source: Ashby job board, company slug `havocai`
 * (`https://jobs.ashbyhq.com/havocai`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'havocai';
const COMPANY_NAME = 'Havoc AI';

@SourcePlugin({
  site: Site.HAVOC_AI,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class HavocAIService implements IScraper {
  private readonly logger = new Logger(HavocAIService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Havoc AI',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Havoc AI: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.HAVOC_AI;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'havocai-');
      }
    }

    this.logger.log(`Havoc AI: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
