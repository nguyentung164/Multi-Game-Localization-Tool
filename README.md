# CIV7 Localization Tool

![Version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6?style=flat-square&logo=windows&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri&logoColor=black)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)

Công cụ desktop hỗ trợ **xuất, kiểm tra, đồng bộ, dịch và triển khai** bản địa hóa tiếng Việt cho **Civilization VII**.

Ứng dụng gói gọn toàn bộ pipeline vào giao diện trực quan: dry-run trước khi ghi file, backup tự động, xoay API key Gemini, cache dịch và khả năng tiếp tục tác vụ bị gián đoạn.

## Tính năng chính

- **Pipeline 5 bước** — Export → Kiểm tra & Thống kê → Đồng bộ → Dịch → Deploy, có gate logic giữa các bước
- **Dry-run / Apply** — Xem trước thay đổi trước khi ghi vào mod hoặc thư mục game
- **Dịch AI (Gemini)** — Hỗ trợ nhiều API key, xoay key khi hết quota, fallback model, cache dịch
- **Glossary** — Chuẩn hóa thuật ngữ EN → VN trong prompt dịch
- **Tra cứu** — Tìm tag/file trong dữ liệu localization
- **Báo cáo & Backup Center** — Lịch sử job, QA issues, khôi phục backup
- **An toàn dữ liệu** — Backup trước khi ghi, ghi atomic, invalidate bước phía sau khi restore
- **Bảo mật credential** — API key lưu trong Windows Credential Manager, không nằm trong file cấu hình

## Luồng pipeline

```
Export → Inspect → Sync (dry-run → apply) → Translate → Deploy (dry-run → apply)
```

| Bước          | Mô tả ngắn                                                            |
| ------------- | --------------------------------------------------------------------- |
| **Export**    | Trích xuất file localization từ bản game EN                           |
| **Inspect**   | Thống kê, so sánh EN vs mod VN (`english-only`, `vietnamese-only`, …) |
| **Sync**      | Đồng bộ cấu trúc mod VN theo bản export (dry-run rồi apply + backup)  |
| **Translate** | Dịch chuỗi còn thiếu qua Gemini API (có cache & QA)                   |
| **Deploy**    | Copy bản dịch từ mod sang thư mục game (dry-run rồi apply)            |

Lần đầu mở app, **Thiết lập nhanh** sẽ yêu cầu cấu hình:

- Thư mục game Civilization VII
- Thư mục export (bản EN)
- Thư mục mod tiếng Việt
- Ít nhất một API key Gemini (cho bước Dịch)

## Kiến trúc

| Thành phần    | Công nghệ                                                     |
| ------------- | ------------------------------------------------------------- |
| Giao diện     | React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui           |
| Shell desktop | Tauri 2 (Rust) — orchestrator, IPC, credential, job lifecycle |
| Engine xử lý  | Python (`engine/civ7_tool/`) — đóng gói PyInstaller sidecar   |
| Giao tiếp     | JSONL protocol v1 giữa Rust orchestrator và Python engine     |

## Yêu cầu hệ thống

### Chạy bản cài đặt (end user)

- Windows 10/11 x64
- Civilization VII đã cài đặt
- API key Google Gemini (cho bước dịch)

### Phát triển / build từ source

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) (stable) + MSVC toolchain
- [Python](https://www.python.org/) 3.10+ (khuyến nghị 3.13 cho build sidecar)
- PowerShell

## Bảo mật

- **Không commit** API key, file `.env`, cache dịch cá nhân
- Credential Gemini được lưu qua Windows Credential Manager
- CSP chặt trong Tauri config — app không load script ngoài

## Liên hệ & đóng góp

Mã nguồn: [https://github.com/nguyentung164/CIV7-Localization-Tool](https://github.com/nguyentung164/CIV7-Localization-Tool)

Báo lỗi hoặc đề xuất tính năng qua GitHub Issues.

---

_Dự án cộng đồng, tối ưu cho quy trình Việt hóa Civilization VII._
