import { SourcePlugin, PluginRegistry } from '@ever-jobs/plugin';

import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  IScraper, ScraperInputDto, JobResponseDto, Site,
  ScrapeDiagnostics,
} from '@ever-jobs/models';

/**
 * Confluent — Data streaming platform built around Apache Kafka.
 *
 * Confluent provides a data streaming platform built on Apache Kafka,
 * enabling organizations to process and connect real-time data across
 * systems. It offers both self-managed software and a fully managed cloud
 * service.
 *
 * Sector: Data streaming infrastructure. HQ: Mountain View, California, USA.
 *
 * Source: Ashby job board, company slug `confluent`
 * (`https://jobs.ashbyhq.com/confluent`). The company's live
 * postings are served by Ashby. Rather than re-implement Ashby parsing (and
 * risk drift), this plugin resolves the registered Ashby source plugin from
 * the `PluginRegistry` at runtime and delegates the fetch + field mapping to
 * it, then re-stamps the company identity (site, companyName, id prefix) onto
 * the results — so every Ashby field fix is inherited automatically. This
 * honours the "no plugin imports a peer plugin directly; discover via the
 * registry" rule.
 */
const COMPANY_SLUG = 'confluent';
const COMPANY_NAME = 'Confluent';

@SourcePlugin({
  site: Site.CONFLUENT,
  name: COMPANY_NAME,
  category: 'company',
})
@Injectable()
export class ConfluentService implements IScraper {
  private readonly logger = new Logger(ConfluentService.name);

  constructor(
    @Optional() private readonly registry?: PluginRegistry,
  ) {}

  async scrape(input: ScraperInputDto): Promise<JobResponseDto> {
    const ashby = this.registry?.getScraper(Site.ASHBY);
    if (!ashby) {
      this.logger.error(
        'Ashby source plugin is not registered; cannot scrape Confluent',
      );
      // A registry miss is a wiring problem, not an empty board -
      // not_registered keeps the two distinguishable upstream.
      return new JobResponseDto(
        [],
        new ScrapeDiagnostics('not_registered', 'Ashby source plugin is not registered'),
      );
    }

    this.logger.log(
      `Confluent: delegating to Ashby (slug ${COMPANY_SLUG})`,
    );

    const result = await ashby.scrape({
      ...input,
      companySlug: COMPANY_SLUG,
    } as ScraperInputDto);

    for (const job of result.jobs) {
      job.site = Site.CONFLUENT;
      job.companyName = COMPANY_NAME;
      if (job.id) {
        job.id = job.id.replace(/^ashby-/, 'confluent-');
      }
    }

    this.logger.log(`Confluent: scraped ${result.jobs.length} jobs`);
    return result;
  }
}
