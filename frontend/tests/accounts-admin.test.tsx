import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { AccountsAdmin } from "../src/components/AccountsAdmin";
import { json, mockApi, type Route } from "./helpers/mock-api";

const ME = {
	id: 1,
	email: "kenny@example.com",
	display_name: "Kenny",
	role: "admin",
	timezone: "Asia/Taipei",
};
const USERS = [
	{ id: 1, email: "kenny@example.com", display_name: "Kenny", role: "admin" },
	{ id: 2, email: "boss@example.com", display_name: "老闆", role: "admin" },
	{ id: 3, email: "ming@example.com", display_name: "小明", role: "user" },
];
const MING_BUTTON = "產生重設密碼連結：小明（ming@example.com）";
const ONCE_TEXT =
	"這個連結只會顯示這一次，24 小時內有效、只能用一次。再產生一次，舊的就不能用了。";

function errorResponse(status: number, code: string, message: string) {
	return json({ error: { code, message, details: {} } }, status);
}

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

/** 管理員的後端。`counts.list` 記清單被 GET 了幾次——「清單重新載入」要看到真的多一次 GET，
 *  不是看 invalidateQueries 有沒有被呼叫（第 50 種）。產生連結的路徑比清單長，排在前面
 *  （mockApi 用子字串比對）。 */
