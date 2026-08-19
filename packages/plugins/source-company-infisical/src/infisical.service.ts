import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Infisical — Open-source secrets management and security infrastructure platform.
 *
 * Infisical is an open-source security infrastructure platform used for
 * secrets management, certificate management, and privileged access
 * management. It helps developers and organizations manage secrets securely.
 * The company has raised funding from Y Combinator, Google, and Elad Gil.
 *
 * Sector: Secrets Management. HQ: San Francisco, California, United States.
 *
 * Source: Ashby job board, company slug `infisical`
 * (`https://jobs.ashbyhq.com/infisical`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'infisical';
const COMPANY_NAME = 'Infisical';

@SourcePlugin({
  site: Site.INFISICAL,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class InfisicalService implements IScraper {
  private readonly logger = new Logger(InfisicalService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Infisical',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Infisical: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.INFISICAL;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'infisical-');
      }
    }

    this.logger.log(`Infisical: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
