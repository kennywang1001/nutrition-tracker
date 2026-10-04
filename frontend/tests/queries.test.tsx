import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { queryKeys } from "../src/api/queries";

describe("query key", () => {
	it("今日總覽與補劑各有自己的 key", () => {
		expect(queryKeys.dailyStats).not.toEqual(queryKeys.supplementsToday);
	});

	it("失效今日總覽不會連帶失效無關的 key", () => {
		// 這條守的是「key 的前綴沒有重疊到不該重疊的東西」。
		// 全部共用一個前綴的話，記一餐會把常吃清單也一起失效掉——
		// 那不是錯誤，但會讓每次記帳多打兩個沒必要的請求。
		const client = new QueryClient();
		client.setQueryData(queryKeys.dailyStats, { marker: "stats" });
		client.setQueryData(queryKeys.frequentFoods, { marker: "foods" });

		client.invalidateQueries({ queryKey: queryKeys.dailyStats });

		expect(client.getQueryState(queryKeys.frequentFoods)?.isInvalidated).toBe(
			false,
		);
	});
});

describe("花費的 query key", () => {
	it("expensesAll 是清單與報表兩者的前綴", () => {
		// 這條守的是「記一筆花費之後，清單跟總額要一起重取」。
		// TanStack Query 的 invalidateQueries 是前綴比對，所以兩個 key
		// 都必須以 expensesAll 開頭——否則失效會靜默漏掉其中一個，
		// 症狀是「記了一筆，總額沒變」。
		const prefix = queryKeys.expensesAll;
		expect(queryKeys.expenses(null).slice(0, prefix.length)).toEqual([
			...prefix,
		]);
		expect(queryKeys.expenseSummary(null).slice(0, prefix.length)).toEqual([
			...prefix,
		]);
	});

	it("expensesByDate 也掛在 expensesAll 底下", () => {
		// 總覽的「今天的支出」要在記帳、記一餐、改刪之後一起重取。
		// 那些地方都只失效 expensesAll——前綴不對的話，總覽會停在舊資料。
		const prefix = queryKeys.expensesAll;
		expect(
			queryKeys.expensesByDate("2026-12-15").slice(0, prefix.length),
		).toEqual([...prefix]);
	});

	it("清單與報表是不同的 key——不會互相覆蓋", () => {
		expect(queryKeys.expenses("2026-12")).not.toEqual(
			queryKeys.expenseSummary("2026-12"),
		);
	});

	it("null（這個月）與明確月份是不同的 key", () => {
		// null 必須出現在 key 裡。省略的話「這個月」跟某個明確月份會撞成
		// 同一份快取，而使用者會看到錯的月份資料。
		expect(queryKeys.expenses(null)).not.toEqual(queryKeys.expenses("2026-12"));
	});
});

describe("單一餐的 query key", () => {
	it("掛在 meals 底下——改了任何一餐，今日清單與那一餐一起重取", () => {
		const prefix = queryKeys.meals;
		expect(queryKeys.meal(5).slice(0, prefix.length)).toEqual([...prefix]);
	});

	it("移除某一餐的快取不會連帶移除今日清單", () => {
		// 刪一餐之後要 removeQueries(meal(id))（見 EditMeal 的 DeleteMeal）。
		// 這條守的是那一行不會順手清掉別的東西。
		const client = new QueryClient();
		client.setQueryData(queryKeys.meals, []);
		client.setQueryData(queryKeys.meal(5), { id: 5 });

		client.removeQueries({ queryKey: queryKeys.meal(5) });

		expect(client.getQueryData(queryKeys.meals)).toEqual([]);
		expect(client.getQueryData(queryKeys.meal(5))).toBeUndefined();
	});
});
