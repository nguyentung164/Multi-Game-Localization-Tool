# Quy trình release

Checklist ngắn khi phát hành phiên bản mới.

## 1. Bump version

Cập nhật cùng một số version ở các file sau **trước khi tag**. Bản đầu tiên có updater phải là version **mới** (ví dụ `9.9.9`) — không rebuild / không gắn updater vào tag `v9.9.9` đã phát hành.

| File                        | Ví dụ                |
| --------------------------- | -------------------- |
| `src-tauri/tauri.conf.json` | `"version": "9.9.9"` |
| `package.json`              | `"version": "9.9.9"` |

(Tùy chọn: `src/lib/app-meta.ts`, badge version trong `README.md`)

## 2. Commit & push

```powershell
git add .
git commit -m "chore: release v9.9.9"
git push origin master
```

## 3. Tạo tag & push

Tag phải bắt đầu bằng `v` và khớp version:

```powershell
git tag v9.9.9
git push origin v9.9.9
```

## 4. Chờ GitHub Actions

- Workflow: `.github/workflows/release.yml`
- Theo dõi: **GitHub → Actions → Release**
- Kết quả: **GitHub → Releases** → file `*-setup.exe` (Windows x64), `latest.json` và chữ ký `.sig`

Build thường mất **10–20 phút**.

## 5. Kiểm tra sau khi release

- [ ] Release xuất hiện trên tab **Releases**
- [ ] Có file installer `.exe` trong Assets
- [ ] Có `latest.json` (và file `.sig`) để updater trong app đọc được
- [ ] Version hiển thị đúng
- [ ] Cài thử trên Windows sạch (nếu có thể)

---

## Updater trong app (ký artifact)

Updater dùng minisign của Tauri, **không** phải Authenticode Windows.

### Secrets trên GitHub (một lần)

Repo → **Settings → Secrets and variables → Actions**:

- `TAURI_SIGNING_PRIVATE_KEY` — **nội dung** private key (không commit)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — để trống nếu key không có password

Public key nằm trong `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

Nếu chưa có key trên máy:

```powershell
npm run tauri signer generate -- --ci -w $env:USERPROFILE\.tauri\localization-tool.key
```

Mất private key thì **không ký được bản cập nhật tiếp theo** — phải tạo cặp mới và phát hành bản cài tay.

### Bản đầu tiên có updater

User đang dùng bản **chưa** có plugin updater (v9.9.9 trên Releases hiện tại) **không** tự OTA lên bản đầu tiên có updater. Họ tải `.exe` trên Releases một lần.

Khi phát hành updater lần đầu:

- [ ] Bump version lên **9.9.9** (hoặc cao hơn) ở `package.json` + `src-tauri/tauri.conf.json`
- [ ] **Không** tag lại `v9.9.9`
- [ ] Có GitHub secret `TAURI_SIGNING_PRIVATE_KEY` (nội dung file key)
- [ ] Release có `latest.json`, `.sig`, và installer `.exe`

Các bản sau (9.9.9 → 9.9.x, …) cập nhật trong app.

### Build local

`npm run build:release` cần khóa ký. `tauri build` đọc `$env:TAURI_SIGNING_PRIVATE_KEY` (nội dung key hoặc đường dẫn file). Script gán mặc định `%USERPROFILE%\.tauri\localization-tool.key` nếu có.

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
git tag v9.9.9 -f
git push origin v9.9.9 -f
```

## Lưu ý

- Chỉ push tag **sau khi** code đã lên `master`
- `npm ci` trên CI yêu cầu `package-lock.json` đồng bộ với `package.json` — chạy `npm install` trước khi commit nếu đổi dependency
- CI dùng **Node 24**, **Python 3.13**, **Rust stable** trên `windows-latest`
