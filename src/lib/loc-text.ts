/**
 * Chuẩn hóa nội dung LOC cho hiển thị bảng.
 * Engine ghép nhiều thẻ <Text> bằng \n — kèm indent tab từ XML — gây xuống dòng/thụt lề lạ trên UI.
 */
export function formatLocDisplayText(text: string): string {
  if (!text) return text
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n[\t ]*/g, " ")
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .trim()
}
