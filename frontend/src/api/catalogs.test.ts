import { describe, expect, it } from 'vitest';
import { DATA_BASE_URL } from '../app/config';
import { dataUrl } from './catalogs';

describe('dataUrl', () => {
  it('percent-encodes filename characters a URL path cannot carry raw', () => {
    // Real keys: Slough Canyon's '&' made B2 answer 400; Sinlahekin's '#' cut the path.
    expect(dataUrl('/raw/incidents/slough-canyon/products/current/IAP_1_Pager_Kirks&Moore_2026_828.pdf'))
      .toBe(`${DATA_BASE_URL}/raw/incidents/slough-canyon/products/current/IAP_1_Pager_Kirks%26Moore_2026_828.pdf`);
    expect(dataUrl('/raw/incidents/sinlahekin/products/current/ops_IncidentName_Inc#_day0801.pdf'))
      .toBe(`${DATA_BASE_URL}/raw/incidents/sinlahekin/products/current/ops_IncidentName_Inc%23_day0801.pdf`);
    expect(dataUrl('/raw/a,b+c[1]?.pdf')).toBe(`${DATA_BASE_URL}/raw/a%2Cb%2Bc%5B1%5D%3F.pdf`);
  });

  it('leaves tile templates and ordinary keys alone', () => {
    const tpl = '/tiles/incidents/slough-canyon/9cb5e90a3905b2ef/{z}/{x}/{y}.png';
    expect(dataUrl(tpl)).toBe(`${DATA_BASE_URL}${tpl}`);
    expect(dataUrl('/frames/weather/{product}/run_2026-09-28.png'))
      .toBe(`${DATA_BASE_URL}/frames/weather/{product}/run_2026-09-28.png`);
  });
});