function adminBackend(reset?: () => Response | Promise<Response>) {
	const counts = { list: 0 };
	const routes: Route[] = [];
	if (reset !== undefined) {
		routes.push({
			method: "POST",
			path: "/api/admin/users/3/password-reset",
			handler: reset,
		});
	}
	routes.push(
		{
			method: "GET",
			path: "/api/admin/users",
			handler: () => {
				counts.list += 1;
				return json(USERS);
			},
		},
		{ method: "GET", path: "/api/me", handler: () => json(ME) },
	);
	const spy = mockApi(routes);
	return { spy, counts };
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("所有帳號（管理員）", () => {
	it("不列自己；名字與 email 分開；一般使用者有產生按鈕，管理員寫「用命令列重設」", async () => {
		adminBackend();

		render(wrap(<AccountsAdmin />));

		expect(
			screen.getByRole("heading", { name: "所有帳號" }),
		).toBeInTheDocument();
		// 先等清單出來，「自己不在」才有意義（第 41 種）。
		expect(
			await screen.findByText("小明", { exact: true }),
		).toBeInTheDocument();
		expect(screen.queryByText("kenny@example.com")).not.toBeInTheDocument();
		expect(screen.queryByText("Kenny")).not.toBeInTheDocument();

		// 名字與 email 各自一個元素：拼成「名字（email）」會跟 e2e/invites.spec.ts 的選擇器撞在一起。
		expect(screen.getByText("ming@example.com")).toBeInTheDocument();
		expect(
			screen.queryByText("小明（ming@example.com）"),
		).not.toBeInTheDocument();

		expect(
			screen.getByRole("button", { name: MING_BUTTON }),
		).toBeInTheDocument();

		const boss = screen.getByText("老闆", { exact: true }).closest("li");
		expect(boss).not.toBeNull();
		const bossRow = within(boss as HTMLElement);
		expect(bossRow.getByText("管理員")).toBeInTheDocument();
		expect(bossRow.getByText("用命令列重設")).toBeInTheDocument();
		expect(bossRow.queryByRole("button")).not.toBeInTheDocument();
		// 只有一顆產生按鈕（小明的）。
		expect(
			screen.getAllByRole("button", { name: /^產生重設密碼連結/ }),
		).toHaveLength(1);
	});

	it("產生：打那個人的端點，顯示整條連結、給誰、「只會顯示這一次」", async () => {
		const { spy } = adminBackend(() =>
			json({ token: "tok-3", expires_at: "2026-10-09T12:00:00Z" }, 201),
		);
		render(wrap(<AccountsAdmin />));

		await userEvent.click(
			await screen.findByRole("button", { name: MING_BUTTON }),
		);

		expect(await screen.findByLabelText("重設密碼連結")).toHaveValue(
			`${window.location.origin}/reset-password#tok-3`,
		);
		expect(screen.getByText("給 小明 的重設密碼連結")).toBeInTheDocument();
		expect(screen.getByText(ONCE_TEXT)).toBeInTheDocument();
		const posts = spy.mock.calls.filter(
			([, init]) => (init?.method ?? "GET").toUpperCase() === "POST",
		);
		expect(posts.map(([url]) => String(url))).toEqual([
			"/api/admin/users/3/password-reset",
		]);
	});

	it("產生之後焦點移到連結那一區（清單很長時按鈕在下面、連結在卡片最上面）", async () => {
		// 連結顯示在卡片最上面，而按下去的那顆按鈕可能在一長串帳號的最底下：畫面上什麼都
		// 沒變，螢幕閱讀器也不會念（帳號設定審查 M7）。焦點移過去，瀏覽器會把它捲進畫面。
		let issued = 0;
		adminBackend(() => {
			issued += 1;
			return json(
				{ token: `tok-${issued}`, expires_at: "2026-10-09T12:00:00Z" },
				201,
			);
		});
		render(wrap(<AccountsAdmin />));

		await userEvent.click(
			await screen.findByRole("button", { name: MING_BUTTON }),
		);

		const region = await screen.findByRole("region", {
			name: "給 小明 的重設密碼連結",
		});
		expect(region).toHaveFocus();
		const link = within(region).getByLabelText("重設密碼連結");
		expect(link).toHaveValue(`${window.location.origin}/reset-password#tok-1`);

		// 再產生一次：新的連結出來，焦點要**再**移過去一次。先把焦點移開（點了連結的輸入框），
		// 不然「還在那一區上」分不出是又移了一次，還是從第一次留到現在。
		await userEvent.click(link);
		expect(region).not.toHaveFocus();
		await userEvent.click(screen.getByRole("button", { name: MING_BUTTON }));
		await waitFor(() =>
			expect(screen.getByLabelText("重設密碼連結")).toHaveValue(
				`${window.location.origin}/reset-password#tok-2`,
			),
		);
		expect(region).toHaveFocus();
	});

	it("複製：連結寫進剪貼簿、顯示「已複製」", async () => {
		const user = userEvent.setup();
		adminBackend(() =>
			json({ token: "tok-3", expires_at: "2026-10-09T12:00:00Z" }, 201),
		);
		render(wrap(<AccountsAdmin />));

		await user.click(await screen.findByRole("button", { name: MING_BUTTON }));
		const writeText = vi.spyOn(navigator.clipboard, "writeText");
		await user.click(await screen.findByRole("button", { name: "複製" }));

		expect(await screen.findByRole("status")).toHaveTextContent("已複製");
		expect(writeText).toHaveBeenCalledTimes(1);
		expect(writeText).toHaveBeenCalledWith(
			`${window.location.origin}/reset-password#tok-3`,
		);
	});

	it.each([
		[
			"對象剛變成管理員（422）",
			() =>
				errorResponse(
					422,
					"RESET_NOT_FOR_ADMINS",
					"管理員帳號不能用重設連結：自己的密碼請用「修改密碼」，其他管理員請用命令列",
				),
			"管理員帳號不能用重設連結：自己的密碼請用「修改密碼」，其他管理員請用命令列",
		],
		[
			"帳號已經不在（404）",
			() => errorResponse(404, "USER_NOT_FOUND", "找不到這個帳號"),
			"找不到這個帳號",
		],
	])("%s：後端訊息在卡片層，清單重新載入", async (_name, reset, message) => {
		const { counts } = adminBackend(reset);
		render(wrap(<AccountsAdmin />));
		await userEvent.click(
			await screen.findByRole("button", { name: MING_BUTTON }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		await waitFor(() => expect(counts.list).toBe(2));
		expect(screen.queryByLabelText("重設密碼連結")).not.toBeInTheDocument();
	});

	it("其他錯誤：「產生失敗，請再試一次」", async () => {
		adminBackend(() => errorResponse(500, "INTERNAL_ERROR", "伺服器錯誤"));
		render(wrap(<AccountsAdmin />));
		await userEvent.click(
			await screen.findByRole("button", { name: MING_BUTTON }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"產生失敗，請再試一次",
		);
	});

	it("useMe 還沒回來：清單先不畫——不然自己會先出現一下、再被濾掉", async () => {
		const counts = { list: 0 };
		mockApi([
			{
				method: "GET",
				path: "/api/admin/users",
				handler: () => {
					counts.list += 1;
					return json(USERS);
				},
			},
			{ method: "GET", path: "/api/me", handler: () => new Promise(() => {}) },
		]);
		render(wrap(<AccountsAdmin />));

		// 清單的回應真的到了，「沒有畫出來」才有意義（第 41 種）。
		await waitFor(() => expect(counts.list).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByText("載入中…")).toBeInTheDocument();
		expect(screen.queryByText("kenny@example.com")).not.toBeInTheDocument();
	});

	it("清單載入失敗：說出來，不是空白", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/admin/users",
				handler: () => errorResponse(500, "INTERNAL_ERROR", "伺服器錯誤"),
			},
			{ method: "GET", path: "/api/me", handler: () => json(ME) },
		]);
		render(wrap(<AccountsAdmin />));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"無法載入帳號清單",
		);
	});
});
