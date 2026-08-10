export interface GlossaryRow {
  id: string
  key: string
  value: string
}

export function entriesToRows(entries: Record<string, string>): GlossaryRow[] {
  return Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value], index) => ({
      id: `row-${index}-${key}`,
      key,
      value,
    }))
}

export function rowsToEntries(rows: GlossaryRow[]): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const row of rows) {
    entries[row.key] = row.value
  }
  return entries
}

export function validateGlossaryRows(rows: GlossaryRow[]): string[] {
  const errors: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (!key) {
      errors.push("Có thuật ngữ EN trống.")
      continue
    }
    if (!value) {
      errors.push(`"${key}" chưa có bản dịch VN.`)
    }
    const normalized = key.toLocaleLowerCase()
    if (seen.has(normalized)) {
      errors.push(`Thuật ngữ trùng: ${key}`)
    }
    seen.add(normalized)
  }
  return [...new Set(errors)]
}
