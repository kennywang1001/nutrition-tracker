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
