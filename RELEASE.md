# Quy trình release

Checklist ngắn khi phát hành phiên bản mới.

## 1. Bump version

Cập nhật cùng một số version ở các file sau:

| File                        | Ví dụ                |
| --------------------------- | -------------------- |
| `src-tauri/tauri.conf.json` | `"version": "1.1.0"` |
| `package.json`              | `"version": "1.1.0"` |

(Tùy chọn: `src/lib/app-meta.ts`, badge version trong `README.md`)

## 2. Commit & push

```powershell
git add .
git commit -m "chore: release v1.1.0"
git push origin master
```

## 3. Tạo tag & push

Tag phải bắt đầu bằng `v` và khớp version:

```powershell
git tag v1.1.0
git push origin v1.1.0
```

## 4. Chờ GitHub Actions

- Workflow: `.github/workflows/release.yml`
- Theo dõi: **GitHub → Actions → Release**
- Kết quả: **GitHub → Releases** → file `*-setup.exe` (Windows x64)

Build thường mất **10–20 phút**.

## 5. Kiểm tra sau khi release

- [ ] Release xuất hiện trên tab **Releases**
- [ ] Có file installer `.exe` trong Assets
- [ ] Version hiển thị đúng
- [ ] Cài thử trên Windows sạch (nếu có thể)

---

## Build local (không qua GitHub)

```powershell
npm run build:release
```

Output:

```
src-tauri/target/release/bundle/nsis/Multi-Game Localization Tool_<version>_x64-setup.exe
```

## Sửa release lỗi (re-build cùng tag)

```powershell
git tag v1.1.0 -f
git push origin v1.1.0 -f
```

## Lưu ý

- Chỉ push tag **sau khi** code đã lên `master`
- `npm ci` trên CI yêu cầu `package-lock.json` đồng bộ với `package.json` — chạy `npm install` trước khi commit nếu đổi dependency
- CI dùng **Node 24**, **Python 3.13**, **Rust stable** trên `windows-latest`
