/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function collectSourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return collectSourceFiles(full);
		return /\.tsx?$/.test(entry) ? [full] : [];
	});
}

describe("decimal.js 的使用範圍", () => {
	it("只有 lib/decimal.ts 可以 import decimal.js", () => {
		// 規格決策 5 的延伸：型別檔讓「寫 parseFloat」變成編譯錯誤，
		// 這條測試讓「繞過 lib/decimal.ts 自己 new Decimal()」變成紅燈。
		//
		// 沒有這條的話，約束只存在於 decimal.ts 的 docstring 裡——
		// 而這個專案的教訓是：文件擋不住重蹈覆轍，程式碼可以。
		const offenders = collectSourceFiles("src")
			.filter((file) => /decimal\.js/.test(readFileSync(file, "utf8")))
			.map((file) => file.replace(/\\/g, "/"))
			.filter((file) => file !== "src/lib/decimal.ts");

		expect(offenders).toEqual([]);
	});
});
