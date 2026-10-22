import { BodyProfileCard } from "../components/BodyProfileCard";
import { TargetsCard } from "../components/TargetsCard";
import { WeightCard } from "../components/WeightCard";

/** 身體與目標（`/me/health`，首頁改版規格 §5）：從「我的」搬過來的三張卡片，**卡片本身不改**。
 *
 *  - 順序（D16）：每日目標（重算提示、運動加回的開關）→ 體重（每天會碰的）→ 身體資料（最少改）。
 *  - 路由在 `/me` 底下（D1）：分頁的「我的」在這一頁照樣亮著（`NavLink` 沒有 `end`），未讀數字也在同一格。
 *    `/me/body`（身體資料表單）、`/me/targets`（每日目標表單）存好之後導回這裡（D2）。
 *  - 寬度是 `contentWidthFor` 的預設 narrow。 */
export function BodyHub() {
	return (
		<section>
			<h1>身體與目標</h1>
			<TargetsCard />
			<WeightCard />
			<BodyProfileCard />
		</section>
	);
}
