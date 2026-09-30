# Chrome 線上應用程式商店 — 上架文案（繁體中文）

以下欄位可直接複製到 [Chrome 開發人員資訊主頁](https://chrome.google.com/webstore/devconsole)。

---

## 名稱（Name）

```
TabNap
```

（若需與套件區隔，可用：`TabNap — 休眠分頁釋放記憶體`）

---

## 簡短說明（Summary / 短描述）

**限制：最多 132 字元（含標點與空白）。**

```
休眠閒置分頁以釋放記憶體。穩定版用 Discard；Dev 版可終止 process。支援快捷鍵、批次釋放／喚醒與自動規則。
```

字元數：62

**備用（更短）：**

```
一鍵休眠分頁釋放記憶體；穩定版 Discard，Dev 可 End Task，並可自動清理閒置分頁。
```

---

## 詳細說明（Description）

**限制：最多 16,000 字元。建議分段、條列，方便審查與使用者掃讀。**

```
TabNap 讓你在 Chromium 系瀏覽器中休眠分頁以釋放記憶體：穩定版使用 Discard 卸載頁面；Chrome Dev / Edge Dev 則可終止分頁 process（等同工作管理員的 End Task）。

適合同時開大量分頁、背景頁吃資源、或長時間使用後想讓瀏覽器變輕的人。

【主要功能】
• 釋放：休眠選定分頁（Discard 或 End Task，依瀏覽器能力自動選擇）
• 喚醒：重新載入已釋放的分頁
• 全部釋放 / 全部喚醒：批次處理目前視窗分頁
• 快捷鍵：預設 macOS Cmd+E、Windows／Linux Ctrl+E（可於擴充功能快捷鍵頁自訂）
• 自動釋放：依閒置分鐘數清理背景分頁
• 站點規則：依 Domain、FQDN 或 URL 設定 Never Close 或自訂分鐘數
• 分頁級政策：單一 tab 可設預設、Never Close 或自訂閒置時間（優先於站點規則）
• 釋放 http／https／file 分頁前，best-effort 在標題最左側加上 💤 與半型空格，原網站圖示不變

【使用方式】
1. 點擊工具列圖示開啟 popup
2. 選擇分頁後按釋放，或使用全部釋放
3. 需要時按喚醒／全部喚醒重新載入
4. 可開啟「自動釋放」並設定預設閒置分鐘與規則

【重要相容性說明】
• Chrome Dev、Edge Dev：可終止 process
• Chrome / Edge 穩定版、Brave：自動改用 chrome.tabs.discard() 休眠分頁
• 作用中分頁在 Discard 模式下會先切換焦點再卸載

【注意事項】
• Dev End Task 是 process 級操作：若多個分頁共用同一個 renderer process，可能一併被終止。Discard 不會連坐
• 喚醒是重新載入頁面，不會完整還原表單未送出內容或 SPA 暫時狀態
• Never Close 只略過自動釋放與全部釋放；手動對單一 tab 仍可釋放
• 內建頁（如 chrome://）等受保護頁面可能無法操作
• 本地 file:// 若要穩定加上標題前綴，請在擴充功能詳細資料開啟「允許存取檔案網址」

【權限用途（摘要）】
• tabs / storage / alarms：列出分頁、儲存規則與自動清理排程
• processes：在支援的瀏覽器終止 process
• scripting、activeTab、主機權限：僅在 Dev End Task 前注入標題前綴（不讀取網頁內容作追蹤）

本擴充功能不會將你的瀏覽資料上傳至外部伺服器。規則與狀態僅儲存在本機瀏覽器儲存空間。
```

---

## 類別建議（Category）

- 主要：`生產力`（Productivity）
- 或：`工具`（Utilities）

---

## 語言

- 預設語言：`中文（繁體）` / `zh-TW`
- 若商店要求英文描述，見同目錄 `listing-en.md`（若未提供可再產生）

---

## 商店圖示（Store icon）

| 檔案 | 規格 | 用途 |
|------|------|------|
| `store-icon-128.png` | 128×128 PNG | **商店／套件圖示（必備）** — 上傳套件時由 manifest icons 提供；亦可作商店代表圖 |
| `store-icon-512.png` | 512×512 PNG | 高解析母圖（裁切、宣傳用） |
| `store-icon-128-transparent.png` | 128×128 PNG 透明底 | 備用 |

Chrome 線上應用程式商店擴充功能圖示要求：**正方形 PNG，至少 128×128**。本目錄已提供符合規格的白底紅叉圖示（與擴充功能既有品牌一致）。

---

## 上架時其他常見欄位（請自行準備）

| 欄位 | 建議 |
|------|------|
| 單一用途說明 | `僅用於讓使用者手動或依規則休眠／喚醒分頁，以釋放瀏覽器記憶體。` |
| 權限 justification | 見下方「權限說明草稿」 |
| 隱私權政策 URL | 若使用 host_permissions／讀取分頁 URL，通常需公開政策頁 |
| 截圖 | 至少 1 張；1280×800 或 640×400 |

### 權限說明草稿（審查用）

```
tabs：列出目前視窗分頁，供使用者選擇要釋放／喚醒的目標，並在穩定版呼叫 chrome.tabs.discard()。
storage：儲存自動釋放開關、閒置分鐘、站點規則與分頁政策。
alarms：在啟用自動釋放時定期檢查閒置分頁。
processes：在支援的瀏覽器呼叫 chrome.processes 終止分頁 process。
scripting + activeTab + host_permissions：僅在使用者於 Dev channel 觸發終止 process 時，best-effort 於 document.title 加上可辨識前綴；不讀取或傳送網頁內容。
file:// 主機權限：讓本地 HTML 分頁在授權「允許存取檔案網址」後也能套用標題前綴。
```

### 單一用途（Single purpose）草稿

```
本擴充功能的唯一用途是協助使用者休眠或喚醒瀏覽器分頁（穩定版 Discard；Dev 版可 End Task），並可依閒置時間與規則自動處理背景分頁，以釋放記憶體。
```
