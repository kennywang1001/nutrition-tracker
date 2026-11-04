import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelReadResponse } from "../src/api/ai";
import type { LabelTextParse } from "../src/api/label-text";
import { MAX_PHOTO_BYTES } from "../src/api/photos";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LabelReader } from "../src/components/LabelReader";
import { OcrUnavailableError, recognizeLabel } from "../src/lib/label-ocr";
import { pickPhoto } from "./helpers/ai-photo";
import { COMPLETE_PARSE, PARTIAL_PARSE } from "./helpers/label-text";
import { json, mockApi } from "./helpers/mock-api";

// 手機辨識（標示 OCR）：預設讀不到字。要讀到字的測試自己 mockResolvedValue／mockImplementation。
vi.mock("../src/lib/label-ocr", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/lib/label-ocr")>()),
	recognizeLabel: vi.fn(async () => ""),
}));
// 改用 AI 讀的照片會先經過 shrinkToLongestEdge（canvas，jsdom 沒有）——原樣回傳。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

const JPEG = () => new File(["fake-jpeg"], "label.jpg", { type: "image/jpeg" });
const PARSE = "/api/foods/parse-label-text";
const READ_LABEL = "/api/ai/read-label";
const AI = "改用 AI 讀（用 1 次額度）";
const WRONG = "數字不對？改用 AI 讀（用 1 次額度）";
const FILL_READ = "填入讀到的";
const PASTE = "貼上營養標示文字";
const FLAGGED = "熱量跟三大營養素算起來對不太上，請特別確認";
const PASTE_BUSY = "手機辨識或 AI 讀取中，完成或取消後再貼上";
const PARTIAL_MESSAGE =
	"讀到：熱量 514 kcal、蛋白質 6 g、脂肪 28 g（每 100 g）；讀不到：碳水化合物";

/** `new-food-barcode.test.tsx` 的那一份（掃條碼規格 §8.4）。 */
const LABEL: LabelReadResponse = {
	analysis_id: 31,
	name: "海苔洋芋片",
	nutrition: {
		base_unit: "g",
		kcal: "514.29",
		protein_g: "6.00",
		fat_g: "28.00",
		carb_g: "60.86",
	},
	serving: { amount: "35.00", unit: "g" },
	servings_per_package: "4.00",
	basis: "per_serving",
	confidence: "0.80",
	consistency: { atwater_kcal: "519.44", deviation: "5.15", flagged: false },
	remaining_today: 17,
};

/** 有字、但一個數字都讀不到（後端的 `no_values`）。 */
const NO_VALUES_PARSE: LabelTextParse = {
	...PARTIAL_PARSE,
	found: { kcal: null, protein_g: null, fat_g: null, carb_g: null },
	missing: ["kcal", "protein_g", "fat_g", "carb_g"],
	reason: "no_values",
	serving: null,
	servings_per_package: null,
};

/** `COMPLETE_PARSE` 交給表單的樣子。 */
const COMPLETE_FILL = {
	baseUnit: "g",
	values: {
		kcal: "514.00",
		protein_g: "6.00",
		fat_g: "28.00",
		carb_g: "60.90",
	},
	serving: "35.00",
	name: null,
};

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	vi.mocked(recognizeLabel).mockReset();
	vi.mocked(recognizeLabel).mockResolvedValue("");
	setTokens({ access_token: "a", refresh_token: "r" });
});

function renderReader() {
	const onFill = vi.fn();
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const view = render(
		<QueryClientProvider client={client}>
			<LabelReader onFill={onFill} />
		</QueryClientProvider>,
	);
	return { onFill, ...view };
}

const card = () => screen.getByRole("region", { name: "確認照片" });
const picker = () => screen.getByLabelText("拍營養標示");

/** 測試決定什麼時候回來的 promise。 */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** 排好的 microtask 與計時器都跑完：斷言「之後也沒有發生」用。 */
const settle = () => new Promise((done) => setTimeout(done, 20));

function urls(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls.map(([input]) => String(input));
}

