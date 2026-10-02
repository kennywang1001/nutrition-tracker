import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { MoneyKeypad } from "../src/components/MoneyKeypad";
import { isPositiveAmount } from "../src/lib/decimal";

/** 鍵盤是受控元件，測試要有人幫它保管 state——跟 AddExpense 的用法一樣。 */
function Harness() {
	const [amount, setAmount] = useState("");
	return (
		<form onSubmit={(event) => event.preventDefault()}>
			<output aria-label="金額">{amount}</output>
			<MoneyKeypad
				value={amount}
				onChange={setAmount}
				submitDisabled={!isPositiveAmount(amount)}
			/>
		</form>
	);
}

describe("MoneyKeypad", () => {
	it("按鍵依序組成金額", async () => {
		render(<Harness />);

		for (const name of ["1", "2", "小數點", "5"]) {
			await userEvent.click(screen.getByRole("button", { name }));
		}

		expect(screen.getByLabelText("金額")).toHaveTextContent("12.5");
	});

	it("刪除鍵刪掉最後一個字", async () => {
		render(<Harness />);

		await userEvent.click(screen.getByRole("button", { name: "1" }));
		await userEvent.click(screen.getByRole("button", { name: "2" }));
		await userEvent.click(screen.getByRole("button", { name: "刪除" }));

		expect(screen.getByLabelText("金額")).toHaveTextContent(/^1$/);
	});

	it("金額是空的時候不能按「記一筆」，打了數字之後才可以", async () => {
		render(<Harness />);

		expect(screen.getByRole("button", { name: "記一筆" })).toBeDisabled();

		await userEvent.click(screen.getByRole("button", { name: "3" }));

		expect(screen.getByRole("button", { name: "記一筆" })).toBeEnabled();
	});

	it("「記一筆」是送出鈕，數字鍵不是", () => {
		// 數字鍵如果是 type="submit"，每按一個數字表單就送出一次。
		render(<Harness />);

		expect(screen.getByRole("button", { name: "記一筆" })).toHaveAttribute(
			"type",
			"submit",
		);
		expect(screen.getByRole("button", { name: "7" })).toHaveAttribute(
			"type",
			"button",
		);
	});
});
