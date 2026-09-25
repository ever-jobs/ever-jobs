import 'reflect-metadata';
import { CornerstoneService } from '../src/cornerstone.service';
import type { CornerstoneRequisition } from '../src/cornerstone.types';

describe('CornerstoneService locations', () => {
  const service = new CornerstoneService() as any;

  it('maps every requisition.locations entry', () => {
    const req = {
      locations: [
        { city: 'Atlanta', state: 'GA', country: 'US' },
        { city: 'Dallas', state: 'TX', country: 'US' },
      ],
    } as unknown as CornerstoneRequisition;
    const locations = service.extractLocations(req);
    expect(locations).toHaveLength(2);
    expect(locations[0]).toMatchObject({ city: 'Atlanta', state: 'GA', country: 'US' });
    expect(locations[1]).toMatchObject({ city: 'Dallas', state: 'TX', country: 'US' });
  });

  it('maps a single location object to a one-entry list', () => {
    const req = {
      location: { city: 'Atlanta', state: 'GA', country: 'US' },
    } as unknown as CornerstoneRequisition;
    expect(service.extractLocations(req)).toHaveLength(1);
  });

  it('splits displayName-only objects and parses display strings', () => {
    const byName = service.extractLocations({
      locations: [{ displayName: 'Atlanta, GA, US' }],
    } as unknown as CornerstoneRequisition);
    expect(byName[0]).toMatchObject({ city: 'Atlanta', state: 'GA', country: 'US' });

    const byDisplay = service.extractLocations({
      displayLocation: 'Austin, TX, US',
    } as unknown as CornerstoneRequisition);
    expect(byDisplay).toHaveLength(1);
    expect(byDisplay[0].city).toBe('Austin');
    expect(byDisplay[0].state).toBe('TX');
  });
});
