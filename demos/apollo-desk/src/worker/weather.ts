import type { DeskState, WeatherReport } from "../shared/protocol";

type Location = NonNullable<DeskState["location"]>;

const WMO: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  66: "freezing rain", 67: "heavy freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "rain showers", 81: "rain showers", 82: "violent rain showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": "tech-demos-apollo-desk (theserverless.dev)" }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}.`);
  return (await res.json()) as T;
}

/** Open-Meteo geocoding. It needs no API key. */
export async function geocode(query: string): Promise<Location> {
  const name = query.split(",")[0]!.trim().slice(0, 80);
  if (!name) throw new Error("Say a city name.");
  const data = await getJson<{ results?: { name: string; country?: string; admin1?: string; latitude: number; longitude: number; timezone?: string }[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(name)}`,
  );
  const hit = data.results?.[0];
  if (!hit) throw new Error(`I could not find a place called ${name}.`);
  const label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(", ");
  return { label, latitude: hit.latitude, longitude: hit.longitude, timezone: hit.timezone ?? "UTC" };
}

export async function currentWeather(loc: Location): Promise<WeatherReport> {
  const data = await getJson<{
    current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
    daily?: { temperature_2m_max: number[]; temperature_2m_min: number[] };
  }>(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto`,
  );
  if (!data.current) throw new Error("Open-Meteo sent no current weather.");
  return {
    locationLabel: loc.label,
    temperatureC: Math.round(data.current.temperature_2m),
    conditionLabel: WMO[data.current.weather_code] ?? "unknown sky",
    highC: data.daily ? Math.round(data.daily.temperature_2m_max[0]!) : undefined,
    lowC: data.daily ? Math.round(data.daily.temperature_2m_min[0]!) : undefined,
    windKph: Math.round(data.current.wind_speed_10m),
    updatedAt: new Date().toISOString(),
  };
}
