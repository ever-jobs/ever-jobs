import { JobPostDto } from './job-post.dto';
import { ScrapeDiagnostics } from './scrape-diagnostics.dto';

export class JobResponseDto {
  jobs: JobPostDto[];
  /**
   * Optional per-source outcome (Spec 5082). A plugin MAY set this to explain a
   * zero/failed result (e.g. `browser_unavailable`, `blocked`); when absent the
   * fan-out infers a reason from the settled outcome.
   */
  diagnostics?: ScrapeDiagnostics;

  constructor(jobs: JobPostDto[] = [], diagnostics?: ScrapeDiagnostics) {
    this.jobs = jobs;
    if (diagnostics) this.diagnostics = diagnostics;
  }
}
