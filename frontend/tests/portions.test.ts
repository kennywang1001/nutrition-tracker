import { describe, expect, it } from "vitest";
import { pickDefaultPortion } from "../src/lib/portions";

function portion(id: number, isDefault: boolean, isGlobal: boolean) {
	return { id, is_default: isDefault, is_global: isGlobal };
}

describe("pickDefaultPortion", () => {
	it("自己的預設份量優先於公開的", () => {
		// 「一碗」因人而異——使用者自己定義過的，比公開資料更貼近他實際吃的量。
		expect(
			pickDefaultPortion([portion(1, true, true), portion(2, true, false)])?.id,
		).toBe(2);
	});

	it("沒有自己的預設，就用公開的預設", () => {
		expect(
			pickDefaultPortion([portion(1, true, true), portion(2, false, false)])
				?.id,
		).toBe(1);
	});

	it("沒有任何預設份量時回 null", () => {
		expect(
			pickDefaultPortion([portion(1, false, true), portion(2, false, false)]),
		).toBeNull();
	});

	it("空清單回 null", () => {
		expect(pickDefaultPortion([])).toBeNull();
	});
});
