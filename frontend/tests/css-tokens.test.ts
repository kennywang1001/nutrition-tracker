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
});
