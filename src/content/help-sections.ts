export interface HelpSection {
  id: string
  title: string
  body: string[]
}

export interface HelpFaqItem {
  id: string
  question: string
  answer: string
}

export const helpSections: HelpSection[] = [
  {
    id: "quick-start",
    title: "Bắt đầu nhanh",
    body: [
      "Pipeline gồm 5 bước tuần tự: Export → Kiểm tra → Đồng bộ → Dịch → Deploy.",
      "Lần đầu dùng app, mở Thiết lập nhanh để cấu hình thư mục game, export và mod VN.",
      "Thêm ít nhất một API key Gemini trước khi chạy bước Dịch.",
      "Theo dõi tiến trình tại Tổng quan hoặc Pipeline; báo cáo chi tiết nằm trong mục Báo cáo.",
    ],
  },
  {
    id: "dry-run",
    title: "Dry-run và Áp dụng",
    body: [
      "Đồng bộ và Deploy luôn chạy dry-run trước để xem trước thay đổi mà không ghi vào mod/game.",
      "Sau dry-run, app giữ fingerprint/preview. Bạn xem danh sách thay đổi rồi bấm Áp dụng.",
      "Áp dụng Đồng bộ sẽ backup file mod rồi ghi atomic. Áp dụng Deploy copy từ mod sang thư mục game.",
      "Nếu preview trống, bước tiếp theo có thể được bỏ qua tự động (ví dụ Deploy khi mod đã khớp game).",
    ],
  },
  {
    id: "safety",
    title: "An toàn dữ liệu",
    body: [
      "Mọi thao tác ghi quan trọng đều có backup trong Backup Center (mục Báo cáo).",
      "Khôi phục backup sẽ invalidate các bước phía sau để tránh trạng thái lệch.",
      "Credential API được lưu trong Windows Credential Manager, không nằm trong file cấu hình.",
      "Xóa cache dịch chỉ ảnh hưởng file cache Gemini — không xóa bản dịch trong mod.",
    ],
  },
  {
    id: "translate",
    title: "API và Dịch",
    body: [
      "Có thể thêm nhiều API key; app xoay key khi hết quota hoặc bị rate-limit.",
      "Chuỗi fallback model thử lần lượt trước khi chuyển sang key tiếp theo.",
      "Cache dịch giúp tiết kiệm quota; tác vụ tạm dừng có thể tiếp tục bằng Resume.",
      "QA sau dịch chỉ báo lỗi — không tự sửa file; dùng tag/file để chỉnh thủ công.",
    ],
  },
  {
    id: "glossary",
    title: "Glossary",
    body: [
      "Glossary là file JSON dạng object: thuật ngữ EN → bản dịch VN chuẩn.",
      "Engine đưa glossary vào prompt khi dịch để thống nhất tên riêng, thuật ngữ game.",
      "Chỉnh glossary trong mục Glossary; lưu xong cần chạy lại Dịch cho các mục chưa cache.",
    ],
  },
]

export const helpFaq: HelpFaqItem[] = [
  {
    id: "faq-translate-locked",
    question: "Tại sao bước Dịch bị khóa?",
    answer:
      "Thường do chưa hoàn tất Đồng bộ, chưa áp dụng preview Đồng bộ, hoặc chưa có API key hợp lệ. Kiểm tra Setup và trạng thái bước Sync.",
  },
  {
    id: "faq-dry-run",
    question: "Dry-run khác gì Apply?",
    answer:
      "Dry-run chỉ quét và hiển thị preview. Apply mới thực sự ghi file (sau backup).",
  },
  {
    id: "faq-cache",
    question: "Xóa cache có mất bản dịch trong mod không?",
    answer:
      "Không. Cache chỉ lưu kết quả API để tái sử dụng. Bản dịch trong mod vẫn giữ nguyên.",
  },
  {
    id: "faq-english-only",
    question: "Inspect báo english-only nghĩa là gì?",
    answer:
      "File có trong bản export EN nhưng chưa có trong mod VN. Bước Đồng bộ sẽ thêm cấu trúc tương ứng.",
  },
  {
    id: "faq-vietnamese-only",
    question: "vietnamese-only là gì?",
    answer:
      "File hoặc tag chỉ có ở mod VN, không còn trong EN. Đồng bộ có thể đánh dấu để xóa nếu EN đã bỏ.",
  },
  {
    id: "faq-quota",
    question: "Hết quota API thì sao?",
    answer:
      "Tác vụ tạm dừng. Thêm key dự phòng hoặc đợi reset quota, rồi bấm Tiếp tục.",
  },
  {
    id: "faq-backup",
    question: "Backup lưu ở đâu?",
    answer:
      "Trong AppData của app và liệt kê tại Backup Center. Có thể khôi phục từng backup hợp lệ.",
  },
  {
    id: "faq-glossary-format",
    question: "Glossary JSON format thế nào?",
    answer:
      'Object đơn giản, ví dụ: { "Civilization": "Nền văn minh", "District": "Quận" }.',
  },
]
