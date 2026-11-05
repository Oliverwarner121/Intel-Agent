import { z } from "zod";
import { weatherLocations } from "@/config/weather-locations";
import { fetchJson, HttpError } from "@/lib/http";
import { SafeError, type WeatherProvider } from "@/types/briefing";
import type { WeatherForecast, WeatherLocationResult } from "@/types/weather";

const conditions: Readonly<Record<number, string>> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Depositing rime fog",
  51: "Light drizzle", 53: "Moderate drizzle", 55: "Dense drizzle",
  56: "Light freezing drizzle", 57: "Dense freezing drizzle",
  61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
  66: "Light freezing rain", 67: "Heavy freezing rain",
  71: "Slight snowfall", 73: "Moderate snowfall", 75: "Heavy snowfall", 77: "Snow grains",
  80: "Slight rain showers", 81: "Moderate rain showers", 82: "Violent rain showers",
  85: "Slight snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with slight hail", 99: "Thunderstorm with heavy hail",
};

const responseSchema = z.object({
  timezone: z.literal("Europe/London"),
  daily_units: z.object({
    time: z.literal("iso8601"), weather_code: z.literal("wmo code"),
    temperature_2m_min: z.literal("\u00b0C"), temperature_2m_max: z.literal("\u00b0C"),
    precipitation_probability_max: z.literal("%"), wind_speed_10m_max: z.literal("km/h"),
  }),
  daily: z.object({
    time: z.array(z.iso.date()).length(1),
    weather_code: z.array(z.int().refine((code) => conditions[code] !== undefined)).length(1),
    temperature_2m_min: z.array(z.number().finite()).length(1),
    temperature_2m_max: z.array(z.number().finite()).length(1),
    precipitation_probability_max: z.array(z.number().min(0).max(100).nullable()).length(1),
    wind_speed_10m_max: z.array(z.number().min(0).finite().nullable()).length(1),
  }),
});

export function createOpenMeteoProvider(fetchImpl?: typeof fetch): WeatherProvider {
  return async ({ locationIds, reportingDate, timezone, signal }) => {
    if (timezone !== "Europe/London" || !z.iso.date().safeParse(reportingDate).success) {
      throw new SafeError("Weather requires a valid London reporting date");
    }
    if (locationIds.length === 0 || new Set(locationIds).size !== locationIds.length) {
      throw new SafeError("Weather requires distinct configured locations");
    }
    const locations = locationIds.map((id) => {
      const location = weatherLocations.find((candidate) => candidate.id === id);
      if (!location) throw new SafeError(`Weather location "${id}" is not configured`);
      return location;
    });
    return Promise.all(locations.map(async (location): Promise<WeatherLocationResult> => {
      try {
        const params = new URLSearchParams({
          latitude: String(location.latitude), longitude: String(location.longitude),
          daily: "weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max",
          timezone, start_date: reportingDate, end_date: reportingDate,
          temperature_unit: "celsius", wind_speed_unit: "kmh",
        });
        const response = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, responseSchema, {
          signal, timeoutMs: 6_000, retries: 1, maxResponseBytes: 32_768,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        const daily = response.daily;
        const minimum = daily.temperature_2m_min[0];
        const maximum = daily.temperature_2m_max[0];
        const code = daily.weather_code[0];
        const summary = code === undefined ? undefined : conditions[code];
        if (daily.time[0] !== reportingDate || minimum === undefined || maximum === undefined ||
          minimum > maximum || !summary) {
          throw new SafeError("Forecast does not match the requested day or temperature range");
        }
        const forecast: WeatherForecast = {
          locationId: location.id, locationName: location.name, date: reportingDate,
          summary, temperatureMinC: minimum, temperatureMaxC: maximum,
          attribution: {
            name: "Open-Meteo", url: "https://open-meteo.com/",
            licenceUrl: "https://creativecommons.org/licenses/by/4.0/",
          },
        };
        const precipitation = daily.precipitation_probability_max[0];
        const wind = daily.wind_speed_10m_max[0];
        if (precipitation !== null && precipitation !== undefined) forecast.precipitationProbabilityPercent = precipitation;
        if (wind !== null && wind !== undefined) forecast.windSpeedMaxKph = wind;
        return forecast;
      } catch (error) {
        return {
          locationId: location.id, locationName: location.name, date: reportingDate,
          unavailableReason: error instanceof SafeError ? error.message
            : error instanceof HttpError ? `Forecast request failed (${error.message})` : "Forecast request failed",
        };
      }
    }));
  };
}
