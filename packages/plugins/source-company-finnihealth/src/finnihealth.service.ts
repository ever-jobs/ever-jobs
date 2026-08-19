import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Finni Health — Platform enabling autism care providers to start and run their own ABA practices.
 *
 * Finni Health provides technology and back-office support that lets autism
 * care (ABA) providers launch and operate independent practices. It handles
 * administrative functions such as credentialing, billing, and insurance.
 * The company supports clinicians delivering applied behavior analysis
 * therapy.
 *
 * Sector: Healthtech (autism / ABA care). HQ: San Francisco, CA, USA.
 *
 * Source: Ashby job board, company slug `finni-health`
 * (`https://jobs.ashbyhq.com/finni-health`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'finni-health';
const COMPANY_NAME = 'Finni Health';

@SourcePlugin({
  site: Site.FINNI_HEALTH,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class FinniHealthService implements IScraper {
  private readonly logger = new Logger(FinniHealthService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Finni Health',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Finni Health: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.FINNI_HEALTH;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'finnihealth-');
      }
    }

    this.logger.log(`Finni Health: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
