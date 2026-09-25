import 'reflect-metadata';
import { JsonLdService } from '../src/jsonld.service';

describe('JsonLdService locations', () => {
  const service = new JsonLdService() as any;

  it('maps every structured location entry incl. postalCode', () => {
    const locations = service.buildLocations(
      [
        { city: 'Austin', region: 'TX', country: 'US', postalCode: '78701', label: 'Austin, TX, US' },
        { city: 'Denver', region: 'CO', country: 'US', postalCode: null, label: 'Denver, CO, US' },
      ],
      false,
    );
    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({ city: 'Austin', state: 'TX', country: 'US', postalCode: '78701' });
    expect(locations[1]).toMatchObject({ city: 'Denver', state: 'CO', country: 'US' });
  });

  it('remote-only postings become a single Remote entry', () => {
    const locations = service.buildLocations([], true);
    expect(locations).toHaveLength(1);
    expect(locations[0].city).toBe('Remote');
    expect(service.buildLocations([], false)).toHaveLength(0);
  });

  it('remote flag fills only the first entry city', () => {
    const locations = service.buildLocations(
      [
        { city: null, region: 'TX', country: 'US', postalCode: null, label: 'TX, US' },
        { city: 'Denver', region: 'CO', country: 'US', postalCode: null, label: 'Denver, CO, US' },
      ],
      true,
    );
    expect(locations[0].city).toBe('Remote');
    expect(locations[1].city).toBe('Denver');
  });
});