function readLabelBodies(fetchMock: ReturnType<typeof mockApi>): unknown[] {
	return fetchMock.mock.calls
		.filter(([input]) => String(input).includes(READ_LABEL))
		.map(([, init]) => JSON.parse(String(init?.body)));
}

describe("LabelReader：拍營養標示", () => {
	it("選了照片就在手機上辨識；讀完整：交給表單、卡片收起、焦點到結果、不打 AI", async () => {
		vi.mocked(recognizeLabel).mockResolvedValue("營養標示\n熱量 514 大卡");
		const fetchMock = mockApi([
			{ method: "POST", path: PARSE, handler: () => json(COMPLETE_PARSE) },
		]);
		const { onFill } = renderReader();

		await userEvent.upload(screen.getByLabelText("拍營養標示"), JPEG());

		const note = await screen.findByText("手機辨識的數字，請對照包裝確認");
		expect(onFill).toHaveBeenCalledExactlyOnceWith(COMPLETE_FILL);
		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("本包裝含 4 份")).toBeInTheDocument();
		expect(screen.queryByText(FLAGGED)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: WRONG })).toBeInTheDocument();
		await waitFor(() => expect(note.closest("[tabindex='-1']")).toHaveFocus());
		expect(urls(fetchMock)).toEqual([PARSE]);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			text: "營養標示\n熱量 514 大卡",
		});
	});

	it("手機讀完整、熱量跟三大營養素對不太上：多一句請特別確認", async () => {
		vi.mocked(recognizeLabel).mockResolvedValue("營養標示");
		mockApi([
			{
				method: "POST",
				path: PARSE,
				handler: () =>
					json({
						...COMPLETE_PARSE,
						consistency: {
							atwater_kcal: "900.00",
							deviation: "386.00",
							flagged: true,
						},
					}),
			},
		]);
		renderReader();

		await userEvent.upload(picker(), JPEG());

		expect(await screen.findByText(FLAGGED)).toBeInTheDocument();
		expect(
			screen.getByText("手機辨識的數字，請對照包裝確認"),
		).toBeInTheDocument();
	});

	it("辨識中：「手機辨識中…」＋秒數、卡片只有「取消」、沒有說明欄、照片按鈕停用；取消會中止、卡片收起、焦點回照片按鈕", async () => {
		let signal: AbortSignal | undefined;
		vi.mocked(recognizeLabel).mockImplementation((_file, received) => {
			signal = received;
			return new Promise<string>(() => {});
		});
		const fetchMock = mockApi([]);
		renderReader();

		await userEvent.upload(picker(), JPEG());

		const running = await screen.findByText("手機辨識中…");
		const status = running.closest("[role=status]");
		// 下載的說明：看得到的那一行在秒數那一列底下（aria-hidden），讀屏從 status 裡的那一份念。
		const notes = screen.getAllByText("第一次使用要下載辨識資料（約 3 MB）");
		expect(notes).toHaveLength(2);
		expect(notes.filter((note) => status?.contains(note))).toHaveLength(1);
		expect(notes.find((note) => !status?.contains(note))).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		expect(screen.getByText("0 秒")).toBeInTheDocument();
		// 秒數在 role="status" 外面：讀屏不會每秒念一次。
		expect(status).not.toHaveTextContent("秒");
		await waitFor(() => expect(card()).toHaveFocus());
		expect(
			within(card())
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["取消"]);
		expect(
			within(card()).queryByLabelText("補充說明（選填）"),
		).not.toBeInTheDocument();
		expect(
			await within(card()).findByRole("img", { name: "營養標示的照片" }),
		).toBeInTheDocument();
		expect(picker()).toBeDisabled();
		expect(signal?.aborted).toBe(false);

		await userEvent.click(within(card()).getByRole("button", { name: "取消" }));

		expect(signal?.aborted).toBe(true);
		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("手機辨識中…")).not.toBeInTheDocument();
		await waitFor(() => expect(picker()).toHaveFocus());
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("讀出空字串：不打後端；卡片說手機讀不出來、有說明欄與「改用 AI 讀」，沒有「填入讀到的」", async () => {
		const fetchMock = mockApi([]);
		renderReader();

		await userEvent.upload(picker(), JPEG());

		expect(
			await within(card()).findByRole("button", { name: AI }),
		).not.toHaveAttribute("aria-disabled", "true");
		expect(within(card()).getByRole("status")).toHaveTextContent(
			"手機讀不出這張營養標示",
		);
		expect(within(card()).getByLabelText("補充說明（選填）")).toHaveAttribute(
			"placeholder",
			"例：這是每 100 ml、一包 2 份",
		);
		expect(
			within(card()).queryByRole("button", { name: FILL_READ }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("手機辨識中…")).not.toBeInTheDocument();
		expect(picker()).not.toBeDisabled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("讀到字、一個數字都讀不到（no_values）：卡片說讀不出數字、沒有「填入讀到的」", async () => {
		vi.mocked(recognizeLabel).mockResolvedValue("成分：馬鈴薯、植物油");
		mockApi([
			{ method: "POST", path: PARSE, handler: () => json(NO_VALUES_PARSE) },
		]);
		renderReader();

		await userEvent.upload(picker(), JPEG());

		expect(
			await within(card()).findByRole("button", { name: AI }),
		).toBeInTheDocument();
		expect(within(card()).getByRole("status")).toHaveTextContent(
			"讀不出營養標示的數字",
		);
		expect(
			within(card()).queryByRole("button", { name: FILL_READ }),
		).not.toBeInTheDocument();
	});

	it("讀不完整：卡片說讀到什麼、缺什麼；「填入讀到的」交給表單（缺的是空的）、卡片收起、結果那一段的按鈕是「改用 AI 讀」", async () => {
		vi.mocked(recognizeLabel).mockResolvedValue("營養標示\n熱量 514 大卡");
		mockApi([
			{ method: "POST", path: PARSE, handler: () => json(PARTIAL_PARSE) },
		]);
		const { onFill } = renderReader();

		await userEvent.upload(picker(), JPEG());

		const fill = await within(card()).findByRole("button", {
			name: FILL_READ,
		});
		expect(within(card()).getByRole("status")).toHaveTextContent(
			PARTIAL_MESSAGE,
		);
		expect(
			within(card()).getByRole("button", { name: AI }),
		).toBeInTheDocument();
		expect(
			within(card()).getByLabelText("補充說明（選填）"),
		).toBeInTheDocument();
		expect(onFill).not.toHaveBeenCalled();

		await userEvent.click(fill);

		expect(onFill).toHaveBeenCalledExactlyOnceWith({
			...COMPLETE_FILL,
			values: { ...COMPLETE_FILL.values, carb_g: "" },
		});
		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		const note = screen.getByText("填入了讀到的數字，其餘請自己填");
		expect(
			screen.queryByText("手機辨識的數字，請對照包裝確認"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: WRONG }),
		).not.toBeInTheDocument();
		await waitFor(() => expect(note.closest("[tabindex='-1']")).toHaveFocus());

		// 結果那一段的「改用 AI 讀」：同一張照片重新打開卡片。
		await userEvent.click(screen.getByRole("button", { name: AI }));
		expect(within(card()).getByRole("status")).toHaveTextContent(
			"用同一張照片改用 AI 讀",
		);
	});

	it("讀不完整 → 改用 AI 讀：同一張照片＋說明打 read-label；等待中三顆按鈕 aria-disabled、說明唯讀、照片按鈕停用；讀好交給表單（帶名稱）", async () => {
		vi.mocked(recognizeLabel).mockResolvedValue("營養標示");
		const reply = deferred<Response>();
		const fetchMock = mockApi([
			{ method: "POST", path: PARSE, handler: () => json(PARTIAL_PARSE) },
			{ method: "POST", path: READ_LABEL, handler: () => reply.promise },
		]);
		const { onFill } = renderReader();

		await pickPhoto("拍營養標示", JPEG(), {
			start: AI,
			hint: "這是每 100 ml",
		});

		expect(await screen.findByText("AI 讀取中…")).toBeInTheDocument();
		const buttons = within(card()).getAllByRole("button");
		expect(buttons.map((button) => button.textContent)).toEqual([
			AI,
			FILL_READ,
			"取消",
		]);
		for (const button of buttons) {
			expect(button).toHaveAttribute("aria-disabled", "true");
		}
		expect(within(card()).getByLabelText("補充說明（選填）")).toHaveAttribute(
			"readonly",
		);
		expect(picker()).toBeDisabled();
		// 停用的「填入讀到的」「取消」按了沒有反應。
		await userEvent.click(
			within(card()).getByRole("button", { name: FILL_READ }),
		);
		await userEvent.click(within(card()).getByRole("button", { name: "取消" }));
		expect(onFill).not.toHaveBeenCalled();
		expect(card()).toBeInTheDocument();

		reply.resolve(json(LABEL));

		expect(
			await screen.findByText("AI 讀的數字，請對照包裝確認"),
		).toBeInTheDocument();
		expect(onFill).toHaveBeenCalledExactlyOnceWith({
			baseUnit: "g",
			values: {
				kcal: "514.29",
				protein_g: "6.00",
				fat_g: "28.00",
				carb_g: "60.86",
			},
			serving: "35.00",
			name: "海苔洋芋片",
		});
		expect(screen.getByText("今天還能用 17 次")).toBeInTheDocument();
		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: WRONG }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: AI })).not.toBeInTheDocument();
		expect(readLabelBodies(fetchMock)).toEqual([
			{ image_base64: btoa("fake-jpeg"), hint: "這是每 100 ml" },
		]);
	});

	it("AI 失敗（502）：卡片與說明留著、說後端那一句；再按一次送同一段說明", async () => {
		const message =
			"AI 讀不出這張營養標示的數字，換一張清楚一點、整個表格都在畫面裡的照片再試（這一次也算在今天的次數裡）";
		let attempt = 0;
		const fetchMock = mockApi([
			{
				method: "POST",
				path: READ_LABEL,
				handler: () => {
					attempt += 1;
					return attempt === 1
						? json(
								{
									error: { code: "AI_LABEL_UNREADABLE", message, details: {} },
								},
								502,
							)
						: json(LABEL);
				},
			},
		]);
		const { onFill } = renderReader();

		await pickPhoto("拍營養標示", JPEG(), { start: AI, hint: "一包 2 份" });

		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		expect(within(card()).getByLabelText("補充說明（選填）")).toHaveValue(
			"一包 2 份",
		);
		expect(onFill).not.toHaveBeenCalled();

		await userEvent.click(within(card()).getByRole("button", { name: AI }));

		await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		const body = { image_base64: btoa("fake-jpeg"), hint: "一包 2 份" };
		expect(readLabelBodies(fetchMock)).toEqual([body, body]);
	});

	it("讀完整之後「數字不對？」：同一張照片重新打開卡片（不重新辨識）、打 AI 一次；AI 讀的時候舊的結果收起來", async () => {
		vi.mocked(recognizeLabel).mockResolvedValue("營養標示");
		const created = vi.spyOn(URL, "createObjectURL");
		const reply = deferred<Response>();
		const fetchMock = mockApi([
			{ method: "POST", path: PARSE, handler: () => json(COMPLETE_PARSE) },
			{ method: "POST", path: READ_LABEL, handler: () => reply.promise },
		]);
		const { onFill } = renderReader();
		const photo = JPEG();

		await userEvent.upload(picker(), photo);
		await userEvent.click(await screen.findByRole("button", { name: WRONG }));

		expect(within(card()).getByRole("status")).toHaveTextContent(
			"用同一張照片改用 AI 讀",
		);
		expect(
			await within(card()).findByRole("img", { name: "營養標示的照片" }),
		).toBeInTheDocument();
		// 用 toBe 比：兩個 File 用 toEqual 比永遠相等（沒有可列舉的欄位）。
		expect(created.mock.calls.at(-1)?.[0]).toBe(photo);
		expect(within(card()).getByLabelText("補充說明（選填）")).toHaveValue("");
		expect(
			within(card()).queryByRole("button", { name: FILL_READ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: WRONG }),
		).not.toBeInTheDocument();
		await waitFor(() => expect(card()).toHaveFocus());

		// 重新打開卡片時，上一次（手機）的結果還在；AI 讀的時候收起來，只說「AI 讀取中…」。
		expect(
			screen.getByText("手機辨識的數字，請對照包裝確認"),
		).toBeInTheDocument();

		await userEvent.click(within(card()).getByRole("button", { name: AI }));

		expect(await screen.findByText("AI 讀取中…")).toBeInTheDocument();
		expect(
			screen.queryByText("手機辨識的數字，請對照包裝確認"),
		).not.toBeInTheDocument();
		expect(screen.queryByText("本包裝含 4 份")).not.toBeInTheDocument();
		reply.resolve(json(LABEL));

		await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(recognizeLabel).toHaveBeenCalledOnce();
		expect(urls(fetchMock)).toEqual([PARSE, READ_LABEL]);
		expect(onFill).toHaveBeenCalledTimes(2);
		expect(onFill).toHaveBeenLastCalledWith(
			expect.objectContaining({ name: "海苔洋芋片" }),
		);
	});

	it("辨識中卸載：中止；之後才回來的字不送後端、不交給表單", async () => {
		let signal: AbortSignal | undefined;
		const text = deferred<string>();
		vi.mocked(recognizeLabel).mockImplementation((_file, received) => {
			signal = received;
			return text.promise;
		});
		const fetchMock = mockApi([
			{ method: "POST", path: PARSE, handler: () => json(COMPLETE_PARSE) },
		]);
		const { onFill, unmount } = renderReader();
		await userEvent.upload(picker(), JPEG());
		await screen.findByText("手機辨識中…");

		unmount();

		expect(signal?.aborted).toBe(true);
		text.resolve("營養標示");
		await settle();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(onFill).not.toHaveBeenCalled();
	});

	it("解析在路上時取消、再選一張：第二張的結果才算（第一張晚回來的不交給表單）", async () => {
		vi.mocked(recognizeLabel)
			.mockResolvedValueOnce("第一張")
			.mockResolvedValueOnce("第二張");
		const first = deferred<Response>();
		let calls = 0;
		const fetchMock = mockApi([
			{
				method: "POST",
				path: PARSE,
				handler: () => {
					calls += 1;
					return calls === 1 ? first.promise : json(COMPLETE_PARSE);
				},
			},
		]);
		const { onFill } = renderReader();

		await userEvent.upload(picker(), JPEG());
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		// 解析也算在辨識裡：還是「手機辨識中…」、照片按鈕停用（換照片要先取消）。
		expect(screen.getByText("手機辨識中…")).toBeInTheDocument();
		expect(picker()).toBeDisabled();
		await userEvent.click(within(card()).getByRole("button", { name: "取消" }));
		await userEvent.upload(picker(), JPEG());
		await screen.findByText("手機辨識的數字，請對照包裝確認");
		expect(onFill).toHaveBeenCalledExactlyOnceWith(COMPLETE_FILL);

		first.resolve(
			json({
				...COMPLETE_PARSE,
				found: { ...COMPLETE_PARSE.found, kcal: "999.00" },
			}),
		);
		await settle();

		expect(onFill).toHaveBeenCalledExactlyOnceWith(COMPLETE_FILL);
		expect(urls(fetchMock)).toEqual([PARSE, PARSE]);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
			text: "第二張",
		});
	});

	it("手機不能辨識（OcrUnavailableError）：卡片說這台裝置不能用＋「改用 AI 讀」；不打後端", async () => {
		vi.mocked(recognizeLabel).mockRejectedValue(
			new OcrUnavailableError(new Error("逾時")),
		);
		const fetchMock = mockApi([]);
		renderReader();

		await userEvent.upload(picker(), JPEG());

		expect(
			await within(card()).findByRole("button", { name: AI }),
		).toBeInTheDocument();
		expect(within(card()).getByRole("status")).toHaveTextContent(
			"這台裝置現在不能用手機辨識",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "限速（429）",
			reply: () =>
				json(
					{
						error: {
							code: "TOO_MANY_LABEL_PARSES",
							message: "讀得太頻繁了，請稍後再試",
							details: {},
						},
					},
					429,
				),
			message: "讀得太頻繁了，請稍後再試",
		},
		{
			name: "網路",
			reply: () => Promise.reject(new TypeError("Failed to fetch")),
			message: "讀不了，請檢查網路再試一次",
		},
	])(
		"解析失敗（$name）：卡片是那一句＋「改用 AI 讀」，沒有「填入讀到的」",
		async ({ reply, message }) => {
			vi.mocked(recognizeLabel).mockResolvedValue("營養標示");
			mockApi([{ method: "POST", path: PARSE, handler: reply }]);
			renderReader();

			await userEvent.upload(picker(), JPEG());

			expect(
				await within(card()).findByRole("button", { name: AI }),
			).toBeInTheDocument();
			expect(within(card()).getByRole("status")).toHaveTextContent(message);
			expect(
				within(card()).queryByRole("button", { name: FILL_READ }),
			).not.toBeInTheDocument();
		},
	);

	it("照片太大：選的當下就擋（alert），不出卡片、不辨識", async () => {
		mockApi([]);
		renderReader();
		const big = JPEG();
		Object.defineProperty(big, "size", { value: MAX_PHOTO_BYTES + 1 });

		await userEvent.upload(picker(), big);

		expect(await screen.findByRole("alert")).toHaveTextContent("照片超過");
		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		expect(recognizeLabel).not.toHaveBeenCalled();
	});
});

