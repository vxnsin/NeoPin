import http from "node:http";
import { strToU8, zipSync } from "fflate";

// A tiny GTFS feed for the tests: bus 10 along four stops in Würzburg, tram 3 from the first
// to the last stop on a road a little to the east, and one stop far away in Munich that no
// slice of the Würzburg region may contain. Plus a stand-in for the Mobility Database and
// the feed host, so nothing touches the network.

export const STOPS = {
  A: { id: "A", name: "Sanderring", lat: 49.7885, lon: 9.933 },
  B: { id: "B", name: "Mainfranken Theater", lat: 49.793, lon: 9.934 },
  C: { id: "C", name: "Juliuspromenade", lat: 49.7975, lon: 9.935 },
  D: { id: "D", name: "Hauptbahnhof", lat: 49.8017, lon: 9.9358 },
  FAR: { id: "FAR", name: "München Hbf", lat: 48.1402, lon: 11.5586 },
};

// Straight lines between the stops, a shape point every ~110 m. Tram 3 runs 100 m east of it.
function shapePoints(id, stops, lonShift = 0) {
  const rows = [];
  let seq = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    const steps = Math.max(1, Math.round(((b.lat - a.lat) * 111_320) / 110));
    for (let s = 0; s < steps; s++) {
      const f = s / steps;
      rows.push(`${id},${(a.lat + (b.lat - a.lat) * f).toFixed(6)},${(a.lon + (b.lon - a.lon) * f + lonShift).toFixed(6)},${seq++}`);
    }
  }
  const last = stops[stops.length - 1];
  rows.push(`${id},${last.lat.toFixed(6)},${(last.lon + lonShift).toFixed(6)},${seq++}`);
  return rows;
}

export function gtfsText() {
  const { A, B, C, D, FAR } = STOPS;
  const stopTimes = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence"];
  // Bus 10 every 20 minutes from 08:10, three minutes per stop.
  for (const [n, start] of [
    ["1", 8 * 60 + 10],
    ["2", 8 * 60 + 30],
    ["3", 8 * 60 + 50],
  ]) {
    [A, B, C, D].forEach((stop, i) => {
      const t = start + i * 3;
      const hhmm = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`;
      stopTimes.push(`bus10-${n},${hhmm},${hhmm},${stop.id},${i + 1}`);
    });
  }
  stopTimes.push("tram3-1,08:12:00,08:12:00,A,1", "tram3-1,08:20:00,08:20:00,D,2");
  return {
    "agency.txt": ["agency_id,agency_name,agency_url,agency_timezone", "wvv,WVV,https://www.wvv.de,Europe/Berlin"].join("\n"),
    "stops.txt": ["stop_id,stop_name,stop_lat,stop_lon", ...[A, B, C, D, FAR].map((s) => `${s.id},${s.name},${s.lat},${s.lon}`)].join("\n"),
    "routes.txt": [
      "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color",
      "r10,wvv,10,Sanderring - Hauptbahnhof,3,E30613,FFFFFF",
      "r3,wvv,3,Straßenbahn 3,0,,",
    ].join("\n"),
    "trips.txt": [
      "route_id,service_id,trip_id,trip_headsign,shape_id",
      "r10,daily,bus10-1,Hauptbahnhof,s10",
      "r10,daily,bus10-2,Hauptbahnhof,s10",
      "r10,daily,bus10-3,Hauptbahnhof,s10",
      "r3,daily,tram3-1,Hauptbahnhof,s3",
    ].join("\n"),
    "stop_times.txt": stopTimes.join("\n"),
    "shapes.txt": ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence", ...shapePoints("s10", [A, B, C, D]), ...shapePoints("s3", [A, D], 0.0014)].join("\n"),
  };
}

// The feed as a ZIP, the way fflate writes it (deflated, or stored with level 0).
export function gtfsZip({ level = 6, text = gtfsText() } = {}) {
  return zipSync(Object.fromEntries(Object.entries(text).map(([name, body]) => [name, strToU8(body)])), { level });
}

const CATALOG_HEADER =
  "mdb_source_id,data_type,entity_type,location.country_code,location.subdivision_name,location.municipality,provider,is_official,is_producer_url_unstable,is_seasonal,name,note,feed_contact_email,static_reference,urls.direct_download,urls.authentication_type,urls.authentication_info,urls.api_key_parameter_name,urls.latest,urls.license,location.bounding_box.minimum_latitude,location.bounding_box.maximum_latitude,location.bounding_box.minimum_longitude,location.bounding_box.maximum_longitude,location.bounding_box.extracted_on,status,features,redirect.id,redirect.comment";

// A catalog line for a feed served by the fake host, in the columns of the real catalog.
export function catalogRow({ id = 9001, country = "DE", provider = "WVV", name = "Würzburg test feed", url, latest = "", license = "", bbox = { minLat: 49.5, maxLat: 50.1, minLon: 9.5, maxLon: 10.4 }, status = "", redirect = "" }) {
  return [id, "gtfs", "", country, "Bayern", "Würzburg", provider, "", "", "", name, "", "", "", url, "0", "", "", latest, license, bbox.minLat, bbox.maxLat, bbox.minLon, bbox.maxLon, "2025-01-01T00:00:00+00:00", status, "", redirect, ""].join(",");
}

// Serves the catalog at /sources.csv and the feed at /feed.zip, counting every request.
export function fakeTransitHost(zip, { rows } = {}) {
  const calls = { catalog: 0, feed: 0 };
  let feedBody = zip;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === "/sources.csv") {
      calls.catalog++;
      res.setHeader("content-type", "text/csv");
      res.end([CATALOG_HEADER, ...(rows ?? [catalogRow({ url: host.feedUrl })])].join("\n") + "\n");
    } else if (req.url === "/feed.zip") {
      calls.feed++;
      res.setHeader("content-type", "application/zip");
      res.end(Buffer.from(feedBody));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  const host = {
    calls,
    url: null,
    feedUrl: null,
    setFeed: (body) => (feedBody = body),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      host.url = `http://127.0.0.1:${server.address().port}/sources.csv`;
      host.feedUrl = `http://127.0.0.1:${server.address().port}/feed.zip`;
      resolve(host);
    })
  );
}
