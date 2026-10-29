export function addYears(date: Date, years: number): Date {
  const out = new Date(date.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  return out;
}

export function subYears(date: Date, years: number): Date {
  return addYears(date, -years);
}
