const QA_RULE_LABELS: Record<string, string> = {
  untranslated: "Còn tiếng Anh",
  "missing-token": "Thiếu token hoặc plural",
  "invalid-file": "File không hợp lệ",
  "xml-structure": "Cấu trúc XML lệch EN",
  "vtt-structure": "Cấu trúc VTT lệch EN",
  "missing-file": "Thiếu file so với EN",
  "extra-file": "File thừa so với EN",
}

export function qaRuleLabel(rule: string): string {
  return QA_RULE_LABELS[rule] ?? rule
}
