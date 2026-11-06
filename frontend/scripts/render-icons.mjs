// 從 public/icon.svg 產生 app 的 PNG 圖示（改名規格 D11）。改了 SVG 之後跑 `npm run icons`，
// 產生的 PNG 一起 commit——build 與 CI 不用跑 Chromium。用 e2e 已經有的 Playwright Chromium。
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
// 同 icon.svg 的底色：maskable 縮小之後，外圈要鋪同一個顏色（不能透明，iOS 會把透明的地方填黑）。
const BACKGROUND = "#fff4ef";
const OUTPUTS = [
	{ file: "apple-touch-icon.png", size: 180, scale: 1 },
	{ file: "icon-192.png", size: 192, scale: 1 },
	{ file: "icon-512.png", size: 512, scale: 1 },
	// Android 會把圖示裁成圓形或圓角：內容縮到 80% 置中才在 maskable 的安全圓裡（叉子、湯匙不會被切掉）。
	{ file: "icon-maskable-512.png", size: 512, scale: 0.8 },
];

const svg = await readFile(`${publicDir}icon.svg`, "utf8");
const browser = await chromium.launch();
try {
	for (const { file, size, scale } of OUTPUTS) {
		const page = await browser.newPage({
			viewport: { width: size, height: size },
			deviceScaleFactor: 1,
		});
		const inner = size * scale;
		const inset = (size - inner) / 2;
		await page.setContent(
			`<!doctype html><style>html,body{margin:0;background:${BACKGROUND}}` +
				`svg{position:absolute;left:${inset}px;top:${inset}px;width:${inner}px;height:${inner}px}</style>${svg}`,
		);
		await page.screenshot({ path: `${publicDir}${file}` });
		await page.close();
		console.log(`${file}（${size}×${size}）`);
	}
} finally {
	await browser.close();
}
