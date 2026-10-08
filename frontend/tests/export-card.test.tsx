import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { ExportCard } from "../src/components/ExportCard";
import { saveBlob } from "../src/lib/save-file";
import { json, mockApi } from "./helpers/mock-api";

// 存檔那一步（object URL、<a download>、iOS 的分享）在 save-file.test.ts；這裡只看
// 卡片交了什麼給它。
vi.mock("../src/lib/save-file", () => ({
	saveBlob: vi.fn(async () => "downloaded"),
}));
const saveBlobMock = vi.mocked(saveBlob);

const BODY = "\uFEFF日期,時間,分類,金額,備註,是否餐費\r\n";

function csv(filename: string | null, body = BODY) {
	const headers = new Headers({ "content-type": "text/csv; charset=utf-8" });
	if (filename !== null) {
		headers.set("content-disposition", `attachment; filename="${filename}"`);
	}
	return new Response(body, { status: 200, headers });
}

function card() {
	return within(screen.getByTestId("export-card"));
}

/** 三顆按鈕現在的文字與能不能按。 */
function buttons(): Array<[string, boolean]> {
	return card()
		.getAllByRole("button")
		.map((button) => [
			button.textContent ?? "",
			!(button as HTMLButtonElement).disabled,
		]);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	saveBlobMock.mockReset();
	saveBlobMock.mockResolvedValue("downloaded");
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("匯出資料", () => {
	it("三顆按鈕在名叫「匯出資料」的一組裡", () => {
		render(<ExportCard />);

		const group = screen.getByRole("group", { name: "匯出資料" });
		expect(
			within(group)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["餐點", "花費", "補劑"]);
	});

	it.each([
		["餐點", "/api/export/meals.csv", "meals-2026-10-09.csv"],
		["花費", "/api/export/expenses.csv", "expenses-2026-10-09.csv"],
		["補劑", "/api/export/supplements.csv", "supplements-2026-10-09.csv"],
	])(
		"按「%s」：帶著登入的票打 %s，把內容與後端給的檔名交去存檔",
		async (label, path, filename) => {
			// mockApi 沒收到 Authorization 一律回 401——走得到 handler 就代表票有帶。
			const fetchMock = mockApi([
				{ method: "GET", path, handler: () => csv(filename) },
			]);
			render(<ExportCard />);

			await userEvent.click(card().getByRole("button", { name: label }));

			expect(await card().findByRole("status")).toHaveTextContent(
				`已下載 ${filename}`,
			);
			expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
				path,
			]);
			expect(saveBlobMock).toHaveBeenCalledTimes(1);
			const [blob, savedAs, mimeType] = saveBlobMock.mock.calls[0] ?? [];
			expect(savedAs).toBe(filename);
			expect(mimeType).toBe("text/csv");
			// BOM 要原封不動：經過 .text() 之類的字串轉手會把它吃掉，Excel 就亂碼了。
			expect(
				new Uint8Array(await (blob as Blob).arrayBuffer()).slice(0, 3),
			).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
			expect(await (blob as Blob).text()).toBe(BODY.slice(1));
		},
	);

	it("下載中：按的那顆寫「下載中…」，三顆都不能按；回來之後恢復", async () => {
		let respond: (response: Response) => void = () => {};
		mockApi([
			{
				method: "GET",
				path: "/api/export/expenses.csv",
				handler: () =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "花費" }));

		expect(buttons()).toEqual([
			["餐點", false],
			["下載中…", false],
			["補劑", false],
		]);
		expect(saveBlobMock).not.toHaveBeenCalled();

		respond(csv("expenses-2026-10-09.csv"));

		await waitFor(() =>
			expect(buttons()).toEqual([
				["餐點", true],
				["花費", true],
				["補劑", true],
			]),
		);
		expect(saveBlobMock).toHaveBeenCalledTimes(1);
	});

	it("429：顯示後端的訊息與還要等幾秒，沒有存任何檔案；再按一次成功就把錯誤清掉", async () => {
		let attempt = 0;
		mockApi([
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => {
					attempt += 1;
					if (attempt > 1) return csv("meals-2026-10-09.csv");
					return new Response(
						JSON.stringify({
							error: {
								code: "TOO_MANY_EXPORTS",
								message: "匯出太頻繁，請稍後再試",
								details: {},
							},
						}),
						{
							status: 429,
							headers: {
								"content-type": "application/json",
								"retry-after": "42",
							},
						},
					);
				},
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "餐點" }));

		expect(await card().findByRole("alert")).toHaveTextContent(
			"匯出太頻繁，請稍後再試（42 秒後可再試）",
		);
		// 先等到錯誤出現，「沒有存檔」才不是因為還沒跑到（第 41 種）。
		expect(saveBlobMock).not.toHaveBeenCalled();
		expect(card().queryByRole("status")).not.toBeInTheDocument();

		await userEvent.click(card().getByRole("button", { name: "餐點" }));

		expect(await card().findByRole("status")).toHaveTextContent(
			"已下載 meals-2026-10-09.csv",
		);
		expect(card().queryByRole("alert")).not.toBeInTheDocument();
	});

	it("先成功、再按一次失敗：上一次的「已下載」不會留在錯誤旁邊", async () => {
		// 429 那一條守的是「成功把上一次的錯誤清掉」；這一條是反方向——不清的話畫面上
		// 同時寫著「已下載 …」與「下載失敗」，看不出這一次到底有沒有存到。
		let attempt = 0;
		mockApi([
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => {
					attempt += 1;
					if (attempt === 1) return csv("meals-2026-10-09.csv");
					return json({ error: { code: "X", message: "x", details: {} } }, 500);
				},
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "餐點" }));
		expect(await card().findByRole("status")).toHaveTextContent(
			"已下載 meals-2026-10-09.csv",
		);

		await userEvent.click(card().getByRole("button", { name: "餐點" }));

		// 先等錯誤出現，「沒有已下載」才不是因為第二次還沒回來（第 41 種）。
		expect(await card().findByRole("alert")).toHaveTextContent(
			"下載失敗，請再試一次",
		);
		expect(card().queryByRole("status")).not.toBeInTheDocument();
	});

	it("其他失敗（500、連不上）：「下載失敗，請再試一次」，按鈕恢復可以按", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/export/supplements.csv",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => Promise.reject(new TypeError("network request failed")),
			},
		]);
		render(<ExportCard />);

		for (const label of ["補劑", "餐點"]) {
			await userEvent.click(card().getByRole("button", { name: label }));
			expect(await card().findByRole("alert")).toHaveTextContent(
				"下載失敗，請再試一次",
			);
			expect(card().getByRole("button", { name: label })).toBeEnabled();
		}
		expect(saveBlobMock).not.toHaveBeenCalled();
	});

	it("存檔那一步失敗也算下載失敗", async () => {
		saveBlobMock.mockRejectedValue(new Error("boom"));
		mockApi([
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => csv("meals-2026-10-09.csv"),
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "餐點" }));

		expect(await card().findByRole("alert")).toHaveTextContent(
			"下載失敗，請再試一次",
		);
	});

	it("後端沒給檔名：退回不帶日期的檔名（前端不自己算今天）", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/export/expenses.csv",
				handler: () => csv(null),
			},
		]);
		render(<ExportCard />);

		await userEvent.click(card().getByRole("button", { name: "花費" }));

		expect(await card().findByRole("status")).toHaveTextContent(
			"已下載 expenses.csv",
		);
		expect(saveBlobMock.mock.calls[0]?.[1]).toBe("expenses.csv");
	});

	it("交給分享面板、或使用者關掉分享面板：不說「已下載」", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/export/meals.csv",
				handler: () => csv("meals-2026-10-09.csv"),
			},
		]);
		render(<ExportCard />);

		for (const result of ["shared", "cancelled"] as const) {
			saveBlobMock.mockResolvedValue(result);
			const before = saveBlobMock.mock.calls.length;
			await userEvent.click(card().getByRole("button", { name: "餐點" }));
			await waitFor(() =>
				expect(saveBlobMock.mock.calls.length).toBe(before + 1),
			);
			await waitFor(() =>
				expect(card().getByRole("button", { name: "餐點" })).toBeEnabled(),
			);
			expect(card().queryByRole("status")).not.toBeInTheDocument();
			expect(card().queryByRole("alert")).not.toBeInTheDocument();
		}
	});
});
