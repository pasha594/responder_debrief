import { describe, expect, it } from 'vitest';
import { HISTORY_YEARS, historyQueryUrl } from './nifcHistory';

describe('historyQueryUrl', () => {
  it('builds a bounded, simplified, paged envelope query', () => {
    const url = historyQueryUrl([-117.8, 42.3, -116.8, 43.0], 1000, 2026);
    expect(url).toContain(`FIRE_YEAR_INT+%3E%3D+${2026 - HISTORY_YEARS}`);
    expect(url).toContain('geometry=-117.8%2C42.3%2C-116.8%2C43');
    expect(url).toContain('resultOffset=1000');
    expect(url).toContain('maxAllowableOffset=0.0003');
    expect(url).toContain('f=geojson');
    expect(url).toContain('outFields=INCIDENT%2CFIRE_YEAR_INT%2CGIS_ACRES%2CIRWINID');
  });
});
