// Amounts as exact decimal text, and back. Amounts are always printed with the token symbol after a space
// ("1.5 NEAR"), numbers never in scientific notation.

/** Raw units to an exact decimal string, trailing zeros dropped. */
export function units(raw: bigint, dec: number): string {
  const neg = raw < 0n, v = neg ? -raw : raw;
  const s = v.toString().padStart(dec + 1, "0");
  const int = s.slice(0, s.length - dec) || "0", frac = dec ? s.slice(s.length - dec).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

/** A short form for people: up to `maxFrac` decimals, or 4 significant digits for small amounts. */
export function short(raw: bigint, dec: number, maxFrac = 6): string {
  const exact = units(raw, dec);
  const [int, frac = ""] = exact.replace("-", "").split(".");
  const sign = exact.startsWith("-") ? "-" : "";
  if (int !== "0" || !frac) {
    const f = frac.slice(0, maxFrac).replace(/0+$/, "");
    return sign + int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
  }
  const lead = frac.length - frac.replace(/^0+/, "").length;
  const f = frac.slice(0, Math.max(maxFrac, lead + 4)).replace(/0+$/, "");
  return sign + "0" + (f ? "." + f : "");
}

export const amountText = (raw: bigint, dec: number, symbol: string): string => `${short(raw, dec)} ${symbol}`;

/** A decimal amount ("0.1", "1,000.5") to raw units; null when it isn't a positive amount with at most `dec` decimals. */
export function toRaw(text: string | number, dec: number): bigint | null {
  const s = String(text).trim().replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] || "";
  if (frac.length > dec) return null;
  const raw = BigInt(m[1] + frac.padEnd(dec, "0"));
  return raw > 0n ? raw : null;
}
