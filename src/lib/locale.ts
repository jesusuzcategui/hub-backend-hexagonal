export type Locale = "es" | "en";

export const SUPPORTED_LOCALES: readonly Locale[] = ["es", "en"];

/** Anything that is not exactly "es" or "en" becomes "es" (the platform default). */
export function normalizeLocale(value: unknown): Locale {
  return value === "en" ? "en" : "es";
}

// The hub schedules every class in Bogota time (see schedule.service.ts), so every
// student-facing date is rendered in that zone and says so explicitly.
export const CLASS_TIME_ZONE = "America/Bogota";

const ZONE_LABEL: Record<Locale, string> = {
  es: "hora de Bogotá, UTC-5",
  en: "Bogotá time, UTC-5",
};

export function zoneLabel(locale: Locale): string {
  return ZONE_LABEL[locale];
}

/** "viernes, 10 de octubre de 2026, 3:00 p. m." (no zone suffix). */
export function formatClassDateTime(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-CO", {
    timeZone: CLASS_TIME_ZONE,
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);
}

/** Short form for subjects: "vie, 10 oct, 3:00 p. m." */
export function formatClassDateTimeShort(date: Date, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "es-CO", {
    timeZone: CLASS_TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
