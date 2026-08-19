import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Delinea — Privileged access management (PAM) and identity security provider.
 *
 * Delinea provides privileged access management and identity security
 * solutions that control and secure access to critical systems and
 * privileged accounts across enterprise environments. Its roles span
 * security operations and enterprise security engineering.
 *
 * Sector: Privileged Access Management. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `delinea`
 * (`https://jobs.ashbyhq.com/delinea`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'delinea';
const COMPANY_NAME = 'Delinea';

@SourcePlugin({
  site: Site.DELINEA,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class DelineaService implements IScraper {
  private readonly logger = new Logger(DelineaService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Delinea',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Delinea: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.DELINEA;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'delinea-');
      }
    }

    this.logger.log(`Delinea: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
