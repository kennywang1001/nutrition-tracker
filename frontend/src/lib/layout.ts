/** 電腦版版面的斷點（電腦版版面規格 §2）。**整個前端只有這裡寫 1024**：
 *  CSS 不寫 media query，而是看外框的 `app-desktop` class（`useIsDesktop`
 *  決定要不要加），所以斷點不會在 CSS 與 JS 之間漂移。 */
export const DESKTOP_MEDIA_QUERY = "(min-width: 1024px)";

/** 電腦版內容區的最寬寬度（規格 §3）：wide 1100、form 480、narrow 640。
 *  `/me/targets`、`/me/password`、`/me/body` 是單欄表單，跟記帳、記一餐一樣用 form
 *  （帳號設定規格 決定 19、身體資料規格 D20）。`/weight` 有圖表，用預設的 narrow。
 *  `/exercises/new` 也是 form；`/exercises/:id/edit` 同編輯餐點用 narrow（運動規格 D24）——
 *  這裡只比完整路徑，有 id 的路徑不會是 form。 */
export type ContentWidth = "wide" | "form" | "narrow";

const WIDE = new Set(["/", "/reports", "/diet"]);
const FORM = new Set([
	"/expenses/new",
	"/meals/new",
	"/me/targets",
	"/me/password",
	"/me/body",
	"/exercises/new",
]);

/** 結尾的斜線不算（`/expenses/new/` 也是記帳，跟 react-router 的比對一致）。 */
export function contentWidthFor(pathname: string): ContentWidth {
	const path = pathname.replace(/\/+$/, "") || "/";
	if (WIDE.has(path)) return "wide";
	if (FORM.has(path)) return "form";
	return "narrow";
}
