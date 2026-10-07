import { expect, it } from "vitest";

/** 守著 `vite.config.ts` 的 `test.env.TZ`：整個前端測試固定在台北時區跑。
 *
 *  CI（ubuntu）是 UTC，開發機是台北——不釘的話，跟裝置時區有關的測試
 *  （`localDateTime`、編輯這一餐的日期與時間）在 UTC 下用 `getUTC*` 或
 *  `…Z` 寫錯也會過，因為 UTC 跟「本地」剛好一樣。哪天這個設定被拿掉或
 *  失效，這支會紅，而不是那些測試靜靜地失去鑑別力。 */
it("測試跑在台北時區（UTC+8，沒有夏令時間）", () => {
	expect(new Date(0).getTimezoneOffset()).toBe(-480);
	expect(new Date(Date.UTC(2026, 6, 1)).getTimezoneOffset()).toBe(-480);
	expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Asia/Taipei");
});
