import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import {
	type PortionChoice,
	PortionQuantityFields,
	usePortionQuantity,
} from "../src/components/PortionQuantityFields";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const MY_BOWL = {
	id: 7,
	label: "我的碗",
	grams: "220.00",
	is_default: true,
	is_global: false,
};
const PLATE = {
	id: 9,
	label: "盤",
	grams: "300.00",
	is_default: false,
	is_global: true,
};

const SOUP_BOWL = {
	id: 21,
	label: "湯碗",
	grams: "250.00",
	is_default: true,
	is_global: false,
};

function Harness({
	initial,
	idPrefix,
	foodId = 1,
}: {
	initial?: { choice: PortionChoice; quantity: string };
	idPrefix?: string;
	foodId?: number;
}) {
	const state = usePortionQuantity(foodId, initial);
	return (
		<>
			<PortionQuantityFields state={state} unit="ml" idPrefix={idPrefix} />
			<output data-testid="portion-id">{String(state.portionId)}</output>
		</>
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
	mockApi({
		"/api/foods/1/portions": () => json([MY_BOWL, PLATE]),
		"/api/foods/2/portions": () => json([SOUP_BOWL]),
	});
});

describe("usePortionQuantity／PortionQuantityFields", () => {
	it("沒有給初始值：用預設份量、數量 1", async () => {
		render(wrap(<Harness />));

		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("7"),
		);
		expect(screen.getByLabelText("份量")).toHaveValue("1");
		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("份");
	});

	it("給了「直接輸入」的初始值：預設份量不能把它蓋掉", async () => {
		// 編輯一個「直接輸入 80 ml」的項目時，食物後來才設的預設份量
		// 不能把它變成 80 碗。
		render(wrap(<Harness initial={{ choice: "manual", quantity: "80" }} />));

		await screen.findByRole("option", { name: "我的碗" });
		expect(screen.getByLabelText("份量選項")).toHaveValue("");
		expect(screen.getByLabelText("份量")).toHaveValue("80");
		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("ml");
		expect(screen.getByTestId("portion-id")).toHaveTextContent("null");
	});

	it("給了某個份量的初始值：選的就是那個份量", async () => {
		render(wrap(<Harness initial={{ choice: 9, quantity: "2" }} />));

		await screen.findByRole("option", { name: "盤" });
		expect(screen.getByLabelText("份量選項")).toHaveValue("9");
		expect(screen.getByLabelText("份量")).toHaveValue("2");
		expect(screen.getByTestId("portion-id")).toHaveTextContent("9");
	});

	it("idPrefix 加在每個 id 前面，標籤照樣對得上", async () => {
		render(wrap(<Harness idPrefix="item-5-" />));

		await screen.findByRole("option", { name: "我的碗" });
		expect(screen.getByLabelText("份量選項")).toHaveAttribute(
			"id",
			"item-5-portion",
		);
		expect(screen.getByLabelText("份量")).toHaveAttribute(
			"aria-describedby",
			"item-5-quantity-unit",
		);
		expect(screen.getByTestId("item-5-quantity-unit")).toBeInTheDocument();
	});

	it("選份量改的是 portionId", async () => {
		render(wrap(<Harness />));
		await screen.findByRole("option", { name: "盤" });

		await userEvent.selectOptions(screen.getByLabelText("份量選項"), "9");

		expect(screen.getByTestId("portion-id")).toHaveTextContent("9");
	});

	it("選「直接輸入數量」：portionId 變 null，單位提示變成食物的單位", async () => {
		render(wrap(<Harness />));
		await screen.findByRole("option", { name: "盤" });

		await userEvent.selectOptions(screen.getByLabelText("份量選項"), "");

		expect(screen.getByTestId("portion-id")).toHaveTextContent("null");
		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("ml");
	});

	it("換食物：上一個食物的「直接輸入」不會帶過去，用新食物的預設份量", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const tree = (foodId: number) => (
			<QueryClientProvider client={client}>
				<Harness foodId={foodId} />
			</QueryClientProvider>
		);
		const { rerender } = render(tree(1));
		await screen.findByRole("option", { name: "盤" });
		await userEvent.selectOptions(screen.getByLabelText("份量選項"), "");
		expect(screen.getByTestId("portion-id")).toHaveTextContent("null");

		rerender(tree(2));

		await screen.findByRole("option", { name: "湯碗" });
		await waitFor(() =>
			expect(screen.getByTestId("portion-id")).toHaveTextContent("21"),
		);
	});
});
