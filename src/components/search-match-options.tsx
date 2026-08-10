import { Checkbox } from "@/components/ui/checkbox"

export function SearchMatchOptions({
  caseSensitive,
  wholeWord,
  onCaseSensitiveChange,
  onWholeWordChange,
}: {
  caseSensitive: boolean
  wholeWord: boolean
  onCaseSensitiveChange: (checked: boolean) => void
  onWholeWordChange: (checked: boolean) => void
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2"
      aria-label="Tùy chọn khớp tìm kiếm"
    >
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox
          checked={caseSensitive}
          onCheckedChange={(checked) => onCaseSensitiveChange(checked === true)}
        />
        Phân biệt hoa/thường
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox
          checked={wholeWord}
          onCheckedChange={(checked) => onWholeWordChange(checked === true)}
        />
        Khớp nguyên từ
      </label>
    </div>
  )
}
