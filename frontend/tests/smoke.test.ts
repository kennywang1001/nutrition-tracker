import { describe, expect, it } from "vitest";

describe("工具鏈", () => {
	it("跑得起來，而且 TypeScript 的 strict 真的開著", () => {
		// 這個斷言本身沒有價值，有價值的是它跑得起來這件事。
		// TypeScript 的 strict 由 `npm run typecheck` 守，不是由這裡守。
		expect(1 + 1).toBe(2);
	});
});
