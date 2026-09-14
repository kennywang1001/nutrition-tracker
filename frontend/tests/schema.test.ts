import { describe, expectTypeOf, it } from "vitest";
import type { components } from "../src/api/schema";

describe("後端契約", () => {
	it("營養素是字串，不是數字", () => {
		// 後端把 Decimal 序列化成字串以避免浮點誤差（規格 §5.1）。
		// 這條測試不是在測後端——它在測「產生的型別檔還是我們以為的那樣」。
		// 哪天有人手改 schema.d.ts、或後端改了序列化方式，這裡會紅。
		type Macros = components["schemas"]["MacrosResponse"];
		expectTypeOf<Macros["protein_g"]>().toEqualTypeOf<string>();
		expectTypeOf<Macros["kcal"]>().toEqualTypeOf<string>();
	});

	it("TokenResponse 沒有 expires_in", () => {
		// 規格 §6.2：所以前端不能排程「快過期時先換票」，一律被動反應 401。
		// 哪天後端加了這個欄位，這條測試會紅——那時要回頭讀 §6.2 重新決定，
		// 而不是默默地把排程加回來。
		type Token = components["schemas"]["TokenResponse"];
		expectTypeOf<Token>().not.toHaveProperty("expires_in");
	});
});
