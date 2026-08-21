/** /sources — where the data comes from. Official upstream sources only. */
import { HREF_DIRECTORY } from '../app/router';
import { DisclaimerFooter } from './DisclaimerFooter';

interface Source {
  name: string;
  what: string;
  url: string;
  label: string;
}

const SOURCES: Source[] = [
  {
    name: 'National Interagency Fire Center (NIFC)',
    what:
      'National wildland-fire coordination center. Provides the daily Incident Management ' +
      'Situation Report behind Resources & Operations, and the WFIGS perimeter service behind fire perimeters.',
    url: 'https://www.nifc.gov',
    label: 'nifc.gov',
  },
  {
    name: 'InciWeb',
    what:
      'The interagency all-risk incident information system. Per-fire "View on InciWeb" links ' +
      'go to the official incident page maintained by the managing team.',
    url: 'https://inciweb.wildfire.gov',
    label: 'inciweb.wildfire.gov',
  },
  {
    name: 'NASA FIRMS — VIIRS & MODIS',
    what:
      'Satellite fire detections from the VIIRS (S-NPP, NOAA-20/21) and MODIS instruments. ' +
      'Powers the hotspot layer and the timeline activity graph.',
    url: 'https://firms.modaps.eosdis.nasa.gov',
    label: 'firms.modaps.eosdis.nasa.gov',
  },
  {
    name: 'National Incident-Specific Maps (ftp.wildfire.gov)',
    what:
      'Map products posted directly by incident management teams: operations and briefing maps, ' +
      'IAPs, and nightly infrared flight data. These power the Maps tab and IR heat overlays.',
    url: 'https://ftp.wildfire.gov/public/incident_specific_maps/',
    label: 'ftp.wildfire.gov',
  },
  {
    name: 'CAL FIRE',
    what:
      'The California Department of Forestry and Fire Protection. Source of incident status and ' +
      'perimeter data for California fires.',
    url: 'https://www.fire.ca.gov',
    label: 'fire.ca.gov',
  },
  {
    name: 'NOAA HRRR',
    what:
      'The High-Resolution Rapid Refresh model from NOAA. Behind the weather layers: temperature, ' +
      'humidity, wind speed and gusts, near-surface smoke, and precipitation.',
    url: 'https://rapidrefresh.noaa.gov/hrrr/',
    label: 'rapidrefresh.noaa.gov',
  },
  {
    name: 'Open-Meteo',
    what:
      'Open weather API aggregating national weather models. Provides the point forecasts shown ' +
      'along the timeline weather strip.',
    url: 'https://open-meteo.com',
    label: 'open-meteo.com',
  },
  {
    name: 'Pyrecast (ELMFIRE)',
    what:
      'Probabilistic fire-spread forecasts from the open-source ELMFIRE model. Behind the Fire ' +
      'Forecast layer (time of arrival, flame length, spread rate).',
    url: 'https://pyrecast.org',
    label: 'pyrecast.org',
  },
  {
    name: 'USGS — The National Map',
    what:
      'U.S. Geological Survey national mapping services. Provides the topographic and aerial ' +
      'imagery basemaps.',
    url: 'https://www.usgs.gov/programs/national-geospatial-program/national-map',
    label: 'usgs.gov',
  },
];

export function SourcesView() {
  return (
    <div className="rd-sources">
      <div className="rd-sources-inner">
      <header className="rd-sources-header">
        <a href={HREF_DIRECTORY} className="rd-back">
          ← All fires
        </a>
        <h1>Sources</h1>
        <p className="rd-sources-sub">
          Incibrief aggregates official interagency data. Everything shown traces back to the
          sources below — always defer to them for operational decisions.
        </p>
      </header>
      <ul className="rd-sources-list">
        {SOURCES.map((s) => (
          <li key={s.name} className="rd-source">
            <div className="rd-source-name">{s.name}</div>
            <p className="rd-source-what">{s.what}</p>
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="rd-source-link">
              {s.label} ↗
            </a>
          </li>
        ))}
      </ul>
      <DisclaimerFooter />
      </div>
    </div>
  );
}
