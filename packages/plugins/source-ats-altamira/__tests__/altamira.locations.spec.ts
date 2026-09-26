import 'reflect-metadata';
import { AltamiraService } from '../src/altamira.service';
import type { AltamiraJob } from '../src/altamira.types';

function job(over: Partial<AltamiraJob> = {}): AltamiraJob {
  return {
    jobId: '123',
    url: 'https://acme.altamira.example/job/123',
    title: 'Engineer',
    companyName: 'Acme',
    city: null,
    state: null,
    country: null,
    locationText: null,
    descriptionHtml: null,
    datePosted: null,
    isRemote: false,
    ...over,
  };
}

describe('AltamiraService locations', () => {
  const service = new AltamiraService();

  it('splitLocation keeps slug-tail Country-Region-City order', () => {
    const svc = service as any;
    expect(svc.splitLocation('Italia Veneto Padova')).toEqual({
      city: 'Padova',
      state: 'Veneto',
      country: 'Italia',
    });
    expect(svc.splitLocation('US Remote')).toEqual({
      city: 'Remote',
      state: null,
      country: 'US',
    });
  });

  it('emits the single resolved site as locations[]', () => {
    const svc = service as any;
    const dto = svc.processJob(
      job({ city: 'Padova', state: 'Veneto', country: 'Italia' }),
      'acme',
    );
    expect(dto.location).toMatchObject({
      city: 'Padova',
      state: 'Veneto',
      country: 'Italia',
    });
    expect(dto.locations).toHaveLength(1);
    expect(dto.locations[0]).toMatchObject({
      city: 'Padova',
      state: 'Veneto',
      country: 'Italia',
    });
  });

  it('omits locations when no location resolves', () => {
    const svc = service as any;
    const dto = svc.processJob(job(), 'acme');
    expect(dto.location).toBeNull();
    expect(dto.locations).toBeUndefined();
  });
});
