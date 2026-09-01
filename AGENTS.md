# TabNap Project Rules

## Versioning

- `manifest.json` 的 `version` 是唯一版本來源。
- 對外可辨識的每次交付都必須調整版本號，並與該次變更同時提交。
- 遵循 Semantic Versioning：修正、效能調整與小型 UX 變更升 PATCH；新增相容功能升 MINOR；不相容變更升 MAJOR。
- 同一輪交付包含多個小變更時，只升級一次版本號。
- 僅文件或純內部、不影響使用者行為的變更可不升版本；交付摘要需說明不升版原因。
- 未明確要求時，不建立封裝檔或發布產物。
