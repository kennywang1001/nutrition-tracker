// 畫 e2e 用的營養標示照片（標示 OCR 規格 §6.3 的 both-photo）：Playwright 把 HTML 表格截圖，
// 轉 −1.6°、模糊 0.7 px、米色底、JPEG 70。**在 Windows 跑**（微軟正黑體）：Linux 沒有中文字型
// 會畫成方框。用法（frontend/）：node e2e/fixtures/make-label.mjs
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const rows = [
	["熱量", "180 大卡", "514 大卡"],
	["蛋白質", "2.1 公克", "6.0 公克"],
	["脂肪", "9.8 公克", "28.0 公克"],
	[" 飽和脂肪", "3.2 公克", "9.1 公克"],
	[" 反式脂肪", "0 公克", "0 公克"],
	["碳水化合物", "21.3 公克", "60.9 公克"],
	[" 糖", "1.2 公克", "3.4 公克"],
	["鈉", "120 毫克", "343 毫克"],
];
const body = rows
	.map(
		([label, serving, per100]) =>
			`<tr><td class="${label.startsWith(" ") ? "sub" : ""}">${label.trim()}</td>` +
			`<td class="n">${serving}</td><td class="n">${per100}</td></tr>`,
	)
	.join("");
const html = `<style>
body { margin: 0; background: #d8d4cc; font-family: "Microsoft JhengHei", "Noto Sans TC", sans-serif; }
.label { border: 2px solid #000; padding: 10px 14px; width: 520px; margin: 24px; color: #000;
	background: #f4f1ea; transform: rotate(-1.6deg); filter: blur(0.7px) contrast(0.85); }
h1 { font-size: 26px; margin: 0 0 6px; text-align: center; border-bottom: 2px solid #000; padding-bottom: 4px; }
.meta { font-size: 19px; line-height: 1.5; border-bottom: 1px solid #000; }
table { width: 100%; border-collapse: collapse; font-size: 19px; }
th { font-weight: normal; text-align: right; border-bottom: 1px solid #000; padding: 4px 2px; }
td { padding: 3px 2px; border-bottom: 1px solid #000; }
td.n { text-align: right; }
td.sub { padding-left: 1.5em; }
</style>
<div class="label"><h1>營養標示</h1>
<div class="meta">每一份量 35 公克<br>本包裝含 4 份</div>
<table><tr><th></th><th>每份</th><th>每100公克</th></tr>${body}</table></div>`;

const browser = await chromium.launch();
try {
	const page = await browser.newPage({
		viewport: { width: 600, height: 520 },
		deviceScaleFactor: 2,
	});
	await page.setContent(html);
	const box = await page.locator(".label").boundingBox();
	if (box === null) throw new Error("找不到標示");
	await page.screenshot({
		path: fileURLToPath(new URL("./nutrition-label.jpg", import.meta.url)),
		clip: {
			x: box.x - 16,
			y: box.y - 16,
			width: box.width + 32,
			height: box.height + 32,
		},
		type: "jpeg",
		quality: 70,
	});
} finally {
	await browser.close();
}
console.log("寫好 e2e/fixtures/nutrition-label.jpg");
