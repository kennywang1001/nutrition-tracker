import { useEffect, useState } from "react";

/** 等 AI 的時候顯示經過幾秒（照片說明規格 §6.3、D11）。掛載時從 0 開始。
 *
 *  **`aria-hidden`，而且呼叫端要放在 `role="status"` 外面**：每秒變一次的字放進 live region，讀屏
 *  會每秒念一次。讀屏的人聽到的是旁邊那句「AI 估算中…」。
 *
 *  秒數由開始的時間點算，不是每次加一：分頁在背景時瀏覽器會把 interval 放慢，
 *  切回來時才不會少算。 */
export function ElapsedSeconds({ className }: { className?: string }) {
	const [seconds, setSeconds] = useState(0);
	useEffect(() => {
		const started = Date.now();
		const timer = window.setInterval(() => {
			setSeconds(Math.floor((Date.now() - started) / 1000));
		}, 1000);
		return () => window.clearInterval(timer);
	}, []);
	return (
		<span aria-hidden="true" className={className}>
			{`${seconds} 秒`}
		</span>
	);
}
