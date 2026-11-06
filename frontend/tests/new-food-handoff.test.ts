import { describe, expect, it } from "vitest";
import type { BarcodePrefill } from "../src/api/barcode";
import {
	labelPhotoState,
	newFoodHandoffFrom,
	newFoodState,
	pickedFoodFrom,
	returnToFrom,
} from "../src/lib/new-food-handoff";
import { releaseStashedPhoto } from "../src/lib/photo-stash";
import { makeFood } from "./helpers/foods";

const PREFILL: BarcodePrefill = {
	name: "可口可樂",
	brand: "Coca-Cola",
	base_unit: "ml",
	per100: { kcal: "42.00", protein_g: "0.00", fat_g: "0.00", carb_g: "10.60" },
	serving: { amount: "330.00", unit: "ml" },
	source: "openfoodfacts",
};

describe("returnToFrom：只認記一餐與編輯這一餐（掃條碼規格 D20）", () => {
	it.each([["/meals/new"], ["/meals/12/edit"], ["/meals/1/edit"]])(
		"%s 收",
		(path) => {
			expect(returnToFrom(path)).toBe(path);
		},
	);

	it.each([
		["/meals/0/edit"],
		["/meals/new/"],
		["/meals/12/edit/"],
		["/meals/12"],
		["/foods/1"],
		["https://x/meals/new"],
		["//evil/meals/new"],
		["/meals/new?x=1"],
		["/meals/01/edit"],
		[""],
		[12],
		[null],
		[undefined],
	])("%j → null", (value) => {
		expect(returnToFrom(value)).toBeNull();
	});
});

describe("newFoodHandoffFrom", () => {
	it("正常：條碼、預填、回去的地方都在", () => {
		expect(
			newFoodHandoffFrom(newFoodState("5449000000996", PREFILL, "/meals/new")),
		).toEqual({
			barcode: "5449000000996",
			prefill: PREFILL,
			labelPhoto: null,
			returnTo: "/meals/new",
		});
	});

	it("8 位條碼也收；沒有預填、沒有 returnTo（食物庫）", () => {
		expect(newFoodHandoffFrom(newFoodState("96385074", null, null))).toEqual({
			barcode: "96385074",
			prefill: null,
			labelPhoto: null,
			returnTo: null,
		});
	});

	it("經過 structuredClone（history.state 存的是複本）還讀得出來", () => {
		const state = structuredClone(
			newFoodState("5449000000996", PREFILL, "/meals/7/edit"),
		);

		expect(newFoodHandoffFrom(state)).toEqual({
			barcode: "5449000000996",
			prefill: PREFILL,
			labelPhoto: null,
			returnTo: "/meals/7/edit",
		});
	});

	it.each([
		["12 位（後端存的一定是標準形式：8 或 13 位）", "036000291452"],
		["不是字串", 4710088432094],
		["有分隔符號", "4710088-432094"],
	])("條碼 %s → 整個不要", (_label, barcodeCode) => {
		expect(
			newFoodHandoffFrom({
				barcodeCode,
				barcodePrefill: PREFILL,
				returnTo: "/meals/new",
			}),
		).toBeNull();
	});

	it.each([
		["沒有 per100", { ...PREFILL, per100: undefined }],
		["數字不是字串", { ...PREFILL, per100: { ...PREFILL.per100, kcal: 42 } }],
		["單位不對", { ...PREFILL, base_unit: "oz" }],
		["名稱不是字串", { ...PREFILL, name: 3 }],
	])("預填 %s → 只丟預填，條碼留著", (_label, barcodePrefill) => {
		expect(
			newFoodHandoffFrom({
				barcodeCode: "5449000000996",
				barcodePrefill,
				returnTo: "/meals/new",
			}),
		).toEqual({
			barcode: "5449000000996",
			prefill: null,
			labelPhoto: null,
			returnTo: "/meals/new",
		});
	});

	it("returnTo 不在白名單 → null（條碼、預填照收）", () => {
		expect(
			newFoodHandoffFrom({
				barcodeCode: "5449000000996",
				barcodePrefill: PREFILL,
				returnTo: "https://evil.example/meals/new",
			}),
		).toEqual({
			barcode: "5449000000996",
			prefill: PREFILL,
			labelPhoto: null,
			returnTo: null,
		});
	});

	it.each([[null], [undefined], ["x"], [{ notice: "x" }]])(
		"不相干的 state %j → null",
		(state) => {
			expect(newFoodHandoffFrom(state)).toBeNull();
		},
	);
});

describe("newFoodHandoffFrom：拍營養標示帶來的照片（改名規格 D4）", () => {
	const photo = () => new File(["x"], "label.jpg", { type: "image/jpeg" });

	it("照片＋回去的地方：沒有條碼、沒有預填", () => {
		const file = photo();
		expect(newFoodHandoffFrom(labelPhotoState(file, "/meals/new"))).toEqual({
			barcode: null,
			prefill: null,
			labelPhoto: file,
			returnTo: "/meals/new",
		});
	});

	it("食物庫來的：沒有 returnTo；returnTo 照樣走白名單", () => {
		const file = photo();
		expect(
			newFoodHandoffFrom(labelPhotoState(file, null))?.returnTo,
		).toBeNull();
		expect(
			newFoodHandoffFrom(labelPhotoState(file, "/foods/1"))?.returnTo,
		).toBeNull();
	});

	it("號碼換不到照片（重新整理、舊的 history）→ 沒有交接", () => {
		const state = labelPhotoState(photo(), "/meals/new");
		releaseStashedPhoto();
		expect(newFoodHandoffFrom(state)).toBeNull();
		expect(
			newFoodHandoffFrom({ labelPhoto: "1", returnTo: "/meals/new" }),
		).toBeNull();
	});

	it("有效條碼和暫存的照片同時在 state 裡 → 條碼優先，labelPhoto 是 null", () => {
		const state = {
			...newFoodState("5449000000996", PREFILL, "/meals/new"),
			...labelPhotoState(photo(), "/meals/new"),
		};
		expect(newFoodHandoffFrom(state)).toEqual({
			barcode: "5449000000996",
			prefill: PREFILL,
			labelPhoto: null,
			returnTo: "/meals/new",
		});
	});

	it("條碼無效（123）＋暫存的照片 → 走照片的交接", () => {
		const file = photo();
		const state = {
			barcodeCode: "123",
			barcodePrefill: PREFILL,
			...labelPhotoState(file, "/meals/new"),
		};
		expect(newFoodHandoffFrom(state)).toEqual({
			barcode: null,
			prefill: null,
			labelPhoto: file,
			returnTo: "/meals/new",
		});
	});

	it("state 只帶號碼，不帶 File", () => {
		const state = labelPhotoState(photo(), null);
		expect(Object.keys(state).sort()).toEqual(["labelPhoto", "returnTo"]);
		expect(typeof state.labelPhoto).toBe("number");
	});
});

describe("pickedFoodFrom", () => {
	it("帶回來的食物", () => {
		const food = makeFood({ id: 9 });

		expect(pickedFoodFrom({ pickedFood: food })).toEqual(food);
		expect(pickedFoodFrom(structuredClone({ pickedFood: food }))).toEqual(food);
	});

	it.each([
		[null],
		[{}],
		[{ pickedFood: { id: "9", name: "x", nutrition: null } }],
		[{ pickedFood: null }],
	])("%j → null", (state) => {
		expect(pickedFoodFrom(state)).toBeNull();
	});
});
