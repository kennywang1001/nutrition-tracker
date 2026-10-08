/** `#tok` → `tok`：邀請（`/join`）與重設密碼（`/reset-password`）的連結都把碼放在 `#` 後面
 *  （不送到伺服器、不進存取紀錄）。
 *
 *  只取 `#` 後面開頭那一段 `[A-Za-z0-9_-]`——碼是 `token_urlsafe`，只會有這些字元。
 *  聊天軟體常在連結後面黏上句號、空白或自己的 `?參數`，整段送去後端只會得到「失效」。 */
export function readLinkToken(hash: string): string {
	return /^#([A-Za-z0-9_-]*)/.exec(hash)?.[1] ?? "";
}
