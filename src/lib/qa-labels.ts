const QA_RULE_LABELS: Record<string, string> = {
  untranslated: "Còn tiếng Anh",
  "missing-token": "Thiếu token hoặc plural",
  "invalid-file": "File không hợp lệ",
  "xml-structure": "Cấu trúc XML lệch EN",
  "vtt-structure": "Cấu trúc VTT lệch EN",
  "missing-file": "Thiếu file so với EN",
  "extra-file": "File thừa so với EN",
  "empty-target": "Bản dịch rỗng",
  "locked-glossary": "Thuật ngữ khóa",
  "source-equals-target": "Giống nguyên văn",
  "han-remaining": "Còn chữ Hán",
  "same-as-source": "Giống nguyên văn",
  "protected-token": "Placeholder/tag lệch nguồn",
  "composite-structure": "Lệch cấu trúc composite/DSL",
  "source-conflict": "Cùng nguồn khác bản dịch",
  "encoding-roundtrip": "Lỗi encoding UTF-8",
  "duplicate-inconsistent": "Cùng nguồn khác bản dịch",
  "structure-drift": "Lệch cấu trúc file",
  "term-success": "Thiếu thuật ngữ",
  "term-preferred": "Thuật ngữ ưu tiên",
}

export function qaRuleLabel(rule: string): string {
  return QA_RULE_LABELS[rule] ?? rule
}
