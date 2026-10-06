/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 跟 decimal-containment.test.ts 同一種作法：用原始碼掃描把「規矩」變成紅燈。
// 規格 §4.1：元件只引用變數、不寫色碼；深色模式只在 index.css 覆寫同一組名字。

const css = readFileSync("src/index.css", "utf8");

function colorTokens(block: string): Map<string, string> {
	const tokens = new Map<string, string>();
	for (const match of block.matchAll(
		/(--color-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g,
	)) {
		const [, name, value] = match;
		if (name !== undefined && value !== undefined) {
			tokens.set(name, value.toLowerCase());
		}
	}
	return tokens;
}

const light = colorTokens(css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "");
const dark = colorTokens(
	css.match(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1] ??
		"",
);

/** WCAG 2.x 的相對亮度。 */
function luminance(hex: string): number {
	const [r = 0, g = 0, b = 0] = [1, 3, 5]
		.map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
		.map((channel) =>
			channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
		);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
	const [high = 0, low = 0] = [luminance(a), luminance(b)].sort(
		(x, y) => y - x,
	);
	return (high + 0.05) / (low + 0.05);
}

/** 文字（前景）× 它會壓在上面的底色。每一組都要 ≥ 4.5:1（WCAG AA 一般文字）。
 *
 *  `--color-accent` **刻意不在這裡**：它只用在沒有文字壓在上面的裝飾
 *  （進度條、選取框），見計畫「與規格的差異」第 1 點。 */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
	["--color-text", "--color-bg"],
	["--color-text", "--color-surface"],
	["--color-text-muted", "--color-bg"],
	["--color-text-muted", "--color-surface"],
	["--color-action", "--color-bg"],
	["--color-action", "--color-surface"],
	["--color-on-action", "--color-action"],
	["--color-danger", "--color-bg"],
	["--color-danger", "--color-surface"],
	// accent-soft 是「選取中」晶片的底色（記帳的分類、鍵盤退格鍵）；淺色的
	// muted / action 壓在上面只有約 4.57 / 4.65，餘裕很薄，值得守。
	["--color-text", "--color-accent-soft"],
	["--color-text-muted", "--color-accent-soft"],
	["--color-action", "--color-accent-soft"],
	// 「公開」標籤（食物清單的 .food-tag）的綠字，壓在畫面底色與卡片上。
	["--color-success", "--color-bg"],
	["--color-success", "--color-surface"],
];

function collectModuleCss(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return collectModuleCss(full);
		return entry.endsWith(".module.css") ? [full] : [];
	});
}

describe("設計變數", () => {
	it("解析器真的抓到了淺色的顏色變數", () => {
		// 少了這條，正規表示式寫錯時 light 是空的，「深色覆寫了每一個」會
		// 因為兩邊都空而通過——handover §6 一再出現的那種綠燈說謊。
		expect(light.size).toBeGreaterThanOrEqual(9);
	});

	it("每個顏色變數都是 6 位十六進位（解析器沒有漏掉任何一個）", () => {
		// 寫成 #fff、#rrggbbaa 或 rgb() 的變數會被 colorTokens 默默略過，
		// 對比度測試就永遠看不到它。這裡數「宣告」的個數，跟解析結果比。
		const declared = (block: RegExp) =>
			(css.match(block)?.[1] ?? "").match(/--color-[\w-]+\s*:/g)?.length ?? 0;
		expect(declared(/:root\s*\{([^}]*)\}/)).toBe(light.size);
		expect(
			declared(/prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/),
		).toBe(dark.size);
	});

	it("深色模式覆寫了每一個顏色變數", () => {
		expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
	});

	for (const [theme, tokens] of [
		["淺色", light],
		["深色", dark],
	] as const) {
		for (const [foreground, background] of PAIRS) {
			it(`${theme}：${foreground} 在 ${background} 上至少 4.5:1`, () => {
				const fg = tokens.get(foreground);
				const bg = tokens.get(background);
				expect(fg, foreground).toBeDefined();
				expect(bg, background).toBeDefined();
				expect(
					contrast(fg ?? "#000000", bg ?? "#000000"),
				).toBeGreaterThanOrEqual(4.5);
			});
		}
	}

	it("元件的 module CSS 不寫色碼", () => {
		const offenders = collectModuleCss("src")
			.filter((file) =>
				/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/.test(readFileSync(file, "utf8")),
			)
			.map((file) => file.replace(/\\/g, "/"));

		expect(offenders).toEqual([]);
	});

	it("index.css 除了設計變數的定義之外沒有色碼", () => {
		// 規格（介面改版第二階段 §3.4）：舊畫面的顏色全部換成變數之後，
		// 色碼只該出現在 :root 與深色模式那兩個區塊裡。
		const outsideTokenBlocks = css
			.replace(/:root\s*\{[^}]*\}/, "")
			.replace(
				/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{[^}]*\}\s*\}/,
				"",
			);
		// 先證明兩個區塊真的被拿掉了——正規表示式沒對上的話，下面的斷言會
		// 把變數定義也算進去而紅，或（更糟）兩個 replace 都沒作用卻剛好沒有
		// 色碼而綠。
		expect(outsideTokenBlocks).not.toContain("--color-text:");

		expect(
			outsideTokenBlocks.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) ?? [],
		).toEqual([]);
	});
});
