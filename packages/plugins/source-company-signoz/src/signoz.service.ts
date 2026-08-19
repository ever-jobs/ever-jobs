import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * SigNoz — Open-source, OpenTelemetry-native observability platform.
 *
 * SigNoz builds an open-source observability platform based on OpenTelemetry
 * that provides application monitoring, metrics, logs, and traces. It
 * reports over 27,000 GitHub stars and 800+ customers. The company hires
 * across engineering, product, design, customer success, growth, and
 * developer relations.
 *
 * Sector: Observability. HQ: Remote (US and India).
 *
 * Source: Ashby job board, company slug `signoz`
 * (`https://jobs.ashbyhq.com/signoz`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'signoz';
const COMPANY_NAME = 'SigNoz';

@SourcePlugin({
  site: Site.SIGNOZ,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class SigNozService implements IScraper {
  private readonly logger = new Logger(SigNozService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape SigNoz',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `SigNoz: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.SIGNOZ;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'signoz-');
      }
    }

    this.logger.log(`SigNoz: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