describe("LabelReader：貼上營養標示文字", () => {
	async function openPaste() {
		await userEvent.click(screen.getByRole("button", { name: PASTE }));
		return screen.getByRole("region", { name: PASTE });
	}

	it("展開／收起（aria-expanded）；空的（或只有空白）時「讀取文字」aria-disabled、按了不打後端；取消時焦點回到那顆按鈕", async () => {
		const fetchMock = mockApi([]);
		renderReader();
		const toggle = screen.getByRole("button", { name: PASTE });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(
			screen.queryByRole("region", { name: PASTE }),
		).not.toBeInTheDocument();

		const region = await openPaste();

		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(toggle).toHaveAttribute("aria-controls", region.id);
		const textarea = within(region).getByLabelText("營養標示文字");
		expect(textarea).toHaveAttribute("maxlength", "4000");
		const read = within(region).getByRole("button", { name: "讀取文字" });
		expect(read).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(read);
		await userEvent.type(textarea, "   ");
		expect(read).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(read);
		expect(fetchMock).not.toHaveBeenCalled();
		// 沒有照片：沒有 AI 按鈕。
		expect(
			within(region).queryByRole("button", { name: AI }),
		).not.toBeInTheDocument();

		await userEvent.click(within(region).getByRole("button", { name: "取消" }));

		expect(
			screen.queryByRole("region", { name: PASTE }),
		).not.toBeInTheDocument();
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(toggle).toHaveFocus();
	});

	it("貼上完整：送 trim 過的字；讀取中 aria-disabled、欄位唯讀；交給表單、收起、說是貼上的、焦點到結果、沒有 AI 按鈕", async () => {
		const reply = deferred<Response>();
		const fetchMock = mockApi([
			{ method: "POST", path: PARSE, handler: () => reply.promise },
		]);
		const { onFill } = renderReader();
		const region = await openPaste();
		await userEvent.type(
			within(region).getByLabelText("營養標示文字"),
			"  營養標示 熱量 514 大卡  ",
		);

		await userEvent.click(
			within(region).getByRole("button", { name: "讀取文字" }),
		);

		await waitFor(() =>
			expect(
				within(region).getByRole("button", { name: "讀取文字" }),
			).toHaveAttribute("aria-disabled", "true"),
		);
		expect(within(region).getByLabelText("營養標示文字")).toHaveAttribute(
			"readonly",
		);
		reply.resolve(json(COMPLETE_PARSE));

		const note = await screen.findByText(
			"從貼上的文字讀的數字，請對照包裝確認",
		);
		expect(onFill).toHaveBeenCalledExactlyOnceWith(COMPLETE_FILL);
		expect(
			screen.queryByRole("region", { name: PASTE }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: PASTE })).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		expect(screen.getByText("本包裝含 4 份")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: WRONG }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: AI })).not.toBeInTheDocument();
		await waitFor(() => expect(note.closest("[tabindex='-1']")).toHaveFocus());
		expect(urls(fetchMock)).toEqual([PARSE]);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			text: "營養標示 熱量 514 大卡",
		});
	});

	it("貼上不完整：這一塊說讀到什麼；「填入讀到的」交給表單、收起、說其餘自己填；沒有 AI 按鈕", async () => {
		mockApi([
			{ method: "POST", path: PARSE, handler: () => json(PARTIAL_PARSE) },
		]);
		const { onFill } = renderReader();
		const region = await openPaste();
		await userEvent.type(
			within(region).getByLabelText("營養標示文字"),
			"營養標示",
		);

		await userEvent.click(
			within(region).getByRole("button", { name: "讀取文字" }),
		);

		await waitFor(() =>
			expect(within(region).getByRole("status")).toHaveTextContent(
				PARTIAL_MESSAGE,
			),
		);
		expect(onFill).not.toHaveBeenCalled();
		expect(
			within(region).queryByRole("button", { name: AI }),
		).not.toBeInTheDocument();

		await userEvent.click(
			within(region).getByRole("button", { name: FILL_READ }),
		);

		expect(onFill).toHaveBeenCalledExactlyOnceWith({
			...COMPLETE_FILL,
			values: { ...COMPLETE_FILL.values, carb_g: "" },
		});
		expect(
			screen.queryByRole("region", { name: PASTE }),
		).not.toBeInTheDocument();
		expect(
			screen.getByText("填入了讀到的數字，其餘請自己填"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: AI })).not.toBeInTheDocument();
	});

	it("送出中按「取消」：收起；結果晚回來也不交給表單", async () => {
		const reply = deferred<Response>();
		const fetchMock = mockApi([
			{ method: "POST", path: PARSE, handler: () => reply.promise },
		]);
		const { onFill } = renderReader();
		const region = await openPaste();
		await userEvent.type(
			within(region).getByLabelText("營養標示文字"),
			"營養標示",
		);
		await userEvent.click(
			within(region).getByRole("button", { name: "讀取文字" }),
		);
		await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

		await userEvent.click(within(region).getByRole("button", { name: "取消" }));
		reply.resolve(json(COMPLETE_PARSE));
		await settle();

		expect(onFill).not.toHaveBeenCalled();
		expect(
			screen.queryByText("從貼上的文字讀的數字，請對照包裝確認"),
		).not.toBeInTheDocument();
	});

	it("解析被限速（429）：這一塊說後端那一句、字留著、可以再讀一次", async () => {
		let attempt = 0;
		const fetchMock = mockApi([
			{
				method: "POST",
				path: PARSE,
				handler: () => {
					attempt += 1;
					return attempt === 1
						? json(
								{
									error: {
										code: "TOO_MANY_LABEL_PARSES",
										message: "讀得太頻繁了，請稍後再試",
										details: {},
									},
								},
								429,
							)
						: json(COMPLETE_PARSE);
				},
			},
		]);
		const { onFill } = renderReader();
		const region = await openPaste();
		await userEvent.type(
			within(region).getByLabelText("營養標示文字"),
			"營養標示",
		);

		await userEvent.click(
			within(region).getByRole("button", { name: "讀取文字" }),
		);

		await waitFor(() =>
			expect(within(region).getByRole("status")).toHaveTextContent(
				"讀得太頻繁了，請稍後再試",
			),
		);
		expect(within(region).getByLabelText("營養標示文字")).toHaveValue(
			"營養標示",
		);
		expect(onFill).not.toHaveBeenCalled();

		await userEvent.click(
			within(region).getByRole("button", { name: "讀取文字" }),
		);

		await screen.findByText("從貼上的文字讀的數字，請對照包裝確認");
		expect(onFill).toHaveBeenCalledExactlyOnceWith(COMPLETE_FILL);
		expect(urls(fetchMock)).toEqual([PARSE, PARSE]);
	});

	it("手機辨識中不能送：「讀取文字」aria-disabled、說為什麼；按了不打後端、不填；取消辨識之後就能送", async () => {
		vi.mocked(recognizeLabel).mockImplementation(
			() => new Promise<string>(() => {}),
		);
		const fetchMock = mockApi([
			{ method: "POST", path: PARSE, handler: () => json(COMPLETE_PARSE) },
		]);
		const { onFill } = renderReader();
		await userEvent.upload(picker(), JPEG());
		await screen.findByText("手機辨識中…");
		const region = await openPaste();
		await userEvent.type(
			within(region).getByLabelText("營養標示文字"),
			"營養標示",
		);
		const read = within(region).getByRole("button", { name: "讀取文字" });

		expect(read).toHaveAttribute("aria-disabled", "true");
		expect(read).toHaveAccessibleDescription(PASTE_BUSY);
		expect(within(region).getByRole("status")).toHaveTextContent(PASTE_BUSY);
		await userEvent.click(read);
		await settle();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(onFill).not.toHaveBeenCalled();

		await userEvent.click(within(card()).getByRole("button", { name: "取消" }));

		expect(read).toHaveAttribute("aria-disabled", "false");
		expect(read).not.toHaveAccessibleDescription(PASTE_BUSY);
		expect(within(region).getByRole("status")).toHaveTextContent("");
		await userEvent.click(read);
		await screen.findByText("從貼上的文字讀的數字，請對照包裝確認");
		expect(onFill).toHaveBeenCalledExactlyOnceWith(COMPLETE_FILL);
		expect(urls(fetchMock)).toEqual([PARSE]);
	});

	it("AI 讀的時候也不能送、也不能填貼上讀到的；AI 讀好之後才可以", async () => {
		const reply = deferred<Response>();
		const fetchMock = mockApi([
			{ method: "POST", path: PARSE, handler: () => json(PARTIAL_PARSE) },
			{ method: "POST", path: READ_LABEL, handler: () => reply.promise },
		]);
		const { onFill } = renderReader();
		// 先貼一段讀不完整的：這一塊有「填入讀到的」。
		const region = await openPaste();
		await userEvent.type(
			within(region).getByLabelText("營養標示文字"),
			"營養標示",
		);
		await userEvent.click(
			within(region).getByRole("button", { name: "讀取文字" }),
		);
		await waitFor(() =>
			expect(within(region).getByRole("status")).toHaveTextContent(
				PARTIAL_MESSAGE,
			),
		);

		// 拍照（手機讀不出來）→ 改用 AI 讀，AI 還沒回來。
		await pickPhoto("拍營養標示", JPEG(), { start: AI });
		await screen.findByText("AI 讀取中…");

		const read = within(region).getByRole("button", { name: "讀取文字" });
		const fill = within(region).getByRole("button", { name: FILL_READ });
		expect(read).toHaveAttribute("aria-disabled", "true");
		expect(fill).toHaveAttribute("aria-disabled", "true");
		expect(read).toHaveAccessibleDescription(PASTE_BUSY);
		expect(within(region).getByRole("status")).toHaveTextContent(PASTE_BUSY);
		await userEvent.click(read);
		await userEvent.click(fill);
		await settle();
		expect(onFill).not.toHaveBeenCalled();
		expect(urls(fetchMock).filter((url) => url === PARSE)).toHaveLength(1);

		reply.resolve(json(LABEL));

		await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(onFill).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ name: "海苔洋芋片" }),
		);
		// AI 讀好了：這一塊回到原來的樣子（讀到什麼、可以填）。
		expect(within(region).getByRole("status")).toHaveTextContent(
			PARTIAL_MESSAGE,
		);
		expect(fill).toHaveAttribute("aria-disabled", "false");
	});
});
