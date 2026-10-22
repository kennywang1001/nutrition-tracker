import {
	useIsRestoring,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { useNavigate } from "react-router";
import {
	type BodyProfile as BodyProfileData,
	type BodyProfileInput,
	invalidateBody,
	saveBodyProfile,
	useFreshBodyProfile,
} from "../api/body";
import { ApiError, describeFieldErrors } from "../api/errors";
import ui from "../components/ui.module.css";
import {
	ACTIVITY_OPTIONS,
	GOAL_OPTIONS,
	RATE_OPTIONS,
	type Rate,
	SEX_OPTIONS,
} from "../lib/body";
import { checkRangeInput, formatMacro } from "../lib/decimal";
import styles from "./BodyProfile.module.css";

type Values = {
	sex: BodyProfileData["sex"];
	birthYear: string;
	heightCm: string;
	activityLevel: BodyProfileData["activity_level"];
	goal: BodyProfileData["goal"];
	rate: Rate | null;
	targetWeightKg: string;
};

const HEIGHT = { min: "100", max: "250", places: 1 } as const;
const WEIGHT = { min: "25", max: "350", places: 2 } as const;

/** `/me/body`（身體資料規格 §6.3）。骨架同 `/me/targets`（D27）：
 *
 *  **表單只用掛載之後才抓回來的那一份預填**——PUT 是整組取代，拿快取裡的舊值（另一台裝置
 *  改之前的、離線還原的）預填，沒動的欄位會被悄悄改回去。重抓失敗就顯示錯誤，不拿舊值湊表單。
 *
 *  **離線快取還在還原的時候不掛 `BodyProfileLoader`**：還原期間建立的 observer 記下的是空的
 *  狀態，還原把 localStorage 裡那份蓋上去之後 `isFetchedAfterMount` 就是 true——一個請求都
 *  還沒回來，舊值就被當成新鮮的填進表單（`Targets` 的說明有完整的推導）。 */
export function BodyProfile() {
	const restoring = useIsRestoring();

	return (
		<section className={ui.screen}>
			<h1>身體資料</h1>
			{restoring ? <p>載入中…</p> : <BodyProfileLoader />}
		</section>
	);
}

/** 重抓身體資料，拿到第一份新鮮的才畫表單。**只能在離線快取還原完之後掛載**（見 `BodyProfile`）。 */
function BodyProfileLoader() {
	const profile = useFreshBodyProfile();
	// 第一份新鮮的資料記下來就不再換：背景重抓失敗不能把表單換成錯誤、帶回別的值也不能蓋掉
	// 使用者打到一半的字（同 `TargetsLoader`）。
	const [prefill, setPrefill] = useState<BodyProfileData | null>(null);
	const fresh =
		profile.isFetchedAfterMount && profile.isSuccess ? profile.data : null;
	if (prefill === null && fresh != null) {
		setPrefill(fresh);
	}
	// 離線時 query 是 paused，不會自己結束——那算讀不到。
	const waiting =
		!profile.isFetchedAfterMount && profile.fetchStatus !== "paused";

	if (prefill !== null) return <BodyProfileForm current={prefill} />;
	if (waiting || fresh != null) return <p>載入中…</p>;
	return <p role="alert">無法載入身體資料</p>;
}

/** 離線快取裡的舊資料可能少了欄位（`undefined`，不是 `null`）：一律用 `?? null` 收（handover §7）。 */
function initialValues(profile: BodyProfileData): Values {
	const rawRate = profile.rate_kg_per_week ?? null;
	const rate = rawRate === null ? null : formatMacro(rawRate);
	const height = profile.height_cm ?? null;
	const target = profile.target_weight_kg ?? null;
	const birth = profile.birth_year ?? null;
	return {
		sex: profile.sex ?? null,
		birthYear: birth === null ? "" : String(birth),
		// formatMacro 去掉尾數的 0：「175.0」預填成「175」，跟卡片上看到的一樣。
		heightCm: height === null ? "" : formatMacro(height),
		activityLevel: profile.activity_level ?? null,
		goal: profile.goal ?? null,
		rate: rate === "0.25" || rate === "0.5" ? rate : null,
		targetWeightKg: target === null ? "" : formatMacro(target),
	};
}

/** 空白＝不設定（null）；有字就要合規則。回傳要送的 body，或一串錯誤。
 *  出生年的「今年 − 100 到今年 − 13」要知道使用者的今天，交給後端（D4）；這裡只擋寫法。 */
function toRequest(
	values: Values,
): { body: BodyProfileInput } | { errors: string[] } {
	const errors: string[] = [];
	const birth = values.birthYear.trim();
	if (birth !== "" && !/^\d{4}$/.test(birth))
		errors.push("出生年要是四位數的西元年");
	const height = checkRangeInput(values.heightCm, HEIGHT);
	if (height !== null && height !== "empty")
		errors.push("身高要在 100 到 250 公分之間，最多一位小數");
	const target = checkRangeInput(values.targetWeightKg, WEIGHT);
	if (target !== null && target !== "empty")
		errors.push("目標體重要在 25 到 350 公斤之間，最多兩位小數");
	if (errors.length > 0) return { errors };
	const heightCm = values.heightCm.trim();
	const targetWeightKg = values.targetWeightKg.trim();
	return {
		body: {
			sex: values.sex,
			// 先比過 /^\d{4}$/，Number() 是安全的（這不是 Decimal 運算）。
			birth_year: birth === "" ? null : Number(birth),
			height_cm: heightCm === "" ? null : heightCm,
			activity_level: values.activityLevel,
			goal: values.goal,
			// 維持時藏起來但照送原本的值（D3）：切回減重時還在。
			rate_kg_per_week: values.rate,
			target_weight_kg: targetWeightKg === "" ? null : targetWeightKg,
		},
	};
}

function BodyProfileForm({ current }: { current: BodyProfileData }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const ids = useId();
	const [values, setValues] = useState<Values>(() => initialValues(current));
	const [errors, setErrors] = useState<string[]>([]);

	const save = useMutation({
		mutationFn: saveBodyProfile,
		// 放在 hook 層：導頁之後元件卸載，這裡照樣會跑（失效是快取的事，不是畫面的事）。
		// 身體資料變了，建議也跟著變——`["body"]` 一次打到身體資料、建議、體重。
		onSuccess: () => invalidateBody(queryClient),
	});

	function set<K extends keyof Values>(key: K, value: Values[K]) {
		setValues((prev) => ({ ...prev, [key]: value }));
	}

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		const result = toRequest(values);
		if ("errors" in result) {
			setErrors(result.errors);
			return;
		}
		setErrors([]);
		// 導頁放在 mutate 的 callback：元件卸載之後不會跑（handover §7）。
		save.mutate(result.body, {
			// 導回身體與目標（首頁改版規格 D2）：剛改的值在那一頁的卡片上，回「我的」看不到。
			onSuccess: () => navigate("/me/health"),
			onError: (caught: unknown) => {
				if (caught instanceof ApiError && caught.status === 422) {
					// BIRTH_YEAR_OUT_OF_RANGE 沒有 errors 陣列，會退回後端的訊息（寫出允許的年份）。
					setErrors(describeFieldErrors(caught));
				} else {
					setErrors(["儲存失敗，請再試一次"]);
				}
			},
		});
	}

	const showRate = values.goal === "lose" || values.goal === "gain";

	return (
		<form onSubmit={handleSubmit} noValidate>
			<p>這些資料只用來算建議目標，好友看不到。留空＝不設定。</p>

			<fieldset className={styles.choices}>
				<legend>性別</legend>
				{SEX_OPTIONS.map((option) => (
					<label key={option.value}>
						<input
							type="radio"
							name="sex"
							value={option.value}
							checked={values.sex === option.value}
							onChange={() => set("sex", option.value)}
						/>
						{option.label}
					</label>
				))}
			</fieldset>

			<div>
				<label htmlFor={`${ids}-birth`}>出生年</label>
				<input
					id={`${ids}-birth`}
					inputMode="numeric"
					autoComplete="bday-year"
					placeholder="例如 1990"
					value={values.birthYear}
					onChange={(event) => set("birthYear", event.target.value)}
				/>
			</div>

			<div>
				<label htmlFor={`${ids}-height`}>身高（cm）</label>
				<input
					id={`${ids}-height`}
					inputMode="decimal"
					autoComplete="off"
					value={values.heightCm}
					onChange={(event) => set("heightCm", event.target.value)}
				/>
			</div>

			<div>
				<label htmlFor={`${ids}-activity`}>活動量</label>
				<select
					id={`${ids}-activity`}
					value={values.activityLevel ?? ""}
					onChange={(event) => {
						const picked = ACTIVITY_OPTIONS.find(
							(option) => option.value === event.target.value,
						);
						set("activityLevel", picked?.value ?? null);
					}}
				>
					<option value="">請選擇</option>
					{ACTIVITY_OPTIONS.map((option) => (
						<option key={option.value} value={option.value}>
							{`${option.label}（${option.hint}）`}
						</option>
					))}
				</select>
			</div>

			<fieldset className={styles.choices}>
				<legend>目標</legend>
				{GOAL_OPTIONS.map((option) => (
					<label key={option.value}>
						<input
							type="radio"
							name="goal"
							value={option.value}
							checked={values.goal === option.value}
							onChange={() => set("goal", option.value)}
						/>
						{option.label}
					</label>
				))}
			</fieldset>

			{showRate && (
				<fieldset className={styles.choices}>
					<legend>速度</legend>
					{RATE_OPTIONS.map((option) => (
						<label key={option.value}>
							<input
								type="radio"
								name="rate"
								value={option.value}
								checked={values.rate === option.value}
								onChange={() => set("rate", option.value)}
							/>
							{option.label}
						</label>
					))}
				</fieldset>
			)}

			<div>
				<label htmlFor={`${ids}-target`}>目標體重（kg，選填）</label>
				<input
					id={`${ids}-target`}
					inputMode="decimal"
					autoComplete="off"
					value={values.targetWeightKg}
					onChange={(event) => set("targetWeightKg", event.target.value)}
				/>
			</div>

			{errors.length > 0 && (
				<ul role="alert">
					{errors.map((message) => (
						<li key={message}>{message}</li>
					))}
				</ul>
			)}
			{/* 送出鈕用原生 disabled（同 /me/targets）：成功就導頁，焦點留在原處沒關係。 */}
			<button type="submit" disabled={save.isPending}>
				儲存
			</button>
		</form>
	);
}
