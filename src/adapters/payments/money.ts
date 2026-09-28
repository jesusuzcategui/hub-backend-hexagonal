import { isSupportedCurrency, minorUnitExponent } from "hexagonal-payments-core";

/**
 * Converts a provider's decimal major-unit amount (e.g. ePayco's x_amount
 * "50.00", PayPal's amount.value "50.00") into our integer amountMinor,
 * using the currency's actual exponent (COP=0, USD=2) instead of a
 * hardcoded /100 or *100 — a hardcoded conversion is wrong for zero-decimal
 * currencies like COP (confirmed as a real bug in both provider adapters
 * before this shared helper existed).
 */
export function toAmountMinor(decimalAmount: string, currencyCode: string): number | undefined {
  const currency = currencyCode.toUpperCase();
  if (!isSupportedCurrency(currency)) return undefined;
  const exponent = minorUnitExponent(currency);
  const major = Number(decimalAmount);
  if (!Number.isFinite(major)) return undefined;
  return Math.round(major * 10 ** exponent);
}

/** Inverse of toAmountMinor — our amountMinor (integer) to a provider's decimal major-unit string. */
export function toDecimalMajor(amountMinor: number, currency: string): string {
  const exponent = isSupportedCurrency(currency) ? minorUnitExponent(currency) : 2;
  return (amountMinor / 10 ** exponent).toFixed(exponent);
}
