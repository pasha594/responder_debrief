/**
 * /release_notes content: what shipped each day, written for wildland
 * firefighters rather than developers.
 *
 * Adding a day: put a new entry at the TOP (newest first), dated in
 * YYYY-MM-DD by the day the changes reached main. Each note is a short title
 * plus one plain-language line saying what changed for the user. Leave out
 * anything a user wouldn't notice (analytics, tests, build and review
 * tooling, pipeline internals); pipeline work stays when users feel it, like
 * maps arriving faster. Days with no user-facing change get no entry.
 * Spell out uncommon acronyms. Mark bug fixes with `fix: true`, listed last.
 * Use firefighter terms: satellite detections are "hotspots", not "heat".
 */

export interface ReleaseNote {
  title: string;
  summary: string;
  /** A user-visible bug fix rather than something new. */
  fix?: boolean;
}

export interface ReleaseDay {
  /** YYYY-MM-DD, the day the changes shipped. */
  date: string;
  notes: ReleaseNote[];
}

export const RELEASE_NOTES: ReleaseDay[] = [
  {
    date: '2026-09-25',
    notes: [
      {
        title: 'Names on historic perimeters',
        summary: 'Each old fire scar now shows its name and year in its middle, no tap needed.',
      },
      {
        title: 'Infrared (IR) flights on the map for more fires',
        summary:
          'Nightly IR heat now shows on the map for fires whose teams publish only a KMZ, like Sisi, drawn with the same symbols and legend as the IR PDF. Flights sit under their day in the Maps tab with when the plane flew.',
      },
      {
        title: 'Share by QR code',
        summary:
          'The QR button beside 3D shows your map view, layers, incident map and drawings as a code. Another phone scans it with Scan code, no signal needed if both phones downloaded the fire.',
      },
      {
        title: 'Historic perimeter dates',
        summary:
          'Tapping an old fire scar showed the date its record was last edited, not when it burned. It now shows the year of the fire.',
        fix: true,
      },
    ],
  },
  {
    date: '2026-09-24',
    notes: [
      {
        title: 'Flames on fresh hotspots',
        summary:
          'Hotspots from the last 12 hours show 3D flames that lean with the wind at the selected time.',
      },
      {
        title: 'Drop a pin',
        summary:
          'Tap anywhere on the map for its coordinates, nearest street address, and directions to that spot.',
      },
      {
        title: 'Official NWCG symbols in Draw',
        summary:
          'The Draw tab now has the full National Wildfire Coordinating Group (NWCG) set: 50 point symbols and 32 line styles.',
      },
      {
        title: 'Draw tools on the map',
        summary:
          'Erase, undo, redo and clear now sit on the map while you draw, and directional lines can be flipped.',
      },
      {
        title: 'Terrain labels',
        summary:
          'The Map background now labels peaks with elevations, ridges, passes, creeks, lakes, and forest and wilderness names.',
      },
      {
        title: 'Compass dial',
        summary: 'A compass sits above the scale bar. Tap it to face north, or drag it to rotate the map.',
      },
      {
        title: 'Topo by default',
        summary: 'Fire maps now open on the USGS topographic map. You can still switch to Map or Satellite.',
      },
      {
        title: 'Compact controls on phones',
        summary: 'On phones, the map buttons fold into smaller ones, leaving more of the screen for the map.',
      },
      {
        title: 'Map labels stay visible',
        summary: 'Place names no longer disappear after the map moves to a new spot on its own.',
        fix: true,
      },
    ],
  },
  {
    date: '2026-09-18',
    notes: [
      {
        title: 'Scale bar',
        summary: 'A scale bar in the map corner shows distance in miles and kilometers (feet and meters up close).',
      },
      {
        title: 'Newest maps first',
        summary: 'The fire list now opens sorted by the most recently posted incident maps.',
      },
      {
        title: 'Right maps for look-alike names',
        summary:
          "Fires with similar names no longer show another fire's old maps (Corrals, NM had been showing Corral, AZ's April maps).",
        fix: true,
      },
      {
        title: 'Draw tool turns off when you leave Draw',
        summary: 'Switching away from the Draw tab no longer leaves a symbol or line tool active on the map.',
        fix: true,
      },
    ],
  },
  {
    date: '2026-09-16',
    notes: [
      {
        title: '3D button',
        summary: 'A new 3D button tilts the map for a terrain view. Tap it again to flatten.',
      },
      {
        title: 'Tap a map to show it',
        summary: 'Tapping anywhere on an incident map in the Maps tab now lays it on the map.',
      },
    ],
  },
  {
    date: '2026-09-10',
    notes: [
      {
        title: 'Weather over incident maps',
        summary:
          'Weather and fire forecast layers now draw on top of incident maps, so an ops map no longer hides the smoke.',
      },
      {
        title: 'Tablet layout',
        summary: 'On iPads, the search bar no longer covers the fire panel.',
        fix: true,
      },
    ],
  },
  {
    date: '2026-09-01',
    notes: [
      {
        title: 'Link previews',
        summary: 'Incibrief links shared by text or chat now show a title, description and image.',
      },
    ],
  },
  {
    date: '2026-08-31',
    notes: [
      {
        title: 'Offline fires',
        summary:
          "Download a fire from its Overview tab to use it with no signal: perimeters, hotspots, forecast, incident maps and 12 hours of weather.",
      },
      {
        title: 'Install as an app',
        summary: "Add Incibrief to your phone's home screen. It opens even with no connection.",
      },
      {
        title: 'Incident map dates',
        summary: 'Maps with typos in their file names no longer show impossible dates.',
        fix: true,
      },
    ],
  },
  {
    date: '2026-08-28',
    notes: [
      {
        title: 'Your location',
        summary: 'Show your live position on the map, and use it as the start or end of directions.',
      },
      {
        title: 'Drive, engine and walk times',
        summary: 'Directions show Drive, Apparatus and Walk times side by side. Tap one to switch.',
      },
      {
        title: 'Fires near a town',
        summary: 'Type a city into the fire list search to see fires within 200 miles, closest first.',
      },
      {
        title: 'Light mode and map styles',
        summary: 'A settings gear lets you switch between dark and light mode and pick from six map styles.',
      },
    ],
  },
  {
    date: '2026-08-27',
    notes: [
      {
        title: 'More incident maps in the South and East',
        summary: 'Incident maps now load for more fires in the Southern and Eastern Areas.',
      },
    ],
  },
  {
    date: '2026-08-25',
    notes: [
      {
        title: 'Place search',
        summary: 'Search for a place or paste coordinates to jump there on the map.',
      },
      {
        title: 'Directions',
        summary:
          'Get directions between any two points. Tap the map to set the start and end, and drag the pins to adjust.',
      },
      {
        title: 'Engine-safe routes',
        summary:
          "The Apparatus option finds routes suited to engines and water tenders, and tells you when there isn't one.",
      },
      {
        title: 'Drive-time rings',
        summary: 'Show 15, 30 and 60-minute drive-time rings around your starting point.',
      },
      {
        title: 'Road closures and traffic',
        summary: 'New layers show road closures, incidents and live traffic near the fire, refreshed every 2 minutes.',
      },
    ],
  },
  {
    date: '2026-08-24',
    notes: [
      {
        title: 'No more "Not Secure" warning',
        summary: 'Browsers no longer occasionally flag the site as "Not Secure".',
        fix: true,
      },
    ],
  },
  {
    date: '2026-08-21',
    notes: [
      {
        title: 'Historic fire perimeters',
        summary:
          'A new layer shows fire scars from the last 10 years around the fire. Tap one for its name, year and acres.',
      },
      {
        title: 'Update times in the fire list',
        summary: 'The perimeter, forecast and FTP columns show how long ago each was last updated.',
      },
      {
        title: 'Search by state name',
        summary: 'Search the fire list by full state name, like "Oregon".',
      },
      {
        title: 'Map opens on the fire',
        summary: 'Fire maps now open zoomed to fit the newest perimeter.',
      },
      {
        title: 'Smoother scrubbing',
        summary: 'Dragging the timeline through hotspot and perimeter history is faster and smoother.',
      },
      {
        title: 'Sources page',
        summary: "A new page lists every official source behind Incibrief's data.",
      },
      {
        title: 'Newest hotspots on long fires',
        summary: 'Long-running fires no longer lose their most recent hotspots.',
        fix: true,
      },
    ],
  },
  {
    date: '2026-08-20',
    notes: [
      {
        title: 'Incident map versions',
        summary: 'Pin every version of an incident map to the timeline, then scrub to watch it change day to day.',
      },
      {
        title: 'Faster incident maps',
        summary:
          'New incident maps appear within about an hour of being posted, and can go on the map about 15 minutes later.',
      },
      {
        title: 'More maps line up on terrain',
        summary:
          'Maps without built-in location data can now be placed on the map using the lat/long labels around their edges.',
      },
      {
        title: 'IR from KMZ files',
        summary: 'Infrared (IR) flight data posted only as Google Earth (KMZ) files now shows on the map.',
      },
      {
        title: 'Layers tab',
        summary: 'The Forecast tab is now Layers, with hotspot and perimeter switches at the top.',
      },
      {
        title: 'Shareable links',
        summary:
          'The web address now names the fire and keeps your view (layers, maps, time), so a copied link opens what you see.',
      },
      {
        title: 'Smoother playback',
        summary: 'Timeline playback glides at a faster speed, without the perimeter flickering.',
      },
      {
        title: 'Weather forecast range',
        summary:
          'The timeline marks how far ahead the HRRR (High-Resolution Rapid Refresh) weather forecast reaches.',
      },
      {
        title: 'Missing incident maps',
        summary: 'Fires with maps in more than one folder, like Bear Trap, now show all of them.',
        fix: true,
      },
    ],
  },
  {
    date: '2026-08-18',
    notes: [
      {
        title: 'Draw tab',
        summary: 'Mark up the map with incident map symbols and lines, with erase and undo. Drawings stay on your device.',
      },
      {
        title: 'Resources and sit report',
        summary:
          "The Overview tab shows crews, engines, helicopters, personnel, cost and structures lost from the National Interagency Fire Center's daily situation report.",
      },
      {
        title: 'Weather on the timeline',
        summary:
          'A strip on the timeline shows conditions, temperature and wind at the fire, past and forecast. On phones, swipe up to see it.',
      },
      {
        title: 'Drag-through timeline',
        summary: 'The timeline slides under a fixed center line. Drag it to move through time, with 10 days in view.',
      },
      {
        title: 'Wind arrows',
        summary: 'Arrows show wind direction over the wind speed and gust layers, and follow the timeline.',
      },
      {
        title: '3D terrain',
        summary: 'Fire maps now show terrain in 3D.',
      },
      {
        title: 'Satellite and topo backgrounds',
        summary: 'Switch the map background between Map, Satellite and Topo.',
      },
      {
        title: 'Incident map upload times',
        summary: "Each incident map shows when it was uploaded, in the fire's local time.",
      },
      {
        title: 'Sharper incident maps',
        summary: 'Incident maps laid on the map are now twice as sharp.',
      },
      {
        title: 'Readable place names',
        summary: 'Place names stay readable over weather layers and incident maps.',
      },
      {
        title: 'Weather layers',
        summary:
          'Temperature no longer shows the whole country as freezing, and weather layers no longer go blank between updates.',
        fix: true,
      },
    ],
  },
  {
    date: '2026-08-17',
    notes: [
      {
        title: 'First release',
        summary: 'Active fires, perimeters, satellite hotspots, spread forecasts, weather and incident maps on one map.',
      },
      {
        title: 'Fire list',
        summary:
          "A sortable list of active fires with size, start date, and how fresh each fire's perimeter, forecast and maps are.",
      },
      {
        title: 'Fire arrival forecast',
        summary: 'See at a glance when the spread forecast expects fire to reach each area, and when the model last ran.',
      },
      {
        title: 'Incident maps by day',
        summary:
          "Maps posted by incident teams are grouped by date, ops maps first. Maps that can't go on the map open in a viewer.",
      },
      {
        title: 'Hotspots by age',
        summary: 'Hotspots fade from yellow to orange to purple over two days, and hide after three.',
      },
      {
        title: 'Timeline markers',
        summary: 'The timeline marks perimeter updates and forecast releases, with a graph of hotspot activity.',
      },
    ],
  },
];

const DAY_FORMAT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** '2026-09-24' → 'Thu, Sep 24, 2026'. Read as a calendar day (UTC midnight),
 * so the viewer's time zone can't shift it to the day before. */
export function formatReleaseDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return DAY_FORMAT.format(new Date(Date.UTC(y, m - 1, d)));
}
