import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	describeBarcodeError,
	lookupBarcode,
	updateFoodBarcode,
} from "../src/api/barcode";
import { ApiError } from "../src/api/errors";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { makeFood } from "./helpers/foods";
import { json, mockApi } from "./helpers/mock-api";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

const PREFILL = {
	name: "可口可樂",
	brand: "Coca-Cola",
	base_unit: "ml" as const,
	per100: { kcal: "42.00", protein_g: "0.00", fat_g: "0.00", carb_g: "10.60" },
	serving: { amount: "330.00", unit: "ml" as const },
	source: "openfoodfacts" as const,
};

function sentUrl(fetchMock: ReturnType<typeof mockApi>): string {
	return String(fetchMock.mock.calls[0]?.[0]);
}

function sentInit(fetchMock: ReturnType<typeof mockApi>): RequestInit {
	return fetchMock.mock.calls[0]?.[1] ?? {};
}

describe("lookupBarcode", () => {
	// mockApi 用 includes 比對：`/api/foods/by-barcode/…` 也包含 `/api/foods`。
	// 更具體的路由排前面，另外斷言實際打的網址（只給路由分不出打的是哪一支）。
	it.each([
		[
			"命中",
			{ code: "4710088432094", food: makeFood({ id: 7 }), prefill: null },
		],
		["沒命中＋預填", { code: "4710088432094", food: null, prefill: PREFILL }],
		["沒命中、沒有預填", { code: "4710088432094", food: null, prefill: null }],
	])("%s：GET /api/foods/by-barcode/{code}，回傳原樣", async (_label, body) => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/foods/by-barcode/",
				handler: () => json(body),
			},
			{ path: "/api/foods", handler: () => json([]) },
		]);

		const result = await lookupBarcode("4710088432094");

		expect(sentUrl(fetchMock)).toBe("/api/foods/by-barcode/4710088432094");
		expect((sentInit(fetchMock).method ?? "GET").toUpperCase()).toBe("GET");
		expect(result).toEqual(body);
	});
});

describe("updateFoodBarcode", () => {
	it("PATCH /api/foods/{id}，body 帶條碼", async () => {
		const updated = makeFood({ id: 7, barcode: "96385074" });
		const fetchMock = mockApi([
			{ method: "PATCH", path: "/api/foods/7", handler: () => json(updated) },
		]);

		const result = await updateFoodBarcode(7, "96385074");

		expect(sentUrl(fetchMock)).toBe("/api/foods/7");
		expect(sentInit(fetchMock).method).toBe("PATCH");
		expect(String(sentInit(fetchMock).body)).toBe('{"barcode":"96385074"}');
		expect(result).toEqual(updated);
	});

	it("移除：body 是 {barcode: null}——後端要這個 key，`{}` 是 422", async () => {
		const fetchMock = mockApi([
			{
				method: "PATCH",
				path: "/api/foods/7",
				handler: () => json(makeFood({ id: 7 })),
			},
		]);

		await updateFoodBarcode(7, null);

		expect(String(sentInit(fetchMock).body)).toBe('{"barcode":null}');
	});
});

describe("describeBarcodeError", () => {
	it("422：欄位錯誤拿掉 Pydantic 的「Value error, 」前綴與欄位路徑", () => {
		const error = new ApiError(422, "VALIDATION_ERROR", "輸入格式不對", {
			errors: [
				{
					loc: ["body", "barcode"],
					msg: "Value error, 條碼的檢查碼不對，請再確認一次",
					type: "value_error",
				},
			],
		});

		expect(describeBarcodeError(error)).toBe("條碼的檢查碼不對，請再確認一次");
	});

	it("422：路徑參數的錯誤也一樣", () => {
		const error = new ApiError(422, "VALIDATION_ERROR", "輸入格式不對", {
			errors: [
				{
					loc: ["path", "code"],
					msg: "Value error, 條碼要是 8、12 或 13 位數字",
					type: "value_error",
				},
			],
		});

		expect(describeBarcodeError(error)).toBe("條碼要是 8、12 或 13 位數字");
	});

	it.each([
		[429, "TOO_MANY_BARCODE_LOOKUPS", "查詢條碼太頻繁，請稍後再試"],
		[409, "BARCODE_EXISTS", "你已經有一個用這個條碼的食物了"],
	])("%i %s：後端那一句", (status, code, message) => {
		expect(describeBarcodeError(new ApiError(status, code, message))).toBe(
			message,
		);
	});

	it.each([
		["其他的 ApiError", new ApiError(500, "INTERNAL_ERROR", "伺服器錯誤")],
		["不是 ApiError", new Error("boom")],
	])("%s →「查詢失敗，請再試一次」", (_label, error) => {
		expect(describeBarcodeError(error)).toBe("查詢失敗，請再試一次");
	});
});
