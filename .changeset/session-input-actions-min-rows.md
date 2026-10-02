---
"@mizunowanko/synapse-chat-react": minor
---

`SessionInput` に `actions` と `minRows` を追加。

- `actions?: ReactNode` — 送信ボタンの真上に縦に積むボタン。渡すと右の列が 24px × 2 段になり（送信ボタンは 36px → 24px）、2 行ぶんの入力欄とちょうど同じ高さになる。
- `minRows?: number` — 空のときの入力欄の行数（既定 1）。自動で伸びる上限は 6 行（`minRows` がそれより大きければ `minRows`）。

どちらも省略すれば、見た目は今までと同じ。

```tsx
<SessionInput value={draft} onChange={setDraft} onSend={send} minRows={2} actions={<TemplateButton />} />
```
