import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { createExercise, invalidateExercises } from "../api/exercises";
import { ExerciseForm } from "../components/ExerciseForm";
import ui from "../components/ui.module.css";
import { localDateTime } from "../lib/dates";
import type { ExerciseFormValues } from "../lib/exercise";

/** `/exercises/new`：記一筆運動（運動規格 §7.2）。存好導回總覽——同記一餐，使用者要的是
 *  立刻看到「額度變了」。 */
export function LogExercise() {
	const navigate = useNavigate();
	const client = useQueryClient();
	// 「現在」只在掛載時取一次：之後重畫不該把使用者改過的時間蓋回去。
	const [initial] = useState<ExerciseFormValues>(() => {
		const now = localDateTime(new Date().toISOString());
		return {
			activity: "",
			name: "",
			minutes: "",
			manual: false,
			kcal: "",
			date: now.date,
			time: now.time,
			note: "",
		};
	});

	return (
		<section className={ui.screen}>
			<h1>記運動</h1>
			<ExerciseForm
				initial={initial}
				save={async (body) => {
					await createExercise(body);
					// 失效放在請求這一邊：導頁之後（表單卸載）照樣要做。
					await invalidateExercises(client);
				}}
				onSaved={() => navigate("/")}
				sendNullKcalWhenEstimated={false}
			/>
		</section>
	);
}
