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

export type HelpGameId = "civ7" | "legend"

export interface HelpGameGuide {
  id: HelpGameId
  title: string
  summary: string
  sections: HelpSection[]
  faq: HelpFaqItem[]
}

export const helpGameGuides: HelpGameGuide[] = [
  {
    id: "civ7",
    title: "Sid Meier's Civilization VII",
    summary:
      "Pipeline 5 bước cho localization .xml/.vtt: export, kiểm tra, đồng bộ mod, dịch Gemini và triển khai vào thư mục game.",
    sections: [
      {
        id: "civ7-start",
        title: "Bắt đầu",
        body: [
          "Vào Cài đặt trong menu Civilization VII để khai báo thư mục game Steam, thư mục export tiếng Anh và mod Việt.",
          "Thêm ít nhất một API key Gemini trong Cài đặt ứng dụng (dưới Giới thiệu) trước khi chạy bước Dịch.",
          "Theo dõi tiến trình tại Tổng quan hoặc Pipeline; báo cáo chi tiết nằm trong mục Báo cáo.",
        ],
      },
      {
        id: "civ7-pipeline",
        title: "Pipeline 5 bước",
        body: [
          "Export → Kiểm tra & Thống kê → Đồng bộ → Dịch → Deploy.",
          "Mỗi bước có gate logic: bước sau chỉ mở khi bước trước hoàn tất hoặc được bỏ qua hợp lệ.",
          "Job chỉ chạy một tác vụ tại một thời điểm; có thể hủy và tiếp tục (Resume) với cache dịch.",
        ],
      },
      {
        id: "civ7-dry-run",
        title: "Dry-run và Áp dụng",
        body: [
          "Đồng bộ và Deploy luôn chạy dry-run trước để xem trước thay đổi mà không ghi vào mod/game.",
          "Sau dry-run, app giữ fingerprint/preview. Bạn xem danh sách thay đổi rồi bấm Áp dụng.",
          "Áp dụng Đồng bộ backup file mod rồi ghi atomic. Áp dụng Deploy copy từ mod sang thư mục game.",
        ],
      },
      {
        id: "civ7-safety",
        title: "An toàn dữ liệu",
        body: [
          "Mọi thao tác ghi quan trọng đều có backup trong Backup Center (mục Báo cáo).",
          "Khôi phục backup sẽ invalidate các bước phía sau để tránh trạng thái lệch.",
          "Xóa cache dịch chỉ ảnh hưởng file cache Gemini — không xóa bản dịch trong mod.",
        ],
      },
      {
        id: "civ7-translate",
        title: "API và Dịch",
        body: [
          "Có thể thêm nhiều API key; số luồng song song = min(số key đang bật, số batch). Mỗi luồng gửi tối đa 1 request trên 1 key.",
          "Key thừa không gọi API — giữ làm dự phòng. Hết quota ngày trên một key thì worker đó chuyển sang key dự phòng (không xoay tuần tự cả job).",
          "Chuỗi fallback model thử lần lượt trên từng key trước khi lấy key dự phòng.",
          "Cache dịch giúp tiết kiệm quota; QA sau dịch chỉ báo lỗi — không tự sửa file.",
        ],
      },
      {
        id: "civ7-glossary",
        title: "Glossary",
        body: [
          "Glossary là file JSON dạng object: thuật ngữ nguồn → bản dịch chuẩn.",
          "Engine đưa glossary vào prompt khi dịch để thống nhất tên riêng và thuật ngữ.",
          "Chỉnh glossary trong mục Glossary; lưu xong cần chạy lại Dịch cho các mục chưa cache.",
        ],
      },
    ],
    faq: [
      {
        id: "civ7-faq-translate-locked",
        question: "Tại sao bước Dịch bị khóa?",
        answer:
          "Thường do chưa hoàn tất Đồng bộ, chưa áp dụng preview Đồng bộ, hoặc chưa có API key hợp lệ. Kiểm tra Cài đặt game, Cài đặt ứng dụng và trạng thái bước Sync.",
      },
      {
        id: "civ7-faq-dry-run",
        question: "Dry-run khác gì Apply?",
        answer:
          "Dry-run chỉ quét và hiển thị preview. Apply mới thực sự ghi file (sau backup).",
      },
      {
        id: "civ7-faq-cache",
        question: "Xóa cache có mất bản dịch trong mod không?",
        answer:
          "Không. Cache chỉ lưu kết quả API để tái sử dụng. Bản dịch trong mod vẫn giữ nguyên.",
      },
      {
        id: "civ7-faq-english-only",
        question: "Inspect báo english-only nghĩa là gì?",
        answer:
          "File có trong bản export EN nhưng chưa có trong mod VN. Bước Đồng bộ sẽ thêm cấu trúc tương ứng.",
      },
      {
        id: "civ7-faq-vietnamese-only",
        question: "vietnamese-only là gì?",
        answer:
          "File hoặc tag chỉ có ở mod VN, không còn trong EN. Đồng bộ có thể đánh dấu để xóa nếu EN đã bỏ.",
      },
      {
        id: "civ7-faq-glossary-format",
        question: "Glossary JSON format thế nào?",
        answer:
          'Object đơn giản, ví dụ: { "Civilization": "Nền văn minh", "District": "Quận" }.',
      },
    ],
  },
  {
    id: "legend",
    title: "Legend of Heroes Three Kingdoms",
    summary:
      "Dịch file AutoTranslator Trung → Việt: kiểm tra file, dịch câu mới, duyệt diff từng trang, QA và áp dụng có backup.",
    sections: [
      {
        id: "legend-start",
        title: "Bắt đầu",
        body: [
          "Chọn file bản dịch và thư mục game trong Cài đặt, rồi vào Dịch bấm Kiểm tra để xem encoding, số dòng và cảnh báo cú pháp.",
          "Thêm API key Gemini trong Cài đặt ứng dụng trước khi dịch. Chỉ một job chạy tại một thời điểm trên toàn app.",
          "Job Console trên trang Dịch hiện started/warning/lỗi/completed. Lọc mức Lỗi khi cần xem vì sao job dừng.",
          "File gốc không bị sửa khi gọi API; mọi thay đổi chỉ ghi sau khi bạn xác nhận Apply.",
        ],
      },
      {
        id: "legend-estimate",
        title: "Ước tính và dịch",
        body: [
          "Sau khi kiểm tra file, panel ước tính hiện 3 chỉ số: câu cần dịch, số lần gọi API (đã gom theo batch), và thời gian ước tính.",
          "Nút Dịch câu mới chỉ xử lý key chưa xong. Nút Dịch lại tất cả bỏ qua bản Việt đã có và không dùng cache — dùng khi muốn làm lại chất lượng. Muốn sửa vài câu thì tick trong bảng diff rồi Dịch lại đã chọn, hoặc bấm icon dịch trên từng dòng.",
          "Bảng diff phân trang; lọc Còn chữ Hán / Lỗi / Cảnh báo do backend trả về từng trang, không tải cả file vào giao diện.",
        ],
      },
      {
        id: "legend-preview",
        title: "Preview, QA và chỉnh sửa",
        body: [
          "Sau dịch toàn bộ, duyệt diff: chọn/bỏ chọn từng dòng, sửa bản dịch rồi bấm Lưu file — lúc đó QA mới chạy lại trên chữ vừa sửa. Chỉ gõ trong ô thì cột QA vẫn là lần kiểm tra trước.",
          "Lọc Còn chữ Hán để xem dòng sót Hán. Dịch lại gửi mọi dòng còn chữ Hán hoặc thiếu thuật ngữ bắt buộc; Dịch lại đã chọn chỉ gửi dòng đang tick trong bộ lọc. Icon dịch ở cột cuối chỉ dịch đúng dòng đó. Chỉ cần lưu khi đã sửa chữ, không phải khi chỉ đổi chọn.",
          "Bỏ chọn chỉ ảnh hưởng Apply (giữ bản cũ trên file); QA luôn kiểm tra bản dịch đề xuất trong cột Sau. Làm mới QA không lưu thay đổi tick — chỉ chạy lại kiểm tra.",
          "Thuật ngữ bắt buộc (tên người, đồ độc, nhãn [瞬], glossary khóa) thiếu thì là lỗi, chặn Apply. Thuật ngữ ưu tiên (ví dụ 火计 → Hỏa Kế trong câu kể) thiếu thì chỉ cảnh báo — trừ khi cả dòng nguồn đúng là nhãn đó.",
          "Apply bị chặn khi QA còn lỗi blocking, preview stale hoặc glossary hash không khớp.",
        ],
      },
      {
        id: "legend-search",
        title: "Tra cứu",
        body: [
          "Menu Tra cứu tìm trong file nguồn XUnity đã chọn ở Cài đặt: tiếng Trung, tiếng Việt hoặc số dòng.",
          "Bấm ô Tiếng Việt để sửa trực tiếp. Replace / Replace All chỉ thay trên cột tiếng Việt, ghi thẳng vào file nguồn (không đụng file game cho đến khi Deploy).",
          "Kết quả giới hạn 500 dòng. Phân biệt hoa/thường và khớp nguyên từ giống Tra cứu của Civilization VII.",
        ],
      },
      {
        id: "legend-glossary",
        title: "Glossary Tam Quốc",
        body: [
          "Quản lý thuật ngữ Trung → Việt; entry khóa được áp dụng bắt buộc trong QA và dịch. Nên khóa tên người và vật phẩm lịch sử theo đúng tên Hán–Việt đã định danh (ví dụ 冯绮凡 → Phùng Khởi Phàm).",
          "Hỗ trợ merge/replace khi import, thao tác hàng loạt và export schema v2 hoặc map phẳng.",
          "Lưu glossary active làm QA preview hiện tại thành stale — cần chạy lại QA trước Apply.",
        ],
      },
      {
        id: "legend-settings",
        title: "Cài đặt",
        body: [
          "Chọn file nguồn XUnity và thư mục game (…\\BepInEx\\Translation\\vi\\Text) tại trang Cài đặt.",
          "Trang Dịch dùng các đường dẫn này để Kiểm tra, dịch và deploy. File gốc không bị sửa khi gọi API.",
        ],
      },
      {
        id: "legend-json-pipeline",
        title: "JSON Pipeline",
        body: [
          "Quét JSON game chỉ đọc: không sửa file JSON. Bản dịch được lưu trong SQLite incremental của ứng dụng.",
          "Preview + Apply mới ghi vào AutoGeneratedTranslations.txt (file chính, không có dấu _). File runtime _AutoGeneratedTranslations.txt không bị đụng.",
          "Khi QA chặn Apply, dùng Apply dòng OK để merge các dòng sạch; dòng lỗi giữ trong SQLite và không ghi file lần đó.",
          "Backup Apply nằm trên trang JSON Pipeline, độc lập với preview đang mở. Restore backup mới nhất hoặc chọn trong danh sách. Nếu file chính đã đổi sau Apply, cần xác nhận force restore.",
          "Chỉ một job chạy trên toàn app: Civilization VII, Dịch Tam Quốc và JSON Pipeline khóa lẫn nhau.",
        ],
      },
      {
        id: "legend-history",
        title: "Báo cáo",
        body: [
          "Theo dõi preview dịch gần đây và quản lý backup Apply trong AppData.",
          "Tab Lịch sử chạy liệt kê artifact JSON preview — mở bảng diff hoặc file kỹ thuật.",
          "Tab Backup Center: mỗi lần Apply tạo backup có manifest. Restore luôn tạo safety snapshot trước khi ghi.",
          "Thư mục game (deploy) nằm ở Cài đặt: Apply backup và ghi đè _AutoGeneratedTranslations.txt trong thư mục đó.",
          "Force restore chỉ dùng khi fingerprint xung đột; source hoặc path không tin cậy luôn bị từ chối.",
        ],
      },
    ],
    faq: [
      {
        id: "legend-faq-qa",
        question: "Vì sao không cho Apply?",
        answer:
          "Bản dịch thử cũ không còn được Apply. Sửa hết lỗi blocking như sót chữ Hán, mất token/regex, target rỗng hoặc vi phạm glossary khóa. Có thể lọc Còn chữ Hán rồi bấm Dịch lại (kể cả dòng thiếu thuật ngữ mà không còn Hán), hoặc tick vài dòng rồi Dịch lại đã chọn.",
      },
      {
        id: "legend-faq-stale",
        question: "QA stale nghĩa là gì?",
        answer:
          "Preview hoặc glossary đã thay đổi sau lần QA cuối. Sửa chữ trong ô chưa đủ: phải Lưu file (hoặc Làm mới QA nếu không sửa chữ) trước khi Apply.",
      },
      {
        id: "legend-faq-unselected",
        question: "Bỏ chọn một dòng thì file ghi thế nào?",
        answer:
          "Dòng bỏ chọn giữ nguyên byte trên file nguồn (escape, khoảng trắng, xuống dòng). Chỉ dòng được chọn mới ghi bản dịch mới.",
      },
      {
        id: "legend-faq-backup",
        question: "Backup Legend lưu ở đâu?",
        answer:
          "Trong AppData của app, liệt kê tại Báo cáo của Legend (tab Backup Center). Safety backup cũng xuất hiện trong danh sách đó, không nằm trong Backup Center của Civilization VII.",
      },
      {
        id: "legend-faq-json-read-only",
        question: "JSON Pipeline có sửa file JSON game không?",
        answer:
          "Không. Quét chỉ đọc. Bản dịch nằm trong SQLite. Chỉ Preview + Apply mới merge vào AutoGeneratedTranslations.txt; file có dấu _ không bị sửa.",
      },
      {
        id: "legend-faq-json-backup",
        question: "Restore JSON Pipeline ở đâu?",
        answer:
          "Trên trang JSON Pipeline, card Backup Apply. Nếu file chính đã đổi sau Apply, xác nhận force restore.",
      },
      {
        id: "legend-faq-json-one-job",
        question: "Có dịch JSON khi Civilization VII hoặc Tam Quốc đang chạy không?",
        answer:
          "Không. App chỉ cho một job tại một thời điểm, gồm cả JSON Pipeline.",
      },
    ],
  },
]

/** FAQ dùng chung cho mọi profile game */
export const helpSharedFaq: HelpFaqItem[] = [
  {
    id: "shared-faq-quota",
    question: "Hết quota API thì sao?",
    answer:
      "Tác vụ tạm dừng. Thêm key dự phòng hoặc đợi reset quota, rồi bấm Tiếp tục.",
  },
  {
    id: "shared-faq-credential",
    question: "API key được lưu ở đâu?",
    answer:
      "Trong Windows Credential Manager, không nằm trong file cấu hình hay log.",
  },
  {
    id: "shared-faq-one-job",
    question: "Vì sao không chạy song song hai tác vụ?",
    answer:
      "App khóa một job toàn cục (Civilization VII, Dịch Tam Quốc và JSON Pipeline) để tránh ghi file hoặc preview đè lẫn nhau giữa các profile.",
  },
  {
    id: "shared-faq-update",
    question: "Làm sao cập nhật app?",
    answer:
      "Bản cài desktop tự kiểm tra GitHub Releases khi mở app và hiện dialog xác nhận. Có thể kiểm tra tay ở Giới thiệu hoặc Cài đặt ứng dụng → Hệ thống.",
  },
]
