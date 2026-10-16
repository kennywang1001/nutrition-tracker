import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { type Food, type FoodScope, useFoodSearch } from "../api/foods";
import { BarcodeScanEntry } from "../components/BarcodeScanEntry";
import { FoodResultList } from "../components/FoodResultList";
import ui from "../components/ui.module.css";
import { newFoodState } from "../lib/new-food-handoff";
import { useDebounced } from "../lib/use-debounced";

const SCOPES: ReadonlyArray<{ value: FoodScope; label: string }> = [
	{ value: "all", label: "全部" },
	{ value: "global", label: "公開食物" },
	{ value: "mine", label: "我建立的" },
];

/** 食物庫搜尋畫面（規格 §5.4、§5.5）。
 *
 *  只放搜尋框、範圍三選一、結果清單、「新增食物」連結。`/foods/new` 與
 *  `/foods/:id` 是 Task 4、5——這裡的連結點過去現在會是空白（`<Routes>`
 *  沒有比對到），那是刻意的，不放佔位畫面。 */
export function FoodLibrary() {
	const navigate = useNavigate();
	const [input, setInput] = useState("");
	const [scope, setScope] = useState<FoodScope>("all");
	const debouncedQuery = useDebounced(input, 300);
	const searchQuery = useFoodSearch(debouncedQuery, scope);
	const hasQuery = debouncedQuery.trim() !== "";

	return (
		<section className={ui.screen}>
			<h1>食物庫</h1>
			<Link to="/foods/new">新增食物</Link>
			{/* 掃條碼（規格 §11）：命中進詳情頁——沒有生效版本的也一樣（詳情頁看得到它，不帶
			    requireNutrition）。沒命中帶到新增食物：一般的 push，存好照舊到詳情頁（沒有 returnTo）。 */}
			<BarcodeScanEntry
				onFood={(food) => navigate(`/foods/${food.id}`)}
				onCreate={(code, prefill) =>
					navigate("/foods/new", {
						state: newFoodState(code, prefill, null),
					})
				}
			/>

			<div>
				<label htmlFor="food-search-input">搜尋食物</label>
				<input
					id="food-search-input"
					type="text"
					value={input}
					onChange={(event) => setInput(event.target.value)}
				/>
			</div>

			<fieldset>
				<legend>範圍</legend>
				{SCOPES.map((option) => (
					<label key={option.value}>
						<input
							type="radio"
							name="food-scope"
							value={option.value}
							checked={scope === option.value}
							onChange={() => setScope(option.value)}
						/>
						{option.label}
					</label>
				))}
			</fieldset>

			{hasQuery && (
				<>
					{searchQuery.isLoading && <p>搜尋中…</p>}
					<FoodResultList
						foods={searchQuery.data ?? []}
						renderAction={(food: Food) => (
							<Link to={`/foods/${food.id}`}>{food.name}</Link>
						)}
					/>
				</>
			)}
		</section>
	);
}
