import { DescriptionFormat } from '@ever-jobs/models';
import { SimplyHiredService } from '../src/simplyhired.service';

describe('SimplyHiredService detail parsing', () => {
  const service = new SimplyHiredService() as any;

  it('uses JobPosting JSON-LD for the current job and ignores similar jobs', () => {
    const html = `
      <html>
        <body>
          <main>
            <h1>Administrative Assistant</h1>
            <section>
              <h2>Job Details</h2>
              <p>Full-time</p>
              <p>$22.58 - $27.19 an hour</p>
              <h2>Qualifications</h2>
              <span>Administrative experience</span>
              <span>Productivity software</span>
              <h2>Full Job Description</h2>
              <p>Position Description:</p>
              <p>MUST HAVE PREVIOUS EXPERIENCE!!!!</p>
              <p>Responsibilities:</p>
              <p>Answer and direct phone calls</p>
            </section>
          </main>
          <aside>
            <h2>Our Most Similar Jobs</h2>
            <a>Office Assistant</a>
            <p>A-OK Portable Services</p>
          </aside>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "JobPosting",
              "title": "Administrative Assistant",
              "description": "<p>Position Description:</p><p>MUST HAVE PREVIOUS EXPERIENCE!!!!</p><p>Responsibilities:</p><p>Answer and direct phone calls</p>",
              "datePosted": "2026-06-30T01:52:48.992Z",
              "employmentType": "FULL_TIME",
              "hiringOrganization": {"name": "CERTITEMP OF GEORGIA LLC"},
              "jobLocation": {
                "@type": "Place",
                "address": {
                  "@type": "PostalAddress",
                  "addressLocality": "Macon",
                  "addressRegion": "GA",
                  "addressCountry": "US"
                }
              },
              "baseSalary": {
                "@type": "MonetaryAmount",
                "currency": "USD",
                "value": {
                  "@type": "QuantitativeValue",
                  "minValue": 22.58,
                  "maxValue": 27.19,
                  "unitText": "HOUR"
                }
              }
            }
          </script>
        </body>
      </html>
    `;

    const detail = service.parseDetailHtml(html, DescriptionFormat.PLAIN);

    expect(detail.title).toBe('Administrative Assistant');
    expect(detail.companyName).toBe('CERTITEMP OF GEORGIA LLC');
    expect(detail.location.city).toBe('Macon');
    expect(detail.location.state).toBe('GA');
    expect(detail.description).toContain('Position Description');
    expect(detail.description).toContain('Answer and direct phone calls');
    expect(detail.description).not.toContain('Our Most Similar Jobs');
    expect(detail.description).not.toContain('A-OK Portable Services');
    expect(detail.compensation.minAmount).toBe(22.58);
    expect(detail.compensation.maxAmount).toBe(27.19);
    expect(detail.employmentType).toBe('FULL_TIME');
    expect(detail.skills).toEqual([
      'Administrative experience',
      'Productivity software',
    ]);
  });

  it('rejects CSS fragments as descriptions', () => {
    expect(service.usefulDescription('.css-lvyu5j{margin-right:10px;}Macon, GA')).toBeNull();
  });
});
